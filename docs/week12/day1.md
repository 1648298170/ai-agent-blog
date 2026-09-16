# 第 12 周 · Day 1：LangGraph 核心概念——State、Node、Edge，把「下一步做什么」画成图

> 对应手册任务：学习「LangGraph 核心概念：State/Node/Edge/Graph」，动手定义 `AgentState(TypedDict)`，含 `messages` 和 `current_step`，当日产出 `agent_state.py`（State 定义 + reducer 行为小实验）。本篇只解决一个问题：上周手写 FC 循环时，流程靠 if/while 硬编、状态散在局部变量里，单 Agent 三步以内凑合能用，一旦多步、多 Agent、要断点恢复就全面失控——LangGraph 的做法是把「下一步做什么」显式化成一张图。

## 今日目标

1. 说得清手写 Agent 循环在什么时刻开始失控，以及 LangGraph 用什么思路接住它
2. 掌握四个概念：State 共享状态、Node 节点、Edge 边、条件边，并且各自对应上周 FC 循环里的哪一段代码
3. 独立定义 `AgentState(TypedDict)`：`messages` 用 `add_messages` 做追加合并，`current_step` 走默认覆盖，用一个小实验亲眼确认两种更新语义的差别，全程不建图

## 概念讲解：为什么 Agent 需要图框架

上周的 `raw-fc-loop.py` 你是这么写的：`while True` 里调模型，回复带 `tool_calls` 就执行工具、把结果 append 回 messages 再来一轮，不带就 break。整条流程由一个 while 和两个 if 管着，七十行以内非常清爽。

问题不在今天，在下一步。你想让 Agent 连续走完「查资料 → 写初稿 → 自查 → 定稿」四个阶段，得记「现在走到哪步」；想加重试，得记「失败了几次」；想再加一个审稿 Agent，谁先谁后、中间传什么，靠函数嵌套硬拼；跑到第 8 步进程挂了想从第 8 步恢复——状态只活在那几个局部变量里，连快照都没处打。

把这些需求摆到一起，根因就露出来了：「下一步做什么」藏在 if 分支里，「做到哪了」藏在局部变量里，两件最要紧的事都是隐式的，全靠读代码脑内模拟。一个 Agent 两三分支还行，三个 Agent 五种状态，人就跟踪不动了。

LangGraph 的回答很直白：把这两件事都显式化。「下一步做什么」显式化为图的边，「做到哪了」显式化为图的 State（共享状态）。你上周那段循环，翻译成图就是这么个东西：

```
START
  │
  ▼
call_llm ── 不带 tool_calls ──▶ END        （条件边出口一）
   ▲ │
   │ └─ 带 tool_calls ─▶ run_tools         （条件边出口二）
   └────────── 固定边：回来 ────────────────┘
```

`call_llm` 和 `run_tools` 是两个节点，就是你上周写的两段函数；「带不带 tool_calls」是一条条件边，就是你写的那个 if；run_tools 干完回到 call_llm 是一条固定边，就是 while 的「再来一轮」；messages 从「你的局部变量」升级成「整张图共享的黑板」。代码没多几行，但流程从「读代码推理」变成「看图即知」，这是从写脚本到搭系统的分水岭。

顺带把名字理清。LangChain 和 LangGraph 什么关系？一句话：LangChain 是模型和工具的生态库，管「怎么调模型、怎么接工具」；LangGraph 是编排引擎，管「流程怎么走、状态怎么存」。1.0 之后两个包分工明确，本周两个都装，import 里同时出现两家是正常现象。

::: warning 版本红线（2025-10 起）
LangChain / LangGraph 1.0 已于 2025 年 10 月发布。`langgraph.prebuilt.create_react_agent` 这类一键创建 Agent 的旧 API 已废弃，官方推荐改用 `langchain.agents.create_agent` + middleware。翻老教程看到 `create_react_agent`，知道那是 1.0 之前的旧 API 就行，别照抄。本手册走手写路线，`StateGraph`、`add_node`、`add_conditional_edges`、`MemorySaver` 这些核心 API 在 1.0 里完全有效，不受废弃影响。另一个硬要求：LangGraph 需要 Python 3.10+，开工前 `python --version` 先确认。
:::

