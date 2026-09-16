# 第 20 周 · Day 5：流式对话 + 思考过程展示——黑盒 Agent 赢不了信任

> 对应手册任务：学习「流式对话 + 思考过程展示」，动手「前端展示 Agent 的 Thought/Action/Observation 折叠面板（可复用第 11 周的 AI SDK + assistant-ui 组件库加速）」，当日产出「对话 UI 升级」。本篇只解决一个问题：Agent 干活的那几秒到几十秒，用户只看得见一个转圈图标，不知道它在查订单还是在瞎编，更不敢把结果转述给客户。今天把这条时间缝填上：让每一步「想什么、调什么、看到什么」实时可见，黑盒变玻璃盒。

## 今日目标

1. 说得清展示过程的三重价值：等待体验、信任、可调试，以及各自对应什么产品判断
2. 掌握三层改造：节点执行事件怎么翻成 thought/tool/answer 帧，SSE 怎么穿过 BFF 不被缓冲，前端怎么按帧类型渲染折叠面板
3. 两条前端路线各跑一遍：全自建和 AI SDK + assistant-ui，说得出各自适合什么场景、工时差多少

## 概念讲解：为什么过程必须可见

先看一个普通场景。客服主管问：「订单 A-1023 的退款到账了吗？」Agent 自己答不了，得先查订单，再查退款单，最后组织语言，全程约 10 秒。

现在 [Day 4](/week20/day4) 收工时的界面上，用户点完发送只剩一个转圈图标。第 3 秒，有人开始怀疑卡死了；第 6 秒，有人刷新了页面；第 10 秒答案终于蹦出来，用户扫一眼，心里反而更疑：「它是真查了，还是编的？」

企业场景里这个疑问更致命。客服要拿答案转述给终端客户，看不见依据就不敢开口；老板想知道 AI 有没有乱调订单系统，看不见过程就只剩信或不信。黑盒赢不了信任，信任需要证据。

把过程亮出来，同样 10 秒，体感完全不同：

```
0.9s  ▸ 思考 · 查订单 query_order ……     （转圈）
1.4s  ✓ 观察 · query_order 返回 ……
1.6s  ▸ 思考 · 查退款单 query_refund …… （转圈）
2.1s  ✓ 观察 · query_refund 返回 ……
2.4s  答案区开始逐字出字：已查到，A-1023 的退款 9 月 15 日发起……
```

用户全程知道它在干嘛，第 3 秒不慌，第 10 秒答案出来心里已有底。这就是展示过程的三重价值：

**等待体验。** 转圈的 10 秒是债务，看得见的 10 秒是流水。「查订单、读结果、组织答案」三段进度，每一段都在告诉用户「还活着，在干正事」。和进度条让人安心是同一个道理，只是它数的不是百分比，是推理步骤。

**信任。** 企业用户对 Agent 的信任不来自你的保证，来自看得见它在干嘛。工具名、参数、返回值都摆在折叠面板里，Thought 默认收起、点开可查，答案有没有依据一眼可验。这个「不藏」的姿态比宣传页上任何「可解释 AI」都有说服力。

**可调试。** 这是给你自己的红利。哪步慢了、哪个工具返回了意外结构、模型为什么拐去调无关工具，过程可视后，这些问题从「复现加猜」变成「看录像」。

一句话定位：流式输出解决「答案多快出现」，第 10、11 周做完了；过程展示解决「等待期间用户信什么」，今天补上。

## 核心知识

### 1. 数据层：把节点执行事件翻成三种帧

你的 Agent 是 LangGraph 画的 ReAct 循环：`agent` 节点做决策，`tools` 节点执行工具。这套结构正好对上经典三段式：`agent` 的决策是 Thought（含 Action：调哪个工具、传什么参数），`tools` 的结果是 Observation，最后一轮不带工具调用的输出是 Answer。

吐出这些事件的开关是 `astream` 的 `stream_mode`，今天两个模式组合用：

