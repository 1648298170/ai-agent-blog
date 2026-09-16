# 第 13 周 · Day 2：Supervisor 实现——让结构化输出当调度员

> 对应手册任务：学习「Supervisor Agent 实现」，动手用 LangGraph 实现一个 Supervisor 节点，根据用户意图路由到不同 Worker，当日产出 `supervisor_graph.py`（Supervisor Graph）。本篇只解决一个问题：昨天架构图里的「大脑」还只是个方框，今天让它真的转起来：读一句用户输入，吐出一个合法的路由指令，驱动整张图跑完查订单、退款、闲聊三种意图。

## 今日目标

1. 说得清 Supervisor 解决什么调度问题，以及硬路由、软路由两条实现路线各自的适用场景
2. 掌握三个部件：`Literal` 枚举约束、`with_structured_output` 结构化输出、条件边加回环的图骨架
3. 跑通「查订单 / 退款 / 闲聊」三种意图的完整路由日志，并用 `thread_id` 验证多轮记忆

## 概念讲解：为什么需要 Supervisor

昨天画好的架构图里，Supervisor 在中间，订单 Agent、退款 Agent 在两边。今天要回答的问题很具体：中间那个方框怎么写。先看没有它时的两条路。

第一条路，关键词 if/else：

```python
if "退款" in text:
    handle_refund(text)
elif "订单" in text:
    handle_order(text)
else:
    handle_chat(text)
```

用户说「这单我想退了」，不含「退款」两个字，掉进闲聊分支；说「上次买的东西不要了，把钱还我」，关键词命中的是「钱」。中文表达意图的方式太多，关键词表永远追不上用户的嘴，每漏一种补一个词，补到最后没人敢动这张表。

第二条路，一个全能 Agent 包打天下：订单工具、退款工具、话术全塞进同一个 prompt。工具越多选错率越高，提示词越长越容易打架，退款这种敏感操作还和查订单共享上下文，权限没法分开管。

Supervisor 的思路是把「决定谁来干」和「干活」拆开。调度是独立节点：输入对话，输出一个受限的路由指令；Worker 各管一摊，各有各的提示词和工具。这条路叫硬路由：路由表是你定的，模型只在表里做选择题，分类这种活小模型就够。

另一条路叫软路由：让模型自己决定下一步去哪，还能给下一个节点捎话（LangGraph 1.0 里对应节点返回 `Command(goto=...)`）。灵活，但贵、慢，路由逻辑也从「白纸黑字的表」变成「模型脑中的判断」。本篇先把硬路由跑通，取舍马上讲。

## 核心知识

本节片段用于讲清形状，完整可运行文件以下面的动手任务为准。版本语境是 LangGraph 1.0：旧教程里的 `MemorySaver` 已改名 `InMemorySaver`，其余图 API 基本没动。

### 1. 硬路由 vs 软路由：一张表分清

| | 硬路由 | 软路由 |
| --- | --- | --- |
| 谁做决定 | 小模型或规则，做选择题 | 大模型，做问答题 |
| 输出约束 | `Literal` 枚举，只能选 | 自由文本或弱约束 |
| 成本与延迟 | 低 | 高 |
| 可测试性 | 好，枚举就是接口 | 难，依赖模型行为 |
| 适用场景 | 分支可枚举：客服分流、工单派发 | 分支开放：研究助理、探索型任务 |

两条路线不是对错，是适用范围：客服的去处就三个，枚举得完，用硬路由；研究助理「下一步搜什么」列不出答案集合，只能软路由。标准一句话：能枚举就硬，枚举不了再软，软化时也尽量套上枚举约束。

### 2. RouterSchema：Literal 枚举保证路由合法

```python
from typing import Literal
from pydantic import BaseModel

class RouterSchema(BaseModel):
    """Supervisor 的路由决策：下一步把任务交给谁"""
    next: Literal["order", "refund", "FINISH"]
```

关键一行是 `next: Literal[...]`：这个字段的值只允许这三个字面量，多一个少一个都不行。「把合法值写进类型」这个思想在[第 1 周的泛型约束](/week01/day1)里见过，也呼应第 9 周的类型注解：类型不只是文档，是可执行的约束，`Literal` 是它最直白的形态。

约束在两个层面生效。模型端：`with_structured_output(RouterSchema)` 把 Pydantic 模型翻译成 JSON Schema 下发给模型，吐回的 JSON 再经同一个模型类校验，值不在枚举里直接抛错。编辑器端：`decision.next` 的类型就是三个字面量的联合，手滑写成 `== "orders"`，多打个 s 立刻见红线。

