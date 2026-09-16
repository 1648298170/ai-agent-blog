# 第 12 周 · Day 4：手写 ReAct 循环——两个节点一条边，串出 Agent

> 对应手册任务：学习「ReAct 循环：Thought → Action → Observation」，动手「用 LangGraph 实现裸 ReAct 循环，含工具调用节点」，当日产出 `bare_react_agent.py`。本篇只解决一个问题：上周你用 while 亲手滚过的 Function Calling 循环，怎么在 LangGraph 里显式成一张可运行的图，让「模型想 → 调工具 → 看结果 → 再想」变成两个节点加一条条件边。这是 Agent 面试的 TOP1 考点，也是一切 Agent 的骨架。

## 今日目标

1. 说得清 ReAct 的思想：Reason 与 Act 交替进行，它和第 11 周手写的 FC 循环在本质上是一回事
2. 掌握图结构：agent 节点（调 LLM）⇄ tools 节点（执行工具）加一条按 `AIMessage.tool_calls` 有无路由的条件边
3. 独立完成可运行的裸 ReAct Agent（计算器 + 当前时间两个工具），每一步打印出 Thought/Action/Observation

## 概念讲解：为什么 Agent 是一个循环

先回忆第 11 周 Day 2 你手写的 Function Calling 循环，骨架大概长这样（凭记忆的缩略版）：

```python
while True:
    resp = call_llm(messages, tools=TOOLS)
    if not resp.tool_calls:          # 模型不再要工具，说明能答了
        print(resp.content)
        break
    for call in resp.tool_calls:     # 执行每个工具调用
        result = run_tool(call)
        messages.append(tool_message(call, result))  # 结果回填
```

写完你大概嘀咕过：这不就是个 while 吗，难在哪？难在你想往这个循环上挂的每一样东西：多轮状态、中断恢复、流式输出、执行记录，全都得撬开 while 往里塞。

ReAct 就是给这个循环起的学名。2022 年的论文《ReAct: Synergizing Reasoning and Acting in Language Models》提出让模型按「Thought → Action → Observation」的节奏干活：Thought 是模型想（「我得先算这一步」），Action 是发起工具调用，Observation 是工具结果回填给模型；模型看完 Observation 产生新的 Thought，如此往复，直到某一轮 Thought 的结论是「可以回答了」。

原论文是纯文本实现，模型真的逐行输出 `Thought:` 和 `Action:`，外部代码拼上 `Observation:` 再喂回去。今天的工具调用协议把 Action 装进了结构化的 `tool_calls`，把 Observation 装进了 `ToolMessage`，骨架一点没变。回头看上面那个 while，循环体转一圈，恰好就是一轮 Thought → Action → Observation。所以面试里你可以脱口而出：Agent 就是一个循环，ReAct 是这个循环的显式名字。

LangGraph 做的事，是把这个循环升格成框架的一等公民。State、节点、条件边你前面都学过了，拼起来就是 ReAct：agent 节点负责想（调 LLM），tools 节点负责做（执行工具），条件边决定循环是再转一圈（还有 tool_calls）还是退出（没了，去 END）。相比裸 while，状态、路由、退出条件各有各的固定位置，持久化、中断、流式这些能力是图自带的。今天写完你自己对比。

顺带一句版本变化：LangGraph 1.0 把 prebuilt 的 `create_react_agent` 废弃了，官方建议迁到 langchain 包里的新 `create_agent`。也就是说，「自己串一个 ReAct」从练习题变成了正经手艺。面试官问「不调 prebuilt 你会不会」，考的正是这一篇。

## 核心知识

本节的代码块按最终文件的顺序出现，工具函数在动手任务第 2 步定义。拼装顺序在动手任务里逐步说明。

### 1. 图骨架：两个节点，一条条件边

先看图长什么样：

```
          ┌──────────┐  有 tool_calls    ┌──────────┐
START ──▶ │  agent   │ ────────────────▶ │  tools   │
          │（想）    │ ◀──────────────── │（做）    │
          └──────────┘     普通边回填     └──────────┘
               │
               │ 没有 tool_calls
               ▼
              END
```

对应装配代码：