- `updates`：每个节点执行完吐一次增量。`agent` 节点的 AIMessage 带 `tool_calls` 就是 Thought + Action；`tools` 节点的 ToolMessage 就是 Observation。粒度是「一步一帧」，干净利落
- `messages`：LLM 的 token 级增量。答案区要逐字效果，光靠 updates 不够（它只在节点跑完后给全文），字得靠这个模式一个个接

帧格式自己定，越简单越好。三种业务帧加一个收尾：

```jsonc
{ "type": "thought", "content": "需要先查订单确认状态", "tool": "query_order", "args": { "order_id": "A-1023" } }
{ "type": "tool", "name": "query_order", "observation": "{\"status\": \"refunded\", ...}" }
{ "type": "answer", "delta": "已查到" }
{ "type": "done", "finish_reason": "stop" }
```

设计要点只有一条：帧必须自描述，前端只看 `type` 就知道往哪送，不依赖跨帧状态。

完整的翻译函数，可以直接抄：

```python
# app/agents/stream.py：把图的执行事件翻译成 SSE 帧
import json
from typing import AsyncIterator

def frame(kind: str, **payload) -> str:
    """统一信封：data: 开头，空行结尾，SSE 只认这个格式"""
    return f"data: {json.dumps({'type': kind, **payload}, ensure_ascii=False)}\n\n"

async def stream_frames(graph, question: str) -> AsyncIterator[str]:
    thought_ids: set[str] = set()  # 已确认「带着工具调用」的消息 id

    async for mode, chunk in graph.astream(
        {"messages": [("user", question)]},
        stream_mode=["updates", "messages"],  # 列表形式，两种模式同时开
    ):
        if mode == "messages":
            msg, meta = chunk  # (token 增量, 元数据)
            if msg.id in thought_ids:
                continue  # 这条消息后面跟着工具调用，它的字属于思考，不进答案区
            if msg.content and meta.get("langgraph_node") == "agent":
                yield frame("answer", delta=msg.content)
        else:  # updates：某个节点刚执行完
            for node, update in chunk.items():
                for m in update.get("messages", []):
                    calls = getattr(m, "tool_calls", None)
                    if node == "tools":  # Observation
                        yield frame("tool", name=m.name, observation=str(m.content))
                    elif calls:  # Thought + Action，同属一条 AIMessage，一起发
                        thought_ids.add(m.id)
                        for c in calls:
                            yield frame(
                                "thought",
                                content=str(m.content or "").strip() or f"需要先调用 {c['name']}",
                                tool=c["name"],
                                args=c["args"],
                            )
    yield frame("done", finish_reason="stop")
```

两个细节。`thought_ids` 是事后标记：token 到达时你不知道这条消息会不会带工具调用，等 `updates` 揭晓「带了」，记下 id，后续 token 不再进答案区。模型只吐 `tool_calls` 不吐正文时，这套逻辑零成本；爱先说一段话再调工具的模型，开头几个字会漏进答案区，修法见坑 4。最后那条不带 `tool_calls` 的 agent 消息不必在 updates 里重发，它的字已经走 messages 模式逐字出去了。

### 2. 传输层：SSE 穿过 BFF，一个字都不能攒

FastAPI 侧把生成器挂上 `StreamingResponse` 就完事，[Day 4](/week20/day4) 的 `CurrentUser` 照旧注入用户上下文：

```python
# app/api/chat.py：SSE 端点
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

router = APIRouter()

@router.post("/api/chat/stream")
async def chat_stream(req: ChatRequest,
                      user: CurrentUser = Depends(current_user)):
    return StreamingResponse(
        stream_frames(graph, req.question),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
```

容易出事的是 BFF 这段。NestJS 平时的习惯是「调下游、拿完整响应、加工、返回」，到这里必须扔掉：BFF 一攒齐再转，前端看到的就不是流，是 10 秒后一次性蹦出的全部帧，前面所有努力清零。

