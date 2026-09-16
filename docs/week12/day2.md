# 第 12 周 · Day 2：构建第一个 Graph——StateGraph 四步曲，让昨天的 State 跑起来

> 对应手册任务：学习「构建第一个 Graph：StateGraph + compile()」，动手写一个「LLM 节点 → 结束」的两节点图并跑通，当日产出「最小 Graph」。本篇只解决一个问题：昨天定义的 AgentState 只是一份数据形状，今天给它配上执行流程，让「调一次 LLM 然后结束」这件最简单的事用图的正规方式跑起来，同时把明天条件路由、后天 ReAct 循环要用的骨架搭好。

## 今日目标

1. 说得清 StateGraph 从无到有的四步：实例化、add_node、add_edge、compile()，以及 START 和 END 这两个哨兵是干嘛的
2. 掌握节点函数的签名约定 `def node(state: AgentState) -> dict`：返回的 dict 不是新 State，是「这次要更新的字段」，按 reducer 的规则合并进去
3. 独立跑通「LLM 节点 → END」的最小图，用 stream 看见每一步的状态，并亲手验证节点只返回部分字段时，其余字段原样保留

## 概念讲解：为什么要把 Agent 画成图

先盘点手里的东西。昨天定义的 AgentState 是一个 TypedDict：messages 带着 add_messages reducer，负责累积对话；current_step 记录流程走到哪。它只是一份「形状」，数据往哪流、按什么顺序处理，一个字没提。数据结构有了，缺的是发动机。

不搞图行不行？第 11 周 Day 2 你手写过 raw-fc-loop.py：一个 while 循环，问 LLM、判断要不要调工具、把结果拼回 messages、再来一轮。三步以内的流程，顺序代码完全管得住。但 Agent 的真实形状是个循环：调 LLM，看它要不要用工具，用了就把结果喂回去再调，直到它给出最终答案。分支、回边、终止条件全揉在一个 while 里，流程控制和状态管理搅在一口锅，第二个功能加进来就开始打架：想加重试？改循环。想在某一步插入人工确认？改循环。想让流程能画出来给人评审？画不出来。

LangGraph 的主张是把「流程」从代码里拎出来，声明成一张图：

- State 是共享内存，就是昨天的 AgentState，所有节点读它、更新它
- Node 是一步工作，一个普通的 Python 函数，只负责「这一步干什么」
- Edge 是走向，「这一步干完去哪」，由图说了算，不由代码里的 if 说了算

这么拆的收益是复利。今天这张图小得可怜：一个真节点，调一次 LLM，然后结束。但四步曲的骨架从今天起就不变了——明天加条件边，后天加工具节点凑成 ReAct 循环，第 6 天加 Checkpointer，都是在骨架上加节点、加边。另外图是声明出来的，所以能画出来：compile 之后一句 `draw_mermaid()` 就能可视化，第 7 天复盘要画的状态图从今天就长出来了。

为什么一个真节点也好意思叫「两节点图」？因为 END 也是图里的一个节点，只是虚拟的，不对应任何函数，专门表示「到这结束」。llm 节点加 END 节点，正好两个。

顺带一个版本提醒：LangGraph 1.0（2025 年 10 月起）里 StateGraph 是长期稳定的正式 API，放心学；但旧教程满天飞的 `langgraph.prebuilt.create_react_agent` 已经废弃。那是「成品 Agent」路线，本手册走手搭路线，不受影响，抄代码时注意甄别。

## 核心知识

本节代码基于 LangGraph 1.0 和 langchain-openai，DeepSeek、Qwen 等 OpenAI 兼容端点通用，可直接照抄。完整可运行版本以下面的动手任务为准。

### 1. StateGraph 四步曲：实例化 → add_node → add_edge → compile()

```python
from langgraph.graph import END, START, StateGraph

builder = StateGraph(AgentState)   # 第 1 步：实例化，把图和 State 的形状绑在一起
builder.add_node("llm", llm_node)  # 第 2 步：注册节点，起个名字，挂上函数
builder.add_edge(START, "llm")     # 第 3 步：接线，入口通到 llm
builder.add_edge("llm", END)       #         llm 干完通到出口
graph = builder.compile()          # 第 4 步：编译，得到可运行的图
```

