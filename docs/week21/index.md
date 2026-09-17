# 第 21 周：生产化 + 可观测性 + 成本控制

> 所属阶段：全栈整合 + 生产化 + 面试冲刺（第 20–23 周）

## 本周目标

掌握 LangSmith / Langfuse 全链路追踪、token 成本计量与按意图的模型路由，并实现限流、死循环防御、语义缓存等生产化能力，通过压测验证。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | LangSmith Tracing 接入 + OTel GenAI 规范与 Langfuse 开源替代 | 配置 `LANGCHAIN_TRACING_V2` 查看 Trace 树；再用 Docker 自托管一个 Langfuse，对比两者数据模型 | Trace 可视化 |
| Day 2 | Token 计量 + 成本追踪 + 模型路由/级联 | 写装饰器累计每次 LLM 调用的 token 和成本存库；再实现按意图分类的模型路由：简单问题走小模型、复杂问题走大模型 | 成本追踪 + 模型路由 |
| Day 3 | 限流 + 配额 + 异常防御 | 在 BFF 层实现基于 Redis 的限流，Agent 层加超时和重试上限 | 限流中间件 |
| Day 4 | 死循环防御 + 最大步数控制 | 在 LangGraph 中设置 `recursion_limit`，超限时优雅终止 | 死循环防御 |
| Day 5 | 日志 + 指标 + 告警 | 把 Agent 的 Trace ID 注入日志，Prometheus 暴露 token/cost 指标 | 可观测性面板 |
| Day 6 | 性能优化：语义缓存 | 用 pgvector 做语义缓存，相同意图的查询直接返回缓存结果 | 缓存命中 |
| Day 7 | 周复盘 + 整理 | 压测 100 次并发对话，观察延迟和成本，写周记 | 压测报告 + 周记 |

## 教程进度

- ✅[Day 1 路 LangSmith 与 Langfuse](/week21/day1)
- ✅[Day 2 路 Token 计量与模型路由](/week21/day2)
- ✅[Day 3 路 限流配额](/week21/day3)
- ✅[Day 4 路 死循环防御](/week21/day4)
- ✅[Day 5 路 日志指标告警](/week21/day5)
- ✅[Day 6 路 语义缓存](/week21/day6)
- ✅[Day 7 路 压测复盘](/week21/day7)

## 本周参考

LangSmith 可将每次调用组织为结构化 Trace 树，包含检索、重排、生成、工具调用等节点。
