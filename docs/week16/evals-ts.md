# 主线补篇 · 自建 TS 评估框架：把「感觉变好了」换成 76 个用例的数字

> 衔接：[Day 1](/week16/day1) 给了方法论——评估是测分，不是单测；[Day 4](/week16/day4) 的 promptfoo 和 [Day 5](/week16/day5) 的 DeepEval 走的是配置化、Python 系的行业工具路线；[Day 6](/week16/day6) 把评估钉进了 CI。本篇做纯 TS 的落地：不引任何评估框架，在 agent-app 的 `packages/engine/src/evals/` 里把同一套方法论手写一遍——这套框架真实存在、跑过真实模型、门禁真实在 CI 上值守。[第 11 周补篇](/week11/agent-loop-ts)手写工具循环时立过一条原则：黑盒拆一次，受用到毕业；评估框架同样配得上拆一次，因为它的本质只有四步：数据集 → 跑测 → 打分 → 基线比对。读者默认走完 TS 主线前十五周和本周前六天，正要把评估搬进自己的 TS 项目。读完的检验标准只有一条：不装 promptfoo 也不装 DeepEval，你能徒手搭出「三档评分器 + key 门控 + 基线门禁」的最小评估闭环，并说清每一档为什么存在。

## 为什么自建：评估的本质只有四步

先回答最容易被问的问题：教程 Day 4/5 刚教完 promptfoo 和 DeepEval，为什么 agent-app 不用？因为本项目从 [手写工具循环](/week11/agent-loop-ts) 起就是「手写理解原理」路线——promptfoo 的 YAML 和 DeepEval 的 pytest 用例，拆到底就是四步：**准备一批带标准答案的用例（数据集）、把它们跑过真实管线（跑测）、拿期望比对实际（打分）、跟上一版的成绩单比跌没跌（基线比对）**。这四步自建十来个 TS 文件就能吃透；行业工具作为对照阅读，不进依赖。等真实项目需要多模型矩阵、红队扫描时再引入不迟——那是它们的主场，不是入门评估的主场。

动机不是造轮子玩。[Day 1](/week16/day1) 摆过行业现状：绝大多数团队有可观测性（看得见 Agent 在干嘛，第 21 周的 LangSmith/Langfuse 就是干这个的），只有一半做离线评估（知道它干得好不好）。差的那一半，差的就是这四步。Agent 系统的每次变更——改 system prompt、换 embedding 模型、调一句工具描述——都可能让某个场景悄悄变坏，人工点几个 case 等于抽检两个产品就发货。评估体系把「感觉」换成「数字」，四步各自落在框架里就是一个文件：

| 四步 | 文件 | 干什么 |
| --- | --- | --- |
| 数据集 | `dataset.ts` + `corpus.ts` | 76 例 TS 固定夹具：18 离线 + 50 检索 + 8 评审 |
| 跑测 | `runner.ts` | 逐例跑**真实**引擎管线，产出 `EvalReport` |
| 打分 | `scorers/` 四件套 | 轨迹逐位比对 / 路由断言 / Recall@k / rubric 二元判定 |
| 基线比对 | `baseline.ts` | 套件级数字快照，跌了拦退出码 |

`types.ts` 把用例定义成判别联合（`suite` 字段做标签），TS 窄化保证轨迹用例取不到检索的 `expectedDocId`、评审用例取不到轨迹的 `script`——四种「对」的判定方式完全不同，硬塞进一个平面结构会逼出四个永远只有一个有意义的可选字段互相打架。

## Tier 1：剧本模型把不确定性剔出评测

三档评分器里，Tier 1 是地基：**零依赖、零网络、零 key，CI 可跑、失败必可复现**。它断言的是确定性事实——模型选了哪些工具、按什么顺序调、路由去了哪。

最容易被困惑的问题是：轨迹评估里模型根本不是真的 GLM，评的意义在哪？答案是被测系统的边界划在哪。评测要穿透**真的** `runToolLoop`——多步循环、工具调度、结果回灌、消息入账，走的全是生产同一条代码路径——只把最外端的「模型」换成剧本。`ai/test` 的 `MockLanguageModelV2` 就是官方提供的这道接缝：类型与真实模型完全同构（`LanguageModelV2`），协议形状漂移在编译期就暴露。夹具换的是环境，不是被测系统：