关键在第 1 步和两个哨兵。`StateGraph(AgentState)` 传入的是昨天的 State 类，图从此知道「共享内存长什么样、每个字段用什么 reducer」。`START` 和 `END` 是 LangGraph 内置的两个特殊节点（本质是保留字符串 `"__start__"` 和 `"__end__"`），你不能拿自己的函数去注册这两个名字，它们只标记入口和出口。`add_edge(START, "llm")` 的意思是「图的输入直接交给 llm 节点」，`add_edge("llm", END)` 是「llm 干完就收工」。

`compile()` 不是摆设。它先做体检：入口接没接、边两端的节点名存不存在、有没有注册了却没人走的孤岛节点，任何一处不对都当场报错，错误信息里带那个名字，照着改就行。体检通过后返回一个编译好的图对象，`invoke`、`stream`、`get_graph` 都从它身上调。

### 2. 节点函数：读全量 State，返回「增量」

```python
def llm_node(state: AgentState) -> dict:
    response = llm.invoke(state["messages"])   # 读：拿到当前全部消息
    return {"messages": [response]}            # 写：只返回要更新的字段
```

签名是硬约定：参数是当前的 State（一个 dict），返回值也必须是 dict，别的类型一律报错。关键在返回值的语义——它不是「新的 State」，是「这次想更新的那几个字段」。LangGraph 拿这个 dict 逐字段合并进 State，规则就三条：

- 字段带了 reducer（messages 带 add_messages）：新旧按 reducer 合并，新消息追加进历史，昨天的功课就是为这一步做的
- 字段没带 reducer（current_step 这种）：新值直接覆盖旧值
- 返回 dict 里压根没提的字段：原样保留，谁也不动

所以节点敢只写 `return {"messages": [response]}`，不用把整个 State 抄一遍再改——没提的 current_step 自动原样，提了的 messages 由 add_messages 负责追加。这条「增量更新」约定贯穿 LangGraph 全部用法，动手任务第 5 步会用实验亲眼看一遍。

### 3. 接模型：第 11 周的三件套原样搬来

LangGraph 不管模型从哪来，节点函数里那个 `llm` 是一个标准 LangChain chat model 就行。接国产模型还是那三个字符串：base_url、api_key、model。

```python
import os

from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="deepseek-chat",
    api_key=os.environ["DEEPSEEK_API_KEY"],
    base_url="https://api.deepseek.com",  # Qwen 换 dashscope 兼容地址，GLM 换 bigmodel
)
```

langchain-openai 的 ChatOpenAI 走 OpenAI 兼容协议，和第 11 周裸用的 openai SDK 同一套原理，换供应商只动这三行。另一个选择是官方的统一入口：

```python
from langchain.chat_models import init_chat_model

llm = init_chat_model(
    "deepseek-chat",
    model_provider="openai",  # 借道 OpenAI 兼容协议，其余参数原样传给底层
    api_key=os.environ["DEEPSEEK_API_KEY"],
    base_url="https://api.deepseek.com",
)
```

`init_chat_model` 的好处是换供应商只改一个字符串，适合多供应商场景；今天动手任务用 ChatOpenAI 直连，少装一个包，语义完全一样。

### 4. 运行与观察：invoke、stream、draw

编译好的图用 invoke 跑，喂一个初始 State，拿回终态：

```python
result = graph.invoke({"messages": [("user", "用一句话介绍你自己")]})
print(result["messages"][-1].content)
```

输入里 `("user", "...")` 这种元组会被 add_messages 自动转成正式的 HumanMessage，是个常用简写。invoke 阻塞到整张图跑完，返回最终的完整 State。

想看「每一步之后 State 长什么样」，用 stream：

```python
for snapshot in graph.stream(
    {"messages": [("user", "用一句话介绍你自己")]},
    stream_mode="values",
):
    print(snapshot["messages"][-1])
```

`stream_mode="values"` 的规则：图一启动先吐一次输入状态，之后每跑完一个节点，吐一次当时的全量 State。今天这图只有两拍——第一行是你输入的那条消息，第二行是 llm 节点跑完后追加的 AI 回复。图大了这个模式才显威力，第 4 天的 ReAct 循环会有五六拍，每拍谁写了什么一目了然。

