# 第 15 周：RAG 进阶 + 引用溯源

> 所属阶段：RAG + 评估 + 记忆 + MCP + 安全 + 国产生态（第 14–19 周）

## 本周目标

掌握 Hybrid 混合检索、重排序、Adaptive RAG 动态策略与引用溯源，并建立用 Precision / Recall / F1 / nDCG 量化评估检索质量的体系。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | Hybrid RAG：稠密 + 稀疏检索 | 用 BM25 + 向量检索做混合检索，对比单一检索效果 | Hybrid 检索 |
| Day 2 | 重排序（Re-ranking） | 用 Cross-Encoder 或 Cohere Rerank 对检索结果重排 | 重排序模块 |
| Day 3 | Adaptive RAG：查询分类 + 动态权重 | 判断查询类型（事实型/分析型），动态调整检索策略 | Adaptive 检索 |
| Day 4 | 引用溯源：返回来源文档片段 | 在回答中标注 `[来源1]`，前端展示可点击的引用卡片 | 引用溯源 UI |
| Day 5 | RAG 评估：Precision/Recall/F1/nDCG | 用 10 个测试问题计算检索指标，对比优化前后 | 评估报告 |
| Day 6 | 前端知识库管理界面 | 在 Next.js 中实现“上传文档 + 查看已上传列表” | 知识库 UI |
| Day 7 | 周复盘 + 整理 | 整理 RAG Pipeline 架构图，写周记 | 架构图 + 周记 |

## 教程进度

- ✅[Day 1 路 Hybrid 检索](/week15/day1)
- ✅[Day 2 路 重排序](/week15/day2)
- ✅[Day 3 路 Adaptive RAG](/week15/day3)
- ✅[Day 4 路 引用溯源](/week15/day4)
- ✅[Day 5 路 RAG 评估](/week15/day5)
- ✅[Day 6 路 知识库 UI](/week15/day6)
- ✅[Day 7 路 周复盘](/week15/day7)

## 本周参考

pgvector RAG Lab 包含 Hybrid RAG、Adaptive RAG、Agentic RAG 的完整实现。第 15 周 Day 5 的检索指标是评估的冰山一角——下周系统学习 Agent 评估工程，这是当前 JD 点名率最高的稀缺技能。
