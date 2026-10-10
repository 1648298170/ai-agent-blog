# 第 12 周 · Day 3：条件边与路由——让图根据 State 自己选路

> 对应手册任务：学习「条件边 + 路由：根据 State 决定下一步」，动手实现一个「如果 messages 为空则调用 LLM，否则结束」的条件路由，当日产出「条件路由」。本篇只解决一个问题：前两天画通的直线图，线全是焊死的，A 执行完永远是 B，State 里发生了什么图根本不关心；条件边把「下一步去哪」从建图时写死的常量，变成运行时由 State 决定的函数返回值。

## 今日目标

1. 说得清固定边和条件边的区别，掌握 `add_conditional_edges` 的三个参数：源节点、router 函数、映射表
2. 写得出守契约的 router：只读 State、返回字符串、不带副作用，能脱离图单独测试
3. 独立完成「messages 为空进 llm，否则直接结束」的条件路由，并用 `stream_mode="updates"` 亲眼看每一步是谁在跑

## 概念讲解：为什么需要条件边

先盘点前两天的家底：一条直线图，START → 节点 → 节点 → END，两站一线到底。把节点串起来的是 `add_edge`，这类线叫固定边。它的特点一句话讲完：编译时定死，运行时无条件执行。前一个节点跑完，后一个节点必然开跑，哪怕前者的输出明明白白写着「不用往下走了」，也拦不住。

这是流水线的世界：工位顺序固定，产品没有发言权。做数据处理管道、固定流程的脚本，直线图完全够用。但 Agent 的日常全是分支：

- 用户问天气，得先调工具查一查；用户打招呼，直接回话就行
- 会话还没开始，先进 LLM；结论已经有了，就该收工退出
- 循环跑了几轮还没收敛，该有个机制喊停

直线图表达不了「看情况」。你可能会想，在节点里写 if else 不行吗？行，但分支逻辑被埋进节点内部，图上看不见：想知道「这个节点之后可能去哪」，得去读节点源码；想加一条分支，就得改节点代码。LangGraph 的选择是把「选路」提升为图的一等公民，这就是条件边。

条件边由两部分组成。一个是你自己写的普通函数，叫 router（路由函数）：接收 State，返回一个字符串。另一个是映射表，一个 dict：把字符串翻译成真实的目的地。执行到条件边时，LangGraph 调一次 router，拿返回值查映射表，决定下一步去哪。图还是你熟悉的图，只是走向由运行时的 State 说了算。

这个设计还有个被低估的好处：router 是纯函数，测它不需要把图跑起来。构造一个假 State，`assert route(fake) == "llm"`，一行验完。分支逻辑从节点里搬出来，既画在图上让人一眼看清，又留着单测的入口。

## 核心知识

本节的代码块都是独立示例，`pip install langgraph` 后存成 .py 文件直接运行就能看到结果。本篇按 LangGraph 1.0 的 API 写，`add_conditional_edges` 在 1.0 里是稳定接口，照抄不用犹豫。最终完整文件以下面的动手任务为准。

### 1. 固定边 vs 条件边：一笔之差

先看两种边并排放（片段示意，完整可跑版本见后面小节）：

```python
# 固定边：a 执行完，无条件去 b
builder.add_edge("a", "b")

# 条件边：a 执行完，去哪由 route 的返回值说了算
builder.add_conditional_edges(
    "a",                          # 源节点：边从谁身上出发
    route,                        # router：读 State，返回字符串
    {"llm": "llm", "done": END},  # 映射表：返回值 → 真实目的地
)
```

关键在第三个参数 `{"llm": "llm", "done": END}`：左边是 router 的返回值，右边是目的地，两边可以不同名。目的地写节点名，也可以写 `END` 表示到此为止。注意 `END` 不是字符串，是从 `langgraph.graph` import 进来的常量，别给它加引号。

映射表其实可以省略，省略时 router 的返回值直接当节点名用。但显式写出来有两个好处：读者一眼看全这个节点的所有可能去向；目的地写错时，构建阶段就能被拦下，不用等运行时才炸。

