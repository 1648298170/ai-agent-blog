# 第 16 周 · Day 2：LLM-as-judge——让 LLM 替你判卷

> 对应手册任务：学习「LLM-as-judge：二元判定优于打分、rubric 设计、位置/篇幅偏差、judge 校准」，动手写一个 judge prompt 给 Agent 回复判定通过/不通过，与人工标注计算一致率，迭代 rubric 直到一致率 >80%，当日产出 judge 校准报告。本篇只解决一个问题：30 条数据人工标一次可以，但每次改 prompt、换模型都要重标不行——把判分交给 LLM，再用你昨天的人工标注当尺子，把它的判定校准到和你一致为止。

## 今日目标

1. 说得清 judge 解决什么问题，以及为什么二元判定比 1-5 打分稳定得多
2. 会写 rubric：把「高质量」翻译成可观察、可验证的具体行为，让 judge 输出结构化的 `{verdict, reason}`
3. 独立跑完校准闭环：judge 判昨天那 30 条、与人工标注算一致率和混淆矩阵、迭代 rubric 到一致率 >80%

## 概念讲解：为什么需要 judge

昨天你标完了 30 条 golden dataset，[本周](/week16/)的计划刚走完第一步。今天早上你把客服 Agent 的 prompt 改了一版，问题立刻来了：新版比旧版好还是差？最直接的办法是把 30 条重新跑一遍 Agent，再人工标一遍，20 分钟没了。下午你想试个新模型，再标一遍。明天数据集扩到 300 条呢？人工判分卡在你一个人身上，评估永远追不上你改代码的手。

LLM-as-judge 的想法就在这：判「这条客服回复合不合格」本身是个语言理解任务，LLM 能干。让它读用户问题和 Agent 回复，按一套规则给出通过或不通过。30 条几秒钟，300 条几分钟，改完随跑随比，你睡觉它也能判。

但天真地直接问「这个回答质量如何？请打 1-5 分」会翻车。你拿同一条回复让 judge 打两次分，一次 4 分一次 2 分，这种噪声拿去做回归门禁等于没做。所以今天真正的工程量不在「调用一次 API」，而在三件事：

1. 把打分换成二元判定，压掉噪声
2. 把「高质量」换成具体的 rubric，对齐人类标准
3. 把「相信它」换成校准：用昨天的人工标注量出一致率，不到 80% 就改 rubric 重跑，到位为止

第三件最容易被人省掉，也最不能省。一个没和人工标注对过一致率的 judge，它的输出没有资格进 CI。校准是 judge 的出生证明，不是可选项。

## 核心知识

### 1. 二元判定：为什么放弃 1-5 打分

先看打分有多不稳。拿同一条客服回复，问两次 judge：

```text
提问：请给这条客服回复的质量打 1-5 分。
第 1 次输出：4（回答完整，语气好）
第 2 次输出：2（没有确认发货时间，信息不足）
```

同一条回复，两个分。问题出在「打分」这个动作本身：它要求模型把事实性、完整性、语气、格式多个维度压成一个数字，但每个维度在心里占多少权重，每次生成都在漂。表面精细，实则噪声大。差 2 分意味着什么？没人说得清，包括 judge 自己。

换成二元判定，问题从「这条回复值几分」变成「这条回复有没有违反第 N 条规则」。回答后者只需要一个锚点：规则文本。规则写得具体，判定就稳定，同一输入跑三遍结果一致。而且 pass/fail 直接对应门禁的放行/阻断，不需要你再定「几分算过」这条二次阈值——那个阈值本身又是一个噪声源。

一句话：打分是让 judge 做主观评价，二元判定是让 judge 做事实核对。后者才是工程能用的。

### 2. rubric 设计：把「高质量」翻译成可检查的行为

二元判定稳不稳，全看 rubric 写得好不好。先看差的写法：

```text
差：判定这条回复是否高质量、专业、对用户有帮助。
```

「专业」是什么？「有帮助」到什么程度算有？judge 每次心里的标准都在漂，你人工标注时心里的标准又是另一套，一致率永远上不去。

好的 rubric，每条判据都写具体行为：

```text
好：
- 用户提供了订单号时，回复必须原样引用该订单号
- 查询类问题必须给出具体结果（状态、时间、金额至少一项）
- 拒绝办理或转人工时，必须写明原因并给出下一步建议
```

三条判据共有的性质：可观察、可验证。拿着回复文本逐条对，有就是有，没有就是没有，一翻两瞪眼。检验一条判据合不合格，问自己三个问题：能不能指着文本里的某句话验证？违反了能不能定位到具体位置？两个人分别读，会不会得出同一个结论？「必须包含订单号」三问全过，「必须专业」三问全挂。

