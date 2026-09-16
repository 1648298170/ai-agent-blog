# 第 19 周：Agent 安全 + A2A + 国产生态

> 所属阶段：RAG + 评估 + 记忆 + MCP + 安全 + 国产生态（第 14–19 周）

## 本周目标

掌握 Prompt Injection 攻防与 OWASP Agentic AI Top 10 安全自查，理解 A2A 协议与 MCP 的分层关系，并用 Dify / Coze 复刻 Agent 输出平台选型决策。

阶段四里程碑要求——确认：RAG + 评估 + 记忆 + MCP + 安全 + 国产生态全链路。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | Prompt Injection 攻防：直接注入、间接注入（工具返回值/RAG 文档投毒） | 在知识库 PDF 里藏一条注入指令，测试 Agent 是否中招，整理攻击面清单 | 注入攻防实验记录 |
| Day 2 | OWASP Agentic AI Top 10（2026）：目标劫持/工具滥用/供应链投毒/记忆污染/级联失败 | 对照 ASI01–ASI10 给第 18 周的 MCP Agent 做安全自查，标出 3 个最高风险项并给出修复方案 | 安全自查清单 |
| Day 3 | Guardrails：输入/输出过滤、工具调用策略管控、NeMo Guardrails 或自写校验中间件 | 为客服 Agent 加一层护栏：拦截注入类输入 + 输出脱敏 + 高危工具二次确认 | guardrail 中间件 |
| Day 4 | A2A 协议：与 MCP 的分层（纵向工具集成 vs 横向 Agent 协作）、Agent Card、华为/腾讯落地案例 | 画一张 MCP + A2A 组合架构图，设计两个 Agent 间 A2A 任务委托的时序图 | 协议分层架构图 |
| Day 5 | Dify 上手：工作流编排、知识库、工具接入 | 用 Dify 复刻第 13 周的“客服 + 知识库问答”Agent，对比与 LangGraph 实现的差异 | Dify 版 Agent |
| Day 6 | 低代码 vs 代码边界：Dify/Coze 能力边界、何时必须自建 | 用 Coze 搭一个同类 Bot，输出“平台选型决策树”（数据私有性/定制复杂度/维护成本三维评估） | 选型决策树 |
| Day 7 | 阶段四里程碑验收 + 周复盘 | 确认：RAG + 评估 + 记忆 + MCP + 安全 + 国产生态全链路 | 里程碑项目 v4 + 周记 |

## 教程进度

::: info 教程编写中
本周教程尚未发布，请先对照上方日程表配合手册学习，或从[第 1 周教程](/week01/)开始。
:::

## 本周参考

OWASP《Top 10 for Agentic Applications 2026》；A2A v1.0 已入驻 Linux 基金会 AAIF（华为小艺、微信已在国内落地，需求主要来自亚洲市场）；国内 JD 高频出现 Dify/Coze 关键词——定位是筛选词与加分项，深度开发能力仍以 LangGraph 为准。
