# 第 12 周 · Day 6：Checkpointer 状态持久化——让 Agent 记得你说过什么

> 对应手册任务：学习「Checkpointer：状态持久化」，动手「用 MemorySaver 或 SqliteSaver 保存对话状态，支持恢复」，当日产出 `persistent_agent.py`（可恢复的 Agent）。本篇只解决一个问题：Day 4 那张 ReAct 图每次 invoke 都从零开始，上一轮说过什么一概不认——编译时挂上一个 checkpointer，用 thread_id 圈住一段会话，Agent 就有了跨轮次、跨进程的记性。

## 今日目标

1. 说得清没有 checkpointer 的图为什么是"一次性"的，以及这和第 11 周 Day 1 的"API 无状态"是同一个真相
2. 掌握两个新东西：`compile(checkpointer=...)` 和 `thread_id`，同 thread 续聊、新 thread 新会话的概念模型要能讲给别人听
3. 独立把 Day 4 的裸 ReAct Agent 改造成可恢复的 Agent：同 thread 二连问验证记忆，杀掉进程重开验证 SqliteSaver 恢复

## 概念讲解：图为什么会"失忆"

先做个实验。[Day 4](/week12/day4) 的 `bare_react_agent.py` 跑通之后，你在同一个进程里连问两次（run 函数就是这么调的）：

```python
run("我叫 Jerry，最喜欢的数字是 7。")
run("我叫什么？最喜欢的数字是多少？")
```

第二问的答案大概率是"抱歉，我不知道"。翻 Day 4 的运行器代码就明白原因：每次调用你都传了一份全新的 `{"messages": [HumanMessage(问题)]}`，里面只有当前这一句。

这里有个容易想反的事实：编译出来的 graph 对象不保存任何运行时状态，它只是一张"流程说明书"。invoke 传进什么 State，图就从什么 State 开始跑；跑完返回结果，State 随着调用结束一起消失。第二次 invoke 和第一次 invoke 之间，没有任何东西替你留着那些 messages。

这个真相你早见过一次。第 11 周 Day 1 不用框架手写多轮 CLI 时就确认过：LLM API 是无状态的，模型不记得你说过什么，所谓"记性"全是客户端把 messages 数组一轮轮拼出来、整包发回去。那时拼数组的是你自己，两次 append 写得明明白白。本周你把数组交给 `MessagesState` 和 `add_messages`，框架确实替你管了追加——但只管一次 invoke 内部。跨 invoke（第二轮提问）、跨进程（明天再聊），这段历史依然没人保管。

checkpointer 就是补这块缺口的组件。工作方式听着朴素：图每执行完一个节点，把当时的完整 State 打一份快照（checkpoint）存进去；下次 invoke 带着同一个 thread_id 进来，先把该 thread 存着的最新快照恢复出来，把你的新消息合并进去，接着跑。

为什么不自己写个字典存 messages？因为 State 不只是 messages。Day 1 你在 State 里放过 `current_step`，以后还会有重试计数、中间产物。checkpointer 存的是整个 State，外加"执行到哪个节点"这类进度信息，恢复时一并还原。这套机制今天服务多轮对话，下周它还要撑一个更硬的需求：把图暂停在某一步，等人回来从原地继续（人机协同）。今天打地基，下周起楼。

## 核心知识

本节代码基于 Day 4 的骨架，工具、节点、装配都来自那一篇，片段可单独试，最终完整文件以下面的动手任务为准。

### 1. thread_id：会话的钥匙

概念模型一句话：一个 thread 就是一段会话，thread_id 是这段会话的钥匙。

想象聊天软件左侧的会话列表。点开昨天那个会话接着聊，是同一 thread；点「新建聊天」，是开一个新 thread。checkpointer 是服务端那份会话数据库，按 thread_id 分格存放，每个 thread 一条独立的执行历史，彼此不可见。于是多轮对话的规则只有两条：

- 同一 thread_id 再 invoke：先恢复该 thread 的最新 State，新消息并入后接着跑——续聊
- 新 thread_id invoke：没有任何历史，从初始 State 开跑——新会话

在同一个 thread 内部，每执行完一个节点落一个 checkpoint，各自带递增的 checkpoint_id，串成一条链。今天你只用"最新那个"，但这条链的存在意味着你可以回到任意一步重跑，官方管这叫时间旅行，先按下不表。

### 2. compile(checkpointer=...)：挂上记忆

```python
from langgraph.checkpoint.memory import MemorySaver

checkpointer = MemorySaver()
graph = builder.compile(checkpointer=checkpointer)  # 记忆是编译期挂上的外挂

config = {"configurable": {"thread_id": "user-jerry-001"}}

# 第一问：新 thread，从初始 State 开跑
graph.invoke({"messages": [HumanMessage(content="我叫 Jerry")]}, config)

# 第二问：同 thread，先恢复历史，再把这一句并进去
graph.invoke({"messages": [HumanMessage(content="我叫什么？")]}, config)
```

