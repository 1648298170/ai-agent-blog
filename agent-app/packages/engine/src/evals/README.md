# 读代码前先读这篇：Agent 为什么需要评估，评测框架怎么工作

> 本目录解决 Agent 的"好坏怎么量化"问题。Agent 能跑 ≠ Agent 好——改了 prompt、
> 换了模型、加了工具之后，"感觉回答变好了"不是工程结论，76 个用例的全绿才是
> （18 条离线确定性 + 50 条检索 + 8 条评审，后两档有 key 时自动加跑）。
> 与 `rag/`、`memory/` 同一套工程哲学：
> **离线优先**——Tier 1 套件零依赖零网络零 key，`pnpm eval` 任何机器上确定性跑通；
> Tier 2 检索套件与 Tier 3 评审套件需要 API key，有 key 自动加跑、无 key 整套跳过
> （跳过 ≠ 失败）。配合教程 [week16 · Agent 评估工程](../../../../../docs/archive/weeks/week16/index.md)
> 与 [week15 · 检索质量指标](../../../../../docs/archive/weeks/week15/index.md)（Recall@k / MRR 已在 P2 落地）。

---

## 一、第一性原理：没有评估，每一次改动都是在赌博

Agent 系统的每次变更——改 system prompt、换 embedding 模型、调工具描述、升级 SDK——
都可能让某个场景悄悄变坏（比如工具描述改一句话，模型开始在该闲聊时调工具）。
人工点几个 case 看看 = 抽检两个产品就发货。评估体系把"感觉"换成"数字"：

1. **谁来判对错？**（评分器——先从确定性断言做起）
2. **拿什么判？**（golden dataset——版本化的期望答案集）
3. **变坏怎么拦？**（基线比对 + 退出码——已落地：本地基线门禁 + CI 的 Tier 1 门禁 job）

行业现状：89% 团队有可观测性（看得见 Agent 在干嘛），只有 52% 做离线评估
（知道它干得好不好）。评估是 Agent 工程里最稀缺的工程能力。

## 二、核心设计：三档评分器，Tier 1 确定性打底，Tier 2 检索门控加跑

| 档位 | 评分器 | 判什么 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| Tier 1 | `trajectory.ts` | 工具调用序列是否与期望逐位一致 | 零（`ai/test` 剧本模型） | ✅ P1 |
| Tier 1 | `routing.ts` | 客服路由是否走了该走的分支 | 零（硬规则纯函数） | ✅ P1 |
| Tier 2 | `retrieval.ts` | 期望文档是否进 top-k（Recall@k / MRR） | GLM embedding | ✅ P2 |
| Tier 3 | `judge.ts` | 回答质量（rubric 二元判定，教程 Day 2） | GLM chat | ✅ P3 |

**为什么先做确定性档**：Tier 1 断言的是"确定性可复现"的事实（调没调工具、路由去哪），
不依赖模型发挥，离线可跑、CI 可跑、失败必可复现。Tier 2/3 依赖真实模型，
属于"有 key 时加跑的增强档"——与 selftest 的压缩成功/降级双路径同一分层思想。
P2 落地后这条分层长这样：检索套件开工前先探测 key（`loadEnv` 会从磁盘读 `.env`，
不能只看 `process.env`），没有就把 50 条用例全部记进 `skipped` + 中文修复指引，
**退出码仍是 0**——环境缺失不是代码失败，CI 在无 key 机器上跑 `pnpm eval` 不会被误拦。
P3 的评审套件沿用同一探测与同一三态门控（8 条用例，见下文"评审套件的设计"）。

### 最容易困惑的一点：模型是剧本，评的是什么？

轨迹评估里模型**不是真的 GLM**，而是 `ai/test` 的 `MockLanguageModelV2` 按剧本逐轮吐
tool-call / 文本。那评的意义在哪？三件事都是真的：

1. **`runToolLoop` 是真的**——多步循环、工具调度、结果回灌、入账，走的是生产同一条代码路径
2. **`onStep` 观测链路是真的**——SSE 流式端点靠它出 Thought/Action 面板，评测靠它采集轨迹，
   评的正是这条观测链路的正确性
