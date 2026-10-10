# 08 · 评估框架：跑分说话

> 一句话：改了 prompt、换了模型，**变好还是变坏？**「感觉变好了」是幻觉——只有固定考卷上的分数能说话。
> 这个目录就是那套「考卷 + 阅卷 + 成绩单 + 往届分数线」：76 个用例、四个评分器、三档分层，
> `pnpm eval` 一条命令出报告。

---

## 它解决什么问题

Agent 系统的每次变更——改一句 system prompt、换一个 embedding 模型、调一段工具描述——
都可能让某个场景**悄悄变坏**（比如工具描述改一个词，模型开始在该闲聊时调工具）。
人工点两三个 case 看看 = 抽检两个产品就发货。

先分清两个容易混的概念：

| | 单元测试（vitest） | 评估（evals） |
|---|---|---|
| 断言什么 | **代码对不对**（函数返回值是否符合预期） | **行为好不好**（该调工具时调了吗、检索准不准、回答合规吗） |
| 判定方式 | 精确断言， deterministic | 从精确匹配到 LLM-as-judge，按题型分档 |
| 失败含义 | bug | 退化（regression）——要跟**基线**比过才知道 |

**解法**：把「感觉」换成「数字」——一份版本化的黄金数据集（考卷）、一套评分器（阅卷）、
一份报告（成绩单）、一份基线快照（往届分数线）。改动前后各跑一遍，分数跌了就是退化，
退出码非 0 拦住你。

## 核心概念（5 分钟版）

### 数据流水线：五件套 + 一份基线

```text
corpus.ts      语料/题目来源 ──┐
dataset.ts     版本化考卷（EVAL_DATASET_VERSION）──┤
fixtures.ts    夹具（假工具 + 剧本模型）──────────┤→ runner.ts 跑评测 → report.ts 报告
types.ts       契约（四种用例的形状）─────────────┤                        ↓
index.ts       桶导出 ──────────────────────────┘              baseline.ts 基线对比
```

### 判分三档（Tier）：从便宜到贵，按题型选

| 档位 | 评分器（`src/evals/scorers/`） | 判什么 | 依赖 | 用例数 |
|---|---|---|---|---|
| Tier 1 | `trajectory.ts` | 工具调用序列与期望**逐位一致**（空序列有特判：期望不调却调了 = 0 分） | 零（剧本模型） | 10 |
| Tier 1 | `routing.ts` | 客服硬规则路由去向（`expectedTarget=null` 表示「必须放行」） | 零（纯函数） | 8 |
| Tier 2 | `retrieval.ts` | 期望文档是否进 top-k（单例 score = 1/rank，**套件均值恰好等于 MRR**；另报 Recall@1/3/5） | embedding key | 50 |
| Tier 3 | `judge.ts` | rubric **二元判定**（LLM-as-judge）；`scoreJudge` 评的是「判得准不准」——负例判出不通过也算过 | chat key | 8 |

合计 **76 例**（10 + 8 + 50 + 8），数据集当前版本 `EVAL_DATASET_VERSION = "3"`。
Tier 1 零网络零 key 任何机器确定性跑通；Tier 2/3 有 key 自动加跑、无 key 整套进
skipped（**跳过 ≠ 失败**，退出码不受影响）。

### 最容易困惑的一点：模型是剧本，评的是什么？

轨迹套件里的模型**不是真的 GLM**，而是 `ai/test` 的 `MockLanguageModelV2` 按剧本逐轮吐
tool-call / 文本。意义在于三件事都是真的：`runToolLoop` 是真的（生产同一条代码路径）、
`onStep` 观测链路是真的（SSE 面板靠它）、评分器是真的。剧本模型把**模型的不确定性**
从评测里剔出去——Tier 1 要的就是每次跑结果完全一致。

---

## 代码走读（`src/evals/`，顶层 9 个文件 + `scorers/` 子目录）