不信？看自由文本的翻车现场：

```python
# 不用结构化输出，让模型自己回一句"下一步转谁"
# 模型："好的，建议转给订单组的同事处理哦～"
# route 函数拿这句去查路由表，KeyError，图当场趴下
```

模型说的是自然语言，路由表认的是机器值。硬路由的本质就是把这层翻译从「祈祷」变成「schema 强制」。

### 3. State 扩展与图骨架：一个环

State 要在对话之外多存一个字段：下一步去哪。

```python
from langgraph.graph import MessagesState

class AgentState(MessagesState):
    next: str  # Supervisor 写，条件边读
```

`AgentState` 继承 `MessagesState`，白得一个带合并规则的 `messages` 字段（新消息追加而不是覆盖）；`next` 是普通字段，整值覆盖。Supervisor 只写 `next`，Worker 只写 `messages`，各写各的。别把 `next` 塞进 `messages`：路由指令是控制流数据，不是对话内容。

图骨架长这样：

```python
from langgraph.graph import StateGraph, START, END

builder = StateGraph(AgentState)
builder.add_node("supervisor", supervisor_node)
builder.add_node("order", order_node)
builder.add_node("refund", refund_node)

builder.add_edge(START, "supervisor")
builder.add_conditional_edges(
    "supervisor",                       # 从谁出发
    lambda state: state["next"],        # 拿什么决定方向
    {"order": "order", "refund": "refund", "FINISH": END},  # 值 → 去处
)
builder.add_edge("order", "supervisor")   # 干完活一律回大脑
builder.add_edge("refund", "supervisor")
```

三段各司其职：入口无条件进 Supervisor；Supervisor 出来走条件边，`next` 是什么就去哪，`FINISH` 是哨兵值不是节点名，映射到 `END` 出图；两个 Worker 出来无条件回到 Supervisor。为什么是环？「任务完没完」只有 Supervisor 有权判断，Worker 干完活必须回来汇报。

### 4. InMemorySaver 与 thread_id：多轮路由的记忆

```python
from langgraph.checkpoint.memory import InMemorySaver

memory = InMemorySaver()  # 1.0 前叫 MemorySaver，老代码里常见
graph = builder.compile(checkpointer=memory)

graph.invoke(
    {"messages": [{"role": "user", "content": "那这单退款呢"}]},
    {"configurable": {"thread_id": "user-001"}},
)
```

分工是：checkpointer 负责存，`thread_id` 负责取哪一份。编译时挂上 `InMemorySaver`，图每走一步都把状态存档；调用时带同一个 `thread_id`，新一轮对话自动带着上一轮的全部历史。用户第二句「那这单退款呢」里的「这单」指哪个订单，靠的就是这份存档。注意配了 checkpointer 的图必须传 `thread_id`，不传直接报错。

## 动手任务：Supervisor Graph 一步一步

手册任务：用 LangGraph 实现一个 Supervisor 节点，根据用户意图路由到不同 Worker。拆成 5 步，全程约 25 分钟。

**第 1 步：备环境、建文件。** 装 LangGraph 1.0 和模型 SDK，在本周练习目录新建 `supervisor_graph.py`：

```bash
pip install -U langgraph langchain-openai
```

模型用 `ChatOpenAI(model="gpt-4o-mini")`，硬路由是分类任务，小模型足够；DeepSeek、Qwen 这类兼容 OpenAI 接口的服务也行，`ChatOpenAI(base_url=..., api_key=...)` 换两个参数的事。

**第 2 步：定义 RouterSchema 和 State。** 路由表写进类型里：

```python
from typing import Literal

from pydantic import BaseModel
from langgraph.graph import MessagesState


class RouterSchema(BaseModel):
    """Supervisor 的路由决策：下一步把任务交给谁"""
    next: Literal["order", "refund", "FINISH"]


class AgentState(MessagesState):
    next: str
```

**第 3 步：写 Supervisor 和两个占位 Worker。** Worker 今天不接真工具（明天 Day 3 的事），但不是空函数：一个带专属提示词的模型调用。

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o-mini")
router = llm.with_structured_output(RouterSchema)

SUPERVISOR_PROMPT = """你是客服团队的调度主管，负责决定下一步把任务交给谁：
- order：用户想查询、追踪订单
- refund：用户想退款、退货、投诉扣款
- FINISH：闲聊寒暄无正事，或者成员已经完成答复且用户没有新问题

输出只能是 order、refund、FINISH 三者之一。"""

