# 第 13 周 · Day 5：前端审批 UI——把 interrupt 搬进浏览器

> 对应手册任务：学习「前端审批 UI」，动手「在 Next.js 中展示待审批的工具调用，用户点击批准/拒绝后恢复 Graph」，当日产出「审批界面」。本篇只解决一个问题：昨天在 CLI 里跑通的 interrupt / `Command(resume=...)`，怎么搬到 FastAPI + Next.js 的 Web 架构上。HTTP 请求不能挂着等人，中断态必须全部落在 checkpointer 里，靠一个 thread_id 在「发起申请」和「点击审批」两次请求之间把图接回去。

## 今日目标

1. 说得清 Web 版 HITL 和 CLI 版的关键差异：请求会结束、审批人不在同一个进程里、状态必须落盘，以及为什么 thread_id 是全篇主角
2. 掌握 FastAPI 端点设计：POST /chat 跑图并区分「普通回复」与「待审批」两种返回；POST /approve 带同一个 thread_id 用 `Command(resume=...)` 恢复
3. 独立完成 Next.js 审批界面：消息列表 + 审批卡片 + idle / waiting_approval / done 状态机，刷新页面后中断态自动恢复

## 概念讲解：为什么 CLI 的写法直接搬到 Web 会失效

昨天（Day 4，见[本周概览](/week13/)）的 CLI 循环长这样：`input()` 等你敲键盘，敲完 `graph.invoke(Command(resume=...))` 接着跑，一个进程从头活到尾。搬到 Web，这套假设全塌。

第一，HTTP 请求不能等。POST /chat 进来，FastAPI 跑完图就得返回。你不可能让这个请求挂着几小时等审批人点按钮，浏览器超时、连接占用、网关掐断，随便哪个都能弄死它。所以「interrupt 之后请求怎么办」必须有明确答案：立刻返回，把「图在等人」作为一个状态告诉前端。

第二，审批人可能在另一个浏览器里。CLI 里发起和恢复是同一个人、同一个进程；Web 上可能是用户 A 提交退款申请，客服 B 半小时后在另一个页面点批准。两次操作之间隔着任意长的时间、任意多的无关请求。

第三，服务可能重启。中断要是挂在一个 Python 进程的调用栈上，进程一死全没了。

好消息是这三件事在 Day 4 已经被同一个东西解决了：checkpointer。`interrupt()` 的本质不是「进程暂停」，而是「把图的状态连同停在哪个节点一起写进检查点」。所以 Web 版只需要四步：跑图，碰到 interrupt 就把 payload 返回给前端，审批人点按钮后前端带着同一个 thread_id 发起新请求，后端 `graph.invoke(Command(resume=...), config)` 从检查点续跑。中断态活在 checkpointer 里，不活在任何一次请求里。thread_id 就是两次请求之间的那条线，它是会话 id，不是请求 id。

还有一个架构决策要先定：graph 实例放哪。答案是 FastAPI 里建一个全局单例。编译出来的图（带 checkpointer）可以被并发调用，LangGraph 靠 config 里的 thread_id 隔离不同会话，图的执行状态本来就不存在实例上，而在 checkpointer 里，所以一个进程一张图足够。反过来，把 `compile()` 写进请求处理函数，每次请求一张新图配一个新 checkpointer，等于每次都失忆，thread_id 永远查无此线程。

前后端分工也就清楚了：FastAPI 只管跑图、体检状态、恢复执行；Next.js 只管发消息、渲染审批卡、发决定。审批业务一行都不进前端。

## 核心知识

本节的代码前后相承：1、2 小节是后端两份文件，3 小节是前端一份文件，抄完就是动手任务的全部代码。

### 1. 图一行不改

