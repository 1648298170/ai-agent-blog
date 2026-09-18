# 主线补篇 · Agent 循环 TS 深入：多步任务与多 Agent 模式

> 衔接：[Day 4](/week11/day4) 用 `ToolLoopAgent` 十几行收编了工具循环，[Day 5](/week11/day5) 用 useChat 接住了它吐的流。本篇做两件收尾的事：先把 Agent 这个黑盒拆开，用 `generateText` 手写一遍完整的多步工具循环，看清 SDK 到底替你转了什么；再往上盖两层，多步任务的规划模式和多 Agent 的三种组织方式。读者默认走完 TS 主线前八周和第十一周，正要用纯 TS 把客服、知识库类产品做上线。读完的检验标准只有一条：不借助任何 Agent 框架，你能徒手写出带工具循环、能控步数、能插自己逻辑的最小 Agent。

## 手写 vs ToolLoopAgent：拆开黑盒

Day 4 结尾留过一句话：ToolLoopAgent 适合「循环就是全部逻辑」的场景，要插检索、记忆这类自定义步骤，还得回底层手动转。产品很快会把你推到那一天：想给每一步打日志、想在某个工具前加一道 [Day 5](/week11/day5) 学的 needsApproval 审批、想缓存中间结果省 token，都得把手伸进循环里。伸手之前，先看清循环长什么样。

理由还有一层。W12 的 LangGraph、W13 的多 Agent 编排，拆到底都是同一段循环的变体。现在花四十多行手写一遍，以后每见到一个新框架，你都能对上号：它的图、它的节点、它的边，映射到这几十行里的哪几行。黑盒拆一次，受用到毕业。

手写前记住三个改动，全都围着 Day 4 的一个坑转：工具不带 `execute`，SDK 就认为你要自己执行，只把 tool-call 透传出来（Day 4 坑 3 说的「故意的」，就是现在）。

1. 工具只写 schema 不写 execute：模型的调用意图会出现在 `result.toolCalls` 里，而不是被 SDK 悄悄跑掉
2. 调用完先入账：`result.response.messages` 是这一轮 assistant 侧的全部消息（含调用意图），原样 push 进历史，模型下一轮才记得自己要过什么
3. 执行完再回灌：自己拼 `role: "tool"` 的消息把结果塞回历史，回到循环头再问一次模型

```ts
import { generateText, tool, type ModelMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const model = openai.chat("gpt-4o-mini");

const tools = {
  searchKnowledgeBase: tool({
    description: "在客服知识库里搜索相关文档",
    inputSchema: z.object({ query: z.string().describe("搜索关键词") }),
  }),
  getOrderByNo: tool({
    description: "按订单号查询订单状态",
    inputSchema: z.object({ orderNo: z.string() }),
  }),
};

// 工具实现就是普通函数，调度自己写
async function runTool(name: string, input: Record<string, unknown>) {
  if (name === "searchKnowledgeBase") return { hits: ["《退货政策》", "《物流时效说明》"] };
  if (name === "getOrderByNo") return { status: "已发货", eta: "明天 18 点前送达" };
  return { error: `未知工具 ${name}` };
}

async function askAgent(question: string): Promise<string> {
  const messages: ModelMessage[] = [{ role: "user", content: question }];
  const MAX_STEPS = 5; // 自己的保险丝，对应 SDK 的 stopWhen

  for (let step = 1; step <= MAX_STEPS; step++) {
    const result = await generateText({ model, messages, tools });
    if (result.toolCalls.length === 0) return result.text; // 模型开口了，出口

    messages.push(...result.response.messages); // ① 入账：模型的调用意图

    for (const call of result.toolCalls) {
      const output = await runTool(call.toolName, call.input); // ② 调度
      messages.push({                                   // ③ 回灌：结果作为 tool 消息
        role: "tool",
        content: [{
          type: "tool-result", toolCallId: call.toolCallId,
          toolName: call.toolName, output,
        }],
      });
    }
  }
  throw new Error("步数用完，模型仍在要工具");
}

console.log(await askAgent("订单 A-1024 到哪了，大概什么时候能到？"));
```

::: tip 运行前提
任意目录 `npm i ai @ai-sdk/openai zod`，`OPENAI_API_KEY` 进 `.env`。这是纯 TS 脚本，`npm i -D tsx` 后 `npx tsx agent-loop.ts` 就能跑，不依赖 Next.js，Day 4 说过 ai 包不绑框架。连 DeepSeek 的照 Day 4 第 1 节换 provider。
:::

同样的事，ToolLoopAgent 版长这样：

