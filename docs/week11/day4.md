# 第 11 周 · Day 4：Vercel AI SDK 后端——streamText、工具循环与 14 行的流式接口

> 对应手册任务：学习「Vercel AI SDK 后端：streamText、工具循环、ToolLoopAgent」，动手「用 AI SDK 重写第 10 周的 /chat/stream，对比手写 SSE 的代码量」，当日产出「AI SDK 版流式接口」。本篇只解决一个问题：你前三天手写的拼 messages、拼 SSE 帧、工具循环，换个项目就得重抄一遍；今天看 TS 事实标准怎么把它们收编成几个调用，收编之后哪些知识反而更值钱。

## 今日目标

1. 说得清 AI SDK 的三个包各干什么：`ai` 出运行时，`@ai-sdk/openai` 出模型接入，`zod` 出工具的参数 schema
2. 掌握三个写法：`streamText` 接 Next.js Route Handler、`tool()` 用 `inputSchema` 定义工具、`stopWhen` 控制工具循环步数
3. 独立完成 AI SDK 版 `/api/chat/stream`，用 `curl -N` 确认它吐的还是 SSE，交出手写版与 SDK 版的行数对比

## 概念讲解：为什么需要框架收编

Day 1 说过：框架能帮你少写代码，前提是你知道它替你写了什么。前三天的手写正好凑齐一份账单：Day 1 两次 `append` 撑起多轮对话；本周 Day 2 手写流式，解析增量再拼 SSE 帧，又手写工具循环，`while` 加 `finish_reason == "tool_calls"` 的判断；第 10 周 Day 5 的 `/chat/stream` 更早，`f"data: {ch}\n\n"`、`is_disconnected`、两个响应头，一样不少。

这些代码不含业务逻辑，每个 LLM 项目都要原样再来一遍；换一家模型商，请求格式、流式事件、工具定义的 JSON 细节还得跟着改，改漏一处就是一个下午。

Vercel AI SDK 收编的就是这一层：Vercel 出的 TS 库，月下载 2000 万+，TS 侧的 AI 事实标准。思路三条：`streamText` 一个调用包掉调模型、取流、拼帧；工具定义用 zod 写一遍，SDK 翻译成各家 API 要的格式；工具循环 SDK 自己转，你只给步数上限。`ai` 包不绑定 Next.js，Express、NestJS、裸 Node 都能跑；今天用 Route Handler 当载体，因为明天 useChat 要和它配对。

收编不是白吃：第 10 周攒流的坑是 Nginx 干的，框架管不着；流中途断掉，排查时你还是得知道 SSE 报文长什么样。今天每收编一处，都会指给你看手写的那几行去了哪。

## 核心知识

本节代码块都是独立示例，可贴进任意 Next.js 项目跑，最终完整文件以下面的动手任务为准。

### 1. 三个包，三份工

```bash
npm i ai @ai-sdk/openai zod
```

`ai` 是核心运行时，`generateText`、`streamText`、`tool`、`ToolLoopAgent` 全从这里出；`@ai-sdk/openai` 是 model provider，把 OpenAI 的 HTTP 细节翻译成统一接口；`zod` 你在第 3 周就认识了，今天多一个身份：工具的参数 schema。

provider 的用法两行看完：

```ts
import { openai, createOpenAI } from '@ai-sdk/openai';

openai.chat('gpt-4o-mini'); // 默认实例，自动读 OPENAI_API_KEY

const deepseek = createOpenAI({
  baseURL: 'https://api.deepseek.com', // Day 1 传 base_url 的地方，这里同理
  apiKey: process.env.DEEPSEEK_API_KEY,
});
deepseek.chat('deepseek-chat'); // 兼容站只认 Chat Completions，用 .chat()
```

关键在 `openai` 和 `openai.chat` 不是一回事：默认工厂 `openai('gpt-4o-mini')` 走 Responses API，DeepSeek 这类兼容站只实现了 Chat Completions，换兼容站统一用 `.chat()`，别为 404 纠结。

`generateText` 一笔带过，它是不流式的兄弟，一次性等完整结果：