## 核心知识

本节的代码片段都可以单独跑。今天不建图、不调模型，只动 State 和 `add_messages`，装好包就能全部复现。完整文件以下面的动手任务为准。

### 1. 四个概念，对应你上周写的代码

**State（共享状态）**：一块所有节点共用的黑板。每个节点读它拿上下文、写它留痕迹。它用 TypedDict 定义，字段就是黑板上的格子：

```python
class AgentState(TypedDict):
    messages: Annotated[list, add_messages]  # 对话历史：追加合并
    current_step: str                        # 当前阶段：整体覆盖
```

**Node（节点）**：一个普通函数，入参 State，返回 dict。注意返回的不是新 State，是「更新」——框架拿这份更新去合并 State：

```python
def run_tools(state: AgentState) -> dict:
    # 读：从共享状态里拿上下文
    results = [{"role": "tool", "content": "北京 22 度，晴"}]  # 执行工具，略
    # 写：只返回这次新增的消息和最新阶段，不返回全量
    return {"messages": results, "current_step": "after_tools"}
```

**Edge（边）**：固定转移。`add_edge("run_tools", "call_llm")` 意思是 run_tools 干完必去 call_llm，没有二话。

**条件边（Conditional Edge）**：动态路由。你提供一个路由函数，它看 State 返回下一个节点的名字：

```python
def should_continue(state: AgentState) -> str:
    last = state["messages"][-1]
    return "run_tools" if getattr(last, "tool_calls", None) else "end"
```

最后用 `StateGraph` 把节点和边拼起来，`compile()` 成可执行物。下面这段明天（Day 2）动手，今天先混个眼熟：

```python
from langgraph.graph import StateGraph, START, END

builder = StateGraph(AgentState)
builder.add_node("call_llm", call_llm)
builder.add_node("run_tools", run_tools)
builder.add_edge(START, "call_llm")                                   # 固定边
builder.add_conditional_edges("call_llm", should_continue,
                              {"run_tools": "run_tools", "end": END}) # 条件边
builder.add_edge("run_tools", "call_llm")                             # 固定边
graph = builder.compile()
```

### 2. State 为什么是 TypedDict

TypedDict 就是「带类型标注的 dict」。注意它在运行时就是普通 dict，类型约束只活在 IDE 和 mypy 里，这和第 1 周聊过的「泛型是编译期的」一个道理。框架在运行时读的其实是你的字段声明结构。

为什么选它，而不是 dataclass？State 是「字段契约」不是业务对象：节点返回的是 dict 更新，TypedDict 和 dict 字面量天然无缝；官方所有示例都建立在 TypedDict 上，跟着走最省事。dataclass 也能跑，但处处要 `.replace()`、属性转 dict，平添麻烦。

更新语义是本节重点。State 里每个字段是一条「通道」，节点返回更新时，没标 reducer 的字段走默认语义：**新值整体顶掉旧值**。`current_step` 要的正是这个——「当前阶段」是只在当下有效的指针，每步只指向一个值，覆盖就对了。

### 3. Annotated reducer：add_messages 为什么是追加

`messages: Annotated[list, add_messages]` 读法：类型还是 list，但附带了一条元数据 `add_messages`。框架看到它，就把这个字段的更新从「覆盖」改成「调用这个函数来合并」。reducer 的签名就一行：`(旧值, 更新) -> 新值`。默认 reducer 相当于 `lambda old, new: new`。

`add_messages` 这个 reducer 干三件事：把裸 dict 和各种消息格式统一转成 LangChain 消息对象；带 `id` 的新消息顶掉同 `id` 的旧消息；其余一律追加到尾部。为什么 messages 必须追加不能覆盖？因为多轮对话的历史就是模型的记性，覆盖了它立刻失忆——上周你手动维护 messages，干的就是追加这件事，现在框架替你干了。而你要付出的代价是搞懂它的规则，这正是今天下半场的内容。

一句忠告：LangGraph 预置了 `MessagesState`（现成的 messages 定义），但本周坚持手写。写过了再用现成的，才知道它替你省了什么。

## 动手任务：定义 AgentState 并验证 reducer，一步一步