最后把图画出来看一眼：

```python
print(graph.get_graph().draw_mermaid())  # 输出 mermaid 文本，贴进 mermaid.live 渲染
```

零依赖，输出几行文本，描述的就是「入口 → llm → 结束」这条链。想直接在终端看线框图换 `draw_ascii()`，要装 `grandalf`。图能画出来，是声明式写法的免费赠品，别浪费。

## 动手任务：最小 Graph 一步一步

手册任务：写一个「LLM 节点 → 结束」的两节点图并跑通。拆成 5 步，全程约 25 分钟。

**第 1 步：建文件，搬 State。** 新建 `first_graph.py`，先装包：`pip install "langgraph>=1.0" langchain-openai`。再把昨天的 State 定义搬过来（手边没有昨天的文件也不怕，完整版在这）：

```python
import os
from typing import Annotated, TypedDict

from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]  # 对话历史，reducer 负责追加
    current_step: str                        # 流程标记，无 reducer，整体覆盖
```

**第 2 步：接模型。** 三件套照第 11 周的老规矩，key 走环境变量：

```python
llm = ChatOpenAI(
    model="deepseek-chat",
    api_key=os.environ["DEEPSEEK_API_KEY"],
    base_url="https://api.deepseek.com",
)
```

**第 3 步：写节点，四步曲搭图。**

```python
def llm_node(state: AgentState) -> dict:
    response = llm.invoke(state["messages"])
    return {"messages": [response]}


builder = StateGraph(AgentState)
builder.add_node("llm", llm_node)
builder.add_edge(START, "llm")
builder.add_edge("llm", END)
graph = builder.compile()
```

**第 4 步：invoke 跑通。** 输入故意把 current_step 也带上，方便下一步做对比：

```python
result = graph.invoke(
    {
        "messages": [("user", "用一句话介绍你自己")],
        "current_step": "start",
    }
)
print(result["messages"][-1].content)  # 模型的回答
print(result["current_step"])          # start
```

跑通的标准：第一行打出模型的一句自我介绍，第二行打出 `start`。注意第二行——llm_node 没返回 current_step，所以它原封没动，这就是「增量更新」的第一次亲眼验证。

**第 5 步：三个观察实验。** 图不动，只改 llm_node 的 return，每改一次跑一遍。

实验一，返回两个字段：

```python
return {"messages": [response], "current_step": "done"}
```

再跑，`result["current_step"]` 变成 `done`。current_step 没有 reducer，新值直接覆盖。

实验二，只返回 current_step，把 messages 扔了：

```python
return {"current_step": "done"}
```

再跑，`result["messages"][-1]` 还是你输入的那句话——模型明明回了话，但没放进返回 dict，State 就当没发生。结论值得抄在笔记本上：图只认节点返回的 dict，不认节点内部干了什么。

实验三，改回第 3 步的原始 return，跑一遍 stream 和画图：

```python
for snapshot in graph.stream(
    {"messages": [("user", "用一句话介绍你自己")]}, stream_mode="values"
):
    print(snapshot["messages"][-1])

print(graph.get_graph().draw_mermaid())
```

::: tip 运行命令
先设 key：Windows PowerShell 里 `$env:DEEPSEEK_API_KEY="sk-..."`，macOS/Linux 用 `export DEEPSEEK_API_KEY=sk-...`，然后 `python first_graph.py`。报 404 先查 base_url 是不是原样照抄（第 11 周 Day 6 的老坑，多拼一段路径就 404）；报 InvalidUpdateError 就检查节点是不是忘了返回 dict。
:::

## 常见踩坑

**坑 1：节点名手抄两遍，抄出了两个名字。** `add_node("llm", ...)` 注册，`add_edge(START, "LLM")` 接线，大小写不一致，编译阶段直接报错。还有反过来的：节点注册了，却没有任何边经过它，成了孤岛，同样过不了编译。好在错误信息会带节点名，好找。防的办法就一条：名字定一次，别在 add_edge 里手抄第二遍。

