# 08 · 评估框架：跑分说话

> **这一站解决「变好还是变坏」的举证问题**：改了 prompt、换了模型，「感觉变好了」是幻觉。学完你将拥有一条五件套评估流水线、三档四评分器、76 例版本化考卷，以及一套改动前后对比基线的回归纪律。

**前置**：[02 · 手写工具循环](/guide/02-agent-loop)（`onStep` 钩子是评测采集轨迹的出口——循环那章埋的线在这收）
**配套跑起来**：`pnpm eval`（无 key 也出报告）+ `pnpm test:engine`（`test/evals.spec.ts` 覆盖打分器与运行器端到端）
**深读**：[参考库 · 评估框架深读](/reference/08-evals)（四个评分器的口径差异与 judge 校准设计）

---

## 一、为什么：单测与评估是两道检验

单测断的是**代码对不对**（入参出参、边界条件）；评估断的是**行为好不好**（该调工具时调了吗、检索命中了吗、回答达标吗）。造车的类比：单测是车间里每个零件的公差检查，评估是把整车拉到试车场跑圈计时——零件全合格的车，圈速照样可能变慢。

Agent 系统的每次变更（改 system prompt、换 embedding 模型、调工具描述、升级 SDK）都可能让某个场景悄悄变坏——比如工具描述改一句话，模型开始在该闲聊时调工具。人工点几个 case 看看 = 抽检两个产品就发货。评估体系把「感觉」换成「数字」，而且这条流水线完全自建——评估的本质只有四步：**数据集 → 跑测 → 打分 → 基线比对**，几个文件就能吃透，不需要先引框架。

## 二、核心形态：五件套流水线 + 三档评分器

`packages/engine/src/evals/` 的分工，一条线五件套：

```text
corpus(语料) → dataset(考卷) → fixtures(剧本模型) → runner(跑) → report + baseline(报告与基线)
```

| 件 | 文件 | 一句话 |
|---|---|---|
| 语料 | `corpus.ts` | 10 篇主题互斥的中文政策文档 + 50 条查询（三种难度混排） |
| 考卷 | `dataset.ts` | 18 条离线用例 + 8 条 judge 用例；`EVAL_DATASET_VERSION = "3"`——改用例必须升版 |
| 夹具 | `fixtures.ts` | 三个固定数据工具 + `createScriptedModel()` 剧本模型 |
| 运行器 | `runner.ts` | 逐 case 跑真实管线，单例失败不炸整轮 |
| 报告 | `report.ts` / `baseline.ts` | 控制台逐例标记 + `.data/eval-report.json`；套件级数字快照 |

**最容易困惑的一点：模型是剧本，评的是什么？** 轨迹评估里的模型不是真 GLM，而是 `ai/test` 的 `MockLanguageModelV2` 按剧本逐轮吐 tool-call / 文本：

```ts
// packages/engine/src/evals/fixtures.ts（节选）
export function createScriptedModel(script: ScriptedModelTurn[]): LanguageModel {
  let cursor = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      const turn = script[cursor]; cursor += 1;   // 游标逐轮推进
      // text 轮 → finishReason "stop"（循环出口）；tool-calls 轮 → "tool-calls"
    },
  });
}
```

但被测的三样东西全是真的：**`runToolLoop` 是真的**（多步调度、回灌、入账走生产同一条代码路径）、**`onStep` 观测链路是真的**（SSE 思考面板同款）、**评分器是真的**。剧本模型把「模型的不确定性」从评测里剔出去——Tier 1 要的是每次跑结果完全一致。这就是「**夹具换环境，被测系统必须是真的**」。同理，评测工具也不用真的 `tools/registry`（kb-search 会打网络），另造三个返回固定 JSON 的夹具工具——打分 100% 可复现。

**三档四评分器，从便宜到贵**：

| 档 | 评分器 | 判什么 | 依赖 |
|---|---|---|---|
| Tier 1 | `scorers/trajectory.ts` | 工具序列与期望**逐位比对**；空序列特判（期望不调、没调 = 1 分，调了 = 0 分） | 零 |
| Tier 1 | `scorers/routing.ts` | 客服路由断言；期望 `null` = 硬规则应放行（不该劫持正常业务） | 零 |
| Tier 2 | `scorers/retrieval.ts` | 期望文档进没进 top-k：单例得分 = 命中排名倒数，套件级汇总出 Recall@1/3/5 与 MRR | embedding key |
| Tier 3 | `scorers/judge.ts` | LLM rubric **二元判定**，宁可误杀不可放过 | chat key |

轨迹评分器的口径值得单独看一眼——**顺序敏感 + 部分分**：

```ts
// packages/engine/src/evals/scorers/trajectory.ts（节选）
const matched = expected.reduce((count, name, i) => count + (actual[i] === name ? 1 : 0), 0);
const passed = expected.length === actual.length && expected.every((name, i) => actual[i] === name);
const score = expected.length === 0 ? (actual.length === 0 ? 1 : 0) : matched / expected.length;
```

先搜单再查物流 ≠ 先查物流再搜单（顺序错了结果就错了）；`matched / expected.length` 的部分分让「调对了工具但顺序/多寡不对」的退化一眼可见（0.5 = 一半对）。

**76 例的构成**：18 离线（10 轨迹 + 8 路由）+ 50 检索 + 8 judge。几处设计值得细看：

- 轨迹里 3 条**负例**（「你好」「谢谢」「问营业时间」期望空工具序列）——闲聊调工具是过度行动，负例守住这条底线；
- 检索语料主题两两刻意互斥（退货退款 vs 售后保修、配送时效 vs 配送范围运费——最容易在向量空间糊在一起的正是这些邻居），查询三种难度混排：直问、间接转述（「买完不想要了怎么办」→ 退货退款政策）、**邻接对抗**（「用优惠券买的订单退款后券会返还吗」→ 优惠券规则，而不是退货退款）；
- judge 的 2 条负例（judge-07 编造平台没有的全场包邮、judge-08 纯客套话零信息）专门抓「只会说通过的好好先生评审员」。

