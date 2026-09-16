# 第 12 周：LangGraph + ReAct + 工具调用

> 所属阶段：Python + FastAPI + Agent 核心（第 9–13 周）

## 本周目标

掌握 LangGraph 的 State / Node / Edge / Graph 核心概念，手写裸 ReAct 循环与 Function Calling 工具调用 Agent，并用 Checkpointer 实现可恢复的状态持久化。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | LangGraph 核心概念：State/Node/Edge/Graph | 定义 `AgentState(TypedDict)`，含 `messages` 和 `current_step` | State 定义 |
| Day 2 | 构建第一个 Graph：`StateGraph` + `compile()` | 写一个“LLM 节点 → 结束”的两节点图，跑通 | 最小 Graph |
| Day 3 | 条件边 + 路由：根据 State 决定下一步 | 实现一个“如果 messages 为空则调用 LLM，否则结束”的条件路由 | 条件路由 |
| Day 4 | ReAct 循环：Thought → Action → Observation | 用 LangGraph 实现裸 ReAct 循环，含工具调用节点 | 裸 ReAct Agent |
| Day 5 | Function Calling：定义 Tool Schema | 定义 `get_weather(city)` 工具，让 LLM 自主决定是否调用 | 工具调用 Agent |
| Day 6 | Checkpointer：状态持久化 | 用 `MemorySaver` 或 `SqliteSaver` 保存对话状态，支持恢复 | 可恢复的 Agent |
| Day 7 | 周复盘 + 整理 | 画一张 ReAct 循环的状态图，写周记 | 状态图 + 周记 |

## 教程进度

- 鉁?[Day 1 路 LangGraph 概念](/week12/day1)
- 鉁?[Day 2 路 最小 Graph](/week12/day2)
- 鉁?[Day 3 路 条件边](/week12/day3)
- 鉁?[Day 4 路 裸 ReAct](/week12/day4)
- 鉁?[Day 5 路 工具定义](/week12/day5)
- 鉁?[Day 6 路 Checkpointer](/week12/day6)
- 鉁?[Day 7 路 周复盘](/week12/day7)

## 本周参考

LangGraph 核心组件包括 State、Node、Edge、Graph，ReAct 循环是 Agent 面试的 TOP1 考点。注意：LangChain/LangGraph 1.0（2025-10）起 `langgraph.prebuilt.create_react_agent` 已废弃，官方推荐 `langchain.agents.create_agent` + middleware；本手册坚持手写裸 ReAct 循环的路线不受影响，查教程时留意 API 版本。