手册任务：定义 `AgentState(TypedDict)`，含 `messages` 和 `current_step`，并验证 reducer 行为，不建图。拆成 5 步，全程约 25 分钟。

**第 1 步：查版本，装包。** `python --version` 确认 3.10+，然后：

```bash
pip install langgraph langchain langchain-openai
# poetry 用户：poetry add langgraph langchain langchain-openai
```

今天不调模型，`langchain-openai` 是给本周后面几天用的，一次装齐。

**第 2 步：建文件，写 State 定义。** 在本周练习目录新建 `agent_state.py`：

```python
from typing import Annotated, TypedDict
from langgraph.graph.message import add_messages


class AgentState(TypedDict):
    messages: Annotated[list, add_messages]
    current_step: str
```

关键行是 `messages: Annotated[list, add_messages]`：类型是 list，附带的 `add_messages` 告诉框架「这个字段的更新用追加合并」。`current_step` 没加 Annotated，走默认覆盖。这十行就是当日产出「State 定义」。

**第 3 步：追加实验。** `add_messages` 本身是个纯函数，不建图也能直接调。拿它模拟框架内部的合并动作：

```python
old = [{"id": "m1", "role": "user", "content": "查北京天气"}]
new = [{"id": "m2", "role": "assistant", "content": "好的，正在查询"}]

merged = add_messages(old, new)
print(len(merged))                # 2：追加，不是覆盖
print(type(merged[0]).__name__)   # HumanMessage：裸 dict 被转成消息对象

# 没带 id 的新消息：直接追加，不参与去重
no_id = [{"role": "user", "content": "顺便查上海"}]
print(len(add_messages(old, no_id)))  # 2

# 同 id 的新消息：顶掉旧消息，长度不变
fix = [{"id": "m1", "role": "user", "content": "改成查深圳天气"}]
replaced = add_messages(old, fix)
print(len(replaced), replaced[0].content)  # 1 改成查深圳天气
```

四条规则亲眼过一遍：增量追加、dict 标准化、无 id 追加、同 id 替换。合并规则全部由 id 决定，这条记牢。

**第 4 步：复刻上周习惯，亲眼看历史翻倍。** 上周你每轮手动拼全量 messages 再发给模型。如果对带 reducer 的字段也这么返回：

```python
full_history = [
    {"role": "user", "content": "查北京天气"},
    {"role": "assistant", "content": "好的，正在查询"},
]
# 节点返回「自己拼好的全量」，框架再把全量追加到已有历史上
doubled = add_messages(full_history, full_history)
print(len(doubled))  # 4：历史翻倍，再来一轮就是 8
```

全是裸 dict、没有 id，去重机制无从下手，只能整批追加。这就是「新手第一大坑」的真面目。

**第 5 步：断言钉板。** 把验证过的行为用 assert 固化，文件本身变成自检单元：

```python
assert len(add_messages(old, new)) == 2   # 增量追加
assert len(replaced) == 1                 # 同 id 替换
assert len(doubled) == 4                  # 全量回传必然翻倍

state: AgentState = {"messages": [], "current_step": "start"}
state["current_step"] = "gather"          # 默认语义：新值顶旧值
assert state["current_step"] == "gather"
print("agent_state.py 全部断言通过")
```

::: tip 运行方式
`python agent_state.py` 直接跑，不联网、不调模型，最后一行打印出来即当日完成。顺手在 IDE 里把 `current_step` 故意拼成 `curent_step`，看它立刻标红——TypedDict 的约束活在类型检查器里，运行时不拦你。
:::

## 常见踩坑

**坑 1：带 reducer 的字段返回全量。** 就是第 4 步那个翻倍现场。带 id 的旧消息靠「同 id 替换」顶掉自己，侥幸不出错；一旦中间用裸 dict 重拼过、丢了 id，就被整条再追加一次，token 成本跟着翻。记住一条：`Annotated` 了 `add_messages` 的字段，节点只返回「这次新增的」，历史交给框架拼。上周养成的手动拼全量的习惯，这周要主动戒掉。

