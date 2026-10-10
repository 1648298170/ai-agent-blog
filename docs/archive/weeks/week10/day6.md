# 第 10 周 · Day 6：前端消费 SSE——fetch 流式读取，逐字渲染

> 对应手册任务：学习「前端消费 SSE：React + EventSource 或 fetch 流」，动手在 Next.js 中写一个组件消费 SSE、逐字渲染，当日产出前后端流式联调。本篇只解决一个问题：Day 5 的 `/chat/stream` 已经在逐字吐了，浏览器怎么把吐出来的字一帧一帧接住、实时画到页面上，还能随时喊停。

## 今日目标

1. 说得清 `EventSource` 的两条硬伤，以及为什么 Agent 接口基本绕不开手写 `fetch` + `ReadableStream`
2. 掌握流式消费的完整链路：POST 带 headers、`reader.read()` 循环、`TextDecoder` 增量解码、按空行分帧解析 `data:` 行
3. 独立完成 `Chat` 组件：逐字渲染、光标闪烁、停止按钮，和 Day 5 的端点联调跑通

## 概念讲解：为什么 EventSource 不够用

后端就绪，前端接 SSE 最省事的路是浏览器原生的 `EventSource`：

```ts
const es = new EventSource("http://localhost:8000/chat/stream");
es.onmessage = (e) => console.log(e.data); // 每条 data: 行自动送到这里
```

五行代码，自动重连、自动解析 `data:` 行、断线自动补发，看着完美。但对一个 Agent 服务，它有两条硬伤，条条致命：

第一条，**只能 GET**。构造函数只收一个 URL，method 没法设，请求体更没地方放。而聊天接口天然是 POST：用户消息要放 JSON body 里，对话历史往后也要跟着走。URL 拼参数塞一句话还能忍，塞十轮对话历史就是行为艺术了。

第二条，**不能带自定义请求头**。Agent 服务迟早要鉴权，`Authorization: Bearer xxx` 这种头 `EventSource` 塞不进去。`withCredentials` 只管 cookie，前后端分离加 token 的方案下帮不上忙。这两条撞上任何一条，`EventSource` 就废了，而我们两条全占。

顺带还有个隐患：它的自动重连对聊天场景是灾难。用户问到一半网断了，三秒后 `EventSource` 默认重连，可 POST 的上下文它带不过去，服务端不知道该从哪个字续发。流式对话宁可断了就断，让用户自己决定重不重发。

所以主路线只剩一条：**`fetch` + `ReadableStream` 手写消费**。fetch 能 POST、能带任意头，`response.body` 就是一条字节流，读取、解析、中断全由你控制。代价是 `EventSource` 白送的三件事现在都得自己干：拆包、解析 `data:` 行、处理断流。今天整个下午就练这个。

## 核心知识

### 1. SSE 报文长什么样：前端到底在解析什么

先看后端在线上吐的原文。Day 5 的端点逐字返回一段文本，TCP 里实际流动的字节是这个样子：

```text
data: 你

data: 好

data: ，

```

SSE 协议就三条规则，记住够用：

1. 一条消息由若干行组成，`data:` 打头的是数据行
2. 消息之间用一个空行（也就是 `\n\n`）分隔
3. 流本身没有「结束消息」标记，连接断了或者读完了就是结束

关键认知：**`fetch` 拿到的既不是「一行」也不是「一条消息」，而是一段一段的原始字节**。网络层按自己的心情切包，一个 chunk（一次 `read()` 的返回）可能是半条消息、恰好一条、或者三条半。把 chunk 当消息解析，偶发丢字、偶发报错，查起来要人命。所以正确的姿势是：字节累积进 buffer，按 `\n\n` 分帧，帧里的行再剥 `data:` 前缀。下面的代码严格照这个流程走。

### 2. fetch + ReadableStream：请求怎么发，流怎么读

先发请求。和普通 fetch 唯一的差别是：拿到 response 后不调 `await response.json()`。流式响应等全量就输了，全量要等 30 秒后才存在。

```ts
const response = await fetch("http://localhost:8000/chat/stream", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer dev-token", // EventSource 塞不进来的那个头
  },
  body: JSON.stringify({ message: "介绍一下 SSE" }),
  signal: controller.signal, // AbortController，停止按钮靠它，后面讲
});

const reader = response.body!.getReader(); // 拿到读取器，从此流的控制权归你
const decoder = new TextDecoder("utf-8"); // 字节转字符串
```

