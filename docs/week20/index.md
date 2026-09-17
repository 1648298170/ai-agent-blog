# 第 20 周：全栈整合 + 平台主链路

> 所属阶段：全栈整合 + 生产化 + 面试冲刺（第 20–23 周）

## 本周目标

参考 full-stack-ai-agent-template 完成平台主链路整合：NestJS BFF 层、多租户 RBAC、统一认证贯通、流式对话 UI 与统一导航。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | full-stack-ai-agent-template 结构分析 | 用 Configurator 生成一个项目，读 `backend/app/` 和 `frontend/` 结构 | 模板分析笔记 |
| Day 2 | 把 NestJS BFF 接入模板 | 用 NestJS 做 BFF，代理前端请求到 FastAPI Agent 服务 | BFF 层 |
| Day 3 | 多租户 + RBAC 整合 | 在 BFF 层实现基于 tenant 的数据隔离和角色权限 | 多租户就绪 |
| Day 4 | 统一认证：NextAuth / JWT 贯通 | 前端登录 → BFF 鉴权 → Agent 服务信任 BFF 传入的用户上下文 | 认证贯通 |
| Day 5 | 流式对话 + 思考过程展示 | 前端展示 Agent 的 Thought/Action/Observation 折叠面板（可复用第 11 周的 AI SDK + assistant-ui 组件库加速） | 对话 UI 升级 |
| Day 6 | 平台导航 + 页面整合 | 把对话、知识库、工具管理、监控整合到统一导航 | 平台主链路 |
| Day 7 | 周复盘 + 整理 | 走一遍“登录 → 对话 → RAG → 工具审批”完整流程，写周记 | 流程验证 + 周记 |

## 教程进度

- ✅[Day 1 · 模板结构分析](/week20/day1)
- ✅[Day 2 · NestJS BFF](/week20/day2)
- ✅[Day 3 · 多租户 RBAC](/week20/day3)
- ✅[Day 4 · 统一认证](/week20/day4)
- ✅[Day 5 · 流式对话 UI](/week20/day5)
- ✅[Day 6 · 平台导航整合](/week20/day6)
- ✅[Day 7 · 周复盘](/week20/day7)