还有一条隐性规则：judge 看到的材料要和你人工标注时看到的材料一致。你昨天只看用户问题和 Agent 回复就打了标，judge 的输入就也只给这两样；如果你标注时还看了工具调用记录，judge 也要给。输入不对齐，rubric 写得再好一致率也上不去。

### 3. 结构化输出与四大偏差

judge 的结论要进脚本算一致率，就得是机器可解析的格式。让 judge 返回 `{verdict: "pass" | "fail", reason: "..."}`，这正是第 11 周练过的 JSON 结构化输出，直接复用：prompt 里写清格式，请求里加 `response_format`，拿到就能 `JSON.parse`。reason 字段别省，它是你后面分析分歧条目的唯一线索。

再用一张表认识 judge 的四大偏差，今天先记住，以后都会撞上：

| 偏差 | 表现 | 触发场景 | 缓解手段 |
| --- | --- | --- | --- |
| 位置偏差 | 对比 A/B 两个回答时偏向排在前面的 | 让 judge 判「哪个回答更好」 | 交换顺序各判一次，结果冲突算平局 |
| 篇幅偏差 | 偏爱更长、看起来更卖力的回答 | 几乎所有判定形式 | rubric 明写「简洁不扣分，冗长不加分」；对比前把两版处理到可比长度 |
| 自我偏好 | 偏向和自己同款模型生成的回答 | judge 与被测 Agent 用同一模型 | 换另一家族的模型当 judge |
| 不一致 | 同一条输入两次判定不同 | temperature 大于 0 | temperature 设 0；要更稳就对同一条跑三次取多数 |

注意第一行的场景是 A/B 对比，今天做的单条判定碰不到它，但 Day 4 用 promptfoo 做多 prompt 对比时会正面撞上。第四行今天就处理：校准脚本里 temperature 写死 0。

## 动手任务：judge 校准一步一步

手册任务：写一个 judge prompt 给 Agent 回复判定通过/不通过，与人工标注计算一致率，迭代 rubric 直到一致率 >80%。拆成 5 步，全程约 40 分钟。

**第 1 步：统一数据格式。** 把昨天的 30 条标注整理成 `golden.json`，每条四个字段：

```json
[
  {
    "id": "case-001",
    "question": "我的订单 A-1024 到哪了，三天了还没发货",
    "answer": "您的订单 A-1024 当前状态为已出库，预计明天送达。",
    "human": "pass"
  },
  {
    "id": "case-007",
    "question": "帮我取消订单 B-2048",
    "answer": "好的，已收到您的请求，请耐心等待。",
    "human": "fail"
  }
]
```

`human` 就是你昨天标的成功/失败，映射成 pass/fail。如果你昨天的文件字段名不一样，改脚本里的类型定义去迁就数据，别反过来改数据。

**第 2 步：写 judge prompt。** 新建 `judge-prompt.md`，全文如下，可直接抄：

```markdown
你是一名电商客服质检员，任务是判断下面这条客服 Agent 的回复是否合格。
逐条检查以下规则，任何一条不满足，verdict 即为 fail。

## 判定规则
1. 事实一致：回复中出现的订单号、商品名、金额必须与用户问题中的完全一致，
   不得编造用户没有提供、上下文里也查不到的信息。
2. 查询必须给结果：用户提出可以办理的查询（订单状态、物流、退款进度）时，
   回复必须包含具体结果（状态、时间、金额至少一项）；
   只回「已收到您的请求」「请稍等」属于不通过。
3. 拒绝必须给理由：Agent 拒绝办理或转人工时，必须写明原因
   （如「该订单已超过退款期」）并给出下一步建议
   （如「可联系人工客服申请特殊处理」），缺任一项不通过。
4. 对题：回复必须回答用户实际问的问题，答非所问不通过。
5. 表述底线：不得出现侮辱性内容，不得承诺任何没有依据的补偿。

## 判定要求
- 按顺序逐条检查，任何一条不满足就判 fail，全部满足才判 pass。
- reason 必须指出违反的规则编号和回复中的具体位置，
  例如「违反规则 2：回复只确认收到请求，未给出订单状态」。
- 只依据下面给出的文本判断，不要假设对话之外的信息。
- 回复简洁不扣分，冗长不加分。

## 用户问题
{question}

## Agent 回复
{answer}

## 输出格式
只输出一个 JSON 对象，不要输出任何其他文字：
{"verdict": "pass 或 fail", "reason": "一句话说明"}
```

这份 prompt 就是 v1 版 rubric。五条规则全部写成可核对的行为，其中「简洁不扣分，冗长不加分」一行是篇幅偏差的 rubric 级缓解。别急着追求一步到位，它大概率拿不到 80%，迭代正是今天的主菜。

**第 3 步：写校准脚本。** 新建 `judge-calib.ts`：