关键在两处。`compile(checkpointer=...)`：图的结构一个字没改，记忆是编译期外挂的，同一份 builder 挂不同的 Saver 就有不同的记忆寿命。`config`：invoke 的第二个参数，thread_id 塞在 `configurable` 字典里。挂了 checkpointer 的图，invoke 必须带 thread_id，缺了当场抛错——框架宁可响亮地失败，也不让你稀里糊涂跑一个"以为有记忆其实没有"的图。

### 3. MemorySaver、SqliteSaver、PostgresSaver 怎么选

| Saver | 存哪 | 进程重启后 | 适用 |
| --- | --- | --- | --- |
| MemorySaver | 进程内的字典 | 全丢 | 单测、notebook 实验 |
| SqliteSaver | 单个 .db 文件 | 还在 | 本地开发、单人小工具 |
| PostgresSaver | PG 数据库 | 还在 | 生产，多进程共享 |

MemorySaver 随主包自带，`from langgraph.checkpoint.memory import MemorySaver` 直接用。名字里带 Saver，存的却只是一个进程内字典，进程一退就没。

SqliteSaver 和 PostgresSaver 不在主包里，各装各的扩展包，然后用对应的连接构造，SqliteSaver 还要 `setup()` 一次建表：

```bash
pip install langgraph-checkpoint-sqlite    # SqliteSaver
pip install langgraph-checkpoint-postgres  # PostgresSaver
```

```python
import sqlite3
from langgraph.checkpoint.sqlite import SqliteSaver  # 来自扩展包，不是主包

conn = sqlite3.connect("agent_memory.db", check_same_thread=False)
checkpointer = SqliteSaver(conn)
checkpointer.setup()  # 建表，第一次跑调用即可，重复调用无害
```

PostgresSaver 用法同构，连接换成 PG 的，一样 `setup()`。第 4 周 Docker 里那个 PG 还记得吗，当时它存业务数据，现在再添一份差事：存 Agent 的 State。生产为什么必须换 PG？SqliteSaver 是单文件单写者，两个进程同时写会锁库，而生产里你的 API 服务多半不止一个进程。

::: warning 版本与包（2025-10 起）
LangGraph 1.0 里 MemorySaver、SqliteSaver、PostgresSaver 三个都完全有效，别被老教程的迁移恐慌带偏。真正要记的是包的归属：MemorySaver 在主包 `langgraph.checkpoint.memory`；SqliteSaver 和 PostgresSaver 在各自的扩展包里，主包里没有，不装扩展包直接 import 会得到 ModuleNotFoundError。
:::

### 4. invoke 只传新消息：历史由 checkpoint 自动带

对照第 11 周 Day 1 的手动写法，这个差别最直观：

```python
# 第 11 周 Day 1：历史自己拼，每轮全量传
messages.append({"role": "user", "content": "我叫什么？"})
resp = client.chat.completions.create(model=MODEL, messages=messages)

# 挂上 checkpointer 之后：只传新消息，历史自动带
graph.invoke({"messages": [HumanMessage(content="我叫什么？")]}, config)
```

第 11 周 Day 1 那两次 append 被谁接管了：assistant 的回复由 checkpointer 存在上一轮的快照里，新问题由你这次传入，`add_messages` 负责合并。你从"历史的管理员"降级成"新消息的搬运工"。token 账单该涨还是涨（历史照样全量发给模型，第 11 周 Day 1 讲的成本问题一分没少），但管历史这份脏活，从此不用你干了。

## 动手任务：可恢复的 Agent 一步一步

手册任务：用 MemorySaver 或 SqliteSaver 保存对话状态，支持恢复。拆成 5 步，全程约 30 分钟。

**第 1 步：建文件，装包。** 在本周练习目录新建 `persistent_agent.py`，装依赖：

```bash
pip install langgraph langchain-openai langgraph-checkpoint-sqlite
```

key 走环境变量 `OPENAI_API_KEY`，规矩同第 11 周。

**第 2 步：搬 Day 4 的骨架，一字不改。** 工具、模型、两个节点、装配，从上到下依次是：