3. **评分器是真的**——序列比对、空序列特判、报告生成，P2/P3 复用同一套 `EvalReport` 管线

剧本模型解决的是"把**模型的不确定性**从评测里剔出去"：Tier 1 要的是每次跑结果完全一致。
真实模型的评估（该调工具时调不调）属于 Tier 2/3 的活。

## 三、文件地图（13 个文件）

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 契约：`EvalCase` 判别联合（trajectory/routing/retrieval/judge）、`EvalResult`、`EvalReport` |
| `fixtures.ts` | 评测夹具：三个确定性测试工具 + `createScriptedModel()` 剧本模型工厂 |
| `dataset.ts` | golden dataset v3：18 个中文客服场景离线 case + 8 个 judge 评审 case（TS fixture，git 即版本管理） |
| `corpus.ts` | 检索语料库（P2）：10 篇主题互斥的政策文档 + 50 条查询（rtv-01..rtv-50） |
| `scorers/trajectory.ts` | 工具序列逐位比对；**空序列特判**：期望不调工具却调了 = 0 分 |
| `scorers/routing.ts` | 路由断言：`null` 期望 = 硬规则应放行（软路由留给模型，P3 接 LLM） |
| `scorers/retrieval.ts` | 检索打分（P2）：单例 = 命中排名倒数；套件级 Recall@1/3/5 与 MRR |
| `scorers/judge.ts` | 评审打分（P3）：rubric 二元判定 + 严格 JSON prompt + 宽松解析；`scoreJudge` 评「判得准不准」 |
| `runner.ts` | `runEvals()`：逐 case 跑真实管线，单例失败不炸整轮（错误变该例 FAIL）；检索/评审套件按 key 三态门控 |
| `report.ts` | `[PASS]/[FAIL]` 逐例 + 汇总表 + 检索指标行 + `.data/eval-report.json` 落盘 |
| `baseline.ts` | 回归基线（P3）：报告压成套件级数字快照，跌幅 >3% 或通过率回退 → 违规 |
| `index.ts` | 桶导出（`@agent-app/engine/evals` 子路径的公共面） |
| `README.md` | 本文 |

## 四、数据从哪来：golden dataset

全套 golden 数据 = **18 离线（`dataset.ts` 的 `EVAL_CASES`）+ 50 检索（`corpus.ts` 的 `EVAL_QUERIES`）+ 8 评审（`dataset.ts` 的 `EVAL_JUDGE_CASES`）= 76 例**，当前 `EVAL_DATASET_VERSION = "3"`。

`dataset.ts` 里 18 个离线 case 就是教程 week16 Day 1 说的 **golden dataset v0**：

- **轨迹 10 例**：查物流（2 种问法）、投诉建单、搜订单→查物流两连、搜不到→建单降级，
  以及 3 个**负例**（"你好"、"谢谢"、"问营业时间"——期望空工具序列，闲聊不许碰工具）
- **路由 8 例**：转人工/投诉/高危关键词/两轮未解决 → 期望 `human`；
  普通查询/退款咨询/制度问答 → 期望 `null`（硬规则不该劫持）

**怎么加新 case**：往 `EVAL_CASES` 数组追加一条即可——轨迹 case 需要写 `script`
（模型逐轮剧本，必须以 text 轮收尾，否则循环不出口）+ `expectedToolCalls`；
路由 case 给 `state` + `expectedTarget`。加完跑 `pnpm eval`，全绿才算数据集合法。