正确姿势是当搬运工，不当翻译官，拿到上游一块字节就立刻写下去一块：

```ts
// chat-stream.controller.ts：BFF 只搬运、不改写、不缓冲
@Post('stream')
async stream(@Body() body: ChatDto, @Req() req: AuthedRequest, @Res() res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // 告诉反向代理：别攒

  const upstream = await fetch('http://localhost:8000/api/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await this.tokens.service()}`, // Day 4 的短命 service token
      'X-Tenant-Id': req.user.tenantId,                       // Day 3 的租户隔离
    },
    body: JSON.stringify({ question: body.question }),
  });

  for await (const chunk of upstream.body!) {
    res.write(chunk); // 拿到一块转发一块
  }
  res.end();
}
```

BFF 对帧内容一无所知，这正是优点：以后帧格式升级，BFF 一行不用改。`@Res()` 一出手，NestJS 的拦截器和序列化全部让位，响应完全归你管，这是流式接口在 NestJS 里的标准写法。

### 3. 前端路线一：自建，按帧类型分发

老手艺直接复用：第 10 周手写过 fetch + reader 的 SSE 解析循环，今天只是把「拼字符串」换成「按 type 分发」。

```ts
// useAgentStream.ts：一条 SSE 管，两种状态容器
import { useCallback, useState } from 'react';

export type Frame =
  | { type: 'thought'; content: string; tool: string; args: unknown }
  | { type: 'tool'; name: string; observation: string }
  | { type: 'answer'; delta: string }
  | { type: 'done' };

export type Step =
  | { kind: 'thought'; content: string; tool: string; args: unknown }
  | { kind: 'tool'; name: string; observation: string };

export function useAgentStream() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [answer, setAnswer] = useState('');
  const [running, setRunning] = useState(false);

  const send = useCallback(async (question: string) => {
    setSteps([]); setAnswer(''); setRunning(true);
    const res = await fetch('/bff/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {   // 空行是帧边界
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = raw.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        const f = JSON.parse(line.slice(6)) as Frame;
        if (f.type === 'answer') {
          setAnswer(a => a + f.delta);           // 答案区：逐字累加
        } else if (f.type === 'thought') {
          setSteps(s => [...s, { kind: 'thought', content: f.content, tool: f.tool, args: f.args }]);
        } else if (f.type === 'tool') {
          setSteps(s => [...s, { kind: 'tool', name: f.name, observation: f.observation }]);
        }
      }
    }
    setRunning(false);
  }, []);

  return { steps, answer, running, send };
}
```

渲染层一个组件解决两种帧。折叠用原生 `<details>`，零依赖，默认收起，感兴趣的用户自己点开：

```tsx
// StepItem.tsx：Thought 与 Observation 共用一个折叠条
export function StepItem({ step, running }: { step: Step; running?: boolean }) {
  if (step.kind === 'thought') {
    return (
      <details className="step">
        <summary>
          思考 · {step.tool}
          {running && <span className="spinner" />}
        </summary>
        <pre>{step.content}</pre>
        <pre>参数：{JSON.stringify(step.args, null, 2)}</pre>
      </details>
    );
  }
  return (
    <details className="step">
      <summary>
        观察 · {step.name}
        {running && <span className="spinner" />}
      </summary>
      <pre>返回：{step.observation}</pre>
    </details>
  );
}
```

组装成页面就是三块：步骤时间线、答案区、输入框。

```tsx
// ChatPanel.tsx
export function ChatPanel() {
  const { steps, answer, running, send } = useAgentStream();
  return (
    <div className="chat">
      <div className="steps">
        {steps.map((s, i) => (
          <StepItem key={i} step={s} running={running && i === steps.length - 1} />
        ))}
      </div>
      <div className="answer">
        {answer}
        {running && <span className="cursor" />}
      </div>
      <button disabled={running} onClick={() => send('A-1023 退款到账了吗')}>发送</button>
    </div>
  );
}
```

转圈逻辑藏在 `running && i === steps.length - 1` 里：thought 帧到了、tool 帧没到，这段空档就是「正在执行」，所以最后一条折叠条在转。

### 4. 前端路线二：AI SDK + assistant-ui 加速

第 11 周留过一句钩子：AI SDK 的数据流协议只是线上的字节约定，跟语言无关，将来想在 Python 后端里手吐也行。今天就是这个「将来」。

路线二的数据层还是同一个 `stream_frames`，换信封：答案 token 走协议的 `text-delta`，思考走 `data-` 数据部件（协议留给自定义结构化事件的通道）：

```python
# 路线二的信封：同一批事件，换成 AI SDK 协议的帧
'{"type": "text-delta", "id": "txt-0", "delta": "已查到"}'          # 答案逐字
'{"type": "data-thought", "id": "th-1", "data": {"content": ..., "tool": ..., "args": ...}}'  # 思考部件
```

注意这不是只换两行：协议还要求 `start`、`start-step`、`finish-step`、`finish` 这些生命周期帧配齐，缺了 `useChat` 直接报错。完整清单以[协议文档](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)为准，照着拼一遍半小时的事。

前端这边，assistant-ui 把路线一手写的折叠卡、时间线、自动滚动全变成现成件，你只负责「每个工具长什么样」：

```tsx
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { AssistantRuntimeProvider, useChatIntegration, Thread, makeAssistantToolUI } from '@assistant-ui/react';

