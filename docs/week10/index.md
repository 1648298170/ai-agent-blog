# 第 10 周：FastAPI + SSE 流式响应

> 所属阶段：Python + FastAPI + Agent 核心（第 9–13 周）

## 本周目标

掌握 FastAPI 分层架构（router → service → repository）与 SQLAlchemy 数据库集成，并实现 SSE 流式响应及前端的逐字渲染联调，为 LLM 对话接口铺路。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | FastAPI 基础：路由、路径参数、查询参数 | 创建 `/health` 和 `/users/{id}` 两个端点 | 可运行的 FastAPI |
| Day 2 | Pydantic 请求体 + 响应模型 | 实现 `/users` 的 POST，用 Pydantic 校验请求体 | 带校验的 POST |
| Day 3 | FastAPI 分层架构：router → service → repository | 把用户操作拆到 `services/user_service.py`，router 只做参数转发 | 分层清晰 |
| Day 4 | SQLAlchemy 2.0 基础（Engine/Session/ORM 模型）+ 依赖注入 `Depends` | 定义 `User` ORM 模型，用 `Depends` 注入 session 实现数据库查询 | DI 可用 |
| Day 5 | SSE 流式响应：`StreamingResponse` | 写一个 `/chat/stream` 端点，逐字返回一段文本 | 流式端点 |
| Day 6 | 前端消费 SSE：React + `EventSource` 或 `fetch` 流 | 在 Next.js 中写一个组件消费 SSE，逐字渲染 | 前后端流式联调 |
| Day 7 | 周复盘 + 整理 | 用 curl 和浏览器分别测 SSE，写周记 | 测试记录 + 周记 |

## 教程进度

- ✅[Day 1 路 FastAPI 入门](/week10/day1)
- ✅[Day 2 路 请求响应模型](/week10/day2)
- ✅[Day 3 路 分层架构](/week10/day3)
- ✅[Day 4 路 SQLAlchemy 与 DI](/week10/day4)
- ✅[Day 5 路 SSE 流式](/week10/day5)
- ✅[Day 6 路 前端消费 SSE](/week10/day6)
- ✅[Day 7 路 周复盘](/week10/day7)

## 本周参考

Udemy 的 FastAPI 30 天路线中 Week 1 是基础路由，Week 2 是 Pydantic，Week 3 是数据库集成。进入框架之前，下周先吃透裸 LLM API——后面 LangGraph 的所有"魔法"都是那周内容的封装。
