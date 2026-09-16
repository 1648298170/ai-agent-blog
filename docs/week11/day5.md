# 第 11 周 · Day 5：AI SDK 前端 useChat——一个 Hook 顶掉上周一整个流式循环

> 对应手册任务：学习「AI SDK 前端：useChat、数据流协议、流式 Markdown 渲染、needsApproval 工具审批」，动手用 useChat 重写第 10 周的前端对话页，并给工具加一道「用户批准才执行」的闸门，当日产出「AI SDK 版对话页面」。本篇只解决一个问题：上周手写的 fetch + reader 循环只认得「纯文本」一种内容，模型回复一旦混进工具调用，前端就没有字可拼了；换 useChat 后，状态、协议解析、中断、审批全部装进一个 Hook，而你要做的第一件事，是搞清楚它到底替你写了什么。

## 今日目标

1. 说得清 useChat 全家桶（messages、input、handleSubmit、status、stop、onFinish）分别顶掉了上周手写的哪一段
2. 看懂 AI SDK 数据流协议的帧：还是 SSE，还是按空行分帧，只是 `data:` 里装了带 type 的 JSON，文本、工具调用、数据部件各走各的帧
3. 跑通 AI SDK 版对话页：流式 Markdown 不再群魔乱舞，工具先弹批准/拒绝按钮，点批准后服务端才真正执行

## 概念讲解：为什么上周的循环该退休了

先把上周的账翻出来。第 10 周 Day 6 的 Chat.tsx：三个 useState、一个存 AbortController 的 useRef、一个 appendDelta、一个 40 多行的 send()——fetch、getReader、TextDecoder、buffer 累积、split 分帧、pop 留尾巴，全在里面。它能跑，但有个当时没暴露的局限：解析器只认一种帧，`data:` 后面的裸文本。正文之外，它什么都不认识。

昨天后端换成 streamText 之后，流里的内容就不只是文字了。模型可能先说半句「我帮你下一单」，接着发起工具调用，参数一个字一个字流过来，然后工具结果回来，模型接着把话说完。这一串事件用裸文本帧表达不了，上周的解析器就算不报错，也只能把工具参数当正文拼进页面，屏幕上糊一坨 JSON。

两条路：继续手写，自己设计一套带类型的帧格式再配一个分发器；或者换成 AI SDK 的数据流协议加 useChat。选后者不只是省事：这套协议在 TS 生态里已经是事实标准，后端吐这种帧，AI SDK 整个前端组件生态都能直接消费；协议本身只是线上的字节约定，跟语言无关，将来想在 Python 后端里手吐也行。useChat 则是官方配好的消费端，状态机、中断、连今天的工具审批，都留好了位置。

上周的手写不白学。今天打开 DevTools 看 useChat 收到的帧，你一眼认得出那是 SSE、按空行分帧——上周的底层功夫从此负责替你导航。先裸写再上框架，这正是本周 Day 1 说过的原则：框架替你写的东西，你得知道它写的是什么。

## 核心知识

### 1. useChat 全家桶：逐个对上上周的代码

最小的能跑骨架：

```tsx
"use client";

import { useChat } from "@ai-sdk/react";

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, status, stop } =
    useChat();
  // 渲染见后面几节
}
```

第一行还是 `"use client"`，上周讲过的客户端边界没变。全家桶与上周手写代码的对照：

| useChat 给的 | 顶掉上周的 |
| --- | --- |
| messages | useState 加 appendDelta |
| input 加 handleInputChange | 输入框的 state 加 onChange |
| handleSubmit | 整个 send()：fetch、getReader、decode、buffer、split、pop |
| status | streaming 布尔，且从两态变四态 |
| stop() | AbortController、abortRef、catch AbortError |
| onFinish | 上周没写，完成收尾今天补 |

status 单独说：四个值是 submitted（请求已发、还没第一个字）、streaming（正在流入）、ready（空闲）、error（出错）。上周的布尔把前两个阶段压成一团，从布尔迁移过来最容易漏的就是这里——「进行中」是两个状态，不是一个。onFinish 是完成回调，整条回复流完触发一次，参数是完整的 assistant 消息，记账、起标题这类收尾放这。

关键在 useChat 的参数对象：transport 管请求发去哪（上周 fetch 那行 URL 的配置化身影，不写则默认 `/api/chat`），sendAutomaticallyWhen 管「满足什么条件自动再发」，onFinish 管完成回调。这三个今天后面全会用到。

### 2. 数据流协议：线上的帧长什么样