// 工具卡：每个工具注册一次，对话流里它的调用自动长成这张卡
const QueryOrderCard = makeAssistantToolUI({
  toolName: 'query_order',
  render: ({ args, result, status }) => (
    <ToolCard name="query_order" args={args}
              observation={result} running={status.type === 'running'} />
  ),
});

export function Chat() {
  const chat = useChat({
    transport: new DefaultChatTransport({ api: '/bff/chat/sdk' }), // 路线二的端点
  });
  return (
    <AssistantRuntimeProvider runtime={useChatIntegration(chat)}>
      <QueryOrderCard />
      <Thread />
    </AssistantRuntimeProvider>
  );
}
```

两个提醒。`useChatIntegration` 的导入路径和签名随版本有调整，以 assistant-ui 官方的 AI SDK Integration 文档为准；`data-thought` 部件不会自动长成组件，在消息渲染层过滤 `parts` 里 `type === 'data-thought'` 的段，套路线一的 `<details>` 自己画。两条路线的思考面板是同一份代码。

怎么选，一张对比表就够：

| 事项 | 路线一：自建 | 路线二：AI SDK + assistant-ui |
| --- | --- | --- |
| SSE 解析与帧分发 | 自己写，约半天 | 协议内置 |
| 折叠面板、工具卡 | 自己写，约半天 | `makeAssistantToolUI` 每工具十分钟 |
| 自动滚动、中断、重试 | 手写或没有 | Thread 自带 |
| 消息分支、编辑重发 | 基本不现实 | 内置 |
| 后端改造 | 零，自己的帧格式 | 要对齐 data stream 协议全套帧 |
| 定制自由度 | 完全自由 | 走它的扩展点 |
| 估算工时 | 1.5 到 2 天 | 半天到 1 天 |

我的建议：内部工具、演示 Demo、要深度定制视觉，走路线一；面向客户的产品、要分支编辑这类高级交互、团队已在 Next.js 全家桶里，走路线二。两条都过一遍手，选型才有底气。

## 动手任务：对话 UI 升级一步一步

手册任务：前端展示 Agent 的 Thought/Action/Observation 折叠面板。拆成 5 步，全程约 90 分钟，接着 [Day 4](/week20/day4) 的项目写。

**第 1 步：数据层出帧。** 把上面的 `stream.py` 和 `chat.py` 抄进 FastAPI 项目，`graph` 换成你现有的 Agent 图。先用 curl 直接验证：`curl -N -X POST http://localhost:8000/api/chat/stream -H "Content-Type: application/json" -d '{"question": "A-1023 退款到账了吗"}'`。终端里应当看见 thought、tool、answer 帧一行行走出来；看不见就查 `stream_mode`。