```ts
// fixtures.ts（精简）：把剧本变成一个「模型」
export function createScriptedModel(script: ScriptedModelTurn[]): LanguageModel {
  let cursor = 0; // 游标：第几次被调用，就吐第几轮
  return new MockLanguageModelV2({
    doGenerate: async () => {
      const index = cursor;
      cursor += 1;
      const turn = script[index];
      if (turn === undefined) {
        throw new Error(
          `评测脚本用尽：模型第 ${index + 1} 次被调用，但脚本只编排了 ${script.length} 轮。` +
            "请检查 dataset 中该用例的 script——工具轮之后必须编排一个 text 轮作最终回答，工具循环才有出口。",
        );
      }
      if (turn.kind === "text") {
        return { content: [{ type: "text", text: turn.text }], finishReason: "stop",
                 usage: ZERO_USAGE, warnings: [] };
      }
      return {
        content: turn.calls.map((call, i) => ({
          type: "tool-call" as const,
          toolCallId: `eval-call-${index}-${i}`, // SDK 用它对账
          toolName: call.toolName,
          input: JSON.stringify(call.input),     // 协议要求字符串化 JSON
        })),
        finishReason: "tool-calls", usage: ZERO_USAGE, warnings: [],
      };
    },
  });
}
```

runner 拿它驱动真实循环，轨迹的「实际值」全靠 `onStep` 观测钩子采集——这条钩子就是 SSE 流式端点出 Thought/Action 面板用的同一条，评的正是这条观测链路的正确性：

```ts
// runner.ts（精简）：只有模型是假的，循环、调度、观测全是真的
const steps: ToolLoopStepEvent[] = [];
await runToolLoop({
  model: createScriptedModel(testCase.script),
  messages: [{ role: "user", content: testCase.userMessage }],
  tools: createEvalTools(),       // 夹具工具：固定假数据，无网络
  system: EVAL_SYSTEM_PROMPT,
  maxSteps: 5,
  onStep: (event) => steps.push(event),
});
const { passed, score, detail } = scoreTrajectory(testCase.expectedToolCalls, steps);
```

打分器是严格的位置对齐比对——先搜单再查物流 ≠ 先查物流再搜单，顺序错了结果就错了（没单号就去查物流是必挂的空查询）：

```ts
// scorers/trajectory.ts（精简）
const matched = expected.reduce((count, name, i) => count + (actual[i] === name ? 1 : 0), 0);
const passed = expected.length === actual.length && expected.every((name, i) => actual[i] === name);
// 空序列特判：matched/0 在数学上无定义——不许调却调了 = 0 分，忍住了 = 满分
const score = expected.length === 0 ? (actual.length === 0 ? 1 : 0) : matched / expected.length;
```

路由套件更干脆：Supervisor 的硬规则 `checkHardRules(state)` 本来就是导出的纯函数，直接喂状态断言出口，零 LLM 调用。这里有个精心设计的 null 语义：期望 `human` = 硬规则必须命中转人工；期望 `null` = 硬规则必须**放行**（null 表示交给模型分类——本层只断言「不误伤」，模型怎么分是 Tier 3 的事）。null 对 null 是过，human 对 human 是过，任何错位不过；路由是单选判定，不存在 0.6 个「转对了」，分数只有 1 和 0。

**坑一：剧本 mock 是无状态的。** 第一版剧本模型里 `doGenerate` 每次返回同一个响应——于是第一步要了工具、结果回灌后第二次调用**又要同一个工具**，`maxSteps` 耗尽循环抛错，用例全军覆没。mock 函数没有「这是第几轮」的概念，而真实模型的每一轮都是看着完整历史现场决策的。修复就是上面那行 `let cursor = 0`：记调用轮次，剧本逐轮推进，每个用例编排一段完整的「工具轮们 + text 收尾轮」。引擎测试里同款接缝的写法更直观——`doGenerateCount === 1 ? toolCallResponse(...) : textResponse(...)`，两段剧本，第一次要工具、第二次给答案。顺带一提，那个「脚本用尽」的中文报错不是装饰：它一定是数据集编排漏了 text 收尾轮，错误信息直接告诉维护者去哪修。

## golden dataset：TS 文件即版本管理

