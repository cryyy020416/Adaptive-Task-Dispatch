import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const dbPath = process.env.DISPATCH_DB_PATH || path.join(__dirname, 'dispatch.sqlite');
const port = Number(process.env.PORT || 8787);
const deepseekEnabled = Boolean(process.env.DEEPSEEK_API_KEY) && process.env.DISPATCH_MODEL_MODE !== 'mock';

const readJson = name => JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
const db = new DatabaseSync(dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, badge_id TEXT NOT NULL, team TEXT NOT NULL,
  plant TEXT NOT NULL, allowed_cross_line INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, person_id TEXT NOT NULL, skill TEXT NOT NULL,
  skill_name TEXT NOT NULL, level INTEGER NOT NULL, certified_until TEXT NOT NULL,
  roles_json TEXT NOT NULL, FOREIGN KEY(person_id) REFERENCES people(id)
);
CREATE TABLE IF NOT EXISTS availability (
  person_id TEXT PRIMARY KEY, status TEXT NOT NULL, area TEXT NOT NULL,
  current_task_id TEXT, can_be_interrupted INTEGER NOT NULL DEFAULT 0,
  distance_meters INTEGER NOT NULL DEFAULT 9999, updated_at TEXT NOT NULL,
  FOREIGN KEY(person_id) REFERENCES people(id)
);
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY, version TEXT NOT NULL, task_type TEXT NOT NULL,
  equipment_keyword TEXT, payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, raw_text TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
  parsed_json TEXT, dispatch_spec_json TEXT, created_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, person_id TEXT NOT NULL,
  role TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, sent_at TEXT,
  responded_at TEXT, UNIQUE(task_id, person_id, role)
);
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, formed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL, person_id TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY(team_id, person_id), FOREIGN KEY(team_id) REFERENCES teams(id)
);
CREATE TABLE IF NOT EXISTS task_outcomes (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, person_id TEXT NOT NULL,
  role TEXT NOT NULL, task_type TEXT NOT NULL, equipment_type TEXT,
  completed_at TEXT NOT NULL, within_sla INTEGER NOT NULL,
  first_pass_success INTEGER NOT NULL, rework_required INTEGER NOT NULL,
  review_result TEXT, actual_duration_minutes REAL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
  actor TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidate_snapshots (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, person_id TEXT NOT NULL,
  role TEXT NOT NULL, eligible INTEGER NOT NULL, rank INTEGER,
  reasons_json TEXT NOT NULL, excluded_by_json TEXT NOT NULL, created_at TEXT NOT NULL
);
`);

function now() { return new Date().toISOString(); }
function json(value) { return JSON.stringify(value ?? null); }
function parseJson(value, fallback = null) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function insertSeed() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM people').get().count;
  if (Number(count) > 0) return;
  const people = readJson('people.json');
  const capabilities = readJson('capabilities.json');
  const availability = readJson('availability.json');
  const rules = readJson('rules.json');
  const history = readJson('historical_tasks.json');
  const insertPerson = db.prepare('INSERT INTO people(id,name,badge_id,team,plant,allowed_cross_line) VALUES(?,?,?,?,?,?)');
  const insertCapability = db.prepare('INSERT INTO capabilities(person_id,skill,skill_name,level,certified_until,roles_json) VALUES(?,?,?,?,?,?)');
  const insertAvailability = db.prepare('INSERT INTO availability(person_id,status,area,current_task_id,can_be_interrupted,distance_meters,updated_at) VALUES(?,?,?,?,?,?,?)');
  const insertRule = db.prepare('INSERT INTO rules(id,version,task_type,equipment_keyword,payload_json) VALUES(?,?,?,?,?)');
  const insertOutcome = db.prepare('INSERT INTO task_outcomes(id,task_id,person_id,role,task_type,equipment_type,completed_at,within_sla,first_pass_success,rework_required,review_result,actual_duration_minutes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const p of people) insertPerson.run(p.id, p.name, p.badge_id, p.team, p.plant, p.allowed_cross_line ? 1 : 0);
  for (const c of capabilities) insertCapability.run(c.person_id, c.skill, c.skill_name, c.level, c.certified_until, json(c.roles));
  for (const a of availability) insertAvailability.run(a.person_id, a.status, a.area, a.current_task_id, a.can_be_interrupted ? 1 : 0, a.distance_meters, a.updated_at);
  for (const r of rules) insertRule.run(r.id, r.version, r.task_type, r.equipment_keyword, json(r));
  for (const h of history) insertOutcome.run(h.id, h.id, h.person_id, h.role, h.task_type, h.equipment_type, h.completed_at, h.within_sla ? 1 : 0, h.first_pass_success ? 1 : 0, h.rework_required ? 1 : 0, h.review_result, h.actual_duration_minutes);
}
insertSeed();

const transitions = {
  draft: ['parsed'], parsed: ['awaiting_dispatch'], awaiting_dispatch: ['inviting'],
  inviting: ['forming_team', 'awaiting_dispatch'], forming_team: ['in_progress'],
  in_progress: ['pending_review'], pending_review: ['completed', 'in_progress'], completed: []
};
function transition(taskId, next, actor = 'system', payload = {}) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (!task) throw new Error('任务不存在');
  if (!transitions[task.status]?.includes(next)) throw new Error(`不允许从 ${task.status} 进入 ${next}`);
  db.prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?').run(next, now(), taskId);
  addEvent(taskId, `status_${next}`, actor, { from: task.status, to: next, ...payload });
}
function addEvent(taskId, eventType, actor, payload = {}) {
  db.prepare('INSERT INTO events(id,task_id,event_type,actor,payload_json,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), taskId, eventType, actor, json(payload), now());
}
function ruleFor(task) {
  const rules = db.prepare('SELECT payload_json FROM rules WHERE task_type=? ORDER BY version DESC').all(task.task_type || 'equipment_incident');
  return rules.map(r => parseJson(r.payload_json)).find(r => !r.equipment_keyword || String(task.equipment || '').includes(r.equipment_keyword)) || null;
}
function parseFallback(rawText) {
  const text = String(rawText || '').trim();
  const urgent = /急单|紧急|关键|停线/.test(text);
  const line = text.match(/([一二三四五六七八九\d]+)\s*号线/);
  const station = text.match(/(\d+)\s*号工位/);
  const equipment = text.match(/(绷缝机|平缝机|锁眼机)/)?.[1] || '绷缝机';
  const minutes = Number(text.match(/(\d+)\s*分钟/)?.[1] || 10);
  return {
    task_type: 'equipment_incident', equipment: `${equipment} 03`,
    location: `${line?.[1] || '3'}号线${station ? ` ${station[1]}号工位` : ' 12号工位'}`,
    impact: urgent ? '急单生产风险' : '当前工位受影响',
    urgency: urgent ? 'critical' : 'normal', goal: '恢复生产并通过首件检查',
    sla_minutes: minutes, confidence: 0.84, missing_fields: []
  };
}
async function parseWithDeepSeek(rawText) {
  if (!deepseekEnabled) return parseFallback(rawText);
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`},
    body: JSON.stringify({model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', temperature: 0, response_format: {type: 'json_object'}, messages: [
      {role: 'system', content: '你是制造现场异常结构化助手。只输出 JSON，不派工。字段：task_type,equipment,location,impact,urgency,goal,sla_minutes,missing_fields,confidence。'},
      {role: 'user', content: rawText}
    ]})
  });
  if (!response.ok) throw new Error(`DeepSeek 请求失败（HTTP ${response.status}）`);
  const body = await response.json();
  return JSON.parse(body.choices?.[0]?.message?.content || '{}');
}
function metricsFor(personId, taskType = 'equipment_incident', equipment = '绷缝机') {
  const rows = db.prepare('SELECT * FROM task_outcomes WHERE person_id=? AND task_type=? AND (equipment_type IS NULL OR equipment_type=?) ORDER BY completed_at DESC').all(personId, taskType, equipment);
  const total = rows.length;
  if (!total) return { sample_size: 0, first_pass_success_rate: null, rework_rate: null, sla_rate: null, avg_duration_minutes: null };
  const sum = field => rows.reduce((n, r) => n + Number(r[field] || 0), 0);
  return { sample_size: total, first_pass_success_rate: sum('first_pass_success') / total, rework_rate: sum('rework_required') / total, sla_rate: sum('within_sla') / total, avg_duration_minutes: Math.round((sum('actual_duration_minutes') / total) * 10) / 10 };
}
function capabilitiesFor(personId) { return db.prepare('SELECT * FROM capabilities WHERE person_id=?').all(personId).map(c => ({...c, roles: parseJson(c.roles_json, [])})); }
function candidatesFor(task, spec) {
  const all = db.prepare('SELECT p.*, a.status, a.area, a.current_task_id, a.can_be_interrupted, a.distance_meters, a.updated_at AS state_updated_at FROM people p JOIN availability a ON a.person_id=p.id').all();
  const output = [];
  for (const roleSpec of spec.required_roles) {
    const role = roleSpec.role;
    for (const person of all) {
      const caps = capabilitiesFor(person.id);
      const cap = caps.find(c => (role === 'repair_owner' && c.skill === 'sewing_machine_repair' && c.level >= 3) || (role === 'operator' && c.skill === 'sewing_machine_operation' && c.level >= 2) || (role === 'reviewer' && c.skill === 'quality_review' && c.level >= 2));
      const excluded = [];
      if (!cap) excluded.push(role === 'repair_owner' ? '缺少绷缝机维修 L3 认证' : '角色资格不足');
      if (person.status === 'offline') excluded.push('当前离线');
      if (person.status === 'busy' && !person.can_be_interrupted) excluded.push('正在处理不可打断任务');
      const eta = Math.max(1, Math.ceil(Number(person.distance_meters) / 18));
      if (eta > Number(spec.sla_minutes || 10)) excluded.push(`预计 ${eta} 分钟到位，超出 SLA`);
      const metrics = metricsFor(person.id, task.task_type, task.equipment?.split(' ')[0] || '绷缝机');
      const eligible = excluded.length === 0;
      const reasons = [];
      if (eligible) {
        if (person.status === 'available') reasons.push('当前空闲');
        if (Number(person.distance_meters) === 0) reasons.push('当前就在现场'); else reasons.push(`预计 ${eta} 分钟到位`);
        if (metrics.sample_size) reasons.push(`同类经验 ${metrics.sample_size} 次`);
        if (metrics.sample_size) reasons.push(`一次解决率 ${Math.round(metrics.first_pass_success_rate * 100)}%`);
      }
      output.push({person_id: person.id, role, eligible, rank: null, reasons, excluded_by: excluded, eta_minutes: eta, metrics, person});
    }
  }
  for (const role of [...new Set(output.map(c => c.role))]) {
    const eligible = output.filter(c => c.role === role && c.eligible).sort((a, b) => a.eta_minutes - b.eta_minutes || (b.metrics.first_pass_success_rate ?? 0) - (a.metrics.first_pass_success_rate ?? 0) || (a.metrics.rework_rate ?? 1) - (b.metrics.rework_rate ?? 1));
    eligible.forEach((c, i) => { c.rank = i + 1; });
  }
  return output;
}
function dispatchSpec(task, parsed) {
  const rule = ruleFor(parsed) || ruleFor({task_type: 'equipment_incident', equipment: '绷缝机'});
  if (!rule) throw new Error('没有找到适用规则');
  return {...rule, task_id: task.id, equipment: parsed.equipment, location: parsed.location, sla_minutes: parsed.sla_minutes || rule.sla_minutes};
}
function serializeTask(task) {
  if (!task) return null;
  const events = db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY created_at').all(task.id).map(e => ({...e, payload: parseJson(e.payload_json, {})}));
  const invitations = db.prepare('SELECT i.*,p.name,p.badge_id FROM invitations i JOIN people p ON p.id=i.person_id WHERE i.task_id=?').all(task.id);
  const candidates = db.prepare('SELECT * FROM candidate_snapshots WHERE task_id=? ORDER BY role, rank IS NULL, rank').all(task.id).map(c => ({...c, reasons: parseJson(c.reasons_json, []), excluded_by: parseJson(c.excluded_by_json, [])}));
  const team = db.prepare('SELECT t.id,tm.person_id,tm.role,p.name,p.badge_id FROM teams t JOIN team_members tm ON tm.team_id=t.id JOIN people p ON p.id=tm.person_id WHERE t.task_id=?').all(task.id);
  return {...task, parsed: parseJson(task.parsed_json), dispatch_spec: parseJson(task.dispatch_spec_json), events, invitations, candidates, team};
}
async function handleApi(req, res, pathname, body) {
  const send = (status, payload) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify(payload)); };
  try {
    if (req.method === 'GET' && pathname === '/api/health') return send(200, {ok:true, db_path:dbPath, model_mode:deepseekEnabled ? 'deepseek' : 'mock'});
    if (req.method === 'GET' && pathname === '/api/bootstrap') return send(200, {people: db.prepare('SELECT * FROM people').all(), rules: db.prepare('SELECT id,version,task_type,equipment_keyword,payload_json FROM rules').all().map(r => ({...r,payload:parseJson(r.payload_json)}))});
    if (req.method === 'POST' && pathname === '/api/import') {
      const imported = body || {};
      const people = Array.isArray(imported.people) ? imported.people : [];
      const capabilities = Array.isArray(imported.capabilities) ? imported.capabilities : [];
      const availability = Array.isArray(imported.availability) ? imported.availability : [];
      const outcomes = Array.isArray(imported.historical_tasks) ? imported.historical_tasks : [];
      const insertPerson = db.prepare('INSERT OR REPLACE INTO people(id,name,badge_id,team,plant,allowed_cross_line) VALUES(?,?,?,?,?,?)');
      const insertCapability = db.prepare('INSERT INTO capabilities(person_id,skill,skill_name,level,certified_until,roles_json) VALUES(?,?,?,?,?,?)');
      const insertAvailability = db.prepare('INSERT OR REPLACE INTO availability(person_id,status,area,current_task_id,can_be_interrupted,distance_meters,updated_at) VALUES(?,?,?,?,?,?,?)');
      const insertOutcome = db.prepare('INSERT OR REPLACE INTO task_outcomes(id,task_id,person_id,role,task_type,equipment_type,completed_at,within_sla,first_pass_success,rework_required,review_result,actual_duration_minutes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
      for (const p of people) if (p.id && p.name) insertPerson.run(p.id,p.name,p.badge_id||p.id,p.team||'未分组',p.plant||'杭州一厂',p.allowed_cross_line?1:0);
      for (const c of capabilities) if (c.person_id && c.skill) insertCapability.run(c.person_id,c.skill,c.skill_name||c.skill,Number(c.level||1),c.certified_until||'2099-12-31',json(c.roles||[]));
      for (const a of availability) if (a.person_id) insertAvailability.run(a.person_id,a.status||'available',a.area||'未知',a.current_task_id||null,a.can_be_interrupted?1:0,Number(a.distance_meters||9999),a.updated_at||now());
      for (const h of outcomes) if (h.id && h.person_id) insertOutcome.run(h.id,h.task_id||h.id,h.person_id,h.role||'repair_owner',h.task_type||'equipment_incident',h.equipment_type||null,h.completed_at||now(),h.within_sla?1:0,h.first_pass_success?1:0,h.rework_required?1:0,h.review_result||'passed',Number(h.actual_duration_minutes||0));
      return send(200,{ok:true,imported:{people:people.length,capabilities:capabilities.length,availability:availability.length,historical_tasks:outcomes.length}});
    }
    if (req.method === 'POST' && pathname === '/api/tasks') {
      if (!body.raw_text?.trim()) return send(400, {error:'raw_text 必填'});
      const id = `task_${randomUUID().slice(0,8)}`; const timestamp = now();
      db.prepare('INSERT INTO tasks(id,raw_text,source,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, body.raw_text.trim(), body.source || 'manual', 'draft', body.created_by || 'demo_leader', timestamp, timestamp);
      addEvent(id, 'task_created', body.created_by || 'demo_leader', {raw_text: body.raw_text.trim()});
      return send(201, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id)));
    }
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(.*))?$/);
    if (taskMatch) {
      const taskId = taskMatch[1]; const action = taskMatch[2] || '';
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      if (!task) return send(404, {error:'任务不存在'});
      if (req.method === 'GET' && !action) return send(200, serializeTask(task));
      if (req.method === 'POST' && action === 'parse') {
        const parsed = await parseWithDeepSeek(task.raw_text);
        db.prepare('UPDATE tasks SET status=?,parsed_json=?,updated_at=? WHERE id=?').run('parsed', json(parsed), now(), taskId);
        addEvent(taskId, 'task_parsed', deepseekEnabled ? 'deepseek' : 'mock-parser', {parsed, model_mode: deepseekEnabled ? 'deepseek' : 'mock'});
        const spec = dispatchSpec({...task, id:taskId}, parsed);
        db.prepare('UPDATE tasks SET status=?,dispatch_spec_json=?,updated_at=? WHERE id=?').run('awaiting_dispatch', json(spec), now(), taskId);
        addEvent(taskId, 'rule_retrieved', 'rules-v1', {rule_id: spec.id, version: spec.version});
        const candidates = candidatesFor({...task, task_type: parsed.task_type}, spec);
        db.prepare('DELETE FROM candidate_snapshots WHERE task_id=?').run(taskId);
        const insertCandidate = db.prepare('INSERT INTO candidate_snapshots(id,task_id,person_id,role,eligible,rank,reasons_json,excluded_by_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
        for (const c of candidates) insertCandidate.run(randomUUID(), taskId, c.person_id, c.role, c.eligible ? 1 : 0, c.rank, json(c.reasons), json(c.excluded_by), now());
        addEvent(taskId, 'candidate_filtered', 'dispatch-engine', {candidate_count: candidates.length, eligible_count: candidates.filter(c=>c.eligible).length});
        return send(200, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)));
      }
      if (req.method === 'POST' && action === 'dispatch') {
        if (task.status !== 'awaiting_dispatch') return send(409, {error:`当前状态 ${task.status} 不能下发`});
        const personIds = Array.isArray(body.person_ids) ? body.person_ids : [];
        const candidates = db.prepare('SELECT * FROM candidate_snapshots WHERE task_id=? AND eligible=1').all(taskId);
        const selected = candidates.filter(c => personIds.includes(c.person_id));
        const spec = parseJson(task.dispatch_spec_json, {});
        for (const required of (spec.required_roles || []).filter(r=>r.required)) if (!selected.some(c=>c.role === required.role)) return send(400, {error:`缺少必需角色：${required.role}`});
        transition(taskId, 'inviting', 'demo_leader', {person_ids: personIds});
        const insert = db.prepare('INSERT OR IGNORE INTO invitations(id,task_id,person_id,role,status,sent_at) VALUES(?,?,?,?,?,?)');
        for (const c of selected) { insert.run(randomUUID(), taskId, c.person_id, c.role, 'pending', now()); addEvent(taskId, 'candidate_invited', 'dispatch-engine', {person_id:c.person_id,role:c.role}); }
        return send(200, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)));
      }
      if (req.method === 'POST' && action.match(/^invitations\/[^/]+\/respond$/)) {
        const personId = action.split('/')[1]; const invitation = db.prepare('SELECT * FROM invitations WHERE task_id=? AND person_id=?').get(taskId, personId);
        if (!invitation) return send(404, {error:'邀请不存在'});
        const status = body.response === 'accepted' ? 'accepted' : 'rejected';
        db.prepare('UPDATE invitations SET status=?,reason=?,responded_at=? WHERE id=?').run(status, body.reason || null, now(), invitation.id);
        addEvent(taskId, status === 'accepted' ? 'candidate_accepted' : 'candidate_rejected', personId, {reason:body.reason || null});
        const invites = db.prepare('SELECT * FROM invitations WHERE task_id=?').all(taskId);
        if (invites.filter(i=>i.status==='accepted').length >= 2 && task.status === 'inviting') transition(taskId, 'forming_team', 'system', {accepted_count:2});
        return send(200, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)));
      }
      if (req.method === 'POST' && action === 'team/form') {
        if (task.status !== 'forming_team') return send(409, {error:`当前状态 ${task.status} 不能组队`});
        const accepted = db.prepare("SELECT * FROM invitations WHERE task_id=? AND status='accepted'").all(taskId);
        const teamId = `team_${randomUUID().slice(0,8)}`; db.prepare('INSERT INTO teams(id,task_id,formed_at) VALUES(?,?,?)').run(teamId, taskId, now());
        const addMember = db.prepare('INSERT INTO team_members(team_id,person_id,role) VALUES(?,?,?)'); for (const i of accepted) addMember.run(teamId, i.person_id, i.role);
        addEvent(taskId, 'team_formed', 'system', {team_id:teamId, members:accepted.map(i=>i.person_id)});
        return send(200, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)));
      }
      if (req.method === 'POST' && action === 'check-in') {
        if (task.status !== 'forming_team') return send(409, {error:'任务尚未完成组队'});
        transition(taskId, 'in_progress', body.person_id || 'badge-simulator', {location:body.location || '设备 NFC'}); addEvent(taskId, 'task_started', body.person_id || 'badge-simulator', {location:body.location || '设备 NFC'}); return send(200, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)));
      }
      if (req.method === 'POST' && action === 'complete') {
        if (task.status !== 'in_progress') return send(409, {error:'任务当前不可完成'});
        transition(taskId, 'pending_review', body.person_id || 'badge-simulator', {notes:body.notes || '设备恢复生产'}); addEvent(taskId, 'task_completed', body.person_id || 'badge-simulator', {notes:body.notes || null}); return send(200, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)));
      }
      if (req.method === 'POST' && action === 'review') {
        if (task.status !== 'pending_review') return send(409, {error:'当前不在待复核状态'});
        if (body.passed === false) { transition(taskId, 'in_progress', body.reviewer_id || 'demo_leader', {review_result:'failed'}); addEvent(taskId, 'review_failed', body.reviewer_id || 'demo_leader', {notes:body.notes || null}); return send(200, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId))); }
        transition(taskId, 'completed', body.reviewer_id || 'demo_leader', {review_result:'passed'}); const team = db.prepare('SELECT * FROM team_members WHERE team_id=(SELECT id FROM teams WHERE task_id=? ORDER BY formed_at DESC LIMIT 1)').all(taskId); const parsed = parseJson(task.parsed_json, {}); const insertOutcome = db.prepare('INSERT INTO task_outcomes(id,task_id,person_id,role,task_type,equipment_type,completed_at,within_sla,first_pass_success,rework_required,review_result,actual_duration_minutes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'); for (const m of team) insertOutcome.run(randomUUID(), taskId, m.person_id, m.role, parsed.task_type || 'equipment_incident', parsed.equipment?.split(' ')[0] || '绷缝机', now(), 1, body.first_pass_success === false ? 0 : 1, body.rework_required ? 1 : 0, 'passed', Number(body.actual_duration_minutes || 8)); addEvent(taskId, 'review_passed', body.reviewer_id || 'demo_leader', {outcome_recorded:true}); return send(200, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)));
      }
      if (req.method === 'POST' && action === 'rematch') {
        if (!['awaiting_dispatch','inviting'].includes(task.status)) return send(409, {error:'当前状态不能重新匹配'});
        db.prepare('DELETE FROM invitations WHERE task_id=?').run(taskId); if (task.status === 'inviting') transition(taskId, 'awaiting_dispatch', 'demo_leader', {reason:'manual_rematch'}); const parsed = parseJson(task.parsed_json, {}); const spec = parseJson(task.dispatch_spec_json, {}); const candidates = candidatesFor({...task, task_type:parsed.task_type}, spec); db.prepare('DELETE FROM candidate_snapshots WHERE task_id=?').run(taskId); const insert = db.prepare('INSERT INTO candidate_snapshots(id,task_id,person_id,role,eligible,rank,reasons_json,excluded_by_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)'); for (const c of candidates) insert.run(randomUUID(), taskId, c.person_id, c.role, c.eligible ? 1 : 0, c.rank, json(c.reasons), json(c.excluded_by), now()); addEvent(taskId, 'candidate_filtered', 'dispatch-engine', {manual_rematch:true}); return send(200, serializeTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId)));
      }
    }
    const personMatch = pathname.match(/^\/api\/people\/([^/]+)\/history$/);
    if (req.method === 'GET' && personMatch) { const person = db.prepare('SELECT * FROM people WHERE id=?').get(personMatch[1]); if (!person) return send(404,{error:'人员不存在'}); return send(200, {person, capabilities:capabilitiesFor(person.id), metrics:metricsFor(person.id), history:db.prepare('SELECT * FROM task_outcomes WHERE person_id=? ORDER BY completed_at DESC').all(person.id)}); }
    return send(404, {error:'接口不存在'});
  } catch (error) { return send(500, {error:error.message || '服务器错误'}); }
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? path.join(__dirname, '..', '第一版技术方案_Demo.html') : null;
  if (!target) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); fs.createReadStream(target).pipe(res);
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}); return res.end(); }
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`); let body = {};
  if (req.method === 'POST') { try { const chunks=[]; for await (const chunk of req) chunks.push(chunk); body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { res.writeHead(400, {'Content-Type':'application/json'}); return res.end(JSON.stringify({error:'请求体必须是 JSON'})); } }
  if (parsedUrl.pathname.startsWith('/api/')) return handleApi(req, res, parsedUrl.pathname, body);
  return serveStatic(req, res, parsedUrl.pathname);
});
server.listen(port, '127.0.0.1', () => console.log(`Dispatch Agent MVP listening on http://127.0.0.1:${port}`));