**P2 的检索数据长什么样（`corpus.ts`）**：`EVAL_CORPUS` 是 10 篇 300~600 字的
中文政策文档，主题两两刻意互斥（退货退款 vs 售后保修、配送时效 vs 配送范围运费——
最容易在向量空间里糊在一起的正是这些邻居）；`EVAL_QUERIES` 是 50 条查询
（`rtv-01`..`rtv-50`），每篇文档至少 4 条覆盖，难度三档混排：直问（政策名出现）、
间接转述（只说症状，如「买完不想要了怎么办」→ 退货退款政策）、邻接对抗
（查询里出现别的主题词但答案仍是本主题，如「用优惠券买的订单退款后券会返还吗」
→ 优惠券使用规则）。语料即标准答案：recall@3 不达标时先怀疑语料主题不够
互斥、转述不够真实，改语料必须升 `EVAL_DATASET_VERSION`。

**P3 的评审数据长什么样（`dataset.ts` 的 `EVAL_JUDGE_CASES`）**：8 条用例
（`judge-01`..`judge-08`），每条 = 用户问题 + **预写好的候选回答** + rubric 条目
+ 期望判定。回答是预写的：judge 只评审、不生成，判定结论可以确定性地归因到
数据集（哪条回答满足了哪些条目是人可以逐条核对的事实）。6 条正例是满足全部
rubric 条目的好回答（物流查询含单号/承运/预计送达、退款含时效与原路退回……），
2 条负例是明确违反条目的坏回答——`judge-07` 编造了平台没有的全场包邮政策、
`judge-08` 纯客套话零可执行信息。负例就是教程 Day 2「judge 校准」的落地点：
只会说「通过」的好好先生评审员会在负例上当场露馅。

## 五、跑法与退出码

```bash
pnpm eval                       # agent-app 根目录跑：全绿退出 0，有失败退出 1
pnpm cli eval                   # 等价（cli 路由）
pnpm cli eval --trace           # 追加引擎 trace 输出（▶⚙✓ 逐事件），调试用
pnpm eval --update-baseline     # 把本轮结果存为回归基线（见第七节）
```

报告三份产物：控制台逐例标记、suite 汇总表（检索套件会多一行
`retrieval 指标: recall@1=… recall@3=… recall@5=… mrr=…`；评审套件是普通的一行
`judge n/n`）、`.data/eval-report.json`（机器可读，基线比对在 CLI 里直接用内存中
的同一份 report 对象，不回读这份 JSON）。
无 key 机器上检索/评审套件（50 + 8 条）整体进 skipped 并打印跳过原因——
跳过 ≠ 失败，退出码仍为 0；只有「执行了的用例出现失败」才退出 1。

## 六、评审套件的设计：二元判定与「宁可误杀」

教程 week16 Day 2 的核心结论：**judge 先做二元判定，不做数字打分**。
「给回答打 1~10 分」的评审员会漂移（同一份回答今天 8 分明天 6 分，分数没有
可复现的锚点），而「rubric 条目是否全部满足」是可核对的事实。`scorers/judge.ts`
把这套设计压成四个决定：

1. **判定锚点是 rubric 条目**：prompt 协议写死「只依据 rubric 逐条核对，不得
   引入条目之外的标准——文笔、语气、篇幅一律不看」。条目渲染成**编号列表**
   而不是埋进散文（位置偏差防护：LLM 对显式编号的逐条核对远比对一段 prose
   里「顺便提一句」可靠）。
2. **宁可误杀，不可放过**：任何条目不满足、只满足一半、或评审员无法确认是否
   满足，一律判 `pass=false`。评审员「误放」（放过坏回答）的代价是线上事故，
   「误杀」（错杀好回答）的代价是报告里一眼可见的 FAIL——两害相权取其轻，
   与客服场景「高危宁可转人工」同一取向。
3. **评的是「判得准不准」，不是「回答好不好」**：`scoreJudge(expectedPass,
   verdict)` 的 passed = 判定与期望**一致**——负例判出不通过同样是过。
   这让「judge 是不是好好先生」变成可测试的断言，数据集的两个负例（judge-07
   编造政策 / judge-08 纯客套话）就是专门用来抓它的。