```python
from langgraph.graph import StateGraph, START, END, MessagesState

builder = StateGraph(MessagesState)
builder.add_node("agent", call_agent)      # 想：调用 LLM
builder.add_node("tools", call_tools)      # 做：执行工具
builder.add_edge(START, "agent")           # 开局：问题直接进思考
builder.add_conditional_edges(             # 循环的退出条件
    "agent",
    should_continue,                       # 路由函数：返回 "tools" 或 "end"
    {"tools": "tools", "end": END},
)
builder.add_edge("tools", "agent")         # 做完必须回去想
graph = builder.compile()
```

关键在三种线：START 到 agent 是固定开场；tools 到 agent 是普通边，意思是工具结果回填后必须回到 agent 节点看结果、接着想；agent 到 tools 或 END 是条件边，循环还转不转由路由函数说了算。两个节点一条条件边，没了。后面你见到的各种 Agent、RAG、多 Agent 协作，都是在这个骨架上加节点加花样。

### 2. agent 节点：bind_tools 与路由依据 tool_calls

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="deepseek-chat",
    base_url="https://api.deepseek.com",  # 和第 11 周同一个地方；连 OpenAI 就删掉这行
    temperature=0,                        # 循环要稳，温度高了两步就开始漂
)

llm_with_tools = llm.bind_tools([calculator, get_current_time])

def call_agent(state: MessagesState):
    response = llm_with_tools.invoke(state["messages"])
    return {"messages": [response]}

def should_continue(state: MessagesState):
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else "end"
```

关键在 `bind_tools`：它把两个函数的名字、参数签名、docstring 编译成工具手册随请求发给模型，等价于第 11 周 Day 2 你手写的 `tools` 参数。模型决定行动后，返回的 AIMessage 上就钉着 `tool_calls`，每项形如 `{"name": "calculator", "args": {"expression": "..."}, "id": "call_abc123"}`。路由函数只看一件事：最后一条消息有没有 `tool_calls`，有就去 tools，没有就去 END。

另一个关键在节点返回值：`call_agent` 返回的不是整个 messages，而是增量 `{"messages": [response]}`。MessagesState 自带 add_messages 归并逻辑，节点返回的是「合并指令」，新消息追加、历史原样。上周你自己维护 `messages.append(...)`，现在框架替你管。

### 3. tools 节点：手写执行器与 ToolMessage 回填

```python
from langchain_core.messages import ToolMessage

TOOL_REGISTRY = {"calculator": calculator, "get_current_time": get_current_time}

def call_tools(state: MessagesState):
    results = []
    for call in state["messages"][-1].tool_calls:   # 一条 AIMessage 可能带多个调用
        fn = TOOL_REGISTRY.get(call["name"])
        output = fn(**call["args"]) if fn else f"没有这个工具: {call['name']}"
        results.append(ToolMessage(content=str(output), tool_call_id=call["id"]))
    return {"messages": results}
```

关键在 `tool_call_id`：每个 tool_call 必须有一条 ToolMessage 回应，id 要原样抄 `call["id"]`。这是第 11 周 Day 2 讲过的底层协议，端点靠 tool_call_id 把 Action 和 Observation 配对，对不上当场 400。循环也一样要紧：模型一轮可以发多个 tool_calls，只回一个照样算协议违规。

手写完这个节点，可以告诉你一个「秘密」：`langgraph.prebuilt.ToolNode` 干的就是这件事，一行 `ToolNode([calculator, get_current_time])` 顶替整个 `call_tools`。教学仍然先手写，写过一遍，ToolNode 对你就不再是黑盒，而是缩写。

## 动手任务：裸 ReAct Agent 一步一步

手册任务：用 LangGraph 实现裸 ReAct 循环，含工具调用节点。拆成 5 步，全程约 30 分钟。

**第 1 步：建文件，装包。** 在本周练习目录新建 `bare_react_agent.py`，装依赖：

```bash
pip install langgraph langchain-openai
```

key 走环境变量 `OPENAI_API_KEY`（放 DeepSeek 的 key，规矩同第 11 周 Day 1）。Windows PowerShell 里 `$env:OPENAI_API_KEY="sk-..."`，macOS/Linux 用 export。

**第 2 步：定义两个工具。** 工具就是普通函数，docstring 就是工具手册，写得多准，模型调得多对：

```python
import datetime

