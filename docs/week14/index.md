# 第 14 周：RAG Pipeline 基础

> 所属阶段：RAG + 评估 + 记忆 + MCP + 安全 + 国产生态（第 14–19 周）

## 本周目标

掌握 RAG 全流程（文档解析 → 切块 → Embedding → pgvector 向量存储 → 相似度检索），端到端跑通"上传 PDF → 提问 → 返回答案"的最小 RAG 应用。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | RAG 概念 + Naive RAG 流程 | 画出“文档 → 切块 → Embedding → 检索 → 生成”的流程图 | RAG 流程图 |
| Day 2 | 文档解析：PDF/Markdown/TXT | 用 `pypdf` 或 `unstructured` 解析一份 PDF 文档 | 文本提取脚本 |
| Day 3 | 文本切块策略：固定长度、递归、语义 | 实现递归切块，对比固定切块的检索效果 | 切块模块 |
| Day 4 | Embedding：OpenAI / 开源模型 | 用 OpenAI Embedding API 将切块转为向量 | Embedding 脚本 |
| Day 5 | pgvector 安装 + 向量存储 | 在 PostgreSQL 中启用 `pgvector` 扩展，创建 `documents` 表存向量 | pgvector 就绪 |
| Day 6 | 相似度检索：余弦距离 + Top-K | 实现“给定问题，检索最相似的 5 个切块” | 检索函数 |
| Day 7 | 周复盘 + 整理 | 端到端跑通“上传 PDF → 提问 → 返回答案”，写周记 | 最小 RAG + 周记 |

## 教程进度

- ✅[Day 1 路 RAG 概念](/week14/day1)
- ✅[Day 2 路 文档解析](/week14/day2)
- ✅[Day 3 路 文本切块](/week14/day3)
- ✅[Day 4 路 Embedding](/week14/day4)
- ✅[Day 5 路 pgvector](/week14/day5)
- ✅[Day 6 路 相似度检索](/week14/day6)
- ✅[Day 7 路 周复盘](/week14/day7)

## 本周参考

pgvector RAG Lab 提供了从 Naive RAG 到 Hybrid RAG 的渐进式实验。