## 三、跑起来（先体感）

```powershell
cd agent-app
pnpm eval                        # 任何机器可跑：Tier 1 确定性出报告
# 无 key 时检索/评审两档整表 skipped 并打印原因——skipped ≠ failed，退出码仍 0
pnpm eval --update-baseline      # 把本轮结果存为 .data/eval-baseline.json
pnpm eval                        # 之后再跑：自动比对基线，回归 → [REGRESSION] + 退出码 1
```

**回归防护的工作流**：改动前跑一次留基线 → 改 prompt / 换模型 → 再跑一次对比。判定口径（`baseline.ts`）：套件 avg score 跌幅超 `BASELINE_TOLERANCE`（0.03）算回归——3% 容差吸收真实模型的正常抖动；**通过率下降零容差**——少过一条用例就是实打实的回退。数据集版本不一致只提示基线过期（stale），不拦退出码。

报告长三份产物：控制台逐例 `[PASS]/[FAIL]` 标记、suite 汇总表（检索套件多一行 `recall@1=… recall@3=… mrr=…`）、`.data/eval-report.json`（机器可读）。控制台大致长这样（无 key 机器）：

```text
[PASS] traj-01 按订单号查物流（单工具）           score 1.00   12ms
[PASS] route-01 用户明确要求转人工（关键词命中）   score 1.00    0ms
[SKIP] rtv-01 直问退货退款流程 —— 未检测到 embedding key（跳过 ≠ 失败）
suite 汇总：trajectory 10/10 · routing 8/8 · retrieval skipped · judge skipped
```

想逐事件看评测在干什么：`pnpm cli eval --trace` 会追加引擎 trace（▶⚙✓ 逐事件），调试单条用例时再用。

## 四、诚实的现状清单（每一句都是取舍）

1. **无 key → skipped ≠ failed**：环境缺失不是代码失败。`runner.ts` 的三态门控把 skipped 与 failed 分开计数——只有「执行了的用例出现失败」才退出 1，CI 在无 key 机器上跑 `pnpm eval` 不被误拦（探测时 `loadEnv` 会从磁盘读 `.env`，不能只看 `process.env`）。
2. **CI 现状**：博客仓库 `.github/workflows/agent-app.yml` 的 `evals` job 跑 `pnpm eval`，但 CI 不配 key——实际拦住合并的只有 Tier 1 的 18 条确定性用例；Tier 2/3 要进 CI 得把 key 配成 GitHub Secret（成本与安全自负），本阶段刻意保持零 Secret。
3. **基线是本地 `.data` 文件不进 git**：它保护「同一台开发机跨改动的回归」，不是团队共享标准——团队级要么把基线文件提交进 git（改 `.gitignore` 一行的事），要么等在线评估。
4. **在线评估未做**：10% 流量采样 + trace 回流数据集在路线图上，需要生产流量。
5. **judge 为什么二元判定不打分**：「给回答打 1~10 分」的评审员会漂移（今天 8 分明天 6 分，分数没有可复现的锚点），「rubric 条目是否全部满足」是可核对的事实。`scoreJudge` 评的是「**判得准不准**」——负例被判不通过同样是过，这样好好先生才会露馅。
6. **为什么自建而不引 promptfoo / DeepEval**：本项目从 agent-loop 起就是「手写理解原理」路线——评估本质只有四步，自建几个文件就能吃透；行业工具作为对照阅读，不进依赖。等真实项目需要多模型矩阵、红队扫描时再按需引入不迟。

## 五、动手任务（做完才算通关）

1. `pnpm eval` 跑一遍，找到报告中 retrieval 套件的状态行，确认 skipped 的原因文案与退出码。
2. 破坏性实验：把 `dataset.ts` 里 traj-05（「你好」负例）的期望改成 `["query_logistics"]` 再跑，亲眼看到 [FAIL] + 退出码 1，然后改回原样。
3. **改造**：往 `EVAL_CASES` 追加一条你自己的轨迹用例（script 必须以 text 轮收尾，否则循环不出口），跑绿。

## 自测题（先凭记忆答，再展开）

1. 剧本模型评出来的结果有意义吗？被测的到底是什么？
2. 基线比对里，avg score 和通过率的容差为什么一个 3% 一个 0？
3. 无 key 机器上 `pnpm eval` 的退出码是多少？为什么这样设计？

<details><summary>答案</summary>

1. 有意义。夹具换的是环境（模型），被测系统是真的：`runToolLoop` 的调度回灌、`onStep` 观测链路、评分器管线全走生产代码——Tier 1 剔除的是模型的不确定性，要每次跑结果完全一致。
2. avg score 有 3% 容差：Tier 2/3 依赖真实模型，本来就有软毛（embedding 微调、网关换版），容差 0 会报警疲劳；通过率零容差：少过一条用例是实打实的回退——容差保护的是分数抖动，不是用例掉了。
3. 0。环境缺失（没 key）不是代码失败——skipped 与 failed 分开计数，只有「执行了的用例出现失败」才退出 1，否则 CI 在无 key 机器上会被误拦。

</details>

---

## 延伸

- [参考库 · 评估框架深读](/reference/08-evals) —— 评分器口径、judge 校准、基线三态的逐文件走读
- 归档周教程：[week16 · Agent 评估工程](/archive/weeks/week16/) · [week16 · 评估 TS 版](/archive/weeks/week16/evals-ts)
- 下一站：[09 · 产品线组装：客服系统](/guide/09-product) —— 零件全部验完货，总装开始