数据集 76 例，当前 `EVAL_DATASET_VERSION = "3"`：18 条离线（`dataset.ts`，10 轨迹 + 8 路由）+ 50 条检索查询（`corpus.ts`）+ 8 条 judge 判例（`dataset.ts`）。为什么用 TS 固定夹具而不是外部 JSON？三条理由：**类型即护栏**（工具名填错、script 缺 text 收尾，`pnpm typecheck` 当场标红，不用等跑挂）；**版本化随代码走**（改用例 = 改代码 = 过 code review，版本号显式升版，历史报告可追溯）；**零 IO**（不读文件就没有路径/编码/并发问题）。

数据长这样（[Day 1](/week16/day1) 说的 golden dataset v0 落地物）：

```ts
// dataset.ts（节选）：一个双工具正例 + 一个空序列负例
{
  caseId: "traj-04",
  description: "忘单号：先按手机尾号搜订单再查物流（双工具序列）",
  userMessage: "我不记得订单号了，手机尾号 6688 名下有什么订单？帮我查最新的物流",
  script: [
    { kind: "tool-calls", calls: [{ toolName: "search_orders", input: { keyword: "6688" } }] },
    { kind: "tool-calls", calls: [{ toolName: "query_logistics", input: { orderId: "A-1024" } }] },
    { kind: "text", text: "您名下最新一笔是订单 A-1024（9 月 25 日下单）：已发货……" },
  ],
  expectedToolCalls: ["search_orders", "query_logistics"],
},
{
  caseId: "traj-05", // 负例：开场问候，一步工具都不该调
  userMessage: "你好",
  script: [{ kind: "text", text: "您好！请问有什么可以帮您？" }],
  expectedToolCalls: [],
}
```

注意三个负例（「你好」「谢谢」「问营业时间」）不是凑数。[Day 1](/week16/day1) 的坑 1 说透了：只挑表现好的对话，数据集全绿看着舒服，测不出任何问题。闲聊场景调工具是过度行动——费时费钱还答非所问，负例守住的正是这条底线，也是空序列特判存在的原因。

Tier 2 的语料库是另一份标准答案：`corpus.ts` 里 10 篇 300~600 字的中文政策文档，主题两两**刻意互斥**（退货退款 vs 售后保修、配送时效 vs 配送范围运费——最容易在向量空间里糊在一起的正是这些邻居）；50 条查询每篇至少 4 条覆盖，难度三档混排：直问（政策名出现）、间接转述（只说症状，「买完不想要了怎么办」→ 退货退款政策）、邻接对抗（查询里出现别的主题词但答案仍是本主题，「用优惠券买的订单退款后券会返还吗」→ 优惠券规则而不是退货政策）。语料即标准答案：recall 不达标时先怀疑语料主题不够互斥、转述不够真实——改语料就是改标准答案，必须升 `EVAL_DATASET_VERSION`。

## Tier 2/3：有 key 加跑，无 key 跳过

Tier 2 检索套件评真实 embedding + 余弦检索（默认智谱 GLM 网关 embedding-3）。打分刻度用倒数排名：期望文档排第 1 名得 1.0、第 2 名 0.5、未命中 0；**通过线定在 top-3**（`EVAL_RELEVANCE_K = 3`）——客服场景检索完要拼进 prompt，top-3 之外的块基本进不了答案。于是有个漂亮的性质：单例 score = 1/rank，套件的 avg score 数学上恰好等于 MRR（平均倒数排名），汇总表和指标行是同一口径的两种读法——正是 [第 15 周](/week15/) Recall@k / MRR 那套指标的落地。跑法上还有笔经济学账：语料切块 + 50 条查询全部批量向量化（embedder 内部 32 条一批），整轮约 3 次 embedding API 调用，而不是 60 次单条往返。

Tier 3 评审套件是 [Day 2](/week16/day2) LLM-as-judge 的落地，两个关键决定都值得抄：

**判定锚点是 rubric 条目，不是主观标尺。**「给回答打 1~10 分」的评审员会漂移——同一份回答今天 8 分明天 6 分，分数没有可复现的锚点；「条目是否全部满足」是可核对的事实。所以 rubric 全部写成短的可核对陈述（「回答必须包含订单号 A-1024」「不得承诺平台没有的加急退款服务」），条目渲染成**编号列表**而非埋进散文（LLM 对显式编号的逐条核对远比 prose 里「顺便提一句」可靠），system prompt 写死评审协议：只看 rubric、不看文笔语气篇幅，**任何条目不满足、只满足一半、无法确认，一律判不通过——宁可误杀，不可放过**。取向和客服「高危宁可转人工」同构：误放（放过坏回答）的代价是线上事故，误杀的代价只是报告里一眼可见的 FAIL。