4. **严格 JSON 指令 + 宽松解析双保险**：输出约定为单行
   `{"pass": boolean, "reason": string}` 且禁止 markdown 围栏；解析侧复用
   `json-utils.ts` 的 `extractJson`（取第一个 `{` 到最后一个 `}`，天然容忍
   围栏与前后废话），形状不对（pass 不是 boolean）或整体不可解析 → 一律判
   `pass=false` 并在 reason 里说明——评审员没按协议回话本身就是不合格的判定。
   模型调用 temperature 0，复用引擎的 `getModel()`（与生产 chat 同一工厂，
   不另建客户端）。

单测通过 `EvalRunOptions.judgeDeps` 注入假评审员（`JudgeFn`）零网络跑通整条
编排链路；真实链路由有 key 机器上的 `pnpm eval` 行使（8 例 = 8 次模型调用，
答案预写、judge 只评审不生成）。

## 七、基线回归门禁（--update-baseline）

Tier 2/3 有了量化指标之后，教程 Day 6 的最后一环是**回归门禁**：数字比上一版
跌了才算坏，退出码拦住合并。`baseline.ts` + eval CLI 的三态用法：

```bash
pnpm eval --update-baseline   # 首次：生成 .data/eval-baseline.json（套件级数字快照）
pnpm eval                     # 之后每轮：自动比对基线，回归 → [REGRESSION] + 退出码 1
```

判定口径（只比对基线与当前**两边都有**的套件）：

- 套件 avg score 跌幅超过 `BASELINE_TOLERANCE`（0.03）→ 回归——3% 以内视为
  真实模型的正常软毛（embedding 微调、网关换版），容差 0 会让任何抖动都报警，
  报警疲劳之后没人看门禁；
- passed/total 通过率下降 → 回归（不设容差：少过一条用例就是实打实的回退，
  容差保护的是分数抖动，不是用例掉了）；
- 数据集版本不一致 → `[提示]` 基线已过期（stale），**不拦退出码**：数据集
  变了口径已对不上，比对结论仅供参考，建议重新生成。

**局限要知道：基线是 `.data/` 下的本地文件（gitignored），换机器/CI 没有
上一份基线**——它保护的是「同一台开发机上跨改动的回归」，不是团队共享的
绝对标准。团队级方案要么把基线文件提交进 git（改 `.gitignore` 一行的事），
要么等在线评估（trace 回流）落地，本阶段刻意取简。

## 八、原理 → 代码对照表（学习自测清单）

| 你应该能回答 | 对应实现 |
| --- | --- |
| 为什么不直接调真模型来评？ | 本文第二节：Tier 1 要确定性可复现；真模型评估在 Tier 2/3 |
| 评测工具为什么不用 `tools/registry.ts` 的真工具？ | `fixtures.ts` 头注释：kb-search 会打 embedding 网络，夹具工具保证零依赖；评的是循环与观测链路，不是工具实现 |
| 剧本模型怎么知道该吐第几轮？ | `createScriptedModel()` 游标逐轮推进；剧本用尽抛中文错误提示"script 未以 text 轮收尾" |
| 期望空序列怎么打分？ | `trajectory.ts` 特判：`matched/0` 无定义 → 没调 = 1 分，调了 = 0 分 |
| 一个 case 跑挂了会怎样？ | `runner.ts`：错误变成该例的 FAIL（detail 带修复指引），其余 case 照跑 |
| 路由评估为什么不用跑整个客服 Agent？ | `supervisor.ts` 的硬规则是导出的纯函数，`checkHardRules(state)` 直接可测——确定性层不需要 LLM |
| 检索套件无 key 为什么是跳过而不是失败？ | `runner.ts` 三态门控：环境缺失 ≠ 代码失败，`skipped` 与 `failed` 分开计数，退出码不受跳过影响 |
| 检索套件的 avg score 为什么等于 MRR？ | `scorers/retrieval.ts`：单例 score = 1/rank，倒数排名的平均就是平均倒数排名 |
| judge 为什么评「判得准不准」而不是「回答好不好」？ | 第六节：`scoreJudge` 的 passed = 判定与期望一致，负例判出不通过也是过——否则好好先生评审员无法被抓住 |
| judge 输出不按 JSON 回话怎么办？ | `scorers/judge.ts` 宽松解析：extractJson 抠对象 + 形状校验，失败一律 pass=false（宁可误杀） |
| 基线为什么存套件级均值而不是整份报告？ | `baseline.ts` 头注释：对单例噪声免疫、文件小到可以 code review；逐用例真相在 eval-report.json |
| 基线文件损坏了会怎样？ | `loadBaseline` 抛带修复指引的中文错误（删除后 --update-baseline 重建）；CLI 报错但本轮评测照常出结论 |
| 退出码为什么要非 0？ | CI 门禁靠退出码阻断合并（week16 Day 6）；本地基线 + CI 退出码共同构成回归闸 |