关键一行是 `response.body!.getReader()`：`body` 的类型是 `ReadableStream<Uint8Array>`，`getReader()` 把流锁给当前读取器，之后只能通过它消费。然后是今天的心脏，读取循环：

```ts
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break; // 流关了

  buffer += decoder.decode(value, { stream: true });

  const frames = buffer.split("\n\n"); // 按空行分帧
  buffer = frames.pop() ?? ""; // 最后一段可能只有半条消息，留回 buffer 等下个 chunk

  for (const frame of frames) {
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) {
        onDelta(line.slice(5).replace(/^ /, "")); // 剥掉 "data: " 前缀，交出正文
      }
    }
  }
}
```

五处各司其职，一处都不能省：

- `await reader.read()`：有新数据就返回一段 `Uint8Array`，流关闭时 `done` 为 `true`。注意它和 SSE 消息没有对应关系，这是第 1 小节说的关键认知的代码落点。
- `decoder.decode(value, { stream: true })`：`stream: true` 让 decoder 把「切在字符中间的半个字」记在肚子里，等下个 chunk 拼上再输出。中文字符在 UTF-8 里占三个字节，chunk 正好切在中间时，不带这个标志会解码出乱码。丢字丢在第一个字，就是这个坑。
- `buffer` 累积：半条消息的落脚点。
- `frames.pop()`：`split` 出来的最后一段后面可能还没等到 `\n\n`，是不完整的帧，必须留回 buffer。这一行是「chunk 当消息解析」这个坑的解药。
- `line.slice(5).replace(/^ /, "")`：剥掉 `data:` 前缀和它后面的一个空格，剩下的就是这一帧的正文。

如果你的 Day 5 端点吐的不是纯文本而是 JSON（比如 `data: {"delta":"字"}`），只改 `onDelta` 那一行：先 `JSON.parse(line.slice(5))`，再把 `.delta` 交出去。解析框架一个字不用动。

### 3. React 侧：'use client'、增量拼接与光标

**组件第一行必须是 `'use client'`。** 第 2 周讲服务端/客户端组件边界时说过：服务端组件在 Node 里跟着请求走一轮就结束，而消费 SSE 要在用户浏览器里挂着循环持续读、持续更新 UI，这是纯粹的客户端行为。hooks、DOM 事件、`response.body`，全都是只有浏览器里才存在的东西。忘了这一行，Next.js 报错会报得很有礼貌但很坚决。

状态就一个数组：

```ts
interface Message {
  role: "user" | "assistant";
  content: string;
}

const [messages, setMessages] = useState<Message[]>([]);
```

流式渲染的技巧在「**占位 + 拼接**」：发送时先压入用户消息和一条空的 assistant 消息，流式期间不新增数组元素，只往最后一条里拼：

```ts
function appendDelta(delta: string) {
  setMessages((prev) => {
    const next = [...prev];
    const last = next[next.length - 1];
    next[next.length - 1] = { ...last, content: last.content + delta };
    return next;
  });
}
```

关键在函数式更新 `setMessages((prev) => ...)`：读取循环是个长期运行的 async 函数，闭包里的 `messages` 是发起那一刻的旧值，直接 `setMessages([...messages, ...])` 会把流式期间用户可能的操作全部覆盖掉。永远从 `prev` 出发，这是 React 状态的第一纪律。

光标闪烁是纯 CSS，一个方块 span 加无限循环的透明度动画：

```css
.cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  animation: blink 0.8s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
```

中断用 `AbortController`。发起前 `new` 一个，`signal` 塞进 fetch 配置，停止按钮调 `controller.abort()`。abort 之后，还在 `await reader.read()` 挂着的那个循环会立刻抛出 `AbortError`，用 `try/catch` 接住、静默收尾。这个按钮不只是体验优化——下周接真实 LLM 后，模型按输出 token 计费，用户觉得答案够了就停，后半段的 token 就不用付。今天写按钮，明天省钱。

## 动手任务：Chat 组件一步一步

手册任务：在 Next.js 中写一个组件消费 SSE，逐字渲染。拆成 5 步，全程约 40 分钟。

**第 1 步：后端开 CORS 白名单。** Next.js 跑在 3000 端口，FastAPI 跑在 8000 端口，跨域。而且我们的请求带 `Authorization` 头，浏览器会先发 OPTIONS 预检，FastAPI 默认对预检一律拒绝。在 FastAPI 的应用入口（Day 1 建的 `main.py`）加上：

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # 白名单，写 Next.js 的地址
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