```python
# refund_graph.py —— Day 4 的图浓缩版：聚焦审批链路，字段抽取先写死
from typing import TypedDict

from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt


class State(TypedDict):
    message: str
    order_id: str
    amount: float
    reason: str
    decision: str
    reply: str


def parse_request(state: State):
    # 真实项目里这步交给 LLM 抽取；这里写死，整条链路不需要 API key 就能跑
    return {"order_id": "A-1024", "amount": 199.0, "reason": "尺码不合适"}


def human_approve(state: State):
    decision = interrupt({  # 这个 dict 会原样发给前端，就是审批卡的数据
        "order_id": state["order_id"],
        "amount": state["amount"],
        "reason": state["reason"],
    })
    return {"decision": decision}  # 收到 resume 之前，这行永远不会执行


def execute(state: State):
    if state["decision"] == "approved":
        return {"reply": f"退款 {state['amount']} 元已原路退回（订单 {state['order_id']}），请查收。"}
    return {"reply": f"很抱歉，订单 {state['order_id']} 的退款申请未通过审批，如有疑问请联系人工客服。"}


def build_refund_graph() -> StateGraph:
    builder = StateGraph(State)
    builder.add_node("parse_request", parse_request)
    builder.add_node("human_approve", human_approve)
    builder.add_node("execute", execute)
    builder.add_edge(START, "parse_request")
    builder.add_edge("parse_request", "human_approve")
    builder.add_edge("human_approve", "execute")
    builder.add_edge("execute", END)
    return builder
```

关键在 `human_approve` 里的 `interrupt({...})`：括号里那个 dict 会被原样发给前端，就是审批卡上显示的订单号、金额、原因。恢复时这个函数从头重新执行，`interrupt()` 那一行直接返回 resume 值，赋给 decision。这个行为 Day 4 你已经见过，今天一点没变：变的只是「谁在另一头按回车」，从终端里的你，变成浏览器里点按钮的审批人。

### 2. FastAPI：全局单例 + 三个端点

```python
# main.py —— 图一行不改，Web 版只加「跑图」和「恢复」两个入口
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from refund_graph import build_refund_graph

# 全局单例：图和 checkpointer 都只有一个，所有请求、所有会话共用
checkpointer = InMemorySaver()
graph = build_refund_graph().compile(checkpointer=checkpointer)

app = FastAPI()

# 前端跑在 3000 端口，没这几行浏览器会拦跨域请求
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def current_status(thread_id: str) -> dict:
    """三个端点共用的体检函数：这条线程是在等人，还是已经跑完。"""
    config = {"configurable": {"thread_id": thread_id}}
    snapshot = graph.get_state(config)
    if snapshot.next:  # 还有节点排队没跑 = 图停在 interrupt() 上
        payload = snapshot.tasks[0].interrupts[0].value
        return {"status": "pending_interrupt", "interrupt": payload}
    return {"status": "done", "reply": snapshot.values.get("reply", "")}


class ChatRequest(BaseModel):
    thread_id: str
    message: str


@app.post("/chat")
def chat(req: ChatRequest):
    config = {"configurable": {"thread_id": req.thread_id}}
    graph.invoke({"message": req.message}, config)  # 碰到 interrupt 会正常返回
    return current_status(req.thread_id)


class ApproveRequest(BaseModel):
    thread_id: str
    decision: str  # "approved" 或 "rejected"


@app.post("/approve")
def approve(req: ApproveRequest):
    config = {"configurable": {"thread_id": req.thread_id}}
    if not graph.get_state(config).next:  # 没有在等的审批（防手抖双击），直接返回现状
        return current_status(req.thread_id)
    graph.invoke(Command(resume=req.decision), config)  # 同一个 thread_id，从检查点续跑
    return current_status(req.thread_id)


@app.get("/state")
def state(thread_id: str):
    return current_status(thread_id)
```

关键在 `current_status` 这个辅助函数：判断图是不是在等人，不靠异常、不靠日志，只看 `get_state` 返回的快照。`snapshot.next` 非空说明还有节点排队，本图只有一个 interrupt 点，所以它非空就等于「卡在审批」。payload 从 `snapshot.tasks[0].interrupts[0].value` 拿，就是你塞进 `interrupt()` 的那个 dict。三个端点共用这一个函数：/chat 和 /approve 在 invoke 之后各调一次，GET /state 专门给前端刷新时用。顺带一提，LangGraph 1.0 里 invoke 的返回值直接带 `.interrupts` 元组，在 /chat 里读 `result.interrupts[0].value` 也行；但 /state 没有 invoke 结果可看，统一走 get_state 最省心。