对着昨天 `/api/chat` 的响应开 DevTools，你会看到熟悉的形状：Content-Type 还是 `text/event-stream`，帧还是 `data:` 打头、空行收尾，上周的分帧知识原样适用。变化在 `data:` 的正文：不再是裸文本，是带 type 字段的 JSON。线上真实的样子：

```text
data: {"type":"text-delta","id":"msg_68679...","delta":"你好"}

data: {"type":"tool-input-delta","toolCallId":"call_fJdQ...","inputTextDelta":"2"}
```

第一帧是文本增量，delta 就是你上周 onDelta 交出去的那个字，只是包了一层身份。第二帧是工具参数增量：模型一边决定调工具，一边把参数当文本流出来。此外还有 start 与 finish（收尾帧，finishReason 就在里面）、工具结果帧、`data-` 开头的数据部件（后端往前端塞任意结构化数据的正道，比如流式进度）。useChat 的工作就是把这一串帧翻译成 messages 里的部件。

为什么学了 Hook 还要看协议？两个理由。排障时要分清「后端没发」还是「前端没渲染」，EventStream 面板（上周 Day 7 练过的）里看到的就是这些帧，认识 type 等于拿到日志的钥匙。二是这协议是 TS 生态的事实标准，第 13 周起你自己的任何后端只要吐这种帧，前端组件全部白拿。

### 3. parts 数组与流式 Markdown：还上周坑 4 的债

换 useChat 后第一个不习惯：消息上没有 content 了。UIMessage 的形状是 `{ id, role, parts: [...] }`，一条回复是一个部件列表。为什么必须变？因为一条回复已经不是「一段文字」，是「文字夹着工具调用再夹着文字」的序列，一个字符串塞不下。渲染逻辑相应从「打印 content」变成「按部件分发」。

文本部件的渲染，顺手把上周坑 4 欠的流式 Markdown 还上：

```tsx
if (part.type === "text") {
  return <ReactMarkdown key={i}>{part.text}</ReactMarkdown>;
}
```

流式为什么不再群魔乱舞：每个 delta 到达，useChat 更新 messages，React 重渲染，react-markdown 拿到的是「这个部件到目前为止的全文」，从头重新解析一遍。关键在它对未闭合语法的态度：代码围栏开了没关，就当作「围栏还开着」渲染，看起来是一个正在生长的代码块；列表、加粗这类短语法闪半拍就稳定。上周的 `pre-wrap` 纯文本可以退休了。想吹毛求疵，表格流到一半的毛边有专门的流式 Markdown 组件（Vercel 出过 streamdown），先用 react-markdown 足够。光标沿用上周的 `.cursor` CSS，一字不改。

### 4. needsApproval：工具执行前的刹车

昨天的工具有个前提没说破：模型决定调用，execute 立刻就跑。查天气无所谓，但下单、发邮件、删数据这类动作，模型决定不等于可以干。needsApproval 就是给 tool 加的闸门。

服务端，在昨天路由的工具定义里加一行：

```ts
import { streamText, tool, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: openai("gpt-4o-mini"), // 换成你昨天用的模型
    messages: convertToModelMessages(messages),
    tools: {
      createOrder: tool({
        description: "替用户创建订单。执行前必须获得用户批准。",
        inputSchema: z.object({ item: z.string(), quantity: z.number() }),
        needsApproval: true, // 也可写成 async 函数，按参数内容决定要不要审批
        execute: async ({ item, quantity }) => {
          console.log(`[真的执行了] ${quantity} × ${item}`);
          return { ok: true, orderId: "A-" + Math.floor(Math.random() * 1000) };
        },
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}
```

关键一行是 `needsApproval: true`：工具调用照常流向前端，但 execute 压着不跑，前端部件停在「待批准」状态。客户端两处配合：

```tsx
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";

const { messages, input, handleInputChange, handleSubmit, status, stop, addToolApprovalResponse } =
  useChat({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
```

渲染部件时，类型按工具名动态生成，工具叫 createOrder，部件类型就是 `"tool-createOrder"`：

```tsx
if (part.type === "tool-createOrder") {
  switch (part.state) {
    case "approval-requested": // 等用户表态，按钮在这
      return (
        <div key={part.toolCallId} style={{ border: "1px solid #94a3b8", padding: 8, borderRadius: 8 }}>
          模型想下单：{part.input.quantity} × {part.input.item}，批准吗？
          <button onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: true })}>
            批准
          </button>
          <button onClick={() => addToolApprovalResponse({ id: part.approval.id, approved: false })}>
            拒绝
          </button>
        </div>
      );
    case "output-available": // 批准后执行完，结果在这
      return <div key={part.toolCallId}>订单已创建：{part.output.orderId}</div>;
    case "output-denied": // 拒绝了，模型会收到这个事实
      return <div key={part.toolCallId}>这次下单被你拒绝了。</div>;
  }
}
```