```ts
import { generateText } from 'ai';

const { text } = await generateText({
  model: openai.chat('gpt-4o-mini'),
  prompt: '用一句话解释 SSE',
});
```

后台任务、批量处理这类没人盯着看的场景用它；用户等着看的场景，主角是 `streamText`。

### 2. streamText：14 行接上真流式

```ts
import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai.chat('gpt-4o-mini'),
    messages, // Day 1 手拼的 { role, content } 数组，格式原样进来
    abortSignal: req.signal, // 用户停止或断开，上游模型调用跟着停
  });

  return result.toUIMessageStreamResponse();
}
```

关键在 `streamText` 前面没有 `await`：立刻返回结果对象，生成是惰性的，流被消费才真正跑。`messages` 收的就是 Day 1 那个 `ModelMessage` 数组，两次 `append` 的记忆机制没变，搬运工换了人。`toUIMessageStreamResponse()` 把结果包装成 Response，Next.js 负责泵流。

教程里常见的 `toDataStreamResponse()` 是 v5 的名字，v6 配 useChat 的标准出口是 `toUIMessageStreamResponse()`；报「方法不存在」先查教程是哪年的。

现在兑现行数对比：第 10 周 Day 5 手写版完整文件 34 行（含空行，还是假模型）；上面这段 14 行，接的就是真模型。

| 事项 | 第 10 周手写版 | AI SDK 版 |
| --- | --- | --- |
| 完整代码行数 | 34 行（假模型） | 14 行（真模型） |
| SSE 拼帧 | `f"data: {ch}\n\n"` 逐处手拼 | SDK 生成 |
| 断开检测 | 每轮 `await request.is_disconnected()` | `abortSignal: req.signal` 一行 |
| 响应头 | 手写 `Cache-Control`、`X-Accel-Buffering` | 出口方法内置 |
| 换模型商 | 请求格式自己改 | 换一个 provider 字符串 |

两个注脚：两边语言栈不同，对比的意义不在行数，在传输层细节从你的代码里消失；行数少不等于知识作废——出口吐的仍是 `text/event-stream`，`curl -N` 打它，报文还是 `data:` 一帧一帧地到，Nginx 攒流的坑该防还得防。

### 3. tool()：zod schema 就是 FC schema

本周 Day 2 手写 Function Calling 时，你用 JSON Schema 描述参数：`type: "object"`、`properties`、`required`，一大段 JSON 字面量。AI SDK 里同样的事用 zod 写：

```ts
import { tool } from 'ai';
import { z } from 'zod';

const getWeather = tool({
  description: '查询一个城市的当前天气',
  inputSchema: z.object({
    city: z.string().describe('城市名，例如「上海」'),
  }),
  execute: async ({ city }) => {
    // Day 2 里你自己写的那段业务逻辑，搬进来就是
    return `${city}今天晴，24 度`;
  },
});
```

对照翻译：`z.object()` 就是 `type: "object"` 那层壳，`z.string()`、`z.enum()` 对应 `type` 和 `enum`，`.describe()` 就是字段级的 `description`。SDK 把 zod 转成各家 API 要的格式，同一份工具定义换 provider 一个字不用改——Day 2 自己扛的格式差异，归了 SDK。

多出来的是 `execute`：模型决定调工具后，SDK 拿参数进这里执行，返回值自动作为工具结果回传。Day 2 手写的三步——解析参数、调用真函数、拼 `tool` 消息塞回数组——收编成这一个函数。参数先过 zod 校验，模型瞎填得到的是工具错误，不是服务崩掉。

### 4. 工具循环：stopWhen 与 ToolLoopAgent

Day 2 手写的循环：发请求，看 `finish_reason` 是不是 `"tool_calls"`，是就执行工具、append 结果、再发一次，直到模型不再要工具。这段 while 不需要了：只要工具带 `execute`，`streamText` 收到 `tool_calls` 就自己执行、回传、再推理，你只管给步数上限：

```ts
const result = streamText({
  model: openai.chat('gpt-4o-mini'),
  messages,
  tools: { getWeather },
  stopWhen: isStepCount(5), // 循环最多 5 步，防失控的保险丝
});
```

