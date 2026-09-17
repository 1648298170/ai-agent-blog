# 第 16 周：Agent 评估工程

> 所属阶段：RAG + 评估 + 记忆 + MCP + 安全 + 国产生态（第 14–19 周）

## 本周目标

建立 Agent 评估工程体系：构建 golden dataset、校准 LLM-as-judge、编写 trajectory 期望轨迹，并用 promptfoo / DeepEval 把评估接入 CI 作为回归门禁。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | 评估方法论：离线/在线评估、golden dataset、error analysis 先行 | 从第 13 周客服 Agent 的对话记录挑 30 条，人工标注成功/失败并归类失败模式 | golden dataset v0 |
| Day 2 | LLM-as-judge：二元判定优于打分、rubric 设计、位置/篇幅偏差、judge 校准 | 写一个 judge prompt 给 Agent 回复判定通过/不通过，与人工标注计算一致率，迭代 rubric 直到一致率 >80% | judge 校准报告 |
| Day 3 | Trajectory 评估：工具选择/参数提取/结果利用/错误恢复/计划连贯/任务完成 6 维度 | 为 10 条 golden case 编写期望轨迹（该调哪个工具、该传什么参数），跑 Agent 对比实际轨迹差异 | trajectory 评估脚本 |
| Day 4 | promptfoo 实操：YAML 测试用例、多 prompt/多模型矩阵对比、红队插件 | 把 golden dataset 转成 promptfoo 配置，本地跑通评估 + 执行一次注入红队扫描 | `promptfooconfig.yaml` |
| Day 5 | DeepEval 实操：pytest 风格用例、G-Eval、任务完成度指标 | 用 DeepEval 给客服 Agent 写 5 个测试用例，`deepeval test run` 全绿 | `test_agent.py` |
| Day 6 | 评估进 CI：GitHub Action 集成、回归门禁、prompt/数据集版本化 | 配置 promptfoo CI：prompt 或模型变更自动跑回归，通过率跌幅 >3% 自动阻断合并 | CI 评估门禁 |
| Day 7 | 周复盘 + 整理 | 设计在线评估方案（10% 流量采样 + 差 trace 回流数据集），写周记 | 在线评估设计文档 + 周记 |

## 教程进度

- ✅[Day 1 · 评估方法论](/week16/day1)
- ✅[Day 2 · LLM-as-judge](/week16/day2)
- ✅[Day 3 · 轨迹评估](/week16/day3)
- ✅[Day 4 · promptfoo](/week16/day4)
- ✅[Day 5 · DeepEval](/week16/day5)
- ✅[Day 6 · 评估进 CI](/week16/day6)
- ✅[Day 7 · 周复盘](/week16/day7)

## 本周参考

行业调研显示 89% 团队有可观测性、却只有 52% 做离线评估、37% 做在线评估——评估是当前 Agent 工程师最被 JD 点名的稀缺技能（Ragas/DeepEval/promptfoo 高频出现）。延伸阅读：Hamel Husain《Your AI Product Needs Evals》、LangChain Academy《Building Reliable Agents》免费课程。