| 文件 | 行数参考 | 要点 |
|---|---|---|
| `types.ts`（L33） | 195 行 | `EvalCase` 判别联合（trajectory/routing/retrieval/judge 四种用例，suite 字段做标签）+ `EvalResult` / `EvalReport`——四选一的「期望值」硬塞一个平面结构会逼出可选字段打架，判别联合让 TS 窄化保证轨迹用例取不到 `expectedTarget` |
| `dataset.ts`（L23） | 327 行 | `EVAL_DATASET_VERSION = "3"`；`EVAL_CASES` 18 条离线用例（含 3 条「期望空工具序列」的闲聊负例）；`EVAL_JUDGE_CASES` 8 条评审用例（6 正例 + 2 负例——负例专抓「好好先生评审员」） |
| `corpus.ts`（L33） | 160 行 | `EVAL_CORPUS` 10 篇主题互斥的政策文档 + `EVAL_QUERIES` 50 条查询（直问 / 间接转述 / 邻接对抗三档难度混排）——语料即标准答案，recall 不达标先怀疑语料主题不够互斥 |
| `fixtures.ts`（L29/89） | 123 行 | `createEvalTools()` 三个确定性假工具（execute 全返回固定 JSON，工单号写死 `TK-EVAL-0001`）+ `createScriptedModel()` 剧本模型工厂 |
| `runner.ts`（L274） | 372 行 | ★ `runEvals()` 总入口：Tier 1 永远全跑；Tier 2/3 按 key 三态门控；单例失败不炸整轮（错误变该例 FAIL + 中文修复指引） |
| `report.ts`（L62） | 133 行 | `printReportToConsole()` 控制台表格 + `writeReportFile()` 落盘 `.data/eval-report.json`；标记用纯 ASCII `[PASS]/[FAIL]`（Windows 老终端 / CI 日志 / grep 都稳） |
| `baseline.ts`（L28） | 181 行 | `BASELINE_TOLERANCE = 0.03`；报告压成**套件级**数字快照存 `.data/eval-baseline.json`；`compareBaseline()` 比对出违规 |
| `index.ts` | 14 行 | 桶导出（`@agent-app/engine/evals` 子路径公共面；根出口刻意不加 evals，避免业务方误依赖评测夹具） |
| `scorers/` | 子目录 | 四个评分器（见上文判分三档表）——runner 按套件分发，输出统一的 `ScorerOutput { passed, score, detail }` |

### 考卷长什么样（`dataset.ts`）

```ts
export const EVAL_DATASET_VERSION = "3";

// 轨迹用例：script 是「好模型会怎么做」的剧本，expectedToolCalls 是标准答案
{
  caseId: "traj-04",
  suite: "trajectory",
  description: "忘单号：先按手机尾号搜订单再查物流（双工具序列）",
  userMessage: "我不记得订单号了，手机尾号 6688 名下有什么订单？帮我查最新的物流",
  script: [
    { kind: "tool-calls", calls: [{ toolName: "search_orders", input: { keyword: "6688" } }] },
    { kind: "tool-calls", calls: [{ toolName: "query_logistics", input: { orderId: "A-1024" } }] },
    { kind: "text", text: "您名下最新一笔是订单 A-1024…预计明天 18 点前送达。" },
  ],
  expectedToolCalls: ["search_orders", "query_logistics"],
}
```

为什么考卷是 TS 文件而不是外部 JSON？三条理由写在 `dataset.ts` 头注：**类型即护栏**
（填错工具名 `pnpm typecheck` 当场标红）、**版本化随代码走**（改用例 = 改代码 = 过
code review，版本号显式升）、**零 IO**（不读文件就没有路径/编码/并发问题）。

### 剧本模型工厂（`fixtures.ts`，骨架）

```ts
export function createScriptedModel(script: ScriptedModelTurn[]): LanguageModel {
  let cursor = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      const turn = script[cursor]; cursor += 1;
      if (turn === undefined) {
        throw new Error(`评测脚本用尽：…请检查 script——工具轮之后必须编排一个 text 轮作最终回答`);
      }
      if (turn.kind === "text") {
        return { content: [{ type: "text", text: turn.text }], finishReason: "stop", /* … */ };
      }
      return { content: turn.calls.map((call, i) => ({
        type: "tool-call", toolCallId: `eval-call-${cursor}-${i}`,
        toolName: call.toolName, input: JSON.stringify(call.input),
      })), finishReason: "tool-calls", /* … */ };
    },
  });
}
```