关键在 `stopWhen: isStepCount(5)`：不配它默认单步，工具执行完循环就停，模型没机会根据结果开口，症状是「工具跑了但没有最终回答」。它也改过名——v5 叫 `maxSteps`，v6 换成 `stopWhen` 加条件函数，还支持组合：`stopWhen: [isStepCount(10), hasToolCall('finalAnswer')]`，谁先到谁收口。

「带工具的循环」本身要复用时，打包成 `ToolLoopAgent`：

```ts
import { ToolLoopAgent, isStepCount } from 'ai';

const agent = new ToolLoopAgent({
  model: openai.chat('gpt-4o-mini'),
  tools: { getWeather },
  stopWhen: isStepCount(5),
});

const result = await agent.generate({ prompt: '上海今天适合跑步吗？' });
console.log(result.text);
```

三样料收进一个对象，`generate`、`stream` 两个入口，背后转的就是第 3 节那个循环。它适合「循环就是全部逻辑」的场景；要插检索、记忆这类自定义步骤，还得回 `streamText` 手动转。W12 的 LangGraph 用图结构做同一件事，今天这个就是对照基线。

## 动手任务：AI SDK 版 `/chat/stream` 一步一步

手册任务：用 AI SDK 重写第 10 周的 `/chat/stream`，对比手写 SSE 的代码量。拆成 5 步，全程约 25 分钟。

**第 1 步：备项目，装包。** 任意 Next.js App Router 项目都行，复用第 2 周的 `apps/web` 或 `npx create-next-app@latest` 新开一个。装三件套：`npm i ai @ai-sdk/openai zod`。key 进 `.env.local`：`OPENAI_API_KEY=sk-...`，Day 1 的规矩原样有效。用 DeepSeek 就照第 1 节写个 provider，后面把 `openai.chat(...)` 换成 `deepseek.chat(...)`。

**第 2 步：写 14 行的最小版。** 新建 `app/api/chat/stream/route.ts`，内容就是核心知识第 2 节那段完整代码。`npm run dev` 起服务。

**第 3 步：curl -N 验收。**

```bash
curl -N -X POST http://localhost:3000/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"用一句话介绍 SSE"}]}'
```

你会看到 `data:` 帧一条条到达，除了文字增量还有开头收尾的几条元信息。字段看不懂没关系，确认两件事就算过：逐帧到达、不是憋到最后一大坨。验收动作搬第 10 周的：`curl -i -N` 看响应头，`Content-Type` 是 `text/event-stream`。收编的是拼帧，协议一个字没换。

**第 4 步：加工具和循环。** 把 `route.ts` 换成完整版：

```ts
import { isStepCount, streamText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const getWeather = tool({
  description: '查询一个城市的当前天气',
  inputSchema: z.object({
    city: z.string().describe('城市名，例如「上海」'),
  }),
  execute: async ({ city }) => {
    return `${city}今天晴，气温 24 度，空气质量优`;
  },
});

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai.chat('gpt-4o-mini'),
    messages,
    tools: { getWeather },
    stopWhen: isStepCount(5),
    abortSignal: req.signal,
  });

  return result.toUIMessageStreamResponse();
}
```

28 行，工具定义占 10 行，业务含量比第 10 周那 34 行高出一截。用第 3 步同样的 curl 换问题：「上海现在多少度？适合跑步吗」。流里先滚过工具事件帧，然后才是文字增量——模型查完天气才开口，这就是自动循环在转。

**第 5 步：做实验，验证保险丝。** 把 `isStepCount(5)` 改成 `1` 再问同一个问题：流在工具执行完就草草收口，最终回答没有了。改回 5。再看 `abortSignal: req.signal`：它就是第 10 周 `is_disconnected` 的 TS 版，curl 起来后 Ctrl+C 掐掉，服务端的上游请求跟着中止，token 计费停在那一刻。

::: tip 验证清单
两样都过才算完成：`curl -N` 逐帧到达且响应头是 `text/event-stream`；带工具的问题先工具事件、后文字。PowerShell 里 `curl` 是别名，用 `curl.exe`，或拿 Postman、Hoppscotch 发 POST。
:::