```ts
// judge-calib.ts —— 判 30 条、算一致率、输出混淆矩阵
import { readFileSync } from "node:fs";

const API_URL = "https://api.openai.com/v1/chat/completions";
const API_KEY = process.env.OPENAI_API_KEY; // 按你的环境改
const MODEL = "gpt-4o-mini"; // 换成你选定的裁判模型，别和被测 Agent 同款

interface GoldenCase {
  id: string;
  question: string;       // 用户问题
  answer: string;         // Agent 当时的回复
  human: "pass" | "fail"; // 昨天的人工标注
}

interface JudgeResult {
  verdict: "pass" | "fail";
  reason: string;
}

const JUDGE_PROMPT = readFileSync("judge-prompt.md", "utf-8");

async function judgeOne(c: GoldenCase): Promise<JudgeResult> {
  const prompt = JUDGE_PROMPT
    .replace("{question}", c.question)
    .replace("{answer}", c.answer);

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0, // 不一致偏差的缓解，写死别动
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content) as JudgeResult;
}

async function main() {
  const cases: GoldenCase[] = JSON.parse(readFileSync("golden.json", "utf-8"));

  let tp = 0, tn = 0, fp = 0, fn = 0;
  const disagreements: string[] = [];

  for (const c of cases) {
    const j = await judgeOne(c);
    if (c.human === "pass" && j.verdict === "pass") tp++;
    else if (c.human === "fail" && j.verdict === "fail") tn++;
    else if (c.human === "fail" && j.verdict === "pass") {
      fp++; // 漏网之鱼：人说不合格，judge 放行
      disagreements.push(`[${c.id}] 人工 fail / judge pass：${j.reason}`);
    } else {
      fn++; // 错杀：人说合格，judge 打回
      disagreements.push(`[${c.id}] 人工 pass / judge fail：${j.reason}`);
    }
  }

  const agree = ((tp + tn) / cases.length) * 100;
  console.log(`一致率：${agree.toFixed(1)}%（${tp + tn}/${cases.length}）\n`);
  console.log("混淆矩阵（行=人工，列=judge）：");
  console.log(`            judge pass  judge fail`);
  console.log(`human pass   ${String(tp).padStart(4)}        ${String(fn).padStart(4)}`);
  console.log(`human fail   ${String(fp).padStart(4)}        ${String(tn).padStart(4)}`);
  console.log("\n分歧条目：");
  console.log(disagreements.join("\n"));
}

main();
```

关键在两处。一是 `temperature: 0` 加 `response_format`，把「不一致」偏差摁住、把输出格式钉死，这是校准结果可复现的前提。二是分歧条目按 FP/FN 分开记，你的每一轮 rubric 修改都应该从这份清单里来，而不是凭感觉改。

**第 4 步：首跑，先读混淆矩阵再读一致率。** 跑完别只看总数字。同样 80% 的一致率，FP 多的 judge 爱放过坏回复（上线风险），FN 多的 judge 爱错杀好回复（误报回归）。当门禁用，宁可错杀不能放过，FP 是你优先消灭的方向。混淆矩阵会告诉你分歧往哪边偏，分歧条目会告诉你具体是哪类回复、违反了你的直觉还是 judge 的规则没写到。

**第 5 步：迭代 rubric，写校准报告。** 低于 80% 就改 `judge-prompt.md` 重跑第 3 步脚本。每轮变更记进报告，格式如下（数字为示意，你的结果取决于数据集）：

```markdown
# judge 校准报告

- judge：gpt-4o-mini，temperature 0，JSON mode
- 数据集：golden dataset v0（30 条：pass 18 / fail 12）

## 迭代记录

| 迭代 | rubric 变更 | 一致率 | FP | FN | 主要分歧模式 |
| --- | --- | --- | --- | --- | --- |
| v1 | 首版：五条行为规则 | 70% | 7 | 2 | 「礼貌但没给查询结果」被判 pass |
| v2 | 规则 2 拆细：明确「已收到请求，请稍等」不算结果 | 80% | 4 | 2 | 转人工回复被误判，缺「理由+建议」的正面定义 |
| v3 | 规则 3 改写：理由与下一步建议二者齐备才通过 | 87% | 2 | 2 | 订单号引用格式争议 |

## 结论
v3 一致率 87% > 80%，定为当前 judge。剩余分歧集中在订单号格式，
下次扩充数据集时优先补这类样本，补完重新校准。
```

这份报告就是当日产出。把 `judge-prompt.md` 各版本和 `golden.json` 放一起做版本化管理，rubric 是和数据集同级的资产。

::: tip 运行命令
在文件所在目录执行 `npx tsx judge-calib.ts`（需要 Node 18+，没装 tsx 就 `npm install -D tsx`）。环境准备参见[第 1 周教程](/week01/)。API 地址与密钥按你实际使用的模型服务修改，只要请求兼容 OpenAI chat completions 格式即可。
:::

## 常见踩坑