ORDER_PROMPT = "你是订单查询专员，只负责帮用户查询和追踪订单，用一句话答复。"
REFUND_PROMPT = "你是退款专员，只负责处理退款退货申请，用一句话答复并说明已登记。"


def supervisor_node(state: AgentState):
    decision = router.invoke(
        [{"role": "system", "content": SUPERVISOR_PROMPT}, *state["messages"]]
    )
    return {"next": decision.next}


def order_node(state: AgentState):
    reply = llm.invoke(
        [{"role": "system", "content": ORDER_PROMPT}, *state["messages"]]
    )
    return {"messages": [reply]}


def refund_node(state: AgentState):
    reply = llm.invoke(
        [{"role": "system", "content": REFUND_PROMPT}, *state["messages"]]
    )
    return {"messages": [reply]}
```

Supervisor 节点只做一件事：把完整对话交给小模型，拿回一个受 `Literal` 约束的 `next`。`FINISH` 的判定条件必须写进提示词，否则会踩到后面坑 1 的死循环。

**第 4 步：搭图、编译。** 三段骨架加 checkpointer：

```python
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import InMemorySaver

builder = StateGraph(AgentState)
builder.add_node("supervisor", supervisor_node)
builder.add_node("order", order_node)
builder.add_node("refund", refund_node)

builder.add_edge(START, "supervisor")
builder.add_conditional_edges(
    "supervisor",
    lambda state: state["next"],
    {"order": "order", "refund": "refund", "FINISH": END},
)
builder.add_edge("order", "supervisor")
builder.add_edge("refund", "supervisor")

graph = builder.compile(checkpointer=InMemorySaver())
```

**第 5 步：跑三种意图，看日志。** 三个问题共用 `user-001` 这条会话，专门验证多轮记忆：

```python
def ask(question: str, thread_id: str = "user-001"):
    result = graph.invoke(
        {"messages": [{"role": "user", "content": question}]},
        {"configurable": {"thread_id": thread_id}},
    )
    print("用户:", question)
    print("Supervisor 最终决策:", result["next"])
    reply = result["messages"][-1]
    if reply.type == "ai":
        print("回复:", reply.content)
    else:
        print("回复: (没有 Worker 被派活，图在 Supervisor 处直接结束)")
    print("-" * 50)


ask("我的订单 A-1024 到哪了？")
ask("太慢了，这单我要退款")
ask("算了不退了，今天下班真累，跟你聊两句")
```

预期输出（措辞因模型而异，路由结果一致）：

```text
用户: 我的订单 A-1024 到哪了？
Supervisor 最终决策: FINISH
回复: 您好，订单 A-1024 已发货，预计明天 18 点前送达。
--------------------------------------------------
用户: 太慢了，这单我要退款
Supervisor 最终决策: FINISH
回复: 已为您登记订单 A-1024 的退款申请，1-3 个工作日原路退回。
--------------------------------------------------
用户: 算了不退了，今天下班真累，跟你聊两句
Supervisor 最终决策: FINISH
回复: (没有 Worker 被派活，图在 Supervisor 处直接结束)
--------------------------------------------------
```

三行日志三个看点。第一，前两问最终决策都是 `FINISH`，但回复内容说明中间派过活：第一问实际走了 supervisor → order → supervisor，`FINISH` 是第二跳验收后的收工指令。第二，第二问没提订单号，退款专员却答出了 A-1024，这是 checkpointer 按 `thread_id` 回放了历史。第三，闲聊那问什么都没派，Supervisor 判定无事可做直接收工，想让它先陪聊一句再结束，改法在自测第 5 题。

想看图内部每一跳，换条新会话用 `stream_mode="updates"` 再跑第一问：

```python
for update in graph.stream(
    {"messages": [{"role": "user", "content": "我的订单 A-1024 到哪了？"}]},
    {"configurable": {"thread_id": "user-002"}},  # 新会话，日志干净
    stream_mode="updates",
):
    for node, chunk in update.items():
        print("节点:", node, "| 本次更新字段:", list(chunk.keys()))