**评的是「判得准不准」，不是「回答好不好」。**回答是数据集里预写的，judge 只评审不生成；`scoreJudge` 的 passed = 判定与期望**一致**——负例判出不通过同样是过。这让「judge 是不是好好先生」变成可测试的断言：8 例 = 6 正例 + 2 负例，`judge-07` 编造了平台没有的全场包邮政策、`judge-08` 纯客套话零可执行信息，一个只会说「通过」的评审员在这两条上当场露馅。输出协议约定单行 JSON、禁围栏，解析侧却宽松（复用 `extractJson` 抠第一个 `{` 到最后一个 `}`）——但形状不对一律判不通过：评审员没按协议回话，本身就是不合格的判定。模型调用 temperature 0，复用引擎的 `getModel()` 工厂，不另建客户端。

两档共同的三态门控是工程上最务实的一笔。`EvalRunOptions` 里 `embeddingAvailable` / `judgeAvailable`：单测显式传 `false` 走跳过路径或注入假实现（假评审员、假 embed）零网络跑通链路；CLI 裸调用则自动探测配置里的 key（`loadEnv` 会从磁盘读 `.env`，不能只看 `process.env`）。无 key 时 50 + 8 条整体进 `skipped` 并打印中文修复指引——**跳过 ≠ 失败**：`total` 只数实际执行的用例，退出码按 `passed === total` 判，环境缺失不把整轮评测打成失败。单例也兜错：一条用例抛错记成该例 FAIL + 修复指引，其余照跑——评测报告的价值在「全貌」，一个坏用例把整轮掐了，你只知道有错，不知道错多少。

::: tip 跑法
`agent-app` 根目录：`pnpm eval` 全绿退出 0、有失败退出 1；`pnpm cli eval --trace` 追加引擎逐事件轨迹调试用；`pnpm eval --update-baseline` 见下节。报告三份产物：控制台逐例 `[PASS]/[FAIL]`（纯 ASCII，Windows 老终端、CI 日志、grep 管道都稳定识别）+ 分套件汇总表（检索套件多一行 `recall@1/3/5、mrr`）+ `.data/eval-report.json` 机器可读留档。
:::

配 key 实测一轮的数字：**recall@3 = 1.000，MRR = 0.990，76/76 全绿**——judge 真实调用 8 次（每例一次，答案预写、只评审不生成，账单可控到个位数）。

## 基线门禁与 CI：数字跌了才算坏

[Day 6](/week16/day6) 的最后一环是回归门禁：单轮全绿只说明「此刻没病」，改动之后比上一版**跌了**才算坏。`baseline.ts` 的取舍很清晰：

```ts
// baseline.ts 的三道判据（精简）
if (base.avgScore - now.avgScore > BASELINE_TOLERANCE) { /* 回归：avg score 跌超 3% */ }
if (nowRatio < baseRatio) { /* 回归：通过率下降，零容差 */ }
if (baseline.datasetVersion !== report.datasetVersion) { /* stale 提示，不拦退出码 */ }
```

三个口径三种性格。**分数容差 3%**：Tier 2/3 依赖真实模型，本来就有软毛（embedding 微调、网关换版），容差 0 等于任何抖动都报警，报警疲劳之后没人看门禁。**通过率零容差**：容差保护的是分数抖动，不是用例掉了——少过一条用例就是实打实的回退。**版本不一致只提示**：数据集变了口径已对不上，比对结论仅供参考，建议重建基线，但不拦退出码。基线存的是套件级均值快照而非整份报告：对单例噪声免疫（一条用例网络抖动慢 300ms 也会出现在整份报告的 diff 里），文件小到可以直接 code review；逐用例真相在 `eval-report.json`，两份文件各管各的时段。局限也诚实写着：基线是 `.data/` 下的本地文件（gitignored），它保护的是「同一台开发机上跨改动的回归」，团队级方案要么把基线提交进 git，要么等在线评估（[Day 7](/week16/day7) 的 trace 回流）落地。

CI 侧 `.github/workflows/agent-app.yml` 的 `evals` job 刻意保持**零 Secret** 的最小形态：

```yaml
evals:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    # …pnpm install + build，同 test job…
    - name: 评测套件（Tier 1 门禁；无 key 时 Tier 2/3 跳过）
      run: pnpm eval
      working-directory: agent-app
```