**坑 1：rubric 写形容词，不写行为。** 「判定回复是否专业、友好、高质量」这种判据，judge 每次心里的标准都在漂，一致率死活卡在 70% 以下，而且你不知道该改哪。诊断方法：把每条判据单独拿出来问「我能不能在回复文本里指出违反它的那句话」，指不出就重写。今天的 v1 到 v3 迭代里，提升一致率的每一步都是把形容词换成了行为。

**坑 2：judge 和被测 Agent 用同一个模型。** 被测 Agent 用某模型，judge 也用它，等于让选手兼裁判，同款风格的回复会被偏爱。这不是理论风险，是各家模型都被实测过的自我偏好。缓解很直接：judge 换另一家族的模型。今天 30 条的量级换模型成本几乎为零，别省。

**坑 3：temperature 忘了设 0。** 默认 temperature 大于 0，同一条输入两次判定可能不同，你昨天校准出的 87% 今天就复现不了，整个校准失去意义。校准脚本和将来进 CI 的评估脚本里，`temperature: 0` 都写死。追求更稳还可以对同一条跑三次取多数，代价是三倍调用费，30 条的量级无感。

**坑 4：只看一致率，不看混淆矩阵。** 一致率 83% 丢过来，你以为万事大吉，翻混淆矩阵发现 FP=5、FN=0：judge 把人工判 fail 的回复放过去一小半。当门禁用这是最危险的方向，坏回复进了线上你还以为有评估兜底。记住看数顺序：先看 FP/FN 分布，再看总数。方向偏了，改 rubric 的哪一条就从猜测变成了诊断。

**坑 5：校准一次，终身有效。** 三种情况都要重跑校准：golden dataset 扩充或修订之后；judge 换模型或升版本之后；任务定义变化（比如客服 Agent 新接了售后场景）之后。任何一边动了，你手里的 87% 就过期了。校准报告里写明数据和 rubric 的版本，就是为了让未来的你知道这次 87% 对应的是哪套组合。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么 1-5 打分不适合做回归门禁，二元判定更适合？

::: details 参考答案
打分要把多个维度压成一个数字，各维度权重每次生成都在漂，同一回答两次打分能差 2 分，噪声大到无法做门禁；二元判定只需回答「是否违反某条具体规则」，锚点是规则文本，重复判定稳定，且 pass/fail 直接对应门禁的放行/阻断，省掉了「几分算过」这道二次阈值。
:::

2. 「回复必须专业、有同理心」这条 rubric 有什么问题？怎么改？

::: details 参考答案
它不可观察、不可验证，judge 和你各自心里一套标准，一致率上不去。改成可核对的行为，例如「拒绝办理时必须写明原因并给出下一步建议」「回复引用的订单号必须与用户输入完全一致」，每条都能指着文本验证。
:::

3. 四大偏差分别是什么，各自的缓解手段是什么？

::: details 参考答案
位置偏差：A/B 对比时偏向排在前面的回答，缓解是交换顺序各判一次、冲突算平局；篇幅偏差：偏爱更长的回答，缓解是 rubric 明写长度不影响判定、对比前归一化长度；自我偏好：偏爱同款模型的回答，缓解是换另一家族模型当 judge；不一致：同输入两次判定不同，缓解是 temperature 设 0，更稳则三次取多数。
:::

4. 两个 judge 一致率都是 83%，A 的 FP 少 FN 多，B 的 FP 多 FN 少，当回归门禁该选谁？

::: details 参考答案
选 A。FP 是人工判 fail 却被 judge 放行，坏回复会漏进线上；FN 是好回复被错杀，后果是多做几次无谓的排查，方向上是安全的。门禁场景宁可错杀不能放过，所以优先消灭 FP，然后再继续修 rubric 压 FN。
:::

5. 什么情况下必须重新校准 judge？

::: details 参考答案
四种：golden dataset 扩充或修订后；judge 换模型或版本升级后；rubric 修改后；任务定义变化（新增业务场景、调整合格标准）后。本质上，凡是一侧变化可能改变「正确答案」或「判定标准」，旧的一致率就作废，需要重跑校准。
:::

## 延伸阅读

- [Hamel Husain《Your AI Product Needs Evals》](https://hamel.dev/blog/posts/evals/)，评估这件事为什么是 AI 产品的生命线，本周手册的原始出处之一，值得反复读
- [Zheng et al.《Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena》](https://arxiv.org/abs/2306.05685)，位置偏差、自我偏好等现象的系统观测出处，四大偏差的原始文献
- [promptfoo：model-graded 断言](https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/)，工程化封装好的 LLM-as-judge 用法，Day 4 就要用到，今天先扫一眼

今天的产出 judge 校准报告、`judge-prompt.md` 和 `golden.json` 一起版本化留好，Day 4 把它们转成 promptfoo 配置、Day 6 接进 CI 门禁时，这三样就是全部输入。