**第 2 步：BFF 透传。** 抄 `chat-stream.controller.ts`，注意租户头和 service token 别漏。验证：两个终端同时 curl FastAPI 和 BFF，帧应近乎同步出现。慢半拍甚至一次性吐完就是被缓冲了，回坑 2。

**第 3 步：路线一上线。** `useAgentStream.ts`、`StepItem.tsx`、`ChatPanel.tsx` 三件套抄进前端。跑起来先做减法验证：`<details>` 临时换成 `<div>`，确认每帧都上屏，再恢复折叠样式。默认收起这个决定别动摇。

**第 4 步：路线二上线。** FastAPI 侧按协议文档补齐生命周期帧，前端接 useChat 和 assistant-ui。先让 `text-delta` 通路跑通（答案能逐字出），再挂 `data-thought` 部件和 `makeAssistantToolUI` 工具卡。卡在报错上先数帧：DevTools Network 里对着文档一帧帧核，缺哪个补哪个。

**第 5 步：完整体验录。** 用一个会触发两次工具调用的问题跑全流程，录屏或截图，填一张状态流转表：

| 时刻 | 到达的帧 | 界面状态 |
| --- | --- | --- |
| 0.0s | 用户发送 | 问题上屏，步骤区空，答案区光标闪烁 |
| 0.9s | thought(query_order) | 第一条折叠条「思考 · query_order」出现，带转圈 |
| 1.4s | tool(query_order) | 转圈消失，点开可见订单 JSON |
| 1.6s | thought(query_refund) | 第二条折叠条出现，转圈重新亮起 |
| 2.1s | tool(query_refund) | 第二段依据落位 |
| 2.4s 起 | answer 逐字 | 答案区开始出字 |
| 3.5s | done | 光标消失，输入框解锁，推理链完整可查 |

这张表就是当日产出的验收单。每一行都真实发生了，功能才算过关。

::: tip 验收标准
验收不看代码量，看这张表能不能填满：三种帧都出现过、折叠条走完「带转圈到完成」的一生、答案区逐字生长、done 后回到可输入。
:::

## 常见踩坑

**坑 1：stream_mode 用错。** `values` 每步吐全量快照，对话越长帧越大，带宽和解析都遭殃。要增量事件用 `updates`，要逐字用 `messages`，组合就写列表 `["updates", "messages"]`。写成列表后解包也变了：每次迭代给 `(mode, chunk)` 元组，忘了直接当字典用，第一行就 TypeError。

**坑 2：流在某一层被缓冲，前端「一次性收到」。** 三个惯犯：NestJS 的拦截器或压缩中间件攒响应（`@Res()` 手写响应可绕开，但全局中间件仍可能插一脚）；Node 侧用 axios 调下游（它会等完整响应体），流式必须用 fetch 逐块迭代 `upstream.body`；反向代理攒批，`X-Accel-Buffering: no` 就是防它的。自检手段固定：DevTools 里看 EventStream，帧应一条条实时出现，一屏齐刷刷到达就是被缓冲。

**坑 3：手拼 SSE 帧弄坏边界。** SSE 靠空行分帧，正文里不能有裸换行。`json.dumps` 会把换行转义成 `\n` 字面量，天然安全；一旦你偷懒手拼字符串、或拿 `str(dict)` 当序列化，帧里冒出裸换行，一帧被拆成两帧，前端 JSON.parse 当场报错。永远走统一的 `frame()` 函数，别手拼。另外帧尾必须是 `\n\n`，少一个空行，解析端永远等不到帧边界。

