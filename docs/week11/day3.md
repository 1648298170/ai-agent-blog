# 第 11 周 · Day 3：结构化输出——让模型输出严格可解析的 JSON

> 对应手册任务：学习「结构化输出：JSON Schema 约束（response_format 严格模式）、zod 解析与失败重试」，动手实现「用户评论 → 结构化情感分析」接口，验证 Schema 符合率 100%，当日产出「结构化输出模块」。本篇只解决一个问题：模型天生吐自然语言，而下游代码要的是稳定字段，把「提示词里求它输出 JSON」的碰运气，换成「吐出来的每个字段都错不了」的硬保证。

## 今日目标

1. 说得清「提示词求 JSON」为什么不可靠，`json_object` 与 `json_schema` 严格模式各保证什么、不保证什么
2. 掌握三件事：用 zod 定义 Schema 并经 openai SDK 的 `zodResponseFormat` 喂给 API、用 `.parse()` 校验响应、校验失败时带错误信息重问模型的自愈重试
3. 独立完成「用户评论 → 结构化情感分析」模块，包成 Next.js Route Handler 的 `/analyze` 端点，批量跑评论验证 Schema 符合率 100%

## 概念讲解：为什么提示词求 JSON 不可靠

到今天为止，你已经会原生调用，昨天还手写过 Function Calling 的完整循环。但 Agent 工程里更日常的需求其实更朴素：让模型直接输出一个结构化结果，给程序消费。比如「评论 → 情感分析」，下游要的是 `{"sentiment": "positive", "score": 0.9}`，于是你在提示词里认真写上「请以 JSON 格式返回结果，包含 sentiment 字段」。

然后你会撞上模型的三种背叛。第一种，加围栏：输出被包进 ` ```json ` 代码块，前面还带一句「好的，以下是分析结果」。第二种，自由发挥字段：`sentiment` 给你写「好评」，`score` 给你写成字符串 `"0.9"`，或者热情洋溢地加一个你没要的 `reason` 字段。第三种，JSON 里夹注释、带尾逗号，`JSON.parse` 当场爆炸。

你写个容错函数：正则剥围栏、截取第一个花括号、try/catch 包住解析。语法层的错多半能救，字段层的错救不了——`{"sentiment": "好评"}` 是完全合法的 JSON，可程序拿它进不了 `if (result.sentiment === "positive")` 这个分支。

更要命的是这一切是概率性的。手测十条全过，你觉得稳了；上线后每天五千次调用，哪怕 2% 的失败率也是每天一百次崩溃告警。demo 里 90% 可用叫能用，生产里 99% 可用都叫事故。结构化输出要的不是「模型通常听话」，是「不听话的输出根本生成不出来」。

## 核心知识

本节的代码片段都可以单独跑，模型名按你实际可用的填，最终完整实现以下面的动手任务为准。

### 1. 三条路线，三档保证

**路线一：提示词 + 解析容错。** 提示词写清字段要求，拿到输出后剥围栏、容错解析、失败重试全自己写。围栏能剥，字段错没法猜，只能靠校验器兜底。适合当天就要演示的 demo。

**路线二：`json_object` 模式。** 请求里加一个参数：

```typescript
const resp = await client.chat.completions.create({
  model: MODEL,
  messages,
  response_format: { type: "json_object" }, // 只保证「合法 JSON」
});
```

API 在解码阶段保证输出能被 `JSON.parse`，围栏和开场白从此绝迹。但字段名、类型、枚举值全靠模型自觉：你要求 `positive/neutral/negative`，它照样可能回「好评」。另外 OpenAI 规定这个模式下 messages 里必须出现「JSON」字样，否则请求直接 400。

**路线三：`json_schema` 严格模式。**

```typescript
const resp = await client.chat.completions.create({
  model: MODEL,
  messages,
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "sentiment_result",
      schema,       // 你定义的 JSON Schema
      strict: true, // 约束解码级保证
    },
  },
});
```

关键在 `strict: true`：它做的是约束解码（constrained decoding），生成每个 token 时，凡是会导致输出偏离 Schema 的候选直接被屏蔽。字段缺失、类型不对、枚举越界，不是「事后被纠正」，是从根上生成不出来。这是 OpenAI gpt-4o 及之后模型的能力，openai npm SDK 还内置了 zod 助手把这条路铺平，下一节讲。注意 DeepSeek、GLM 这类 OpenAI 兼容端点对它支持度不一：有的只认 `json_object`，有的对 Schema 里某些写法报错，文档还可能滞后。所以生产代码别赌端点能力，先按 strict 发，端点报不支持就降级到路线二，再靠校验和重试兜底。这套兜底今天动手部分会完整写出来。

三档保证排个序：路线三保证「符合你给的 Schema」，路线二保证「是合法 JSON」，路线一什么都不保证，只保证你多写了五十行容错代码。

### 2. zod 定义 Schema：一个对象管两头

手写 JSON Schema 字符串，再手写一份 interface，再手写一份校验代码，就是三份独立事实，改字段时总有一边忘了改。用 zod，从头到尾只有一个对象：

```typescript
import { z } from "zod";

