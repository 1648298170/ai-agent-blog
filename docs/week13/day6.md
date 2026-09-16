# 第 13 周 · Day 6：容错三道防线——错误处理、重试、超时，失败时让 Agent 自己拿主意

> 对应手册任务：学习「错误处理 + 重试 + 超时」，动手「为工具调用加 try/catch 和超时，失败时让 Agent 决定重试或告知用户」，当日产出「容错 Agent」。本篇只解决一个问题：Demo 里一切正常，不是因为系统好，是因为故障还没来。生产里工具会超时、API 会限流、模型会犯浑，三层故障要布三道防线，而最关键的一道不是把代码写得更皮实，是把错误说清楚，让 Agent 自己决定重试还是认输。

## 今日目标

1. 说得清 Agent 系统的三层故障——工具失败、模型失败、逻辑失败——以及为什么每一层的防线和处理者都不一样
2. 掌握三道防线的落地写法：工具层 try/except + `asyncio.wait_for` 超时 + 写给模型看的错误消息；模型层指数退避重试；逻辑层 recursion_limit + Pydantic 工具结果校验
3. 独立完成容错 Agent：造一个会失败的工具，亲眼看 Agent 读到错误后自己重试、自愈；再把故障调成永久，看它止损并如实告知用户

## 概念讲解：故障一定会来，而且分三层来

前五天你把客服系统从图纸做到了能演示的程度：Supervisor 路由，两个 Worker 干活，退款前 `interrupt()` 等人工批准，前端还有批准按钮。一路顺。顺的原因不是系统没毛病，是环境干净：本地演示时网络不抖、API 不限流、模型不犯浑。生产环境这三样一个都躲不掉。

物流服务高峰期会超时，LLM API 撞限流会吐 429，模型偶尔会拿一个幻觉出来的订单号反复查。单次工具调用 1% 的故障率听着不高，但 Agent 是循环结构，一次任务转五六圈，每一圈都在独立掷骰子。放到每天上千次调用里，没有容错的系统每天要在用户面前炸几十次。

更麻烦的是，Agent 系统的故障和普通应用不一样，分三层，病因不同，药方也不同。工具失败发生在你的代码里，网络抖动、下游超时、数据不存在，你能捕获。模型失败发生在 API 那头，429 限流、5xx、响应挂起，你只能等。逻辑失败最阴险，代码不报错、API 不报错，系统在空转，或者拿着脏数据一本正经地输出。

三层里有个反直觉的结论：工具失败时，最有资格决定「重试还是放弃」的不是你的代码，是 Agent 自己。硬编码重试是条件反射——同样的请求原样再发，参数错了重发一百次还是错。Agent 是看病情开药——它看得见对话上下文，读得懂错误消息：「超时」就再试一次，「订单不存在」就去问用户要单号，「服务持续异常」就如实相告换条路。这是 Agent 与硬编码重试的本质差异：前者带上下文决策，后者不带脑子复读。

前提只有一个：错误消息得把模型需要知道的事说清楚。所以今天最核心的手艺不是 try/except 的语法，是把错误写成给模型的情报。

## 核心知识

本节的代码块都是独立可运行的片段。API 全部是 LangGraph 1.0 语境：`StateGraph`、`ToolNode`、`bind_tools` 都是你第 12 周用熟的原语，今天没有任何新框架 API——容错不是框架替你做的事，全部落在你自己的工具函数和模型客户端上。唯一的框架参数 recursion_limit，也是第 12 周配过的。

### 1. 三层故障，三道防线，三个处理者

| 故障层 | 典型症状 | 防线 | 处理者 |
| --- | --- | --- | --- |
| 工具失败 | 网络抖动、下游超时、数据不存在 | try/except + 超时 + TOOL_ERROR 消息 | Agent（它有上下文，能判断重试有没有意义） |
| 模型失败 | 429 限流、5xx、响应挂起 | 指数退避重试 | 你的代码（Agent 正在等回复，管不了自己） |
| 逻辑失败 | 死循环、幻觉参数、脏数据 | recursion_limit + Pydantic 校验 | 框架兜底 + 事前校验 |

定位口诀：故障发生在哪一层，处理者就该站在哪一层。工具层的处理者是 Agent，模型层的处理者是你，逻辑层的处理者是框架。下面三节挨个落地。

### 2. 工具层：错误消息是写给模型的情报

第 12 周 Day 5 讲工具设计时留过一句话：工具出错该返回错误字符串，不该抛异常。今天把这句话升级成完整方案。先看骨架：