**坑 2：单值字段乱加 reducer。** 给 `current_step` 也加上 `add_messages` 会怎样：它从字符串变成列表，每步追加一个元素，`current_step == "respond"` 永远是 False，条件边永远路由不出去，图死循环到触发迭代上限。什么时候追加、什么时候覆盖，用这条判断：一直攒着的账本用 reducer，只在当下有效的指针用覆盖。

**坑 3：指望 TypedDict 在运行时拦你。** 它运行时就是 dict，字段拼错、类型传错，Python 一声不吭，要等框架或下游代码炸了才暴露。类型约束在 IDE 和 mypy 里生效，运行时的真正兜底是第 5 步那些 assert。两头都要：静态检查防笔误，断言防语义漂移。

**坑 4：老教程的 create_react_agent 跑不通。** 识别特征：`from langgraph.prebuilt import create_react_agent`。它在 1.0 已废弃，报错不是你装错了版本，是那个 API 退场了。别按报错去改参数，换官方新姿势 `langchain.agents.create_agent` + middleware，或者更好——跟着本手册手写，手写才是看懂这些封装的唯一路径。同时检查 Python 是否 3.10+，低版本连装都装不上。

**坑 5：往 State 里塞不可序列化的大对象。** 数据库连接、OpenAI client、几百 KB 的原始响应体。State 的设计预期是可序列化的轻数据：Day 6 的 Checkpointer 要把整份 State 存盘做断点恢复，塞进连接对象直接把持久化搞挂。client 这类重资产放在节点外面，节点函数里引用；State 只放消息和少量控制字段。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 节点函数返回的 dict，框架拿它做什么？为什么说返回的是「更新」而不是「新 State」？

::: details 参考答案
框架把返回的 dict 按 State 定义逐字段合并进共享状态：带 reducer 的字段用 `reducer(旧值, 更新)` 算出新值，没带的直接用更新顶掉旧值，更新里没提到的字段保持不动。所以节点返回的是增量更新，共享 State 由框架统一维护，节点永远不用背全量。
:::

2. `messages` 用 `add_messages`、`current_step` 不用，分别是什么更新语义？为什么这么分工？

::: details 参考答案
`messages` 是追加合并：新消息按 id 去重后追加到尾部，历史只增不减；`current_step` 是整体覆盖：新值顶掉旧值，永远只表示「当前这一步」。分工标准：一直攒着的账本用 reducer 追加，只在当下有效的指针用默认覆盖。
:::

3. 节点里 `return {"messages": 自己拼好的全量历史}` 会发生什么？

::: details 参考答案
框架照样执行追加合并：带 id 的旧消息靠同 id 替换被「顶掉自己」，侥幸不出错；丢了 id 的（比如用裸 dict 重拼过的）会被整条再追加一次，历史越滚越长，token 成本跟着涨。正确做法永远是只返回本轮新增的消息。
:::

4. 固定边和条件边的区别是什么？上周 FC 循环里的「检查 tool_calls 决定继续还是结束」对应哪一种？

::: details 参考答案
固定边是 A 完必去 B，写死在图上；条件边挂一个路由函数，看 State 动态返回下一个节点的名字。「检查 tool_calls」是条件边：路由函数读最后一条消息，带 tool_calls 去 run_tools，不带去 END。而「run_tools 干完回到调模型」是固定边。
:::

5. LangChain 和 LangGraph 各管什么？一句话说清。

::: details 参考答案
LangChain 是模型和工具的生态库，管「怎么调模型、怎么接工具」；LangGraph 是编排引擎，管「流程怎么走、状态怎么存」。前者管用什么，后者管怎么走。
:::

## 延伸阅读

- [LangGraph 官方文档](https://docs.langchain.com/oss/python/langgraph/overview)，State / Node / Edge 的概念原始出处，Graph API 一章和本周前三天一一对应
- [PEP 593](https://peps.python.org/pep-0593/)，`Annotated` 的提案原文，读懂「类型 + 附加元数据」这个机制，reducer 只是它的一种用法
- [Python typing 文档：TypedDict](https://docs.python.org/3/library/typing.html#typing.TypedDict)，官方说明，重点看「运行时就是 dict」这一点

今天的 `agent_state.py` 留好，它是本周全部五天的地基：明天 `StateGraph` 就要用这份 State 定义，搭出第一个能跑的图。