## 常见踩坑

**坑 1：v5 教程配 v6 包。** `maxSteps`、`parameters`、`toDataStreamResponse` 这些名字，在 v6 里分别变成了 `stopWhen: isStepCount(...)`、`inputSchema`、`toUIMessageStreamResponse()`。照老教程抄报「属性不存在」，第一反应不是改代码，是 `npm ls ai` 对版本。这库迭代快，教程保质期短。

**坑 2：`openai()` 和 `openai.chat()` 混用。** 默认工厂走 Responses API，兼容站只有 Chat Completions，请求直接报错。规则：连 OpenAI 本家随意，连兼容站一律 `createOpenAI({ baseURL, apiKey }).chat('...')`。

**坑 3：工具忘了写 `execute`。** 没有 `execute`，SDK 认为你要自己执行，只把 `tool-call` 透传出来，循环不转。自动循环的前提就一个：`execute` 在。手动接管确实存在，但那是故意的，不是忘了写。

**坑 4：忘了 `abortSignal`。** 功能上测不出来，账单测得出来：用户关了页面，模型接着生成，token 照烧。第 10 周坑 5 的 TS 版，药方从每轮手查变成传一个 signal。

**坑 5：把 `ai` 的调用写进客户端组件。** `streamText` 出现在带 `'use client'` 的文件里，key 就等于贴在浏览器上。调用永远在服务端（Route Handler、Server Action），组件只管接流。明天 useChat 的分工就是它：前端一根管子，后端一台引擎。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `generateText` 和 `streamText` 怎么选？为什么 `streamText` 不加 `await`？

::: details 参考答案
要完整结果做后处理（后台任务、批量）用 `generateText`；要用户边生成边看用 `streamText`。它立刻返回结果对象，生成是惰性的，流被消费才真正跑，Route Handler 返回 `toUIMessageStreamResponse()` 后由框架泵流。
:::

2. `inputSchema: z.object({...})` 最终变成了请求里的什么？比 Day 2 手写的省在哪？

::: details 参考答案
转换成模型 API 要求的工具参数 JSON Schema。省三处：不手写 `type`/`properties`；换 provider 格式 SDK 翻译；回传参数先过 zod 校验，坏参数是工具错误不是崩溃。
:::

3. 工具循环自动转起来的条件是什么？`stopWhen: isStepCount(5)` 防的是什么？

::: details 参考答案
条件是工具带 `execute`：SDK 收到 `tool_calls` 就执行、回传、继续推理，直到模型不再要工具或步数用完。`stopWhen` 防无限调工具烧钱；不配默认单步，模型没机会根据结果说话。
:::

4. `abortSignal: req.signal` 一行替掉了第 10 周的哪个写法？语义差在哪？

::: details 参考答案
替掉循环里每轮手写的 `await request.is_disconnected()`。升级在于不只「断开就 break」，而是把 abort 传给上游模型请求，生成在模型那侧就中止，计费停在那一刻。
:::

5. `toUIMessageStreamResponse()` 吐出来的还是 SSE 吗？怎么亲手证明？

::: details 参考答案
是。`curl -i -N` 看响应头 `Content-Type: text/event-stream`，正文是逐条 `data:` 帧。第 10 周的报文知识全部有效，SDK 只是收走拼帧的活，往帧里放结构化事件，明天 useChat 吃的就是这股流。
:::

## 延伸阅读

- [AI SDK 文档：streamText 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)，本篇主角的一手说明，参数与事件逐个列全
- [AI SDK 文档：Tools 与 Tool Calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)，`tool()` 的完整能力与进阶钩子
- [AI SDK 文档：Building Agents](https://ai-sdk.dev/docs/agents/building-agents)，`ToolLoopAgent` 的官方用法，W12 的对照起点
- [OpenAI Provider 文档](https://ai-sdk.dev/providers/ai-sdk-providers/openai)，`createOpenAI`、`.chat()` 与兼容站接入的细节

今天的 `route.ts` 留好。明天 useChat 把前端也收编：fetch、拼帧解析、停止按钮全部一行换掉，接的就是今天这股流。进度见[本周日程](/week11/)。