```python
import asyncio
import json
from langchain_core.tools import tool

@tool
async def query_logistics(order_id: str) -> str:
    """查询订单的物流轨迹。

    当用户问订单到哪了、什么时候送达时调用。
    参数 order_id 是订单号，如「A-1024」。
    正常返回 JSON 字符串；失败时返回 TOOL_ERROR 开头的说明。
    """
    try:
        data = await asyncio.wait_for(logistics_api(order_id), timeout=3.0)
        return json.dumps(data, ensure_ascii=False)
    except asyncio.TimeoutError:
        return "TOOL_ERROR: 物流服务超时（3 秒无响应），临时故障，可以重试"
    except LookupError:
        return f"TOOL_ERROR: 订单 {order_id} 不存在，重试无效，请向用户确认订单号"
    except Exception as e:
        return f"TOOL_ERROR: 物流服务异常（{type(e).__name__}），可以重试"
```

关键一行是 `await asyncio.wait_for(logistics_api(order_id), timeout=3.0)`：`wait_for` 给异步调用掐表，到点抛 `asyncio.TimeoutError`，把「永远等下去」变成「3 秒后确定失败」。这味药专治挂死——下游服务器不响应时没有任何异常可捕获，except 再全也接不住一个不来的人，只有表能救你。

三个 except 分支对应三种病情，每条消息都带三要素：出了什么事（超时、不存在、服务异常）、能不能重试（能、不能、能）、建议下一步（重试、问用户、重试）。`TOOL_ERROR` 这个前缀一石二鸟：模型一眼认出这是错误不是结果，你排查日志时也能一行 grep 出所有故障。

为什么不干脆让异常飞？LangGraph 的 ToolNode 默认有层兜底（`handle_tool_errors=True`），工具抛异常不会炸图，而是包成一条 `Error: ConnectionError('connection refused') Please fix your mistakes.` 式的英文消息发回模型。保险丝归保险丝，设计归设计：那条兜底消息里没有业务语义，模型不知道错能不能重试，更不知道下一步该干嘛。自己捕获、自己写消息，本质是把「怎么办」的决策权连同决策所需的情报，一起交给模型。

顺带一句：三五个工具就是三五份结构雷同的 try/except 和 wait_for，[第 1 周](/week01/)说过的复制粘贴病在这同款发作。今天先手写两遍体会细节，工具多了再把「捕获 + 超时 + 包装消息」抽成一个装饰器——第 9 周 Day 6 的手艺，又是装饰器的活。

### 3. 模型层：指数退避，只等会自己好的病

模型调用也会失败，而且 Agent 自己管不了自己——它正在等回复。防线只能架在你的代码里。ChatOpenAI 自带 `max_retries` 参数，底层 SDK 就是指数退避，生产里优先用它。但重试的逻辑值得亲手写一遍，以后遇到没有内置重试的调用点直接搬：

```python
import functools
import random
import time

def with_retry(max_retries: int = 3, base_delay: float = 1.0, cap: float = 30.0):
    """指数退避重试：只对限流（429）和服务端错误（5xx）生效。"""
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    status = getattr(e, "status_code", None)
                    transient = status == 429 or (
                        status is not None and 500 <= status < 600
                    )
                    if not transient or attempt == max_retries:
                        raise
                    time.sleep(min(base_delay * 2 ** attempt, cap) + random.uniform(0, 0.5))
        return wrapper
    return decorator
```

三层结构是第 9 周 Day 6 带参装饰器的原样复用，改的只有 except 分支：先用 `getattr(e, "status_code", None)` 从异常上摘状态码（openai 这类 SDK 的异常都带），再判断是不是瞬态故障。429 和 5xx 是「服务端暂时不行」，等一等大概率自己好；401 是密钥不对，400 是请求本身有错，重试一百次还是错——只重试会自己好的病，这是重试策略的第一原则。

为什么是指数？撞了限流说明对端过载，匀速重试等于继续施压；1、2、4、8 秒的递增间隔给服务端恢复的时间，成功率随等待上升。`cap` 封顶防止指数膨胀到离谱（不然重试 8 次要等两三分钟，网关早就把你的连接掐了），末尾那点随机抖动是为了避免一群 Agent 在同一秒同步重试、把刚缓过来的服务再撞倒。

异步管线里用要注意：同步的 `time.sleep` 会堵住事件循环。把 wrapper 改成 `async def`、调用改成 `await func(...)`、`time.sleep` 换成 `asyncio.sleep`，三处改完就是异步版——第 9 周 Day 6 留的那个尾巴，今天顺手收掉。

### 4. 逻辑层：闸门与校验，防的是不报错的错