def calculator(expression: str) -> str:
    """计算四则运算表达式。参数 expression：要计算的表达式，例如 '(312 * 46) + 2280'。"""
    try:
        return str(eval(expression, {"__builtins__": {}}, {}))  # 演示用：锁掉内置函数
    except Exception as e:
        return f"无法计算: {e}"

def get_current_time() -> str:
    """获取当前的日期和时间，格式为 'YYYY-MM-DD HH:MM:SS'。"""
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
```

eval 锁掉 `__builtins__` 只是演示省事，生产代码请换 ast 解析或专门的计算库。`get_current_time` 没有参数，模型调用时会传空的 `args`，下面 `fn(**{})` 天然兜住。

**第 3 步：写入 agent 节点。** 把核心知识第 2 节的代码原样贴进文件：`llm`、`llm_with_tools`、`call_agent`、`should_continue`。顺手检查 docstring，它们正被 bind_tools 编成手册。

**第 4 步：手写 tools 节点，装配图。** 贴入核心知识第 3 节的 `TOOL_REGISTRY`、`call_tools`，再贴第 1 节的装配代码。至此文件从上到下依次是：导入、工具、模型、agent 节点、tools 节点、装配，一段不缺即可运行。

**第 5 步：跑三个问题，看日志。** 文件末尾加一个带日志装饰的运行器，用 `stream_mode="values"` 拿到每一步的快照：

```python
from langchain_core.messages import HumanMessage

def run(question: str):
    print(f"\n========== 问题：{question} ==========")
    for snapshot in graph.stream(
        {"messages": [HumanMessage(content=question)]},
        stream_mode="values",   # 每执行一个节点吐一份全量状态
    ):
        msg = snapshot["messages"][-1]
        if isinstance(msg, HumanMessage):
            continue
        if isinstance(msg, ToolMessage):
            print(f"[Observation] {msg.content}")
        elif getattr(msg, "tool_calls", None):
            for call in msg.tool_calls:
                print(f"[Thought] 决定调用工具")
                print(f"[Action] {call['name']}({call['args']})")
        else:
            print(f"[最终答案] {msg.content}")