/approve 里的顺序是：先 `get_state` 确认真的有节点在等，再 `invoke(Command(resume=...), config)`。config 里的 thread_id 必须和 /chat 那次完全相同，这是整个方案的主线。

### 3. Next.js：审批卡与状态机

```tsx
// app/page.tsx —— 审批界面：消息列表 + 审批卡片 + 三态状态机
"use client";

import { useEffect, useState } from "react";

type UIState = "idle" | "waiting_approval" | "done";

interface InterruptPayload {
  order_id: string;
  amount: number;
  reason: string;
}

const API = "http://localhost:8000";

export default function Page() {
  const [threadId, setThreadId] = useState("");
  const [ui, setUi] = useState<UIState>("idle");
  const [messages, setMessages] = useState<string[]>([]);
  const [payload, setPayload] = useState<InterruptPayload | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    // thread_id 即会话 id：首次生成，之后一直复用，刷新也不换
    let tid = localStorage.getItem("tid");
    if (!tid) {
      tid = crypto.randomUUID();
      localStorage.setItem("tid", tid);
    }
    setThreadId(tid);
    // 刷新恢复：问后端这条线程是不是正卡在审批
    fetch(`${API}/state?thread_id=${tid}`)
      .then((r) => r.json())
      .then(applyResponse);
  }, []);

  function applyResponse(d: any) {
    if (d.status === "pending_interrupt") {
      setUi("waiting_approval"); // 切审批态，渲染审批卡
      setPayload(d.interrupt);
    } else {
      setUi("done");
      setPayload(null);
      if (d.reply) setMessages((m) => [...m, `客服：${d.reply}`]);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || !threadId || ui === "waiting_approval") return;
    setInput("");
    setUi("idle");
    setMessages((m) => [...m, `我：${text}`]);
    const d = await fetch(`${API}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ thread_id: threadId, message: text }),
    }).then((r) => r.json());
    applyResponse(d);
  }

  async function decide(approved: boolean) {
    const d = await fetch(`${API}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        thread_id: threadId,
        decision: approved ? "approved" : "rejected",
      }),
    }).then((r) => r.json());
    applyResponse(d);
  }

  return (
    <main style={{ maxWidth: 460, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>退款客服 · 人工审批</h1>
      <div style={{ minHeight: 120 }}>
        {messages.map((m, i) => (
          <p key={i} style={{ margin: "6px 0" }}>{m}</p>
        ))}
      </div>

      {ui === "waiting_approval" && payload && (
        <div style={{ border: "2px solid orange", borderRadius: 8, padding: 16 }}>
          <h3 style={{ marginTop: 0 }}>待人工审批</h3>
          <p>订单号：{payload.order_id}</p>
          <p>金额：{payload.amount} 元</p>
          <p>原因：{payload.reason}</p>
          <button onClick={() => decide(true)}>批准</button>{" "}
          <button onClick={() => decide(false)}>拒绝</button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <input
          style={{ flex: 1 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={ui === "waiting_approval"}
          placeholder={ui === "waiting_approval" ? "等待审批中..." : "描述你的退款需求"}
        />
        <button onClick={send} disabled={ui === "waiting_approval"}>
          发送
        </button>
      </div>
    </main>
  );
}
```

关键在 `applyResponse`：后端只有两种返回，前端按 status 分流。`pending_interrupt` 就切 waiting_approval 态渲染审批卡；否则把 reply 追加进消息列表，状态落到 done。三个状态各管一段：idle 输入框可用，waiting_approval 审批卡出现、输入禁用，done 本轮结束可以开下一轮。审批卡不过是一堆 payload 字段加两个按钮，按钮把 decision 发给 /approve，后面的流程和聊天完全一样。

### 4. 刷新不丢：thread_id 存 localStorage

页面加载时读 localStorage，没有就生成一个 uuid 存进去，然后拿它 GET /state。如果这条线程正卡在审批，后端从 checkpointer 里翻出快照，返回 pending_interrupt 和 payload，审批卡原样回来。刷新、关标签页再开，中断态都在。这是 checkpointer 的价值第二次兑现：第一次是 Day 4 重启脚本不丢状态，这次是 Web 会话跨请求续命。

### 5. 流式与中断怎么共存

先非流式跑通（今天的主线），流式后加，别一口吃成胖子。加法只有一个关键认知：interrupt 不会让流报错，只会让流提前正常收尾。所以在 SSE 端点里用 `astream_events` 把 token 逐个推给前端，流结束的地方统一 `get_state` 体检一次，发现 `next` 非空就补推一条 interrupt 事件，前端收到后从打字态切审批态：

```python
# 思路示意，不是可运行代码：流式版 /chat 的骨架
async for event in graph.astream_events({"message": msg}, config, version="v2"):
    if event["event"] == "on_chat_model_stream":
        yield sse_event("token", event["data"]["chunk"].content)  # 正常 token，逐字上屏

# 流在这里结束，interrupt 也会走到这里而不是抛错
snapshot = graph.get_state(config)
if snapshot.next:
    yield sse_event("interrupt", snapshot.tasks[0].interrupts[0].value)
    # 前端收到 interrupt 事件，从打字态切到审批态
```

## 动手任务：跑通完整用户旅程 一步一步

手册任务：在 Next.js 中展示待审批的工具调用，批准/拒绝后恢复 Graph。拆成 5 步，全程约 40 分钟。

**第 1 步：建目录。** 新建 backend 目录放 Python 两份文件，再建前端项目：`npx create-next-app@latest approval-ui`，按提示选 TypeScript 和 App Router。后端依赖一条命令：`pip install fastapi uvicorn langgraph`。

**第 2 步：写图。** 把核心知识 1 的 `refund_graph.py` 抄进 backend。如果 Day 4 的图还在，直接用你的，今天所有新增代码都在图外面。在 backend 目录跑 `python -c "from refund_graph import build_refund_graph; print('ok')"`，能打印 ok 说明导入没问题。

**第 3 步：写 FastAPI。** 把核心知识 2 的 `main.py` 抄进 backend，启动 `uvicorn main:app --reload --port 8000`，浏览器打开 http://localhost:8000/docs。在 FastAPI 自带的交互文档里手动 POST /chat 试一把：thread_id 填 "t1"，message 随便写，看到 `"status": "pending_interrupt"` 和 payload 就对了。再 POST /approve，decision 填 "approved"，拿到退款成功的 reply，后端就通了。

**第 4 步：写前端。** 用核心知识 3 的代码整个替换 approval-ui 里的 `app/page.tsx`，`npm run dev` 启动，浏览器开 http://localhost:3000。

**第 5 步：走完整个用户旅程。** 照这个剧本过一遍：

1. 输入「订单 A-1024，199 块，尺码不合适，申请退款」，点发送
2. 消息列表下方弹出橙色审批卡：订单号、金额、原因、批准和拒绝两个按钮，输入框同时禁用
3. 点批准：审批卡消失，客服消息「退款 199.0 元已原路退回……」出现
4. 再发起一轮，这次点拒绝：「很抱歉……未通过审批」
5. 复测刷新：再触发一次审批卡，按 F5，页面回来后审批卡还在（GET /state 从检查点把中断态捞了回来），照常批准

::: tip 启动命令
后端：cd backend 后 `pip install fastapi uvicorn langgraph`，再 `uvicorn main:app --reload --port 8000`。前端：`npx create-next-app@latest approval-ui`，替换 `app/page.tsx` 后 `npm run dev`。main.py 里 CORS 那几行别删，3000 端口调 8000 端口，没有它浏览器直接拦截。
:::

## 常见踩坑

**坑 1：等 interrupt 抛异常，白写一堆 try/except。** `invoke` 碰到 `interrupt()` 不抛任何东西，正常返回当前状态。判断「图在等人」只有一个可靠办法：`get_state(config)` 看快照。新手常见写法是把 /chat 包进 `try/except GraphInterrupt`，结果 except 永远不触发，代码看起来在工作，状态判断其实写错了地方。

**坑 2：每个请求 compile 一张新图。** 两个后果：慢，白白重建拓扑；更要命的是新 checkpointer 等于失忆，上一个请求写的检查点这个请求读不到，thread_id 形同虚设。graph 和 checkpointer 都必须是模块级全局变量。另外 uvicorn 开多 worker 时每个进程各有一份内存，开发阶段老老实实用默认单 worker。

**坑 3：thread_id 当请求 id 用。** 每次请求都 `crypto.randomUUID()`，那每个请求都是全新会话，/approve 恢复的是个空线程。记住：thread_id 的生命周期是会话，不是请求。一个用户从进页面到清 localStorage，始终是同一个 thread_id。

**坑 4：把副作用写在 interrupt() 之前。** 恢复时 LangGraph 会把 `human_approve` 整个函数从头重新执行，`interrupt()` 之前的代码会跑第二遍。如果你把「发短信通知审批人」写在 interrupt 之前，批准恢复时短信再发一次。规矩：interrupt 之前只做纯读取，所有副作用放进恢复之后才执行的路径（比如本例的 execute 节点）。

**坑 5：/approve 裸奔上线。** 教程里 localhost 谁都能调无所谓，生产上这个接口等价于「谁 curl 一下谁就能批退款」。上线前至少三件事：登录态校验、审批角色权限、防重复提交。代码里那段 `get_state` 前置检查只是兜底，不是安全机制。同理，InMemorySaver 官方明说只配调试测试用，生产换 SqliteSaver 或 PostgresSaver，否则进程重启，所有等待中的审批一起蒸发。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Web 版 HITL，中断状态存在哪？前端刷新为什么不影响它？

::: details 参考答案
存在 checkpointer 里。图停在 interrupt 时状态已落盘，刷新只是前端重新 GET /state，凭 thread_id 把快照翻出来，所以审批卡能原样恢复。中断态不依赖任何一次 HTTP 请求的存活。
:::

2. /chat 和 /approve 两次请求的 config 必须有什么相同？为什么？

::: details 参考答案
`configurable.thread_id` 必须相同。checkpointer 按 thread_id 存取线程，两次请求是同一条线程的前后两段；id 不同等于换了会话，resume 无从谈起。
:::

3. invoke 遇到 interrupt() 时的行为是什么？代码里靠什么判断图在等人？

::: details 参考答案
不抛异常，正常返回当前状态。靠 `graph.get_state(config)` 的快照判断：`snapshot.next` 非空说明还有节点排队没跑。LangGraph 1.0 里也可以直接读 invoke 返回值的 `.interrupts` 元组。
:::

4. graph 为什么要建成全局单例？

::: details 参考答案
编译后的图可并发复用，会话状态靠 thread_id 隔离、存在 checkpointer 而不是实例上。每个请求新建图和新 checkpointer 会丢掉之前的检查点，恢复失败，还慢。
:::

5. 为什么副作用不能写在 interrupt() 之前？

::: details 参考答案
恢复时整个节点函数从头重新执行，interrupt 之前的代码会跑第二遍，副作用（发通知、扣库存）就重复发生。把副作用放到恢复之后才执行的节点里。
:::

## 延伸阅读

- [LangGraph 官方 Human-in-the-Loop 指南](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)，interrupt、Command、检查点三者怎么咬合，官方完整版
- [LangGraph Persistence 概念](https://langchain-ai.github.io/langgraph/concepts/persistence/)，thread_id 和 checkpointer 的底层说明，读懂它，刷新恢复就不神秘了
- [FastAPI 官方 CORS 文档](https://fastapi.tiangolo.com/tutorial/cors/)，前后端分离必看，main.py 里 add_middleware 那几行的出处

今天的产出「审批界面」留好，Day 7 阶段里程碑验收时，它要和 Supervisor 多 Agent 架构拼成完整项目，Day 6 的错误处理也会直接长在这套 FastAPI 骨架上。