### 2. router 的契约：纯函数，只读不改

router 是你和 LangGraph 之间的契约，条款就三条：入参是 State；返回值是字符串（或字符串列表，表示同时去多个目的地，本篇用不上）；函数体只读不写。执行时机也值得记一下：源节点跑完之后、目的地节点开跑之前，LangGraph 拿「当时的 State」调它一次。从 START 出发的条件边，用的就是你 invoke 时传入的初始 State。

「只读不写」这条最容易被破。看两个反面教材：

```python
# 错：在 router 里修改 State
def bad_router_mutate(state: MessagesState):
    state["messages"].append(HumanMessage(content="垫一条消息"))
    return "llm"


# 错：在 router 里干重活
def bad_router_busy(state: MessagesState):
    # decision = model.invoke(...)  # 调模型、发请求、写库，全是雷
    return "llm"
```

为什么计较？LangGraph 更新 State 只有一条合法通道：节点返回 dict，交给 reducer 合并。router 的返回值只被当作路由键，你在里面改 State，改动不会被当成状态更新生效，还可能污染正在被读取的数据，属于没人替你担保的写法。至于干重活：router 的调用时机归框架管，你控制不了，塞进去的请求会让每一步路由都变慢，而且这种函数没法脱离图单独测试。

正确姿势是今天动手任务里那种两行小函数，判断只依赖入参。想影响路由的信息（比如 LLM 决定用工具），让节点把它写进 State，router 只负责翻译。记住分工：节点生产信息，条件边消费信息。

### 3. 循环图：A→B→A 合法，recursion_limit 兜底

直线思维容易让人以为图不能绕圈。恰恰相反，LangGraph 的图不是 DAG，环合法且常用，明天的 ReAct 就靠环工作。新建 `loop_demo.py`，整个文件贴进去跑一遍：

```python
# loop_demo.py
from typing import Literal

from typing_extensions import TypedDict
from langgraph.errors import GraphRecursionError
from langgraph.graph import StateGraph, START, END


class LoopState(TypedDict):
    count: int


def bump(state: LoopState):
    return {"count": state["count"] + 1}


# 版本一：只有固定边，b 之后永远回 a，没有出口
builder = StateGraph(LoopState)
builder.add_node("a", bump)
builder.add_node("b", bump)
builder.add_edge(START, "a")
builder.add_edge("a", "b")
builder.add_edge("b", "a")  # 环：b 的下一步又回到 a

graph = builder.compile()
try:
    graph.invoke({"count": 0})
except GraphRecursionError as e:
    print(f"预期中的崩溃：{e}")  # Recursion limit of 25 reached ...


# 版本二：给环装一个条件出口
def exit_or_loop(state: LoopState) -> Literal["again", "exit"]:
    return "again" if state["count"] < 5 else "exit"


builder2 = StateGraph(LoopState)
builder2.add_node("a", bump)
builder2.add_node("b", bump)
builder2.add_edge(START, "a")
builder2.add_edge("a", "b")
builder2.add_conditional_edges("b", exit_or_loop, {"again": "a", "exit": END})

graph2 = builder2.compile()
print(graph2.invoke({"count": 0}))  # {'count': 6}
```

版本一没有出口，a→b→a→b 永远跑下去。LangGraph 的保底机制是 recursion_limit：单次执行最多 25 个超步，超出就抛 `GraphRecursionError`，不让你的进程跟着环一起转到天荒地老。上限可以调：`graph.invoke({"count": 0}, config={"recursion_limit": 50})`。但对没有出口的图，调大只是把崩溃从第 25 步推迟到第 50 步，治本的答案是版本二那样给环装一个条件出口。

死循环的系统性防御是第 21 周的正题，今天先记住两件事：环合法，recursion_limit 默认 25 是最后一道闸。

### 4. stream_mode="updates"：每一步谁在跑，一眼看清

图一旦有了分支和环，「谁在哪一步跑了」就成了调试时最想知道的事。invoke 只给你最终 State，中间过程全是黑盒。stream 能打开黑盒，而且有两个档位。