第 5 周在 Node 侧配过 CORS 的概念（预检、白名单、允许的头），今天原样搬到 Python 侧落地。两个细节：`allow_origins` 里的地址要带协议、带端口，少一个都匹配不上；别图省事写 `["*"]`，通配符和 `allow_credentials=True` 组合时浏览器规范直接不允许，凭证场景下老老实实写白名单。

另外确认 Day 5 的端点开了 POST。如果当时只挂了 GET，把装饰器换成 `@app.post("/chat/stream")`，或者两个都挂。前端今天全程用 POST 调它。

**第 2 步：建组件骨架。** 在 Next.js 项目的 `components/Chat.tsx` 写下第一行 `'use client'`，然后把类型和状态铺好：

```tsx
"use client";

import { useRef, useState } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function appendDelta(delta: string) {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, content: last.content + delta };
      return next;
    });
  }

  // 第 3 步的 send() 写在这里
}
```

`abortRef` 用 `useRef` 存而不是 `useState`：controller 是个工具对象，不参与渲染，塞进 state 反而会触发无意义的重绘。

**第 3 步：写 `send()`，流式消费的核心。** 把核心知识第 2 小节的循环装进函数，串上状态：

```tsx
  async function send() {
    if (!input.trim() || streaming) return;
    const question = input;
    setInput("");

    const controller = new AbortController();
    abortRef.current = controller;

    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "" }, // 占位，流式期间往这条里拼
    ]);
    setStreaming(true);

    try {
      const response = await fetch("http://localhost:8000/chat/stream", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer dev-token",
        },
        body: JSON.stringify({ message: question }),
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              appendDelta(line.slice(5).replace(/^ /, ""));
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") throw error; // 停止不算错
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }
```

两个动作值得盯一眼：发送时先 `setInput("")` 再用局部变量 `question`，避免闭包里拿到被清空的输入；`finally` 里收尾 `streaming`，正常结束和手动停止走的是同一扇门。

**第 4 步：渲染消息列表 + 光标。** 在组件里补上 JSX 和停止按钮：

```tsx
  function stop() {
    abortRef.current?.abort();
  }

  return (
    <div style={{ maxWidth: 560, margin: "40px auto" }}>
      {messages.map((m, i) => (
        <div key={i} style={{ textAlign: m.role === "user" ? "right" : "left", margin: "8px 0" }}>
          <span
            style={{
              display: "inline-block",
              padding: "8px 12px",
              borderRadius: 8,
              background: m.role === "user" ? "#dbeafe" : "#f1f5f9",
              whiteSpace: "pre-wrap", // 保住换行，先纯文本渲染，原因见踩坑
            }}
          >
            {m.content}
            {m.role === "assistant" && i === messages.length - 1 && streaming && <span className="cursor" />}
          </span>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          style={{ flex: 1, padding: 8 }}
          placeholder="输入消息，回车发送"
        />
        {streaming ? <button onClick={stop}>停止</button> : <button onClick={send}>发送</button>}
      </div>
    </div>
  );
```

光标只在「最后一条 assistant 消息且还在流式中」渲染。光标的 CSS 加进 `app/globals.css`（核心知识第 3 小节那段原样贴入）。

**第 5 步：接入页面，联调。** 把 `app/page.tsx` 换成：

```tsx
import Chat from "@/components/Chat";

export default function Home() {
  return <Chat />;
}
```

::: tip 联调命令
两个终端各起一个：终端一按 Day 1 的方式启动 FastAPI（形如 `uvicorn main:app --reload`，端口 8000）；终端二在 Next.js 项目里 `npm run dev`（端口 3000）。浏览器打开 `http://localhost:3000`，发一句话，应该看到回复一个字一个字蹦出来，右下角光标在闪，流式中按钮变「停止」，点停即断。
:::

## 常见踩坑

**坑 1：直接拿 chunk 当消息解析。** 最省事的写法是拿到 `value` 就 `decoder.decode()` 然后 `JSON.parse` 或者当一行用，测试时看着也通——因为本机网络快、帧小，一个 chunk 恰好一条消息的概率很高。一上真实环境就偶发丢字、解析报错。记住结论：chunk 和消息没有任何对应关系，`buffer` + `split("\n\n")` + `frames.pop()` 留尾巴，这三件套一个不能少。

**坑 2：中文第一个字乱码。** `decoder.decode(value)` 不带 `{ stream: true }`，遇到 chunk 正好切在多字节字符中间，会输出替换符 U+FFFD。症状很有辨识度：每次流式输出的第一个字是个问号方块，后面的都正常——因为切在字符中间的概率低，只有开头的对齐最容易撞上。补上 `stream: true` 即可，decoder 自己会攒不完整的字节。