```

```text
节点: supervisor | 本次更新字段: ['next']
节点: order | 本次更新字段: ['messages']
节点: supervisor | 本次更新字段: ['next']
```

三行日志就是那个环：Supervisor 写 `next`，order 写回复，Supervisor 再写一次 `next`（这次是 `FINISH`）出图。

::: tip 运行与排错
直接 `python supervisor_graph.py`。报 Pydantic 校验错误说明模型输出没命中枚举，检查提示词里三个值是否原样列出；图停不下来先看坑 1。
:::

## 常见踩坑

**坑 1：死循环，Supervisor 反复派活。** Worker 答完了，Supervisor 又派一次，图在环里出不去。根因是提示词没写清 `FINISH` 条件，「成员已经完成答复且用户没有新问题就输出 FINISH」这句不能省。保险丝另有一道：config 里加 `"recursion_limit": 10`，超步数直接抛错。

**坑 2：四处名字对不上。** `Literal` 里的 `"order"`、`add_node("order", ...)`、条件边映射的 key、回边指向的节点名，四处必须一字不差，大小写敏感。模型那一侧有枚举兜底，人这一侧拼错图就断，报错是 `KeyError: 'Order'`，不好一眼看穿。改名的顺序：先改 `Literal`，再全局搜着改。

**坑 3：把 `next` 和 `messages` 混着放。** 要么把路由指令当消息追加进对话，要么给 `next` 错标了合并规则。控制流和对话内容是两个频道：`next` 整值覆盖，`messages` 追加合并，别互相越界。

**坑 4：checkpointer 没配，或者 `thread_id` 每次现造。** 图每跑一次都是失忆状态，第二句「这单退款」无所指，路由跟着错乱。同一用户同一会话从头到尾复用同一个 `thread_id`，换会话才换新值；生产上换成 Postgres 之类的持久化后端时，这套约定原样平移。

**坑 5：路由不稳就想着换更大的模型。** 硬路由是三选一，gpt-4o-mini 这个量级绰绰有余。漂移的原因多半不是模型笨，而是选项边界没写清（比如「投诉扣款」归 refund 还是闲聊）。先修表，再考虑加模型；真到模型也判不准，那说明该上软路由，而不是在硬路由里堆参数。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 硬路由和软路由各自的适用场景？判断标准是什么？

::: details 参考答案
分支能提前枚举（客服分流、工单派发）用硬路由：小模型加结构化输出，便宜、快、可测试。分支集合开放（研究助理决定下一步搜什么）用软路由：大模型自己决定 `next`，可带 `Command(goto=...)`。标准：能枚举就硬，枚举不了再软。
:::

2. `Literal["order", "refund", "FINISH"]` 在哪两个层面起作用？

::: details 参考答案
模型端：`with_structured_output` 把它编进 JSON Schema 下发，输出不在枚举内时 Pydantic 校验直接抛错，非法路由进不了图。编辑器端：`next` 的类型是三个字面量的联合，手写比较拼错立刻红线。
:::

3. 为什么所有 Worker 都要连回 Supervisor，而不是干完活直接连 `END`？

::: details 参考答案
「任务是否结束」只有 Supervisor 有权判断。Worker 回到大脑，大脑看最新对话决定继续派活还是 `FINISH`。如果 Worker 直接连 `END`，查完订单接着退款这种多步任务第一步就被掐断。
:::

4. `InMemorySaver` 和 `thread_id` 各管什么？配了 checkpointer 但不传 `thread_id` 会怎样？

::: details 参考答案
checkpointer 负责存：图每步把状态按会话归档。`thread_id` 负责取：标识当前对话对应哪份档案。配了 checkpointer 不传 `thread_id` 直接报错，LangGraph 强制要求会话标识，没标识的存档取不回来等于没存。
:::

5. 想加一个「闲聊 Worker」让第三个意图也有人接，要改哪几处？

::: details 参考答案
五处：`Literal` 加 `"chat"`；写 `chat_node`；`add_node("chat", chat_node)`；条件边映射加 `"chat": "chat"`；提示词补一句 chat 的使用时机，再连上 `add_edge("chat", "supervisor")`。所有改动都围着 `Literal` 转，它就是路由的单一事实来源。
:::

## 延伸阅读

- [LangGraph 多 Agent 概念文档](https://langchain-ai.github.io/langgraph/concepts/multi_agent/)，Supervisor、层级式、Swarm 几种编排模式的官方说明
- [langgraph-supervisor 库](https://github.com/langchain-ai/langgraph-supervisor)，官方把手写这套 Supervisor 封装成了现成库，先手写一遍再看，每个参数都眼熟
- [结构化输出 how-to](https://python.langchain.com/docs/how_to/structured_output/)，`with_structured_output` 的完整用法，含各模型的支持差异

今天的产出 `supervisor_graph.py` 留好。明天 Day 3 给两个占位 Worker 接上真工具：查订单、发起退款。大脑不动，换手脚，这张图扩展时只需要动 Worker 内部。