const SentimentResult = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  score: z.number().min(0).max(1),      // 0 到 1，该情感的置信度
  keywords: z.array(z.string()).max(5), // 触发判断的原文关键词，最多 5 个
  summary: z.string(),                  // 一句话概括评论
});

type SentimentResult = z.infer<typeof SentimentResult>;
```

上游约束、运行时校验、编译期类型，看的是同一张图，想漂移都没机会。`z.infer` 直接从 Schema 反推出 TS 类型，后面的代码里 `result.sentiment` 全程 IDE 补全，拼错字段编译期就报错。Python 世界的同类工具叫 Pydantic，思路同源；会 JS 的人用 zod 天然顺手，它就是拿写类型的思维方式写校验。本周后面讲 Vercel AI SDK 时 zod 还会挑大梁，这里先把根基打牢。

openai npm SDK 对 zod 是一等公民待遇，内置助手一步到位：

```typescript
import { zodResponseFormat } from "openai/helpers/zod";

const resp = await client.chat.completions.create({
  model: MODEL,
  messages,
  temperature: 0,
  response_format: zodResponseFormat(SentimentResult, "sentiment_result"),
});
```

`zodResponseFormat` 内部把 zod 对象转成 JSON Schema，按 `strict: true` 组装好 response_format 发出去；name 参数只是标识，随便起。这是本篇的主路线。

strict 模式对 Schema 有两条硬性要求：所有字段列进 `required`，对象加 `additionalProperties: false`。zod 字段默认全必填，第一点天然满足；但 `.optional()` 或 `.default()` 修饰的字段不会进 required，`additionalProperties` 也不是默认导出的内容。哪天绕开 SDK 助手自己导 Schema（比如裸用 fetch 或换了别的封装），记得统一补一刀：

```typescript
import { zodToJsonSchema } from "zod-to-json-schema";

function toStrictSchema(schema: z.ZodType): Record<string, unknown> {
  const json = zodToJsonSchema(schema) as Record<string, unknown>;
  delete json.$schema; // 声明性字段，部分严格端点不认
  json.additionalProperties = false;
  json.required = Object.keys(json.properties as Record<string, unknown>);
  return json;
}
```

关键在后两行：不管导出成什么样，补完一定是 strict 要的形状。今天的模型是单层的，以后嵌套子对象时，内层对象也得同样处理，先记住这回事。

### 3. 解析：`JSON.parse` 管语法，`.parse()` 管字段

```typescript
const result: SentimentResult = SentimentResult.parse(JSON.parse(content));
```

解析分两层：`JSON.parse` 管语法，字符串不是合法 JSON 时抛 `SyntaxError`；`.parse()` 管字段，类型不对、枚举越界、字段缺失时抛 `ZodError`。过了闸，你手里就是 `z.infer` 推出来的强类型对象，后面的代码全程 IDE 补全。注意即使请求走的是 strict 模式，这一步也不能省——降级路径的输出、兼容端点的意外，都得靠它在门口拦住。

### 4. 失败重试：带着报错回去质问

校验失败后把同样的请求从零重发一遍是浪费：模型不知道自己错在哪，大概率原样再错。正确姿势叫 self-correction，把上次的输出和具体报错都塞回对话，让它改：

```typescript
import { z } from "zod";
import type OpenAI from "openai";