run("(312 * 46) + 2280 等于多少？")
run("现在是几月几号几点？")
run("用一句话说说什么是 Agent。")
```

第一问的预期输出（缩略）：

```
========== 问题：(312 * 46) + 2280 等于多少？ ==========
[Thought] 决定调用工具
[Action] calculator({'expression': '(312 * 46) + 2280'})
[Observation] 16632
[最终答案] (312 * 46) + 2280 = 14352 + 2280 = 16632
```

三个问题故意挑了三种走法：第一问必经工具，第三问一步到 END。跑的时候盯日志，条件边每次分岔都看得见。

说句实话：现代工具调用实现里，Thought 不一定被模型显式吐出来，它藏在「调不调工具」这个决定内部，你能直接观察的是 Action 和 Observation，日志里的 [Thought] 是「它决定行动了」的推断。原论文版本则要求模型逐行输出 Thought 文本。面试官若追问论文版和现代实现的差别，这就是标准答案。

::: tip 想亲眼看图
在 Jupyter 里执行 `graph.get_graph().draw_mermaid_png()` 能把这张图渲染成图片；本地终端用 `print(graph.get_graph().draw_mermaid())` 打出 Mermaid 定义，贴进任何 Mermaid 渲染器即可。
:::

**最后对照一次。** 第 11 周手写 FC 循环 vs 本周图版：

| | 第 11 周 while 版 | 本周图版 |
|---|---|---|
| 循环控制 | `while True` + `break` | 条件边路由 |
| 状态 | 自己维护 messages 列表 | MessagesState 归并保管 |
| 退出条件 | `if not tool_calls: break` | 条件边 → END |
| 工具执行 | 循环内 for | 独立的 tools 节点 |
| 代码量 | 约 40 行 | 约 50 行（含日志） |
| 想加持久化、中断 | 撬开 while 自己造 | 图生态自带 |

代码量半斤八两，赚的是结构：while 版是一个长函数，图版是两个职责单一的节点，换工具、换模型、加节点都只动局部。「把循环显式成图」买来的就是这件事。

## 常见踩坑

**坑 1：tool_call_id 缺失或对不上。** ToolMessage 的 id 和 tool_calls 里的不一致，或者一条 AIMessage 带两个调用你只回一个，端点立刻报 400，提示 tool_calls 后面必须跟 tool messages。铁律：遍历全部 tool_calls，id 原样抄，一个不能少。

**坑 2：tools 节点返回了裸字符串。** 图不报错，但状态没更新：节点返回值是状态更新片段，必须写成 `{"messages": [...]}`。返回 `str(output)` 的话 agent 节点下一轮看不到 Observation，模型只能干瞪眼编答案。

**坑 3：路由读错了消息。** `should_continue` 必须读 `state["messages"][-1]` 这条最新的 AIMessage。遍历全量历史的话，任意一条旧消息带过 tool_calls 都会把你再次送进 tools 节点，循环出不去。

**坑 4：docstring 敷衍。** bind_tools 拿函数名、签名、docstring 编手册。docstring 只写一个「计算」，模型就敢把中文句子当表达式传进来。写清「干什么用、参数是什么、给个例子」，命中率差一个量级。

**坑 5：模型绕着工具打转。** 偶尔模型会连着十几轮调同一个工具。LangGraph 默认 `recursion_limit` 是 25，超了抛 `GraphRecursionError`，这是保险丝不是解法。解法在两处：工具返回格式写明确（「只返回数值结果」），system prompt 里加一句「信息足够后立即直接作答」。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. agent 节点做什么？tools 节点做什么？条件边依据什么路由？

::: details 参考答案
agent 节点带着工具手册调用 LLM，产出一条 AIMessage（要么含 tool_calls，要么含最终答案）；tools 节点把 tool_calls 逐个执行并回填 ToolMessage。条件边看 `AIMessage.tool_calls` 是否非空：非空去 tools，空了去 END。
:::

2. tool_call_id 在消息流里起什么作用？少了它会怎样？

::: details 参考答案
AIMessage 里每个 tool_call 带唯一 id，回应的 ToolMessage 必须带同一个 id，端点靠它把 Action 和 Observation 配对。缺失或不匹配都违反协议，下一轮请求直接 400。
:::

3. 手写工具执行器最少要做哪几件事？

::: details 参考答案
三件：维护名字到函数的注册表；遍历最后一条 AIMessage 的全部 tool_calls（不是只取第一个）；为每个调用生成 tool_call_id 对应的 ToolMessage，以 `{"messages": [...]}` 返回。做完这三件，你写的东西就和 ToolNode 等价。
:::

4. 图版 ReAct 和第 11 周的 while 版，本质区别在哪？

::: details 参考答案
控制流相同：都是模型决定循环是否继续。区别在组织方式：while 版状态和退出条件内聚在一个长函数里；图版状态交给 MessagesState、路由交给条件边、工具执行是独立节点，循环显式成图，进而白得持久化、中断、流式、可视化这些周边能力。
:::

5. 模型无限调用工具时会发生什么？怎么防？

::: details 参考答案
步数撞上默认 recursion_limit（25），抛 GraphRecursionError 终止。防法分层：把工具 docstring 和返回格式写清楚，减少模型反复试探；system prompt 声明「信息足够即直接作答」；生产环境显式设置合适的 recursion_limit，并捕获该异常做降级。
:::

## 延伸阅读

- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)，2022 年原论文，看前两节的图和示例，Thought/Action/Observation 的原型都在
- [LangGraph 官方文档](https://langchain-ai.github.io/langgraph/)，Quickstart 里「agent ⇄ tools」的示例就是本篇手写的这套骨架，可对照 API 细节
- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)，业界常被引用的文章，其中「Agent 就是由 LLM 驱动的循环」这句判断，正是今天内容的产品视角版本

今天的产出 `bare_react_agent.py` 留好，明天往这张图上挂记忆与检查点，骨架不用动。