**坑 3：点停止，控制台一片红。** `controller.abort()` 之后，挂着的 `await reader.read()` 会以 `AbortError` 拒绝，没人接就是未捕获错误。代码里的处理是 `catch` 判断 `error.name !== "AbortError"` 才往上抛，主动停止静默收尾。另外别在 `finally` 里再去读 `reader`，abort 之后再读只会再抛一次。

**坑 4：流式期间上 markdown 渲染，画面群魔乱舞。** 想当然地在消息上套 `react-markdown`，流到一半时 ```` ```python ```` 代码围栏开了没关，高亮器把后面所有文本当代码染；列表符号渲染到一半又收回，字在跳。渐进渲染 markdown 需要专门的流式方案处理「半截语法」，本周先 `white-space: pre-wrap` 纯文本渲染，观感已经够好。后面用 Vercel AI SDK 的周次里有现成的流式 markdown 组件，到时候一行换掉。

**坑 5：CORS 配了还是报错。** 按顺序查三处：`allow_origins` 里的地址带没带协议和端口（`localhost:3000` 不等于 `http://localhost:3000`）；fetch 的 URL 和后端实际端口对不对；浏览器控制台Network 面板里预检 OPTIONS 请求的状态码是不是 204。还有一种：开发模式 StrictMode 会让组件逻辑跑两遍，如果流请求发在了 `useEffect` 里会收到两次流。今天的请求挂在按钮点击里，天然躲开；往后挪进 effect 时，记得在 cleanup 里 `abort()`。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `EventSource` 的两条硬伤是什么？为什么聊天接口两条全占？

::: details 参考答案
只能 GET（没法带请求体，对话历史没地方放）；不能带自定义请求头（`Authorization: Bearer` 塞不进去，Agent 服务鉴权直接废）。聊天接口天然 POST + 鉴权，两条全撞。
:::

2. `reader.read()` 返回的一个 chunk，和 SSE 的一条消息是什么关系？

::: details 参考答案
没有关系。chunk 是网络层任意切割的字节段，可能是半条消息、一条或几条半。消息边界只能靠 SSE 协议的空行（`\n\n`）自己切：累积进 buffer，split 分帧，最后一段不完整地留回 buffer 等下一个 chunk。
:::

3. `decoder.decode(value, { stream: true })` 的 `stream: true` 去掉会怎样？

::: details 参考答案
遇到 chunk 切在多字节字符（中文三字节）中间时，decoder 无法解码那半个字，输出替换符 U+FFFD，表现为丢字或问号方块。带上 `stream: true` 后 decoder 把不完整字节暂存，下个 chunk 到来拼上再输出。
:::

4. 点了停止按钮之后，代码里发生了什么？

::: details 参考答案
`controller.abort()` 让正在 `await` 的 `reader.read()` 立刻以 `AbortError` 拒绝，循环中断进入 `catch`；判断 `error.name === "AbortError"` 静默处理，其他错误照常抛；`finally` 里把 `streaming` 收成 `false`，按钮换回「发送」。
:::

5. 增量拼接为什么必须 `setMessages((prev) => ...)`，直接用外面的 `messages` 变量会怎样？

::: details 参考答案
读取循环是个长期挂着的 async 函数，闭包捕获的是它启动那一刻的 `messages`。流式期间任何其他更新（包括下一次流式）都会被旧闭包覆盖回去，出现「闪一下又消失」。函数式更新每次从最新 `prev` 出发，不依赖闭包里的旧值。
:::

## 延伸阅读

- [MDN：使用服务器发送事件](https://developer.mozilla.org/zh-CN/docs/Web/API/Server-sent_events/Using_server-sent_events)，`EventSource` 的官方用法与 SSE 协议细节，读完你会更清楚它替你干了什么、我们又为什么手写
- [MDN：ReadableStream](https://developer.mozilla.org/zh-CN/docs/Web/API/ReadableStream)，`getReader()`、`read()`、`done/value` 语义的权威定义，今天循环的每一行都出自这里
- [MDN：AbortController](https://developer.mozilla.org/zh-CN/docs/Web/API/AbortController)，中断 fetch 与流读取的完整说明，包括 `abort()` 后各处 Promise 的表现

今天的产出 `Chat.tsx` 留好，Day 7 拿 curl 和浏览器分别再压一遍端点；往后接真实 LLM 时，这个组件只换 URL 和报文格式，循环一行不用改。