死循环是逻辑层最吓人的形态：模型对失败的工具无限重试，图在 chat 和 tools 之间无限打转。第 12 周配过的 `config={"recursion_limit": 25}` 就是这道闸，默认 25 步，超出抛 `GraphRecursionError`，循环就地终止。要认清它的定位：它是保险丝不是策略——日常止损该由 Agent 读错误消息自己完成，闸只兜「没人止损」的最坏情况。确定性的事交给闸，概率性的事交给模型，两层都要有。

另一类逻辑失败更隐蔽：脏数据。下游接口改了字段名、返回半截 JSON，全程没有异常，但数据已经错了。模型拿到脏数据不会报错，会一本正经地编。防线是把第 9 周的 Pydantic 掉个头用——那时验证模型的结构化输出，现在验证工具的输出，两头都验，中间的信任链才闭环：

```python
from pydantic import BaseModel, ValidationError

class LogisticsInfo(BaseModel):
    order_id: str
    status: str
    eta: str

def checked(data: dict) -> str:
    try:
        LogisticsInfo.model_validate(data)
    except ValidationError:
        return "TOOL_ERROR: 物流数据格式异常，内容不可信，请勿据此作答"
    return json.dumps(data, ensure_ascii=False)
```

工具成功路径的 `return json.dumps(...)` 换成 `return checked(data)`，校验就挡在了数据流向模型的最后一米。try/except 防「没有结果」，校验防「结果不可信」，同一道防线上一前一后两块盾。

## 动手任务：容错 Agent 一步一步

手册任务：为工具调用加 try/catch 和超时，失败时让 Agent 决定重试或告知用户。拆成 5 步，全程约 30 分钟。图的骨架复用第 12 周 Day 5 那张 chat/tools 图，今天全部改动都在工具函数和模型客户端上。

**第 1 步：建文件，写一个会出毛病的模拟服务。** 新建 `fault_tolerant_agent.py`，先造故障，再谈容错：

```python
import asyncio
import json

_state = {"calls": 0}   # 调用计数器，用来制造「前几次失败」
FAIL_UNTIL = 2          # 前 2 次调用失败，第 3 次起恢复

async def logistics_api(order_id: str) -> dict:
    """模拟下游物流接口：会抖动、会查无此单、正常时 0.2 秒返回。"""
    _state["calls"] += 1
    if _state["calls"] <= FAIL_UNTIL:
        raise ConnectionError("connection refused")
    if order_id not in {"A-1024", "A-1025"}:
        raise LookupError(f"order {order_id} not found")
    await asyncio.sleep(0.2)
    return {"order_id": order_id, "status": "运输中", "eta": "3 天后送达"}
```

再写一个「裸奔」版工具，不捕获，让异常直接往上飞：

```python
from langchain_core.tools import tool

@tool
async def query_logistics(order_id: str) -> str:
    """查询订单的物流轨迹。

    当用户问订单到哪了、什么时候送达时调用。
    参数 order_id 是订单号，如「A-1024」。
    """
    data = await logistics_api(order_id)
    return json.dumps(data, ensure_ascii=False)

print(asyncio.run(query_logistics.ainvoke({"order_id": "A-1024"})))
# ConnectionError: connection refused —— 异常砸脸，裸奔工具的真实形态
```

**第 2 步：穿甲。** 把工具换成上文核心知识第 2 节的完整版（try/except + `wait_for` 超时 + TOOL_ERROR 三要素），然后单独测四种情况：

```python
for oid in ["A-1024", "A-1024", "A-1024", "A-9999"]:
    print(asyncio.run(query_logistics.ainvoke({"order_id": oid})))
# TOOL_ERROR: 物流服务异常（ConnectionError），可以重试      ← 第 1 次调用，服务在抖
# TOOL_ERROR: 物流服务异常（ConnectionError），可以重试      ← 第 2 次调用，还在抖
# {"order_id": "A-1024", "status": "运输中", "eta": "3 天后送达"}  ← 第 3 次，恢复
# TOOL_ERROR: 订单 A-9999 不存在，重试无效，请向用户确认订单号   ← 永久故障
```

输出对得上注释再进下一步。注意最后一条和前两条的措辞差别：一个说「可以重试」，一个说「重试无效」——这几行字就是待会儿模型做决策的全部依据。

**第 3 步：接图，看 Agent 自愈。** 照第 12 周 Day 5 的骨架拼图，chat 节点换成 async 写法：