async function analyzeWithRetry(comment: string, maxAttempts = 3): Promise<SentimentResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: comment },
  ];
  for (let i = 0; i < maxAttempts; i++) {
    const content = await callLlm(messages);
    try {
      return SentimentResult.parse(JSON.parse(content));
    } catch (e) {
      const detail = e instanceof z.ZodError ? JSON.stringify(e.issues, null, 2) : String(e);
      messages.push(
        { role: "assistant", content }, // 案发现场留在上下文里
        {
          role: "user",
          content: `上面的输出校验失败：${detail}。请严格按 Schema 重新输出，只输出 JSON 本身。`,
        },
      );
    }
  }
  throw new Error(`重试 ${maxAttempts} 次仍未通过校验`);
}
```

关键在 catch 里那两条消息：assistant 消息把上次的原始输出留在上下文里，user 消息给出具体死因，模型才知道往哪改。`e instanceof z.ZodError` 的判断顺带把 `JSON.parse` 的 SyntaxError 也接住了：语法错和字段错对模型来说都是「输出不合格」，一起退回去重写。另外 `maxAttempts` 必须封顶，否则修复循环自己变成烧钱的无底洞；重试耗尽就抛异常给上层，记日志、发告警，别吞。

### 5. 包成 Next.js Route Handler

请求进、结构化结果出，zod 一鱼两吃，连入参校验也是它：

```typescript
// app/analyze/route.ts
import { z } from "zod";
import { analyzeWithRetry } from "@/lib/structured-output";

const AnalyzeRequest = z.object({
  text: z.string().min(1).max(2000),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const parsed = AnalyzeRequest.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "参数不合法", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const result = await analyzeWithRetry(parsed.data.text);
    return Response.json(result);
  } catch {
    return Response.json({ error: "分析失败，请稍后重试" }, { status: 502 });
  }
}
```

App Router 的约定就两条：文件放在 `app/analyze/route.ts`，导出名叫 `POST` 的异步函数，`POST /analyze` 这个路由自动挂上，不用注册。入参的 `safeParse` 挡掉空文本和超长文本，它只返回结果不抛异常，适合 HTTP 层；出参形状由 `analyzeWithRetry` 的返回类型锁死，TS 保证你 return 不了别的形状——而真正的运行时保证，始终是 `.parse()` 那道闸，不靠任何框架承诺。流式场景记住一条：流出来的是 JSON 碎片，要攒齐、整体校验通过，再交给消费者，别把半个 JSON 推给前端。

## 动手任务：「评论 → 结构化情感分析」一步一步

手册任务：实现「用户评论 → 结构化情感分析」接口，验证 Schema 符合率 100%。拆成 5 步，全程约 30 分钟。

**第 1 步：建文件、定义 Schema。** 在 Next.js 项目里新建 `lib/structured-output.ts`，它就是当日产出的结构化输出模块：

```typescript
// lib/structured-output.ts
import OpenAI, { BadRequestError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); // 兼容端点再加 baseURL: "..."
const MODEL = "gpt-4o-mini"; // 按你实际可用的填

export const SentimentResult = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  score: z.number().min(0).max(1),
  keywords: z.array(z.string()).max(5),
  summary: z.string(),
});

export type SentimentResult = z.infer<typeof SentimentResult>;

export const SYSTEM_PROMPT = [
  "你是电商评论情感分析引擎。对用户评论输出 JSON：",
  "sentiment 取 positive/neutral/negative 之一；",
  "score 是 0 到 1 的置信度；",
  "keywords 是触发判断的原文关键词，最多 5 个；",
  "summary 一句话概括评论。只输出 JSON。",
].join("");
```

`.min(0).max(1)`、`.max(5)` 不是白写的：转成 JSON Schema 时它们映射成 `minimum`、`maximum`、`maxItems`，一并交给 API。这些约束关键字各端点采纳程度不一——就算 API 没拿它约束生成，`SentimentResult.parse` 这道闸也认它，双层保险。SYSTEM_PROMPT 里每个字段的取值都写了，还出现了「JSON」字样，这是 `json_object` 模式的前置条件，降级时用得上。

**第 2 步：调用函数，strict 优先、自动降级。**

```typescript
async function callLlm(messages: OpenAI.Chat.ChatCompletionMessageParam[]): Promise<string> {
  let resp: OpenAI.Chat.ChatCompletion;
  try {
    resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0, // 抽取任务要稳定，采样参数见第 11 周 Day 1
      response_format: zodResponseFormat(SentimentResult, "sentiment_result"),
    });
  } catch (e) {
    if (!(e instanceof BadRequestError)) throw e;
    // 端点不支持 json_schema（或不认 Schema 的某些写法），降级到 json_object
    resp = await client.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
    });
  }
  return resp.choices[0].message.content ?? "";
}
```

catch 里先判 `instanceof BadRequestError` 再降级：网络错、限流错不该触发降级，原样抛出去。降级后的输出只有「合法 JSON」这层保证，字段对不对交给第 3 步的校验和重试去兜。两条路径，同一个校验闸门，这才是能在不同端点之间移植的写法。

**第 3 步：套上校验重试。** 把核心知识第 4 节的 `analyzeWithRetry` 抄进 `lib/structured-output.ts`（开头加上 `export`），再新建 `demo.ts` 试一条：

```typescript
// demo.ts
import { analyzeWithRetry } from "./lib/structured-output";

