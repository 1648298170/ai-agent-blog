# 参考库 · 模块深讲

> 这一组文档是「查字典」用的模块深讲——每篇固定结构：解决什么问题 → 核心概念 → 代码走读（真实路径+行号）→ 跑起来验证 → 设计取舍 → 自测题。
> 主线课程（[guide/](/guide/)）按学习顺序组织；这里按模块组织，随查随用。

## 篇目

| 篇 | 模块 | 一句话 |
| --- | --- | --- |
| [01](./01-agent-loop.md) | agent-loop | 手写多步工具循环——全项目的心脏 |
| [02](./02-llm-config-trace.md) | llm / config / trace / json-utils | 内核三辅助 + JSON 手工坊 |
| [03](./03-tools.md) | tools | 工具箱：注册表 / 演示工具 / 幂等层 / 壳组合器 |
| [04](./04-memory.md) | memory | 三层记忆：会话 / 偏好 / 情景 |
| [05](./05-rag.md) | rag | 知识库：切块 / 向量化 / 检索 / 引用 |
| [06](./06-guardrails.md) | guardrails | 脱敏 / 防注入 / 审批 / 审计 |
| [07](./07-mcp.md) | mcp | 标准插口：server / client / adapter |
| [08](./08-evals.md) | evals | 评估框架：三档判分 / 基线对比 |
| [09](./09-service.md) | service | 客服产品线：路由 / 工人 / 转人工 |

## 源码位置

这些深讲对应的源码都在 `packages/engine/src/`（[仓库内浏览](https://github.com/1648298170/ai-agent-blog/tree/main/agent-app/packages/engine/src)），模块各自的 README 也在同目录。