默认档 `values`：每步吐出完整 State 快照。消息一多就受不了，第 10 步的输出会把前 9 步的消息全部重放一遍，日志又长又难找重点。增量档 `updates`：只吐「这一步哪个节点执行了、它往 State 里写了什么」。在 `loop_demo.py` 末尾接着加：

```python
for chunk in graph2.stream({"count": 0}, stream_mode="updates"):
    print(chunk)
# {'a': {'count': 1}}
# {'b': {'count': 2}}
# {'a': {'count': 3}}
# {'b': {'count': 4}}
# {'a': {'count': 5}}
# {'b': {'count': 6}}
```

每个 chunk 是一个小 dict：key 是这一步执行的节点名，value 是它返回的增量。环转了几轮、每轮谁干的活，输出里一目了然。从今天起养成习惯：调带分支或循环的图，先上 `stream_mode="updates"` 看一遍执行轨迹，再谈别的。

### 5. 进阶路由：看 tool_calls 分流，明天 ReAct 的方向盘

手册任务的路由是热身，真实 Agent 里最重要的路由长这样：看最后一条消息有没有 tool_calls（模型请求调用工具的标记），有就去工具节点，没有就结束。新建 `react_router.py`，完整贴入：

```python
# react_router.py
from typing import Literal

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import MessagesState, StateGraph, START, END


def llm_node(state: MessagesState):
    # 真实项目里 reply 由 model.invoke(state["messages"]) 产生：
    # 模型决定用工具时，AIMessage 自带 tool_calls；不用时只有文字
    last = state["messages"][-1]
    if "天气" in last.content:
        reply = AIMessage(
            content="",
            tool_calls=[
                {"name": "get_weather", "args": {"city": "北京"}, "id": "call_1"}
            ],
        )
    else:
        reply = AIMessage(content="这个问题不需要工具")
    return {"messages": [reply]}


def tools_node(state: MessagesState):
    # 真实项目里按 tool_calls 逐个执行工具，把结果写回 State
    return {"messages": [AIMessage(content="北京今天 26 度，晴")]}


def should_use_tools(state: MessagesState) -> Literal["tools", "end"]:
    last = state["messages"][-1]
    if getattr(last, "tool_calls", None):
        return "tools"
    return "end"


builder = StateGraph(MessagesState)
builder.add_node("llm", llm_node)
builder.add_node("tools", tools_node)
builder.add_edge(START, "llm")
builder.add_conditional_edges(
    "llm",
    should_use_tools,
    {"tools": "tools", "end": END},
)
builder.add_edge("tools", "llm")  # 工具结果送回 LLM，一个环诞生了

graph = builder.compile()

for chunk in graph.stream(
    {"messages": [HumanMessage(content="北京天气怎么样")]},
    stream_mode="updates",
):
    print(chunk)
# {'llm': {'messages': [AIMessage(content='', tool_calls=[...])]}}
# {'tools': {'messages': [AIMessage(content='北京今天 26 度，晴', ...)]}}
# {'llm': {'messages': [AIMessage(content='这个问题不需要工具', ...)]}}
```

三个细节。第一，`getattr(last, "tool_calls", None)`：AIMessage 天生带 `tool_calls` 属性（默认空列表），别的消息类型没有，直接 `last.tool_calls` 遇到 HumanMessage 会抛 AttributeError，getattr 是官方示例也在用的兜底写法。第二，`tools → llm` 那条固定边造出一个环，但图不会失控：第二次进 llm 时，最后一条消息是工具结果，不带 tool_calls，路由送它去 END。「什么时候走」和「什么时候停」用的是同一套机制：读 State，做判断。第三，换一句不涉及工具的输入（比如「讲个冷笑话」），第一轮路由就直接去 END，只会打印一个 chunk。

这就是明天 ReAct Agent 的路由核心。官方预制的 create_react_agent，骨架和这张图同构：模型带 tool_calls 就进工具节点，否则收工，工具结果回炉重跑模型。今天把它拆开看明白，明天拼起来就不新鲜了。

## 动手任务：条件路由一步一步