**坑 2：节点没返回 dict。** 函数忘写 return（Python 隐式返回 None），或者图省事 `return response.content` 返回了字符串，图都只认 dict，当场报 InvalidUpdateError。另一个方向的误解也常见：以为必须返回完整 State，于是把所有字段抄一遍再改——能跑，但白白多写代码，还容易把 messages 手滑写成覆盖。记住设计意图：只返回增量。

**坑 3：初始输入少给了字段。** TypedDict 没有默认值这回事，invoke 时没给的 key，State 里就不存在。比如输入只给 messages，节点里却读 `state["current_step"]`，跑图时直接抛错。两个修法：初始输入把要用的字段给全（今天第 4 步的写法），或者节点里改用 `state.get("current_step", "start")` 兜底。

**坑 4：照旧教程抄 create_react_agent。** LangGraph 1.0 起 `langgraph.prebuilt.create_react_agent` 已废弃，官方路线换成了 `langchain.agents.create_agent` 加 middleware。兼容期里旧代码可能还跑得起来，但别往新项目里搬。更要紧的是路线本身：create_agent 是成品，本手册坚持手搭 StateGraph——面试考的是你懂不懂循环本身，不是会不会调预制品。

**坑 5：画图忘了装 grandalf。** `draw_ascii()` 报 ModuleNotFoundError 不是图的问题，是 ASCII 渲染依赖 grandalf 这个包，`pip install grandalf` 即可。不想装就用 `draw_mermaid()`，零依赖，输出文本贴到 mermaid.live 一样看图。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. StateGraph 从搭到跑的四步分别是什么？START 和 END 为什么不能挂自己的函数？

::: details 参考答案
实例化 StateGraph(AgentState)、add_node 注册节点、add_edge 接线（含 START 入口和 END 出口）、compile() 编译。START 和 END 是内置的哨兵节点，本质是保留字符串 `__start__` 和 `__end__`，只标记流程的入口和出口；add_node 遇到这两个名字会直接抛 ValueError。
:::

2. 节点返回的 dict 是怎么变成新 State 的？messages 和 current_step 的待遇差在哪？

::: details 参考答案
LangGraph 逐字段看返回的 dict：带 reducer 的字段按 reducer 合并，messages 走 add_messages，把新消息追加进历史；不带 reducer 的字段如 current_step，新值直接覆盖；返回 dict 没提的字段原样保留。所以节点只返回要更新的字段，就是全部正确做法。
:::

3. invoke 和 stream(stream_mode="values") 分别给出什么？各自适合什么场景？

::: details 参考答案
invoke 阻塞到整张图跑完，返回最终完整 State，适合「我要结果」的调用方。values 模式的 stream 先吐一次输入状态，之后每跑完一个节点吐一次全量 State，适合调试和给前端做进度展示——节点一多，每拍谁写了什么一眼看清。
:::

4. 节点内部调了 LLM，返回 dict 里却没写 messages，终态会怎样？这说明什么？

::: details 参考答案
messages 原样保留输入，模型的回复进不了 State，等于白调。说明 State 的更新只认节点返回的 dict，不认节点内部发生过什么——返回 dict 是节点影响外部世界的唯一通道。
:::

5. 今天只有一个真节点，为什么手册说这是「两节点图」？

::: details 参考答案
END 也是图上的一个节点，虚拟节点，不挂函数，只表示流程终点。「LLM 节点 → 结束」合起来两个节点、两条边，是最小但完整的图：有入口、有工作、有出口。
:::

## 延伸阅读

- [LangGraph 官方文档](https://langchain-ai.github.io/langgraph/)，StateGraph、节点、边的一手定义，Quickstart 和今天的四步曲完全一致，值得对照通读
- [LangGraph 流式输出指南](https://docs.langchain.com/oss/python/langgraph/streaming)，stream_mode 各档位的官方说明，values 之外还有 updates、messages 模式
- [Mermaid Live Editor](https://mermaid.live)，把 `draw_mermaid()` 的输出贴进去，立刻看到渲染好的图

今天的 `first_graph.py` 留好。明天在 llm 和 END 之间加一条条件边，让图学会看 State 决定下一步——ReAct 循环的门就从那里推开。