```ts
import { ToolLoopAgent, isStepCount, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const agent = new ToolLoopAgent({
  model: openai.chat("gpt-4o-mini"),
  tools: {
    searchKnowledgeBase: tool({
      description: "在客服知识库里搜索相关文档",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => ({ hits: ["《退货政策》", "《物流时效说明》"] }),
    }),
    getOrderByNo: tool({
      description: "按订单号查询订单状态",
      inputSchema: z.object({ orderNo: z.string() }),
      execute: async () => ({ status: "已发货", eta: "明天 18 点前" }),
    }),
  },
  stopWhen: isStepCount(5),
});

console.log((await agent.generate({ prompt: "订单 A-1024 到哪了？" })).text);
```

逐段对账，SDK 替你写的就是这么几样：

| 手写版里你亲笔写的 | ToolLoopAgent 里 SDK 替你写的 |
| --- | --- |
| `for` 循环加 `MAX_STEPS` 计数 | `stopWhen: isStepCount(5)` 的保险丝 |
| `result.toolCalls.length === 0` 的出口判断 | finishReason 不是工具调用就自动收口 |
| `messages.push(...)` 维护历史 | 消息历史全程自动维护 |
| 手拼 `role: "tool"` 消息回灌结果 | execute 返回值自动回传 |
| `runTool` 里的 if 调度 | `tools` 对象按名字分发，execute 即实现 |

两份代码跑的是同一段逻辑，差距全在「谁维护循环」。手写版四十多行里，真正的业务只有 runTool 里那几个返回值，其余全是搬运。手写不是要你以后都手写，是让你知道出错时日志该打在哪一步、审批该插在哪一行、哪一环值得缓存。另外留意 `ModelMessage` 这个类型：工具结果消息的形状拼错，tsc 当场标红，照类型提示改就行，[第 1 周](/week01/)起攒的 TS 功夫，在拆黑盒时变成独有的安全网。Day 4 坑 1 的提醒在这里同样有效：手写循环贴着 ai 包底层走，版本升级时 message 形状偶尔会动，报错先 `npm ls ai` 对版本。

## 多步任务的规划模式

循环只回答「怎么执行下一步」，不回答「下一步该是什么」。后一个问题的决定权有两种放法，对应两种规划模式。

**ReAct 式：边想边做。** 模型每一轮都看得到完整历史，包括前面所有工具结果，当场决定下一个动作。第 1 节的 askAgent 本体就是它，循环加现场决策，不需要额外代码，要补的只有一句提示词，让模型把「想」显式化：

```ts
const system = "你是客服排障助手。每次调用工具前，先用一句话说明你怀疑什么、想查什么。";
```

这一句同时喂饱了两头：模型的推理有了落点，你的排障日志有了内容。适用信号看路径依赖：查订单发现没发货，才需要查库存；查完库存才知道要不要给补偿。后一步取决于前一步的观察，提前列计划列不出来。客服排障、诊断类任务，ReAct 是默认选型。

**计划式：先列清单再执行。** 步骤可以预先枚举时，先花一次结构化调用把计划变成数组，再逐项执行：

```ts
import { generateObject, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const model = openai.chat("gpt-4o-mini");

// 第一步：一次结构化输出，把计划变成数组
const { object: plan } = await generateObject({
  model,
  schema: z.object({
    steps: z.array(z.object({
      id: z.number(),
      task: z.string().describe("这一步做什么，一句话"),
    })),
  }),
  prompt:
    "客服知识库要补全「物流时效」主题，用户常问：「发杭州几天到」「能改地址吗」。"
    + "列出要补写的词条，2 到 6 步。",
});

// 第二步：逐项执行，进度对用户可见
const done: string[] = [];
for (const step of plan.steps) {
  const { text } = await generateText({
    model,
    system: `你是知识库编辑，只完成当前这一步：${step.task}。已完成 ${done.length} 步。`,
    prompt: "写这个词条的正文，200 字以内。",
  });
  done.push(text);
  console.log(`[${done.length}/${plan.steps.length}] ${step.task}`);
}
```

`generateObject` 是 [Day 3](/week11/day3) 那套结构化输出在 TS 线的对应物：Python 侧用 response_format 加 Pydantic，这里用 schema 加 zod，同一个思想，模型和代码看同一张图纸。计划式多花一次规划调用的钱，换回三样东西：进度可见（示例里的 console.log 就是进度条的雏形）、步骤可编辑（用户删掉一步再跑）、失败可从单步重试而不用整个重来。知识库批量整理、内容生产这类「步骤能提前列清楚」的任务选它。

两个模式不打架，混合很常见：计划执行到一半发现前提变了，把已完成的步骤和新的观察再喂给 generateObject，重新规划一次。判断标准始终一条：下一步依赖不依赖现场结果。