## 九、推荐学习顺序（约 2 小时）

| 步骤 | 文件 | 学什么 | 通关标准 |
| --- | --- | --- | --- |
| 0 | 本文 | 三档分层 + 剧本模型的意义 | 能回答第八节 13 问 |
| 1 | `types.ts` | 评测的四种数据形状（case/result/report） | 能说出 EvalReport 里五个字段各自给谁用 |
| 2 | `dataset.ts` + `corpus.ts` | golden dataset 与检索语料库长什么样、怎么扩 | 自己加一个 case 并跑绿 |
| 3 | `fixtures.ts` | 剧本模型工厂 + 夹具工具 | 能解释 `doGenerate` 游标与"剧本用尽"错误 |
| 4 | `scorers/` | 四个评分器（轨迹/路由/检索/评审）的口径差异 | 能说出空序列特判、null 路由、倒数排名、二元判定的语义 |
| 5 | `runner.ts` + `report.ts` | 采集 → 打分 → 汇总的管线 | 能说出"单例失败不炸整轮"与"无 key 整套 skipped"的实现位置 |
| 6 | `scorers/judge.ts` | rubric 二元判定 + 严格 JSON / 宽松解析 | 能解释「宁可误杀」与负例的校准作用 |
| 7 | `baseline.ts` + eval CLI | 回归门禁三态与容差口径 | 能说出哪些变化会拦退出码、哪些只是提示 |
| 8 | ✋ 动手 | 破坏性实验：把 traj-05 的期望改成 `["query_logistics"]` 再跑 | 亲眼看到 [FAIL] + 退出码 1，再改回来 |

## 十、扩展路线（接口已留缝）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P1 | 框架 + Tier 1 确定性套件 | ✅ 已实现 |
| P2 | `scorers/retrieval.ts`：Recall@k / MRR + 固定评测语料库（`corpus.ts`，10 篇文档 + 50 query），key 门控（无 key → skipped，退出码不受影响） | ✅ 已实现 |
| P3 | `scorers/judge.ts`（rubric 二元判定 + 8 条黄金评审用例）+ `baseline.ts` 回归门禁（跌幅 >3% 或通过率回退 → 退出码非 0）+ CI `evals` job（Tier 1 门禁） | ✅ 已实现 |
| 在线评估 | 教程 Day 7：10% 流量采样 + trace 回流数据集（需要生产流量，列为路线图） | ⏳ |

**CI 门禁只覆盖 Tier 1**：`.github/workflows/agent-app.yml` 的 `evals` job 跑
`pnpm eval`，但 CI 不配 key——检索/评审套件自动跳过（跳过 ≠ 失败），实际拦住
合并的只有轨迹/路由 18 条确定性用例；基线是 `.data` 本地文件也不进 CI。
要提覆盖率就把 key 配成 GitHub Secret（成本与安全自负），本阶段刻意保持零
Secret 的最小形态。

**为什么自建而不引 promptfoo/DeepEval**（教程 Day 4/5 用的就是它们）：本项目从
agent-loop 起就是"手写理解原理"路线。评估的本质只有四步——**数据集 → 跑测 → 打分 →
基线比对**——自建几个文件就能吃透；promptfoo/DeepEval 作为行业工具对照阅读，
不进依赖。等真实项目需要多模型矩阵、红队扫描时，再按需引入不迟。
