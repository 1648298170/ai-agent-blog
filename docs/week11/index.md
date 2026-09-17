# 第 11 周：LLM API 基础 + 结构化输出 + Vercel AI SDK

> 所属阶段：Python + FastAPI + Agent 核心（第 9–13 周）

## 本周目标

不依赖任何框架手写 LLM API 的多轮对话、流式输出与 function calling 完整循环，再用 Vercel AI SDK 重写一遍并对比抽象层次，同时掌握 Qwen / DeepSeek / GLM 多供应商模型切换。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | LLM API 原生调用：messages 结构、system prompt、temperature/top_p/max_tokens | 不用任何框架，用官方 SDK 写一个多轮对话 CLI，手动维护 messages 历史 | `raw-chat.py` |
| Day 2 | 流式响应与 Function Calling 底层协议：chunk/delta/finish_reason、tools/tool_calls 完整调用链 | 手写流式输出 + 手动实现一次完整的 function calling 循环（不依赖任何框架封装） | `raw-fc-loop.py` |
| Day 3 | 结构化输出：JSON Schema 约束（response_format 严格模式）、Pydantic 解析与失败重试 | 实现“用户评论 → 结构化情感分析结果”接口，验证 Schema 符合率 100% | 结构化输出模块 |
| Day 4 | Vercel AI SDK 后端：streamText、工具循环、ToolLoopAgent | 用 AI SDK 重写第 10 周的 `/chat/stream`，对比手写 SSE 的代码量 | AI SDK 版流式接口 |
| Day 5 | AI SDK 前端：useChat、数据流协议、流式 Markdown 渲染、needsApproval 工具审批 | 用 `useChat` 重写第 10 周的前端对话页，加一个需用户批准才执行的工具按钮 | AI SDK 版对话页面 |
| Day 6 | 多供应商切换：OpenAI 兼容协议、Qwen/DeepSeek/GLM API、模型选型与成本特性 | 把 Day 1 的 CLI 改造成支持 3 家模型热切换（只改 base_url），做一张同题成本对比表 | 多模型 CLI + 成本表 |
| Day 7 | 周复盘 + 整理 | 画一张“裸 API → AI SDK → LangGraph”抽象层次图，标注每层帮你解决了什么问题，写周记 | 抽象层次图 + 周记 |

## 教程进度

- ✅[Day 1 · LLM 原生 API](/week11/day1)
- ✅[Day 2 · 流式与 FC 底层](/week11/day2)
- ✅[Day 3 · 结构化输出](/week11/day3)
- ✅[Day 4 · AI SDK 后端](/week11/day4)
- ✅[Day 5 · AI SDK 前端](/week11/day5)
- ✅[Day 6 · 多供应商切换](/week11/day6)
- ✅[Day 7 · 周复盘](/week11/day7)

## 本周参考

AI SDK 月下载量 2000 万+，已是 TS 侧 AI 全栈的事实标准；Qwen/DeepSeek/GLM 均兼容 OpenAI 协议，替换 base_url 即可切换。先手写裸 API 再上框架，面试讲底层原理不慌。
