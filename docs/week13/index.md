# 第 13 周：多 Agent 协作 + Human-in-the-Loop

> 所属阶段：Python + FastAPI + Agent 核心（第 9–13 周）

## 本周目标

掌握 Supervisor / Worker 多 Agent 协作架构，用 `interrupt()` 实现 Human-in-the-Loop 人工审批中断，并完成前端审批 UI 与错误容错处理。

阶段三里程碑要求——确认：Python + LLM API + 结构化输出 + FastAPI + LangGraph + ReAct + 工具调用 + 多 Agent + HITL 全链路。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | 多 Agent 模式：Supervisor / Worker、Peer-to-Peer | 设计一个“客服 Agent + 订单 Agent + 退款 Agent”的协作架构 | 架构图 |
| Day 2 | Supervisor Agent 实现 | 用 LangGraph 实现一个 Supervisor 节点，根据用户意图路由到不同 Worker | Supervisor Graph |
| Day 3 | Worker Agent 实现 + 工具集成 | 为订单 Agent 接入“查订单”工具，为退款 Agent 接入“发起退款”工具 | 两个 Worker |
| Day 4 | Human-in-the-Loop：`interrupt()` | 在退款 Agent 调用“发起退款”前插入 `interrupt()`，等待人工确认 | 可中断 Agent |
| Day 5 | 前端审批 UI | 在 Next.js 中展示待审批的工具调用，用户点击“批准/拒绝”后恢复 Graph | 审批界面 |
| Day 6 | 错误处理 + 重试 + 超时 | 为工具调用加 try/catch 和超时，失败时让 Agent 决定重试或告知用户 | 容错 Agent |
| Day 7 | 阶段三里程碑验收 + 周复盘 | 确认：Python + LLM API + 结构化输出 + FastAPI + LangGraph + ReAct + 工具调用 + 多 Agent + HITL 全链路 | 里程碑项目 v3 + 周记 |

## 教程进度

::: info 教程编写中
本周教程尚未发布，请先对照上方日程表配合手册学习，或从[第 1 周教程](/week01/)开始。
:::

## 本周参考

多 Agent 协作是 LangGraph 的核心应用场景，8 周学习方案中 W4 专门讲多 Agent 协作。