async function main() {
  const result = await analyzeWithRetry("物流快得离谱，包装扎实，就是客服回复慢了点");
  console.log(result);
}

main();
```

```bash
npx tsx demo.ts
```

预期输出类似 `{ sentiment: 'positive', score: 0.8, keywords: ['物流快', '包装扎实'], summary: '物流和包装满意，客服响应偏慢' }`。

**第 4 步：批量验证 Schema 符合率。** 手册要求 100%，不是抽查一条算过。新建 `batch.ts`，凑满 20 条评论，自己编就行，长短、语气、带错别字的都来点：

```typescript
// batch.ts
import { analyzeWithRetry } from "./lib/structured-output";

const COMMENTS = [
  "物流快得离谱，包装扎实，就是客服回复慢了点",
  "用了三天就坏了，申请售后没人理，避雷",
  "普通吧，说不上好也说不上坏",
  // ...凑满 20 条
];

async function verifySchemaCompliance() {
  let passed = 0;
  for (const text of COMMENTS) {
    const result = await analyzeWithRetry(text); // 走完不抛异常，即符合 Schema
    if (result.score < 0 || result.score > 1) throw new Error("score 越界");
    passed += 1;
  }
  const rate = Math.round((passed / COMMENTS.length) * 100);
  console.log(`Schema 符合率：${passed}/${COMMENTS.length} = ${rate}%`);
}

verifySchemaCompliance();
```

```bash
npx tsx batch.ts
```

100% 的底气来自三道闸：strict 约束解码、`.parse()` 校验、带报错的重试。任何一条评论三次重试后仍失败，函数会抛异常——真抛了就去日志里看模型的原始输出，那是宝贵的失败样本，攒下来就是你项目的测试集。

**第 5 步：Next.js 端点。** 新建 `app/analyze/route.ts`，代码就是核心知识第 5 节那份，然后启动：

```bash
npm run dev
```

另开一个终端验证：

```bash
curl -X POST http://localhost:3000/analyze \
  -H "Content-Type: application/json" \
  -d '{"text": "物流很快，就是客服爱答不理"}'
```

返回长这样，每个字段都过得了 `SentimentResult` 的校验：

```json
{
  "sentiment": "neutral",
  "score": 0.6,
  "keywords": ["物流很快", "客服爱答不理"],
  "summary": "物流满意但客服态度差，整体中性"
}
```

::: tip 运行前提
项目里 `npm install openai zod`，跑脚本用 `npx tsx`（没装就 `npm install -D tsx`）；要手工导 Schema 再加 `zod-to-json-schema`。Key 放进 `.env.local` 的 `OPENAI_API_KEY`，Next.js dev server 会自动读；命令行跑脚本时终端里先设好（PowerShell：`$env:OPENAI_API_KEY="sk-..."`，bash：`export OPENAI_API_KEY=...`），别硬编码进文件。用 DeepSeek、GLM 等兼容端点时，把 `baseURL` 和 `MODEL` 换成对应值，第 2 步的降级逻辑会自动接住不支持 strict 的端点。
:::

## 常见踩坑

**坑 1：`json_object` 模式直接 400。** OpenAI 规定该模式下 messages 里必须出现「JSON」这个单词，否则请求被拒。报错信息里其实写了原因，别当成玄学。本篇的 SYSTEM_PROMPT 第一句就有「输出 JSON」，天然满足。

**坑 2：strict 模式没有「可选字段」。** 常规 JSON Schema 的惯例是「不写进 required 就是可选」，strict 模式不认这套：所有字段必须列进 required。想表达「可以为空」，把 null 加进类型（zod 写 `z.string().nullable()`）；想表达「可以没有」，让模型填 `"unknown"` 这类哨兵值。zod 字段一旦 `.optional()` 或 `.default()`，导出的 required 里就没有它，这正是 `toStrictSchema` 里那行 `required = ...` 兜底存在的原因。

**坑 3：信了 response_format 就不校验。** 「API 承诺会符合 Schema」和「这条输出符合 Schema」是两回事：降级路径的存在、兼容端点的实现差异、上游某次行为变更，都可能放漏网之鱼进来。`SentimentResult.parse` 是最后一道闸，永远写在代码里，不依赖任何文档承诺。符合率是不是 100%，从来是校验器说了算。

**坑 4：重试不带错误信息。** 把同样的 messages 原样再发一遍，模型大概率把同样的错再犯一遍——它看不见自己错在哪。必须带上 assistant 的原始输出和 ZodError 的具体内容，self-correction 才成立。同时次数封顶、耗尽即抛：修复机制自己不能变成新的故障源。

**坑 5：抽取任务还开着温度。** [第 11 周 Day 1](/week11/day1) 讲采样参数时说过，temperature 越低输出越确定。情感分析这类「同一输入要同一输出」的任务，temperature 给 0。开着 0.7 跑，同一条评论两次分析给出不同 sentiment，下游报表对不上数，排查半天最后发现是采样随机性，最冤的一种坑。

**坑 6：把 JSON 字符串直接喂给 `.parse()`。** `z.object()` 的 `.parse()` 期望的是已经解析好的对象，不是字符串——直接把 `content` 塞进去，会收到一条「Expected object, received string」的 ZodError，报错方向还容易把你带偏去查 Schema。正确写法永远是 `SentimentResult.parse(JSON.parse(content))`，两层各管一层，缺一不可。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 「提示词求 JSON」的失败有哪几种典型形态？哪些能靠解析容错救回来，哪些救不回来？

::: details 参考答案
三种：围栏和开场白（` ```json `、客套话）；JSON 语法错误（注释、尾逗号）；字段层面的错（名字不对、类型不对、枚举自由发挥、缺字段）。前两种部分能靠剥壳和容错解析救回；第三种救不回来，因为「合法 JSON」和「错误字段」可以同时成立，程序没法猜。根治靠 response_format 约束加校验，不靠更恳切的提示词。
:::