```python
import datetime
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.graph import StateGraph, START, END, MessagesState

def calculator(expression: str) -> str:
    """计算四则运算表达式。参数 expression：要计算的表达式，例如 '(312 * 46) + 2280'。"""
    try:
        return str(eval(expression, {"__builtins__": {}}, {}))
    except Exception as e:
        return f"无法计算: {e}"

def get_current_time() -> str:
    """获取当前的日期和时间，格式为 'YYYY-MM-DD HH:MM:SS'。"""
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

llm = ChatOpenAI(
    model="deepseek-chat",
    base_url="https://api.deepseek.com",  # 连 OpenAI 就删掉这行
    temperature=0,
)
llm_with_tools = llm.bind_tools([calculator, get_current_time])

def call_agent(state: MessagesState):
    return {"messages": [llm_with_tools.invoke(state["messages"])]}

def should_continue(state: MessagesState):
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else "end"

TOOL_REGISTRY = {"calculator": calculator, "get_current_time": get_current_time}

def call_tools(state: MessagesState):
    results = []
    for call in state["messages"][-1].tool_calls:
        fn = TOOL_REGISTRY.get(call["name"])
        output = fn(**call["args"]) if fn else f"没有这个工具: {call['name']}"
        results.append(ToolMessage(content=str(output), tool_call_id=call["id"]))
    return {"messages": results}

builder = StateGraph(MessagesState)
builder.add_node("agent", call_agent)
builder.add_node("tools", call_tools)
builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", should_continue, {"tools": "tools", "end": END})
builder.add_edge("tools", "agent")
```

特意强调：以上与 Day 4 的产出完全一致。记忆不是改图改出来的，是编译时外挂的，这是今天最重要的一句话。

**第 3 步：挂 MemorySaver，二连问验证记忆。** 文件末尾追加：

```python
from langgraph.checkpoint.memory import MemorySaver

graph = builder.compile(checkpointer=MemorySaver())

def ask(question: str, thread_id: str):
    config = {"configurable": {"thread_id": thread_id}}
    result = graph.invoke({"messages": [HumanMessage(content=question)]}, config)
    print("[" + thread_id + "] " + result["messages"][-1].content)

ask("我叫 Jerry，最喜欢的数字是 7。", "user-001")
ask("我叫什么？最喜欢的数字是多少？", "user-001")  # 同 thread：答得上来
ask("我叫什么？", "user-002")                       # 新 thread：一无所知
```

第二问答得上来，说明历史真的从 checkpoint 恢复了；第三问一无所知，说明会话之间真的隔离。三个问题，两个结论，一次跑完。顺手看一眼库房里存了什么：

```python
snapshot = graph.get_state({"configurable": {"thread_id": "user-001"}})
print(len(snapshot.values["messages"]))  # 这个 thread 攒了几条消息
print(snapshot.next)                     # 下一个待执行节点；跑完的图是空元组
```

`get_state` 返回该 thread 最新快照。哪天 messages 条数和你预期对不上，先来这儿数一数，比瞎猜强。

**第 4 步：换 SqliteSaver，跨进程恢复。** 改两处：编译换成 SqliteSaver，三行固定提问换成从命令行读。把第 3 步开头两行和三行 ask 换成：

```python
import sys
import sqlite3
from langgraph.checkpoint.sqlite import SqliteSaver

conn = sqlite3.connect("agent_memory.db", check_same_thread=False)
checkpointer = SqliteSaver(conn)
checkpointer.setup()
graph = builder.compile(checkpointer=checkpointer)

ask(sys.argv[1], "user-001")  # 问题从命令行来，thread 固定
```

跑法是关键，两遍两个进程：

```bash
python persistent_agent.py "我叫 Jerry，最喜欢的数字是 7。"
# 进程结束，内存清空
python persistent_agent.py "我叫什么？最喜欢的数字是多少？"
```

第二遍是新进程，这里换回 MemorySaver 必死无疑（不信可以换回去做对照），但 SqliteSaver 答得上来：State 上次落在 agent_memory.db 里，这次启动原样恢复。目录里多出来的 .db 文件，就是 Agent 的记性本体。再补一个狠的对照：删掉 agent_memory.db 再问一遍，它立刻失忆。记忆在文件里，不在代码里，这一下看得明明白白。

**第 5 步：亲眼看一次缺 thread_id 的报错。** 临时加一行：

```python
graph.invoke({"messages": [HumanMessage(content="测试")]})
# 挂了 checkpointer 却不传 config，框架当场抛错，大意是缺少 thread_id
```

读完报错把这行删掉，文件回到能跑的状态。框架的态度值得学：含糊地跑下去，不如响亮地失败。

::: tip 交差留哪个版本
练习时 MemorySaver 和 SqliteSaver 都跑一遍，最终文件留 SqliteSaver 版。以后所有要"接着上次聊"的练习默认挂它，省得每问一句都重开进程重新自我介绍。
:::

## 常见踩坑

**坑 1：挂了 checkpointer，invoke 不带 thread_id。** 症状就是动手任务第 5 步那个报错。常见起因是把 config 拼错：thread_id 必须放在 `configurable` 这一层，写成 `{"thread_id": "..."}` 顶层传进去等于没传。别用 try 把报错吞掉，这个错拦着的是"以为有记忆、其实每轮都失忆还浑然不觉"的大坑。