手册任务：实现「如果 messages 为空则调用 LLM，否则结束」的条件路由。拆成 5 步，全程约 20 分钟。

**第 1 步：建环境、建文件。** 执行 `pip install langgraph`（会一并装上 langchain-core，消息类从它 import）。在练习目录新建 `route_demo.py`，下面每一步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：定义 State 和 llm 节点。** State 直接用内置的 `MessagesState`：它自带 `messages` 键和 `add_messages` reducer，节点往里返回新消息时做追加合并而不是整包覆盖。llm 节点先用替身，保证零密钥可跑：

```python
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph import MessagesState, StateGraph, START, END


def llm_node(state: MessagesState):
    # 真实项目里换成：reply = model.invoke(state["messages"])
    reply = AIMessage(content="我是 LLM 的回复")
    return {"messages": [reply]}
```

**第 3 步：写 router，先单测再上图。** 判断逻辑总共两行，返回值类型用 Literal 钉死：

```python
from typing import Literal


def route_on_messages(state: MessagesState) -> Literal["llm", "done"]:
    return "llm" if len(state["messages"]) == 0 else "done"


# router 是纯函数，不用建图就能测
print(route_on_messages({"messages": []}))                            # llm
print(route_on_messages({"messages": [HumanMessage(content="hi")]}))  # done
```

这两行 print 就是纯函数的红利：判断对不对，10 秒验完，图的影子都不用见。

**第 4 步：add_conditional_edges 组图，跑两遍。** 条件边挂在 START 上，进图第一步就分流；llm 跑完用固定边收尾：

```python
builder = StateGraph(MessagesState)
builder.add_node("llm", llm_node)
builder.add_conditional_edges(
    START,
    route_on_messages,
    {"llm": "llm", "done": END},
)
builder.add_edge("llm", END)

graph = builder.compile()

# 第一遍：messages 为空，进 llm
result1 = graph.invoke({"messages": []})
print(len(result1["messages"]))  # 1，llm 跑了，写入一条回复

# 第二遍：messages 已有内容，直接结束
result2 = graph.invoke({
    "messages": [HumanMessage(content="第一句"), HumanMessage(content="第二句")]
})
print(len(result2["messages"]))  # 2，llm 一步没跑，State 原样返回
```

同一张图，两次执行走了两条路。差别不在代码，在输入的 State：路由的判断依据自始至终只有一个，就是当时的状态。

**第 5 步：换 updates 档再跑一遍。** 把第 4 步的两次 invoke 换成 stream：

```python
for chunk in graph.stream({"messages": []}, stream_mode="updates"):
    print(chunk)
# {'llm': {'messages': [AIMessage(content='我是 LLM 的回复', ...)]}}

for chunk in graph.stream(
    {"messages": [HumanMessage(content="已有对话")]},
    stream_mode="updates",
):
    print(chunk)
# （什么也不打印：没有任何节点执行，START 直接路由到了 END）
```

第二段循环一个 chunk 都不吐，这本身就是证据：图确实一步活都没干。

::: tip 接真模型
把 llm_node 里的替身换成真调用：`pip install langchain` 后，`from langchain.chat_models import init_chat_model`，`model = init_chat_model("openai:gpt-4o-mini")`，然后 `reply = model.invoke(state["messages"])`，记得配好环境变量里的密钥。光学路由的话，替身够用还省钱。
:::

## 常见踩坑

**坑 1：映射表指向不存在的节点。** 节点改了名，忘了同步映射表，构建图时就会抛 ValueError，提示你引用了没注册的节点名。映射表右边的值必须是 `add_node` 注册过的名字，或者 START/END 常量。给节点改名前，先拿节点名全局搜一遍。

**坑 2：router 返回值和映射表对不上。** router 返回 `"done"`，映射表里写的 key 是 `"end"`，查表落空时 LangGraph 会把返回值本身当节点名去找，找不到就在运行时报错，出错位置离你拼错的地方十万八千里。对策：router 的返回类型标 Literal，映射表的 key 照着 Literal 逐字抄，两边一个字母都不要差。

