# ToB 动态任务分发 Agent MVP

这是第一版技术方案对应的本地可运行后端。它使用 Node.js 24 的 `node:sqlite`，不需要额外安装数据库或 npm 依赖。

## 启动

```bash
cd toB/agent-backend
DISPATCH_MODEL_MODE=mock npm start
```

浏览器打开：<http://127.0.0.1:8787/>

默认使用规则型 Mock 解析器，不需要模型 key。接入 DeepSeek 时通过环境变量提供 key，不要写入代码或提交记录：

```bash
DEEPSEEK_API_KEY="你的 key" DEEPSEEK_MODEL=deepseek-chat npm start
```

只要 `DEEPSEEK_API_KEY` 存在且没有设置 `DISPATCH_MODEL_MODE=mock`，任务解析节点就会调用 DeepSeek；调用失败时 API 会返回错误，前端可以提示人工处理。

## 主要接口

- `GET /api/health`：检查服务、数据库和模型模式
- `POST /api/tasks`：创建任务，body 为 `{ "raw_text": "..." }`
- `POST /api/tasks/:id/parse`：解析任务、展开规则并生成候选快照
- `POST /api/tasks/:id/dispatch`：body 为 `{ "person_ids": [...] }`
- `POST /api/tasks/:id/invitations/:personId/respond`：接受或拒绝邀请
- `POST /api/tasks/:id/team/form`：形成临时小队并进入执行
- `POST /api/tasks/:id/check-in`：设备 NFC 到场
- `POST /api/tasks/:id/complete`：提交处理结果
- `POST /api/tasks/:id/review`：组长复核并写入历史行为数据
- `POST /api/tasks/:id/rematch`：使用最新状态重新计算候选人
- `GET /api/people/:id/history`：查看人员历史任务和派工指标
- `POST /api/import`：批量导入人员、能力、实时状态和历史任务 JSON

## 数据

首次启动会将 `data/` 下的 JSON 写入 `dispatch.sqlite`：

- `people.json`：人员身份
- `capabilities.json`：技能、等级、认证和角色
- `availability.json`：当前实时状态
- `rules.json`：规则库
- `historical_tasks.json`：历史行为样本

原始任务结果保存在 `task_outcomes`，成功率、返工率等指标在查询时根据事实记录计算，避免手工维护一个不可解释的综合分。

## 导入真实数据

可以把 JSON 组织为 `{ people: [], capabilities: [], availability: [], historical_tasks: [] }`，然后调用：

```bash
curl -X POST http://127.0.0.1:8787/api/import \
  -H 'Content-Type: application/json' \
  --data-binary @your-data.json
```