## 多 Agent 三种 TS 模式

单 Agent 什么时候开始不够用，信号比你想的来得早：system prompt 装了客服规范又要装退款政策，两段提示词开始互相打架；工具列表超过十个，模型选错工具的频率肉眼可见地上升。这时候先别急着换框架，三种纯 TS 的组织方式，从松到紧排下来。

**① 路由模式：一个前台，一队专员。** 入口先用一次结构化输出做分诊，再把消息交给对应专职 Agent。这是第 13 周 Supervisor 思想在 TS 侧的最小版本：前台不做业务，只做分类。

```ts
import { generateObject, ToolLoopAgent, isStepCount, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const model = openai.chat("gpt-4o-mini");
const question = "退款提交三天了还没到账，单号 A-1024。";

// 前台：只分诊，不做业务
const { object: route } = await generateObject({
  model,
  schema: z.object({
    category: z.enum(["order", "refund", "knowledge"]),
    reason: z.string(),
  }),
  prompt: `判断这条用户来话该交给哪个专员：${question}`,
});

// 专员：各带各的工具，职责写进各自的调用
const refundAgent = new ToolLoopAgent({
  model,
  tools: {
    getRefundStatus: tool({
      description: "按订单号查退款流水状态",
      inputSchema: z.object({ orderNo: z.string() }),
      execute: async () => ({ state: "银行处理中", eta: "1 个工作日" }),
    }),
  },
  stopWhen: isStepCount(3),
});

if (route.category === "refund") {
  console.log((await refundAgent.generate({
    prompt: `你是退款专员，只处理退款进度问题。用户来话：${question}`,
  })).text);
} else {
  console.log("其他专员的骨架同上，换工具和提示词而已");
}
```

要点两个。分类 schema 用 `z.enum` 锁死，category 的取值可枚举，日志里能直接统计各路由占比，上线一周就知道该给哪个专员补工具。专员的提示词各写各的，互不干扰，每个都小而稳，出问题定位快。

**② 串行流水线：A 的产出是 B 的输入。** 最朴素的多 Agent 结构，也是最容易测的：上一段的输出过 schema，下一段拿到的就是干净数据。典型如「抽取 Agent → 审核 Agent」：

```ts
import { generateObject, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const model = openai.chat("gpt-4o-mini");

// Agent A：抽取，输出必须过 schema
const { object: ticket } = await generateObject({
  model,
  schema: z.object({
    orderNo: z.string(),
    issue: z.enum(["物流", "质量", "退款", "其他"]),
    sentiment: z.enum(["positive", "neutral", "negative"]),
  }),
  prompt: "从用户反馈里抽取工单字段：「快递三天没动，盒子还瘪了，要求退款，单号 A-1024。」",
});

// Agent B：审核，输入是 A 的结构化产出，不是自然语言
const { text: decision } = await generateText({
  model,
  prompt: `你是审核员，决定优先级和是否人工介入。工单数据：${JSON.stringify(ticket)}`,
});

console.log(ticket, decision);
```

段间交接用 schema 不用自然语言，这是 Day 3 教训的直接应用：自由文本进不了 if/else，结构化数据可以。流水线每一段都能独立跑测试用例，审核段嫌贵还能单独换便宜模型，这些在单个大 Agent 里都做不到。

**③ 委托模式：子任务长成工具。** 主 Agent 把子任务当工具调用，工具的 execute 里跑的是另一个 generateText（甚至另一个 ToolLoopAgent）：

```ts
import { ToolLoopAgent, generateText, isStepCount, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const model = openai.chat("gpt-4o-mini");

// 子任务长成一个工具：execute 里跑另一个模型调用
const draftReply = tool({
  description: "让写作专员起草一条客服回复草稿",
  inputSchema: z.object({
    tone: z.enum(["安抚", "简洁"]),
    facts: z.string().describe("草稿要用到的事实"),
  }),
  execute: async ({ tone, facts }) => {
    const { text } = await generateText({
      model,
      prompt: `你是客服回复写作专员，语气${tone}。基于以下事实起草回复：${facts}`,
    });
    return text; // 草稿作为工具结果回到主循环
  },
});

// 主 Agent：自己决定什么时候叫帮手
const main = new ToolLoopAgent({
  model,
  tools: { draftReply },
  stopWhen: isStepCount(5),
});

console.log((await main.generate({
  prompt: "用户投诉物流慢，单号 A-1024，先安抚再给方案。",
})).text);
```