**坑 2：thread_id 的粒度用错。** thread_id 是"一段会话"的 ID，不是"一条消息"的 ID。每条消息换一个新 thread_id，等于永远从零开始，记忆形同虚设；反过来全应用共用一个 thread_id，所有人串进同一段会话，A 告诉 Agent 的名字 B 也"记得"。生产里常见的做法是用户 ID 加会话 ID 拼一个，一个用户多段会话互不打扰。

**坑 3：把 MemorySaver 当持久化用。** 名字里的 Saver 有欺骗性，它就是进程内的一个字典。notebook 里做实验顺手，进程一重启什么都不剩。判断标准简单粗暴：记忆需不需要活过这次进程？需要，就换 SqliteSaver 或 PostgresSaver，没有中间路线。

**坑 4：挂了 checkpointer 还手动拼全量历史。** 有人把第 11 周的习惯带过来：invoke 前把历史消息重新构造一遍全传进去。结果 messages 重复膨胀——HumanMessage 每次构造都生成新的 id，`add_messages` 按 id 追加，旧消息换个 id 就再进一份。挂了 checkpointer 之后，invoke 只传这一轮的新消息，这是纪律。

**坑 5：以为 checkpointer 只存 messages。** 它存的是完整 State 加进度（下一个节点是谁）。你在 State 里加的 `current_step`、重试计数，恢复时一并回来。这不只是方便：下周讲人机协同，Agent 要在某一步暂停、等人审核后从原地继续，靠的就是"State 加进度"能整体落盘、整体还原。没有 checkpointer，图一停执行现场就没了。今天打的地基，下周直接起楼。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 没有 checkpointer 的图，同一进程里第二次 invoke 从什么 State 开始？这和第 11 周 Day 1 的哪个结论同源？

::: details 参考答案
从你这次传入的初始 State 开始，上一次 invoke 的 State 随调用结束消失，graph 对象本身不保存运行时状态。同源结论：LLM API 无状态，"记性"全靠客户端保管 messages 数组——第 11 周 Day 1 是你手动 append，现在是 checkpointer 接班，边界从数组边界变成了 checkpoint 边界。
:::

2. 同一 thread_id 连续 invoke 两次，框架各做了什么？

::: details 参考答案
第一次：新 thread 从初始 State 开跑，每执行完一个节点落一个 checkpoint，各自带递增的 checkpoint_id 串成链。第二次：先取该 thread 最新 checkpoint 恢复 State，把新消息合并进去接着跑。你只消费"最新那个"，但整条链都在。
:::

3. 换一个新 thread_id 再问同样的问题，会发生什么？这个隔离有什么用？

::: details 参考答案
新 thread 没有任何历史，从初始 State 开跑，对别的 thread 一无所知。用处是会话隔离：多用户、多话题互不串线，等同一个用户想开新话题时也能干净重来，不用被旧上下文带偏。
:::

4. 三个 Saver 各自什么时候用？生产为什么是 PostgresSaver？

::: details 参考答案
MemorySaver 是进程内字典，单测和实验用；SqliteSaver 落单个 .db 文件，本地开发、单人小工具够用；PostgresSaver 连 PG，生产标配。原因是并发：SqliteSaver 单文件单写者，多进程同时写会锁库，生产服务通常多进程部署，PG 才能安全共享，正好复用第 4 周搭的 PG 基础设施。
:::

5. 为什么说 checkpointer 是下周 interrupt()（人机协同）的前提？

::: details 参考答案
interrupt 要把图暂停在某个节点、等人决策后从原地继续。暂停期间 State 和进度必须被完整存住，恢复时原样还原，这正是 checkpointer 的工作。没有它，进程一停执行现场就消失，"从原地继续"无从谈起。所以下周的 HITL 不是新加一个存储，而是站在今天的 checkpointer 上用。
:::

## 延伸阅读

- [LangGraph 官方文档：Persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/)，checkpointer、thread、checkpoint 三层概念的正主出处，值得通读
- [LangGraph 官方文档：Memory](https://langchain-ai.github.io/langgraph/concepts/memory/)，今天这种短期记忆和跨会话长期记忆的边界，后面记忆专题会展开
- [langgraph-checkpoint-sqlite 的 PyPI 页面](https://pypi.org/project/langgraph-checkpoint-sqlite/)，扩展包的安装说明和 SqliteSaver 用法示例

今天的 `persistent_agent.py` 留好。下周讲人机协同时，interrupt() 就直接挂在这份 checkpointer 上用：暂停、等人、恢复，一趟到底。
