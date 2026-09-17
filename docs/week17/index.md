# 第 17 周：记忆架构 + 上下文工程

> 所属阶段：RAG + 评估 + 记忆 + MCP + 安全 + 国产生态（第 14–19 周）

## 本周目标

掌握短期 / 长期 / 向量三层记忆架构与 Deep Agents 上下文压缩模式，把记忆整合进 LangGraph，让 Agent 在第二次对话时记得用户偏好。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | 记忆分类：短期/长期/情景/语义 | 画出三层记忆架构图：Redis（短期）+ PG（长期）+ 向量库（语义） | 记忆架构图 |
| Day 2 | 短期记忆：对话历史压缩 + Deep Agents 上下文模式（compaction、子 Agent 上下文隔离、超长工具结果卸载） | 实现“最近 N 轮 + 摘要”压缩；再实现把超长工具结果卸载到“虚拟文件”后摘要的 compaction demo | 上下文压缩模块 |
| Day 3 | 长期记忆：用户偏好存储 | 用 PostgreSQL 存用户偏好，Agent 启动时加载 | 偏好加载 |
| Day 4 | 向量记忆：情景检索 | 将历史对话 Embedding 存入向量库，新对话时检索相似情景 | 情景检索 |
| Day 5 | 上下文工程：System Prompt 设计 | 设计包含“角色 + 工具说明 + 记忆摘要 + 用户偏好”的 System Prompt 模板 | Prompt 模板 |
| Day 6 | 记忆整合到 LangGraph | 在 Agent 启动和每轮结束时自动读写记忆 | 带记忆的 Agent |
| Day 7 | 周复盘 + 整理 | 测试“用户第二次对话时 Agent 记得偏好”，写周记 | 测试记录 + 周记 |

## 教程进度

- ✅[Day 1 · 记忆架构](/week17/day1)
- ✅[Day 2 · 上下文压缩](/week17/day2)
- ✅[Day 3 · 长期记忆](/week17/day3)
- ✅[Day 4 · 向量记忆](/week17/day4)
- ✅[Day 5 · System Prompt 设计](/week17/day5)
- ✅[Day 6 · 记忆整合](/week17/day6)
- ✅[Day 7 · 周复盘](/week17/day7)