按钮背后发生了什么，是今天最要紧的一段：addToolApprovalResponse 只是把「用户点了啥」写回消息状态；真正推动流程的是 sendAutomaticallyWhen 那行——最后一条消息上所有待审批项都有了答复，useChat 自动把带着答复的完整历史重新 POST 回 `/api/chat`。服务端这回看到批准，execute 才真正执行，结果以 output-available 流回来；拒绝则给模型一个 output-denied 的事实，它会换个说法继续聊。一句话：审批是货真价实的第二轮请求，不是前端本地变戏法。第 13 周 Human-in-the-Loop 的主菜在 Python 侧，概念一模一样：关键动作之前，把控制权交还给人。

## 动手任务：AI SDK 版 Chat 页一步一步

手册任务：用 useChat 重写第 10 周的前端对话页，加一个需批准才执行的工具。拆成 5 步，全程约 40 分钟，接着昨天的 Next.js 项目写。

**第 1 步：改后端路由，装包。** 把核心知识第 4 节的路由写进 `app/api/chat/route.ts`；昨天已有文件的，只加 tools 这段。`console.log` 是后面验证「执行没执行」的探针，别删。执行 `npm install ai @ai-sdk/react @ai-sdk/openai zod react-markdown`，缺哪个装哪个。

**第 2 步：组件骨架换血。** `components/Chat.tsx` 整个替换，先把基本对话跑通：

```tsx
"use client";

import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { useChat } from "@ai-sdk/react";

export default function Chat() {
  const { messages, input, handleInputChange, handleSubmit, status, stop, addToolApprovalResponse } =
    useChat({
      transport: new DefaultChatTransport({ api: "/api/chat" }),
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    });

  const busy = status === "submitted" || status === "streaming";

  return (
    <div style={{ maxWidth: 560, margin: "40px auto" }}>
      {messages.map((m) => (
        <div key={m.id} style={{ textAlign: m.role === "user" ? "right" : "left", margin: "8px 0" }}>
          {m.parts.map((part, i) => {
            if (part.type === "text") {
              return (
                <span
                  key={i}
                  style={{
                    display: "inline-block",
                    padding: "8px 12px",
                    borderRadius: 8,
                    background: m.role === "user" ? "#dbeafe" : "#f1f5f9",
                  }}
                >
                  {part.text}
                  {busy && m.role === "assistant" && <span className="cursor" />}
                </span>
              );
            }
            return null; // 工具部件第 4 步补
          })}
        </div>
      ))}

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input
          value={input}
          onChange={handleInputChange}
          style={{ flex: 1, padding: 8 }}
          placeholder="输入消息，回车发送"
        />
        {busy ? (
          <button type="button" onClick={stop}>停止</button>
        ) : (
          <button type="submit">发送</button>
        )}
      </form>
    </div>
  );
}
```

上周 send() 里的 40 多行，现在整个没了。停止按钮用 `type="button"` 免得触发表单提交；`busy` 把 submitted 和 streaming 都算上，对照表里说过的迁移坑就在这。`npm run dev` 起来，发一句话，逐字输出、光标、停止按钮应该全在——这些白送了。

**第 3 步：文本部件换 Markdown。** 顶部 `import ReactMarkdown from "react-markdown"`，把第 2 步里渲染 `part.text` 那处换成核心知识第 3 节的写法（外层 span 样式保留，光标挪到 ReactMarkdown 后面）。实验：让模型「写一段 Python 代码并逐行解释」，盯着代码围栏在流式过程中长出来，对比上周 `pre-wrap` 的观感。上周坑 4 的债，到此结清。

**第 4 步：加审批 UI。** 在 parts 分发里补上核心知识第 4 节那段 `tool-createOrder` 的 switch。输入「帮我下 2 杯咖啡的单」，模型触发工具后页面上应该出现批准/拒绝按钮，此刻后端控制台没有任何输出——execute 被闸门拦着。

**第 5 步：三连实验收尾。** ①普通提问，看流式 Markdown；②触发下单后点「批准」，后端控制台打出 `[真的执行了] 2 × 咖啡`，前端几秒内变成订单号；③再触发一次点「拒绝」，看模型收到 output-denied 后怎么把话接下去。最后打开 DevTools 的 EventStream 面板，认一认 `text-delta` 帧和工具相关帧，上周 Day 7 的技能直接复用。

::: tip 验证清单
三样都过才算完成：逐字输出加代码块正常生长；点批准前服务端无执行日志、点批准后才有；点拒绝后对话继续且订单没创建。报错先看浏览器 Network 里 `/api/chat` 的响应帧，再决定查前端还是后端。
:::