游标逐轮推进；剧本用尽抛**中文错误**告诉维护者去哪修。夹具换的是环境（模型），
被测系统 `runToolLoop` 必须是真的——这是本框架的宪法。

### 门控与退出码（`runner.ts`，节选）

```ts
// Tier 2：检索套件——无 key → 整套 skipped（跳过 ≠ 失败）
const embeddingAvailable = options?.embeddingAvailable ?? hasLlmKey();
if (!embeddingAvailable) {
  skipped.push(...EVAL_QUERIES.map((testCase) => testCase.caseId));
  skipReasons.retrieval = missingKeySkipReason();   // 中文修复指引，不静默少跑
}

// total 只数实际执行的用例：CLI 按「passed === total」判退出码，
// 不能让环境缺失把整轮评测打成失败
const totals = {
  total: results.length,
  passed: results.filter((r) => r.passed).length,
  failed: results.filter((r) => !r.passed).length,
  skipped: skipped.length,
};
```

### 基线比对（`baseline.ts`，判据）

```ts
export const BASELINE_TOLERANCE = 0.03;

// 只比对基线与当前两边都有的套件
if (base.avgScore - now.avgScore > BASELINE_TOLERANCE) {
  violations.push({ suite, message: `avg score 回归：…跌幅超过 3%。…` });
}
if (nowRatio < baseRatio) {
  violations.push({ suite, message: `通过率回归：…` });   // 零容差：用例掉了就是掉了
}
if (baseline.datasetVersion !== report.datasetVersion) {
  violations.push({ suite: "dataset", stale: true, /* 提示不拦退出码 */ });
}
```

口径：分数跌 >3% 算回归（真实模型有正常软毛，容差 0 会报警疲劳）；**通过率下降零容差**
（容差保护的是抖动，不是用例掉了）；数据集版本不一致只提示不拦截。

---

## 跑起来验证（先跑再读，体感翻倍）

```powershell
cd agent-app
pnpm eval
```

无 key 机器上的输出（耗时数字为示意）：

```text
================================================================
评测报告 · 数据集 v3 · 共 76 例（通过 18 / 失败 0 / 跳过 58）· 总耗时 312ms
================================================================
[PASS] traj-01 · trajectory · score 1.000
[PASS] traj-02 · trajectory · score 1.000
...
----------------------------------------------------------------
suite          passed/total  avg score   duration
trajectory     10/10         1.000       45ms
routing        8/8           1.000       3ms
retrieval      0/0           0.000       0ms
judge          0/0           0.000       0ms
----------------------------------------------------------------
跳过说明（58 例，跳过 ≠ 失败）：
  · retrieval: 未检测到 API 密钥（OPENAI_API_KEY 为空…）
  · judge: 未检测到 API 密钥（OPENAI_API_KEY 为空…）
----------------------------------------------------------------
全部通过
报告已写入：…\agent-app\.data\eval-report.json
```

配好 `.env`（有 key）再跑：50 条检索 + 8 条评审自动加跑，汇总表多一行
`retrieval 指标: recall@1=… recall@3=… recall@5=… mrr=…`。

再试两条：

```powershell
pnpm eval --update-baseline   # 把本轮结果存为回归基线（.data/eval-baseline.json）
pnpm eval --trace             # 追加引擎 ▶⚙✓ 执行轨迹，调试用
```

之后每次 `pnpm eval` 自动比对基线：回归 → `[REGRESSION]` + 退出码 1。

评测框架自身也有单测——`packages/engine/test/evals.spec.ts`（打分器正反例 / 报告 JSON
形状 / 运行器端到端离线跑全绿），随引擎测试套件跑：

```powershell
pnpm test:engine    # vitest；注意 vitest 进程里裸调 runEvals() 时检索/评审套件「缺席」
                    # （既不跑也不记 skipped）——离线回归依赖这一点，属刻意的门控语义
```

CI 侧：博客仓库根的 `.github/workflows/agent-app.yml` 有独立 `evals` job 跑 `pnpm eval`，
但 CI 不配 key——实际拦住合并的只有 Tier 1 的 18 条确定性用例。