**坑 4：思考的前几个字漏进答案区。** 模型习惯在发起工具调用前先吐一段正文（「让我查一下这个订单……」），这些 token 在 `updates` 揭晓前就流出去了，先进了答案区。两种修法：提示词里写明「决定调用工具时不要输出正文」，一劳永逸但依赖模型听话；前端在收到 thought 帧后回收答案区对应片段，可控但状态机变复杂，生产建议两个都上。另外 Thought 默认收起不只是为了干净：中间推理可能很长，也可能带出内部表名、SQL 片段，收起是体验选择，也是安全边界。

**坑 5：两条路线的管子混接。** 路线一的 `{"type": "thought"}` 帧喂给 useChat，它读不懂，要么报错要么静默丢弃，这和第 11 周踩过的「裸文本帧接 useChat」是同一个坑的新皮肤。反过来，路线二的帧喂给路线一的 `useAgentStream`，生命周期帧会让 switch 分支全部落空。一句话：消费端和帧格式必须配套，换路线就两端一起换。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `stream_mode` 的 `updates` 和 `values` 差在哪？今天为什么两个模式一起开？

::: details 参考答案
`values` 每步吐全量快照，`updates` 只吐本节点新增变更，帧小且天然对应「一步一事件」。一起开是因为分工：`updates` 给出干净的 Thought 与 Observation 事件，`messages` 提供 token 增量供答案区逐字渲染，用列表形式同时启用。
:::

2. Thought、Action、Observation 分别对应图的哪一部分？帧格式怎么设计的？

::: details 参考答案
Thought 和 Action 来自 agent 节点：AIMessage 正文是 Thought，`tool_calls` 的工具名和参数是 Action，同属一条消息所以在 thought 帧里一起发；Observation 来自 tools 节点的 ToolMessage。帧格式是三加一：thought（含 tool 与 args）、tool（含 observation）、answer（delta）、done（收尾），每帧靠 `type` 自描述。
:::

3. BFF 透传 SSE 时最容易犯什么错？怎么自检？

::: details 参考答案
最容易犯「攒够再转」：axios 等完整响应、拦截器或压缩中间件缓冲、反向代理攒批。自检：EventStream 里帧应逐条实时到达，一屏同时出现就是被缓冲。解法：fetch 逐块迭代 `upstream.body`、`@Res()` 手写响应、`X-Accel-Buffering: no`。
:::

4. 两条前端路线各适合什么场景？

::: details 参考答案
自建适合内部工具和深度定制场景，后端零改造，但自动滚动、中断、分支要手写或放弃。AI SDK + assistant-ui 适合面向客户的产品，交互件现成，代价是对齐 data stream 协议、定制走它的扩展点。工时差一到两天。
:::

5. 路线二里 `data-thought` 部件和路线一的 thought 帧，本质区别是什么？

::: details 参考答案
业务内容零区别，都是同一个思考事件。区别在信封：路线一是私有帧格式，只有自己的前端认识；`data-thought` 是 data stream 协议里 `data-` 数据部件的实例，任何说这套协议的客户端（useChat、assistant-ui 及其生态）都能解出它，生命周期帧、工具部件这些配套也一并免费。这正是私有约定和采用标准的分水岭。
:::

## 延伸阅读

- [LangGraph：How to stream](https://langchain-ai.github.io/langgraph/how-tos/streaming/)，`stream_mode` 各模式官方说明，`updates` 加 `messages` 组合的出处
- [AI SDK：UI Message Stream Protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)，路线二全部帧类型清单，`data-` 部件与生命周期帧的定义
- [assistant-ui 文档](https://www.assistant-ui.com/docs)，`makeAssistantToolUI`、分支、useChat 集成的官方指南，版本差异以此为准
- [MDN：Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)，SSE 帧格式与边界规则，坑 3 的底层原理

今天的产出留好，三件套组件和体验录都是资产。Day 6 平台导航整合时，这个对话页会作为第一个入口挂进统一导航，和知识库、工具管理、监控拼成完整平台。