## 常见踩坑

**坑 1：到处找 message.content，结果是 undefined。** AI SDK 的消息是 parts 数组，没有 content 字段。渲染一律按部件分发：`text` 给 Markdown，`tool-xxx` 给工具卡片。从上周的 `m.content` 迁移过来，这是第一处要改的肌肉记忆。

**坑 2：把 transport 指向上周的 FastAPI。** useChat 打的是同源 `/api/chat`，期待的是 AI SDK 数据流协议的帧；上周 `/chat/stream` 吐的裸文本帧它读不懂，接上去要么报错要么空白。协议不同的两条管子，别拿 URL 硬接。

**坑 3：点批准没反应。** 两个嫌疑：sendAutomaticallyWhen 没配，答复只是停在本地等下一次发送，补上那行配置；或者 addToolApprovalResponse 的 id 传了 toolCallId，要传的是 `part.approval.id`，两个 id 不是一回事。

**坑 4：停止按钮只在 streaming 时出现。** submitted 阶段（已发出、没第一个字）也是进行中，用户此刻最想反悔。条件用 `status !== "ready"` 或第 2 步的 busy 写法，把两个状态都盖住，error 态另给提示。

**坑 5：把部件原样丢给 Markdown。** 喂给 ReactMarkdown 的必须是 `part.text` 纯文本，手滑写了 `JSON.stringify(part)` 就会把大括号渲染成代码块。另外代码块生长、表格半截是流式的正常毛边，不是 bug，介意就上 streamdown。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 全家桶六个成员，分别顶掉上周的哪段代码？

::: details 参考答案
messages 顶掉消息 state 和 appendDelta；input 加 handleInputChange 顶掉输入框 state 和 onChange；handleSubmit 顶掉整个 send()（fetch、getReader、decoder、buffer、分帧三件套全在里面）；status 顶掉 streaming 布尔并升为四态；stop() 顶掉 AbortController 那套；onFinish 是上周没写的完成回调，收尾逻辑归它。
:::

2. 数据流协议的帧和上周的裸文本帧差在哪？工具参数怎么流过来？

::: details 参考答案
外层没变：还是 SSE，`data:` 打头、空行分帧。变的是正文：从裸文本变成带 type 的 JSON。文本走 `text-delta` 的 delta 字段；工具参数走 `tool-input-delta`，模型一边决定调用一边把参数当文本增量流出，另有 start/finish、工具结果、`data-` 数据部件等帧型。
:::

3. 消息为什么从 content 字符串变成 parts 数组？渲染逻辑相应变成什么？

::: details 参考答案
一条回复不再是「一段文字」，而是文字、工具调用、数据部件的序列，一个字符串表达不了顺序和结构。渲染从「打印 content」变成「按部件类型分发」：text 部件进 Markdown，tool-xxx 部件按 state 渲染审批按钮或结果。
:::

4. 点下「批准」按钮后，系统里发生了什么？execute 在哪一轮请求里执行？

::: details 参考答案
addToolApprovalResponse 把答复写回消息状态；sendAutomaticallyWhen 检测到最后一条消息的待审批项都有了答复，自动把完整历史重新 POST 回 /api/chat。execute 在这第二轮请求里、服务端看到批准后才执行，结果以 output-available 部件流回前端。所以审批是真请求，不是前端本地改状态。
:::

5. status 有哪四个值？停止按钮的显示条件该怎么写？

::: details 参考答案
submitted（已发出、还没第一个字）、streaming（正在流入）、ready（空闲）、error（出错）。「进行中」覆盖前两个，条件写 `status !== "ready"` 或 submitted 与 streaming 的显式组合；error 态单独给错误提示，别和停止按钮混在一起。
:::

## 延伸阅读

- [AI SDK：UI Message Stream Protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)，今天所有帧类型的原始出处，`data-` 数据部件的用法后面做生成 UI 时还要回来查
- [AI SDK Cookbook：Human in the Loop](https://ai-sdk.dev/cookbook/next/human-in-the-loop)，今天审批闸门的官方完整配方，服务端与客户端两端代码都有
- [react-markdown](https://github.com/remarkjs/react-markdown)，流式 Markdown 的地基，README 里的组件映射表值得扫一眼，第 13 周做工具卡片还用得上

今天的 AI SDK 版对话页留好。第 13 周 Human-in-the-Loop 上主菜时，这个批准按钮你已经亲手按过一轮；parts 这个结构也会一直用下去，后面 Agent 的工具卡片、引用来源、生成 UI，全在它上面长。后面几天的安排见[本周日程](/week11/)。