2. `json_object` 和 `json_schema` strict 各保证什么、不保证什么？面向 DeepSeek 这类兼容端点的生产代码该怎么写？

::: details 参考答案
`json_object` 保证输出是合法 JSON，能被 `JSON.parse`，但不保证任何字段的名字、类型、取值；`json_schema` strict 是约束解码，从生成层面保证输出符合你给的 Schema。兼容端点支持度不一，生产代码应当先按 strict 发请求（`zodResponseFormat` 一步到位），端点抛 BadRequestError 就降级到 `json_object`，再统一用 `.parse()` 校验、失败带报错重试——两条路径共用同一道校验闸门。
:::

3. Schema 为什么用 zod 定义，而不是手写 JSON Schema 字符串？

::: details 参考答案
zod 对象同时是三样东西的唯一出处：喂给 API 的 Schema（`zodResponseFormat` 自动转换）、解析响应的校验器（`.parse()`）、TS 类型（`z.infer`）。改一处，三处同步变。手写 Schema 会多出一份独立事实，和校验代码、类型定义靠人肉保持同步，迟早漂移。
:::

4. 校验失败后的重试要带哪两样信息？缺了为什么基本无效？

::: details 参考答案
带上次的原始输出（assistant 消息）和具体的校验报错（ZodError 的 issues）。缺前者，模型对「案发现场」一无所知；缺后者，它只知道错了不知道错在哪。self-correction 的前提是错误可定位。
:::

5. strict 模式对 required 的要求，和 JSON Schema 的通用惯例有什么冲突？zod 的哪种写法会踩进这个坑？

::: details 参考答案
通用惯例是「不进 required 即可选」，strict 要求所有字段全部进 required，「可选」语义改由类型带 null 表达。zod 字段用 `.optional()` 或 `.default()`（包括 `.nullable().default(null)` 这种）时不会出现在 required 里，导出的 Schema 过不了 strict 校验，所以要在后处理里强制补全 required。
:::

## 延伸阅读

- [OpenAI：Structured Outputs 指南](https://platform.openai.com/docs/guides/structured-outputs)，strict 模式的官方说明，支持的字段类型和所有限制条件以这里为准
- [openai-node SDK](https://github.com/openai/openai-node)，`zodResponseFormat` 助手的用法和源码都在这个仓库里
- [zod 文档](https://zod.dev/)，Schema 定义、`.parse()`/`safeParse()`、`z.infer` 的完整参考
- [JSON Schema 官网](https://json-schema.org/)，Schema 语言本身，`additionalProperties`、`required` 这些关键字在通用规范里的语义

今天的产出 `lib/structured-output.ts` 和 `/analyze` 路由留好。后面把工具调用、记忆、规划拼成完整 Agent 时，模型每一步的决策都要靠这个模块从自由文本变成能进 if/else 的数据——结构化输出是 Agent 工程的地基，不是可选优化。