CI 不配 key → 检索/评审套件自动跳过（跳过 ≠ 失败，退出码 0）→ 实际拦住合并的只有轨迹/路由 18 条确定性用例。这套「无 key 优雅降级」设计让门禁在任何仓库都能开箱启用；要提覆盖率就把 key 配成 GitHub Secret（成本与安全自负），覆盖率与保密性自己权衡。

**坑二：并行测试共享 PG，确定性碎了。**评测与基建集成测试同住 engine 的 vitest 里，infra 套件共用同一个真实 PG——并行的测试文件会在共享表上互相插数据，「先数一行、跑一段、再数一行」的相对计数断言在 before 与 count 之间被别的文件插了几块，偶发红。这类「十次里挂一次」的 flaky 比必挂难缠十倍，因为它污染的是你对整套测试的信任。修复一行配置：`fileParallelism: false` 串行化文件执行——全套件两秒不到，并行省下的时间可忽略，换回确定性。评估的第一原则是可复现，这条原则首先要约束评估基建自己。

## 自测 5 题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 轨迹评估里模型是假的（剧本吐的），评的意义在哪？说出三样「是真的」的东西，以及剧本模型到底剔出去的是什么。

::: details 参考答案
真的是：`runToolLoop` 循环本身（调度、回灌、入账走生产代码路径）、`onStep` 观测链路（SSE 面板与评测采集共用）、评分器与报告管线。剔出去的是模型的不确定性——Tier 1 要的是每次跑结果完全一致、失败必可复现，「该调工具时调不调」这类真模型行为属于 Tier 2/3 的活。
:::

2. traj-05 这类「期望空序列」的负例为什么必须存在？打分器对 0/0 做了什么特判？

::: details 参考答案
负例守住「闲聊不许碰工具」的底线——过度行动费时费钱还答非所问；没有负例的数据集全绿看着舒服，测不出「工具描述改一句、模型开始乱调工具」这类退化。特判：matched/0 在数学上无定义，业务含义明确——不许调却调了 = 0 分，忍住了 = 满分。
:::

3. 检索套件的 avg score 为什么恰好等于 MRR？通过线为什么定在 top-3 而不是 top-5？

::: details 参考答案
单例 score = 命中排名的倒数（1/rank），倒数排名的算术平均就是平均倒数排名（MRR）——同一口径的两种读法，不是巧合。top-3 是业务口径：客服检索完要拼进 prompt 喂模型，top-3 之外的块基本进不了答案也浪费上下文；检索窗口取 top-5 只是让 recall@5 与「差一点就进 top-3」的退化（0.25/0.2 的分数）在指标里可见。
:::

4. judge 评分器评的是「判得准不准」而不是「回答好不好」——两个负例（judge-07/08）在其中起什么作用？judge 输出不是合法 JSON 会怎样？

::: details 参考答案
scoreJudge 的 passed = 判定与期望一致，负例判出不通过同样是过。没有负例，一个只会说「通过」的好好先生评审员能拿满分——judge-07（编造全场包邮政策）、judge-08（纯客套话）就是专门抓它的校准用例。输出不合法 JSON：宽松解析（extractJson 抠对象）失败或 pass 字段不是 boolean，一律判 pass=false 并在 reason 里说明——评审员没按协议回话本身就是不合格的判定，宁可误杀。
:::

5. CI 的 evals job 一个 secret 都没配，为什么还能当门禁？基线比对里哪两种变化拦退出码、哪种只提示？

::: details 参考答案
门禁的分母是「实际执行的用例」：无 key 时检索/评审套件整体进 skipped，跳过 ≠ 失败，退出码按 passed === total 判——Tier 1 的 18 条确定性用例照常执行，红一个就非零退出拦住合并。拦退出码的：套件 avg score 跌幅超 3%（BASELINE_TOLERANCE）、通过率下降（零容差）。只提示的：数据集版本不一致（stale，口径对不上，比对仅供参考）。另外基线里有、本轮缺席的套件（无 key 跳过）不比对——环境缺失不是代码回归。
:::

---

promptfoo 和 DeepEval 留着当对照：哪天你需要多模型矩阵或红队扫描，它们的名字会再次出现；但在那之前，评估的骨架你已经亲手写过一遍——四步、三档、一个退出码。[Day 7](/week16/day7) 的在线评估（采样回流数据集）是这套框架的下一块拼图。本周其余安排见[本周日程](/week16/)。