**坑 3：同一个节点同时挂固定边和条件边。** 以为固定边是「默认去向」、条件边管「特殊情况」，二选一？不是。两类边会全部发车，目的地并行执行，你收获一次计划外的扇出。想要「其余情况都去某节点」，把它做成映射表里的一行，而不是另挂一条固定边。

**坑 4：把 recursion_limit 当调参神器。** 默认 25，按超步计数，不是按节点调用次数。GraphRecursionError 一出，先别急着调大：没有出口的图，调到 100 也一样是死，只是死得晚一点。先检查环上有没有条件出口、出口条件是否真的可能为真，再谈改上限。第 21 周讲死循环防御时会把这套检查展开。

**坑 5：在 router 里做判断以外的事。** 判断的原料（LLM 想不想用工具、循环跑了几轮）应该由节点写进 State；router 只做翻译，把 State 翻成路由键。在 router 里调模型、发请求、写日志，路由阶段被拖慢不说，函数也再没法单测。分工记牢：节点生产信息，条件边消费信息。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `add_edge` 和 `add_conditional_edges` 的本质区别是什么？条件边的三个参数各管什么？

::: details 参考答案
固定边在编译期把去向写死，运行时无条件执行；条件边在运行时调用 router 读取 State，由返回值决定去向。三个参数：源节点（边从谁出发，可以是 START）、router（读 State 返回字符串的纯函数）、映射表（返回值到真实目的地的翻译，目的地是节点名或 END 常量）。
:::

2. 为什么 router 必须是纯函数？在里面改 State 或调模型分别有什么后果？

::: details 参考答案
State 的更新只认节点返回的 dict（走 reducer 合并），router 的返回值只被当作路由键：在里面改 State，改动不会被当成合法更新生效，还可能污染正在被读取的数据。在里面调模型等重活，会拖慢每一步路由，且函数无法脱离图单独测试。router 的调用时机由框架控制，任何副作用都会让图的行为失去可推理性。
:::

3. 「messages 为空进 llm，否则结束」的 router 和映射表怎么写？

::: details 参考答案
router 两行：`return "llm" if len(state["messages"]) == 0 else "done"`。映射表：`{"llm": "llm", "done": END}`。条件边从 START 出发：`builder.add_conditional_edges(START, route_on_messages, {...})`，再补一条 `builder.add_edge("llm", END)` 给 llm 收尾。
:::

4. A→B→A 的循环图合法吗？默认上限是多少？超了会怎样？怎么改？

::: details 参考答案
合法，LangGraph 的图不是 DAG，环是常态（ReAct 就靠环工作）。单次执行默认最多 25 个超步，超出抛 GraphRecursionError。用 `graph.invoke(inputs, config={"recursion_limit": 50})` 可以调大，但对没有出口的图只是推迟崩溃，治本要靠条件边给环设计出口。
:::

5. `stream_mode="updates"` 和默认的 `"values"` 输出差别在哪？调试循环图时为什么 updates 更好用？

::: details 参考答案
values 每步输出完整 State 快照，消息越多、步数越多，后面每条输出越冗长；updates 每步只输出「哪个节点执行了、它写入的增量」，形如 `{'llm': {'messages': [...]}}`。循环图里 State 越滚越大，values 每轮都全量重放历史，updates 则一眼看出每轮谁在跑、写了什么。
:::

## 延伸阅读

- [LangGraph 官方文档：Low-level Concepts](https://langchain-ai.github.io/langgraph/concepts/low_level/)，Graph API 概念页，条件边、State、reducer 的官方说明都在这里
- [LangGraph How-to 指南](https://langchain-ai.github.io/langgraph/how-tos/)，分支、循环、流式输出各有独立小节，具体写法拿不准先翻这里
- [LangGraph GitHub 仓库](https://github.com/langchain-ai/langgraph)，官方示例库，多看别人生产代码里的 router 写法长手感

今天写的 `should_use_tools` 明天原封不动就是 ReAct Agent 的方向盘：接上真模型和真工具，让 LLM 自己决定查不查资料、何时收工。`route_demo.py` 留好。
