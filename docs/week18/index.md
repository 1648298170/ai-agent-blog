# 第 18 周：MCP 协议 + 工具生态

> 所属阶段：RAG + 评估 + 记忆 + MCP + 安全 + 国产生态（第 14–19 周）

## 本周目标

掌握 MCP 协议的 Client / Server 模型，实现工具与资源的暴露、LangGraph 集成、输入输出安全护栏与审批 UI 升级，形成可复用的 MCP 工具接入清单。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | MCP 协议概念：Client/Server、Resources/Tools/Prompts | 画出 MCP 架构图，理解“Agent 作为 Client，业务 API 作为 Server” | MCP 架构图 |
| Day 2 | MCP Server 实现：暴露一个 Tool | 用 MCP SDK 写一个 `get_order_status(orderId)` 工具 | MCP Server |
| Day 3 | MCP Client 集成到 LangGraph | 让 LangGraph Agent 通过 MCP Client 调用 Day 2 的工具 | MCP 工具调用 |
| Day 4 | MCP Resources：暴露数据源 | 把知识库文档作为 MCP Resource 暴露，Agent 可读取 | Resource 集成 |
| Day 5 | 安全护栏：输入输出验证 + PII 脱敏 | 为 MCP 工具调用加输入校验和输出脱敏 | 安全中间件 |
| Day 6 | 工具审批 UI 升级 | 把第 13 周的审批 UI 扩展到 MCP 工具 | MCP 审批 |
| Day 7 | 周复盘 + 整理（阶段四里程碑移至第 19 周） | 整理 MCP 工具接入清单与调用链笔记，为下周 Agent 安全自查做准备 | MCP 笔记 + 周记 |

## 教程进度

::: info 教程编写中
本周教程尚未发布，请先对照上方日程表配合手册学习，或从[第 1 周教程](/week01/)开始。
:::

## 本周参考

AgentForge 的 MCP Client/Server 集成可作为代码级参考；`agent-service-toolkit` 的 MCP 深度集成值得研读。注意：MCP 规范 2026-07-28 版已改为**无状态协议**（移除 initialize 握手、引入 Header 路由与 Tasks 扩展，Roots/Sampling 已列入废弃计划），看教程时留意规范版本，概念图按新规范画。