**诚实边界**（如实说明）：① CI 门禁只覆盖 Tier 1，Tier 2/3 在 CI 上天然缺席；② 基线是
`.data/` 本地文件（gitignored），保护的是「同一台机器上跨改动的回归」，不是团队共享标准；
③ 在线评估（生产流量采样 + trace 回流数据集）还在扩展路线（BACKLOG）上，未落地。

---

## 设计取舍（面试级追问）

| 追问 | 回答 |
|---|---|
| 为什么 Tier 1 用剧本模型而不是真模型？ | Tier 1 要确定性可复现（CI 可跑、失败必可复现）。真模型的评估（该调工具时调不调）是 Tier 2/3 的活——分层而非二选一 |
| 为什么不用 `tools/registry.ts` 的真工具？ | 真 kb-search 会打 embedding 网络，离线铁律被破；且工具名即断言对象，评测要一套语义稳定的词表，跟演示工具的命名解耦 |
| 无 key 为什么是 skipped 不是 failed？ | 环境缺失 ≠ 代码失败。`skipped` 与 `failed` 分开计数，无 key 机器上 `pnpm eval` 退出码仍为 0——CI 不会被误拦 |
| 检索套件的 avg score 为什么等于 MRR？ | 单例 score = 命中排名倒数（rank 1 → 1.0，rank 2 → 0.5），倒数排名的平均就是平均倒数排名（MRR）——两个口径天然同源 |
| judge 为什么评「判得准不准」而不是「回答好不好」？ | `scoreJudge(expectedPass, verdict)` 的 passed = 判定与期望**一致**——负例判出不通过也是过。这样「judge 是不是好好先生」变成可测试的断言 |
| 基线为什么存套件级均值而不是整份报告？ | 对单例噪声免疫、文件小到可以 code review；逐用例真相在 eval-report.json 里，两份文件各管各的时段 |
| 为什么自建而不引 promptfoo/DeepEval？ | 本项目从 agent-loop 起就是「手写理解原理」路线。评估的本质只有四步：数据集 → 跑测 → 打分 → 基线比对——自建几个文件吃透，行业工具对照阅读不进依赖 |

---

## 自测题（先凭记忆答，再看文末答案）

1. 评测和单测的区别是什么？「回归防护」靠什么机制实现？
2. 判分三档各自断言什么、依赖什么？无 key 时 `pnpm eval` 的退出码是多少、为什么？
3. 轨迹套件里模型是假的（剧本），那评的东西什么是真的？

<details><summary>答案</summary>

1. 单测断言「代码对不对」（函数级精确断言），评测度量「行为好不好」（工具轨迹 / 检索召回 /
   回答合规）。回归防护 = `pnpm eval --update-baseline` 先存套件级数字快照，之后每轮
   `compareBaseline` 比对：分数跌幅 >3% 或通过率下降 → `[REGRESSION]` + 退出码 1。
2. Tier 1 轨迹（工具序列逐位一致，零依赖）、Tier 1 路由（硬规则去向，零依赖）、
   Tier 2 检索（Recall@k / MRR，依赖 embedding key）、Tier 3 评审（rubric 二元判定，
   依赖 chat key）。无 key 时 58 条进 skipped，**退出码仍为 0**——环境缺失不是代码失败，
   只有「执行了的用例出现失败」才退出 1。
3. 三件事是真的：`runToolLoop`（生产同一份循环代码）、`onStep` 观测链路（SSE 面板同款）、
   评分器与报告管线。剧本模型只是把「模型的不确定性」从评测里剔出去，换来每次跑结果
   完全一致。
</details>

---

## 延伸阅读

- [src/evals/README.md](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/packages/engine/src/evals/README.md) ——本模块深度篇：评审套件「宁可误杀」设计、13 问自测清单、推荐学习顺序
- [ARCHITECTURE.md](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/ARCHITECTURE.md) ——整套引擎的架构图与踩坑实录（评测是其中「质量闸」一环）
- `docs/archive/weeks/week16/evals-ts.md`——教程主线的评估工程篇（`npm run docs:dev` 起博客看，仓库外层 `ai-agent-blog/docs/archive/weeks/week16/`）
- [09-service.md](./09-service.md) ——路由套件断言的 `checkHardRules` 就住在那边
- [01-agent-loop.md](./01-agent-loop.md) ——轨迹套件穿透的被测系统 `runToolLoop` 的实现讲解