```python
from langchain_core.messages import HumanMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, START, END, MessagesState
from langgraph.prebuilt import ToolNode

llm = ChatOpenAI(model="gpt-4o-mini", max_retries=3, timeout=30)
llm_with_tools = llm.bind_tools([query_logistics])

async def chat(state: MessagesState):
    return {"messages": [await llm_with_tools.ainvoke(state["messages"])]}

def should_use_tool(state: MessagesState):
    return "tools" if state["messages"][-1].tool_calls else "end"

builder = StateGraph(MessagesState)
builder.add_node("chat", chat)
builder.add_node("tools", ToolNode([query_logistics]))
builder.add_edge(START, "chat")
builder.add_conditional_edges("chat", should_use_tool, {"tools": "tools", "end": END})
builder.add_edge("tools", "chat")
graph = builder.compile()

async def main():
    _state["calls"] = 0  # 重置计数器，让每次实验可复现
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content="帮我查一下订单 A-1024 到哪了，大概什么时候送到？")]},
        config={"recursion_limit": 25},
    )
    for m in result["messages"]:
        m.pretty_print()

asyncio.run(main())
```

预期消息序列（顺序就是图的走向）：HumanMessage → AIMessage（第一次调工具）→ ToolMessage（TOOL_ERROR，可重试）→ AIMessage（再调一次）→ ToolMessage（TOOL_ERROR，可重试）→ AIMessage（第三次调用）→ ToolMessage（正常 JSON）→ AIMessage（最终答复：订单运输中，预计 3 天后送达）。前两次失败 Agent 没有惊动用户，自己消化了，这就是自愈。你没有写一行「失败后重试」的代码，重试是模型读完错误消息后的自主决策。有兴趣的话把工具换回第 1 步的裸奔版再跑一遍，ToolMessage 会变成 ToolNode 兜底那句英文套话——同一张图，两种情报质量，高下立见。

**第 4 步：故障调成永久，看 Agent 止损。** 把 `FAIL_UNTIL` 改成 `10 ** 9` 再跑。这次观察另一条路径：模型重试两三次，发现错误没有变化，通常就放弃工具，直接答复用户「物流服务暂时查不到，请稍后再试」——同样没人教过它认输。但也可能遇到一根筋的模型一路重试到 recursion_limit，图抛 `GraphRecursionError` 结束。两种结局都算防线生效：前者是 Agent 止损，后者是闸门起效，总好过无限转圈。这也解释了为什么那道闸必须存在——Agent 的止损是概率性的，闸是确定性的。

**第 5 步：补齐另外两道防线，自查。** 模型层在第 3 步已经顺手挂上了：`ChatOpenAI(max_retries=3, timeout=30)` 里的 max_retries 就是 SDK 内置的指数退避，撞 429/5xx 自动等待自动重试，Agent 全程不知情，它只觉得这次回复来得慢了点。`with_retry` 装饰器留给没有内置重试的调用点，异步版按核心知识第 3 节末尾那三处改动翻新。逻辑层把工具成功路径换成 `return checked(data)`（核心知识第 4 节的校验函数），recursion_limit 已在 `ainvoke` 的 config 里。最后照这张表自查：

| 防线 | 检查项 |
| --- | --- |
| 工具层 | 每个工具都有 try/except、wait_for 超时、TOOL_ERROR 三要素消息 |
| 模型层 | LLM 客户端挂了 max_retries 和 timeout，或调用点套了 with_retry |
| 逻辑层 | 图调用带 recursion_limit，工具输出过 Pydantic 校验 |

三行全勾，把这套改造搬进本周前五天的客服系统：两个 Worker 的工具各改一遍，Supervisor 和 Worker 共用的 LLM 客户端统一挂重试参数，图的 recursion_limit 全局生效。容错 Agent 不是新写的系统，是给现有系统的每层各补一块盾。

::: tip 运行命令
执行 `python fault_tolerant_agent.py`。依赖第 12 周已装（langgraph、langchain-openai），API key 按你第 12 周的接法配置；模型换成 DeepSeek、GLM 等支持 tool calling 的都行。第 4 步改参数前先跑通第 3 步的基线，否则故障是模拟的还是代码自带的，分不清。
:::

## 常见踩坑

**坑 1：把错误吞成「空结果」。** `except Exception: return ""`，或者捕获后返回一个空 JSON。图是不炸了，但模型拿到空数据会开始脑补，输出一本正经的胡话——比崩溃难查十倍，因为现场没有报错。记住捕获的职责是翻译不是消灭：把异常翻译成模型能读的情报，错误本身必须可见。

**坑 2：错误消息写给运维不写给模型。** 返回 `repr(e)`、整段 traceback、或者「下游 socket 对端 RST」这种内部行话。模型要的是三要素：出了什么事、能不能重试、下一步建议。检验办法很土但有效：把错误消息当成提示词的一部分自己读一遍，读不出该干嘛，就重写。