和前两个的本质区别在「谁做编排」：路由和流水线的编排写在你的代码里，跑不偏；委托模式的编排交给主模型现场决定，什么时候叫帮手、传什么事实，都是它判断的。换来的是上下文隔离：子 Agent 的中间过程不进主循环的消息历史，主 Agent 只拿最后的草稿，等于用一次工具调用的宽度换掉一整段对话，主上下文保持干净。代价同样明显：工具的 execute 里套着完整的模型调用，token 在两层循环里叠加，内层也要配步数上限，否则账单按乘法涨。Day 5 的 needsApproval 在这里照样能用：给 draftReply 这类要动真格的委托工具加上审批，主 Agent 想叫帮手也得先过用户这一关。

## 生产提醒：成本/延迟/可控性对比与何时停手

四个模式摆在一起看账：

| 模式 | 成本 | 延迟 | 可控性 | 一句话定位 |
| --- | --- | --- | --- | --- |
| 单 Agent + 工具 | 基线 | 基线 | 中，stopWhen 兜底 | 八成场景到此为止 |
| 路由 | 每条消息多一次分类调用 | 加一次小调用，几百毫秒 | 高，分类可枚举可统计 | 入口分诊 |
| 串行流水线 | 段数各一次调用 | 串行叠加，最慢一段定总时长 | 高，段间 schema 可单测 | 抽取审核类加工链 |
| 委托 | 主循环嵌子循环，token 按乘法涨 | 子任务期间主请求挂着等 | 中，要靠日志穿透 | 主上下文要干净时 |

最后一行是刻意放的。多 Agent 不是段位，是账单：每加一个 Agent，多一份提示词要维护、多一处模型行为要测试、多一路日志要穿透，Agent 数量和系统稳定性经常成反比。经验值很保守：单 Agent 加一套好工具，能解决八成的客服和知识库场景。升级之前先问自己三个问题，都答「是」再动手：

1. 是不是加一个工具就能解决（大多数「想加 Agent」的冲动，其实是想加一个检索工具）
2. 是不是把提示词按职责拆成两节就能解决（两段职责揉在一起，先试拆分）
3. 是不是真的出现了升级信号（提示词打架、工具超十个、不同任务要不同的模型或温度）

三个信号一个都没出现就把 Agent 数量往上堆，你多写的不是架构，是维护面积。

## 自测 4 题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 手写循环里，`messages.push(...result.response.messages)` 和后面那条 `role: "tool"` 消息各自记的什么账？漏掉哪一个，循环分别会怎么坏？

::: details 参考答案
前者入账的是 assistant 侧的调用意图：模型要调哪个工具、参数是什么。不 push 进去，模型下一轮不记得自己要过什么，会重复发起同一个调用。后者回灌的是执行结果：工具实际的输出。漏掉它，模型看得到自己的意图却等不到结果，要么重复调用，要么直接编一个答案。历史维护和结果回灌是循环转起来的两半，缺一不可。
:::

2. 「知识库要补 50 个词条」和「用户投诉订单三天没动」，各选一种规划模式，说理由。

::: details 参考答案
补词条选计划式：步骤可以预先枚举，一次 generateObject 列出清单，逐项执行，进度可见、失败可从单步重试。订单投诉选 ReAct：路径依赖现场结果，查订单发现没发货才要查库存，查完库存才知道给不给补偿，后一步取决于前一步的观察，提前列不出有效计划。
:::

3. 委托模式里，子 Agent 跑在工具的 execute 里。这对主 Agent 的上下文和你的 token 账单各意味着什么？

::: details 参考答案
上下文方面是隔离：子 Agent 的中间过程不进主循环消息历史，主 Agent 只收到 execute 的返回值，等于用一次工具调用的宽度换掉一整段对话，主上下文保持干净。账单方面是乘法：主循环一步的代价里嵌着子 Agent 完整的一次或多次模型调用，两层循环的 token 叠加，所以内层也必须配步数上限，并在日志里穿透记录子 Agent 的消耗。
:::

4. 什么时候该忍住不加第二个 Agent？给出升级前的两个自查问题和真正的升级信号。

::: details 参考答案
自查问题：是不是加一个工具就能解决；是不是把提示词按职责拆成两节就能解决。真正的升级信号：提示词互相打架、工具列表超过十个导致选错率上升、不同任务需要不同的模型温度或审批策略。信号没出现就堆 Agent，多出来的是维护面积，不是架构。八成场景，单 Agent 加好工具就够。
:::

---

这三份骨架留着：W12 的 LangGraph 进来时，把它的节点和边逐段对回今天的手写循环；W13 的 Supervisor 进来时，对回今天的路由模式。框架会一直换名字，循环只有那一个。本周其余安排见[本周日程](/week11/)。