**坑 3：重试不挑故障类型。** for 循环套 except Exception 重试三次——订单不存在也重试三遍，纯属对着空气挥拳。瞬态故障（超时、429、5xx）才值得等；永久故障要么换个参数（Agent 的活），要么干脆告知用户。两个方向都会翻车：该等的没等，不该等的硬等。

**坑 4：退避不封顶、不加抖动。** 基数 1 秒重试 8 次，累计等待 255 秒，网关 30 秒就把连接掐了，重试变成自嗨。cap 上限必设；那半秒随机抖动也别省，多个 Agent 同时撞限流时，没有抖动就是同一秒集体冲锋，刚缓过来的服务再被撞倒一次。

**坑 5：超时一刀切，或者只给工具上超时。** 查库存 2 秒合理，生成长报告 2 秒就是误杀，超时值跟着被调用的东西定，逐工具设。另一个常见遗漏是只武装了工具忘了模型：LLM 调用自己也会挂，`ChatOpenAI` 的 `timeout` 参数就是给它掐表的，两边都要有表。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 三层故障分别是什么？为什么每一层的处理者不一样？

::: details 参考答案
工具失败（网络抖动、超时、数据不存在）发生在你的代码里，防线是 try/except + 超时 + 错误消息，处理者是 Agent，因为它有对话上下文，能判断重试有没有意义。模型失败（429、5xx、挂起）发生在 API 那头，Agent 正在等回复、管不了自己，处理者只能是你的代码，用指数退避重试。逻辑失败（死循环、幻觉参数、脏数据）没有异常可捕获，靠 recursion_limit 掐循环、Pydantic 校验挡脏数据。故障发生在哪一层，处理者就站在哪一层。
:::

2. 工具失败时，为什么把重试的决策权交给 Agent，而不是在代码里写死「重试三次」？

::: details 参考答案
写死的重试是原样重发：参数错误和数据不存在，重发一万次还是错。Agent 手里有上下文和错误情报，能区分病情：超时就再试，订单不存在就向用户要单号，服务持续异常就如实相告。前提是错误消息写清三要素——出了什么事、能不能重试、建议下一步。这正是 Agent 容错与硬编码重试的本质差异。
:::

3. 指数退避为什么是「指数」？为什么 429 和 5xx 之外的错误不重试？

::: details 参考答案
429 说明服务端过载，匀速重试等于继续施压；1、2、4、8 秒的递增间隔给对端恢复时间，成功率随等待上升。401 是密钥问题、400 是请求本身有错、数据不存在是业务结果，重试不改变任何一边，白烧时间和配额。只有会自己好的瞬态故障值得等。
:::

4. recursion_limit 防的是哪类故障？超限会发生什么？它和 Agent 止损是什么关系？

::: details 参考答案
防逻辑层死循环：模型对失败工具无限重试，图在 chat 和 tools 之间无限打转。默认 25 步，超出抛 `GraphRecursionError`，本次 invoke 以异常终止。它是确定性兜底，Agent 止损是概率性行为——模型可能一根筋重试到上限。所以闸必须存在，但不能把闸当策略：日常止损靠 Agent 读错误消息，闸只接住没人止损的最坏情况。
:::

5. Pydantic 校验工具输出防的是什么？它和 try/except 是同一道防线吗？

::: details 参考答案
防脏数据：下游改了字段名、返回半截数据，全程无异常，但数据已经错了，模型拿到会一本正经地编。try/except 防「没有结果」，校验防「结果不可信」，同属工具层防线的一前一后两块盾。写法上是第 9 周 Pydantic 验证结构化输出的反向复用——那时验模型的输出，今天验工具的输出。
:::

## 延伸阅读

- [LangGraph 官方文档](https://docs.langchain.com/oss/python/langgraph/overview)，recursion_limit、ToolNode 的错误处理细节都在里面，读完会发现容错的框架侧只剩这两个旋钮
- [Python 官方文档：asyncio 并发任务](https://docs.python.org/3/library/asyncio-task.html)，`wait_for` 与超时的权威说明，注意 3.11 起 `asyncio.TimeoutError` 就是内建的 `TimeoutError`
- [AWS 通用参考：API 重试的指数退避](https://docs.aws.amazon.com/general/latest/gr/api-retries.html)，指数退避加抖动的经典论述，今天模型层防线的原始出处

今天的 `fault_tolerant_agent.py` 留好。明天 Day 7 是阶段三里程碑验收：Python + LLM API + 结构化输出 + FastAPI + LangGraph + ReAct + 工具调用 + 多 Agent + HITL 全链路，验收前把今天的三道防线并进清单——能出错而不倒，才算生产级的 Agent。整周日程见[第 13 周索引](/week13/)。
