# 第 13 周 · Day 3：Worker Agent 实现与工具集成——订单走直线，退款走推理

> 对应手册任务：学习「Worker Agent 实现 + 工具集成」，动手为订单 Agent 接入「查订单」工具、为退款 Agent 接入「发起退款」工具，当日产出两个 Worker。本篇只解决一个问题：Day 2 的 Supervisor 已经会判意图、会派单，可活派出去没人接，图里两个 Worker 还是空壳。今天把它们填实，顺便用同一个场景看清 Worker 的两种形态：不需要推理的活，纯函数节点一条直线办完；需要边走边看的活，把第 12 周的裸 ReAct 原样搬过来。

## 今日目标

1. 说得清 Worker 的两种形态——纯函数节点和 ReAct 子图——以及「这个活要不要推理」这条判据怎么用
2. 掌握工具集成的分寸：什么工具给谁、用什么方式给、谁压根不该看见，Supervisor 为什么一个业务工具都不 bind
3. 独立跑通两个 Worker 的完整对话：申请退款经历追问、调工具、解释结果的多轮循环，查订单一条直线回来

## 概念讲解：同一个名字，两种活法

Day 2 收工时，你的图长这样：Supervisor 挂在中间，条件边读着 `next` 把请求引向 order_agent 和 refund_agent，指向两个还不存在的节点。今天补上它们，第一个要回答的问题不是「怎么写」，是「写成什么」。

Worker 是缩小版的单 Agent，Day 1 就说过。但「缩小」不等于同一种东西等比例缩小。落地时 Worker 有两种形态，判据只有一条：这个活需要推理吗？

订单查询不需要。意图已经被 Supervisor 判完了——查订单。剩下的活是：从消息里拿出订单号，调接口，把结果组织成人话。全程没有岔路，不需要模型权衡任何事。这种活用纯函数节点：一个普通 Python 函数当节点，直接调工具，直接返回，一次 LLM 都不请。

发起退款需要。用户说「不想要了」，订单号给了吗？原因说清了吗？订单到底支付了没有？是先问用户还是先办？每一步都取决于上一步的结果。这种活得边走边看，也就是第 12 周的 ReAct 循环：模型节点决定调不调工具，ToolNode 执行，结果回给模型，直到它能给出最终答复。把那套骨架搬过来，换个提示、换个工具，就是退款的微型子图。

形态选错，两边都疼。给订单查询套上 ReAct，每查一单多烧一次模型调用，还多出一层「模型可能不调工具直接编」的风险；给退款写死成纯函数，用户一句「上周买的那个东西想退」就让正则哑火——没有订单号可抓，函数不知道下一步该干嘛。

一句话记住：参数抓得住、过程无分支，纯函数；要不要调工具、先问还是先办得看情况，ReAct。

## 核心知识

本节代码是 LangGraph 1.0 语境，没有任何新 API：`StateGraph`、`add_node`、`add_conditional_edges`、`ToolNode`，全是第 12 周用熟的原语。代码里用到的 `CustomerServiceState` 和 `llm` 在动手任务第 1 步落地。

### 1. 订单 Worker：纯函数节点

先写工具。查询类工具是只读的，出错顶多答非所问，可以放开手脚：

```python
ORDERS = {
    "A-1024": {"status": "已发货", "amount": 299.0, "paid": True},
    "A-2048": {"status": "待付款", "amount": 159.0, "paid": False},
}
LOGISTICS = {
    "A-1024": ["杭州分拣中心已发出", "上海转运中心已到达", "派送中，快递员王五"],
}

def get_order_status(order_id: str) -> dict:
    """查询订单状态。order_id 形如 A-1024"""
    return ORDERS.get(order_id) or {"error": f"订单 {order_id} 不存在"}

def get_logistics(order_id: str) -> dict:
    """查询物流轨迹。order_id 形如 A-1024"""
    return {"order_id": order_id, "traces": LOGISTICS.get(order_id, ["暂无物流记录"])}
```

注意这两个函数没加 `@tool`。工具的本质是函数，`@tool` 装饰器做的事只是把函数翻译成模型看得懂的 schema。订单 Worker 不请模型，说明书没有观众，Python 直接调用就是了。数据用内存字典模拟，真实项目里换成查库接口，形状不变。

节点本身：

```python
def order_agent(state: CustomerServiceState) -> dict:
    last = state["messages"][-1].content   # Supervisor 刚转来的那条用户消息
    hit = re.search(r"A-\d+", last)
    if not hit:
        reply = "好的，麻烦发一下订单号（形如 A-1024），我马上帮您查。"
    else:
        order_id = hit.group(0)
        if "物流" in last:
            traces = "；".join(get_logistics(order_id)["traces"])
            reply = f"订单 {order_id} 的物流轨迹：{traces}。"
        else:
            order = get_order_status(order_id)
            reply = (order["error"] if "error" in order
                     else f"订单 {order_id} 当前状态：{order['status']}，实付 {order['amount']} 元。")
    return {"messages": [AIMessage(content=reply)], "next": "supervisor"}
```

关键在最后一行 return，它干了两件事：结果包成 `AIMessage` 写回 messages，公共黑板上多一条答复，Supervisor 醒来就能看见；`next` 置回 `"supervisor"`，路由指针还给主管。整个节点没碰一次 LLM，快、稳、免费。答复是模板拼的，呆板了点，但每句话都有数据来源，不会编。缺订单号时会追问，只是追问逻辑也是写死的分支，不经过模型。

### 2. 退款 Worker：微型 ReAct 子图

退款要推理。骨架就是第 12 周裸 ReAct 的形状：一个模型节点、一个 ToolNode、一条条件边循环。先看工具——它和订单那两个不一样，高危，动钱：

```python
@tool
def create_refund(order_id: str, reason: str) -> dict:
    """为订单发起退款。order_id：订单号，形如 A-1024；reason：退款原因"""
    order = ORDERS.get(order_id)
    if order is None:
        return {"ok": False, "msg": f"订单 {order_id} 不存在，请向用户核对订单号"}
    if not order["paid"]:
        return {"ok": False, "msg": f"订单 {order_id} 尚未支付，无款可退"}
    return {"ok": True, "refund_id": f"RF-{order_id[2:]}",
            "amount": order["amount"], "status": "退款已受理"}
```

这里必须加 `@tool`：它要被模型看见和选择，要进 ToolNode，schema 一分不能少。更要紧的是函数体里那两道校验——订单不存在、订单未支付，都在工具里挡下，返回结构化的 `ok` / `msg`。能不能退的底线判断写在代码里，不写在提示里，这句话先记住，踩坑一节展开。

模型节点和子图：

```python
refund_tools = [create_refund]
refund_llm = llm.bind_tools(refund_tools)          # 只看得见这一个工具

def refund_reasoner(state: CustomerServiceState) -> dict:
    msgs = [SystemMessage(content=REFUND_PROMPT), *state["messages"]]
    return {"messages": [refund_llm.invoke(msgs)], "next": "supervisor"}

def refund_needs_tools(state: CustomerServiceState) -> str:
    return "refund_tools" if state["messages"][-1].tool_calls else END

refund_builder = StateGraph(CustomerServiceState)   # 子图共用外图的 State 类型
refund_builder.add_node("refund_reasoner", refund_reasoner)
refund_builder.add_node("refund_tools", ToolNode(refund_tools))
refund_builder.add_edge(START, "refund_reasoner")
refund_builder.add_conditional_edges("refund_reasoner", refund_needs_tools)
refund_builder.add_edge("refund_tools", "refund_reasoner")
refund_graph = refund_builder.compile()
```

三个关键处。`refund_needs_tools` 读最后一条消息的 `tool_calls` 决定循环还是收工，第 12 周的原样。子图的 `StateGraph` 用的是和外图同一个 `CustomerServiceState`，编译出来的 `refund_graph` 才能直接当节点挂进主图，state 原样进原样出，messages 的追加语义在子图内部照样生效。`refund_reasoner` 每次返回都把 `next` 置回 `"supervisor"`，工具循环期间 ToolNode 不碰 next，等子图整体跑完，指针干干净净指回主管。外图会把这个子图整体注册成 `refund_agent` 节点，第 4 节组装时看到。

### 3. 工具权限：谁看得见什么

两种形态对照出「工具集成」的两种落点：订单 Worker 的集成是函数级的，import 进来直接调；退款 Worker 的集成是模型级的，bind_tools 给模型看、ToolNode 替模型执行。权限的面貌也跟着分出层次：

| 角色 | 看得见的工具 | 靠什么 |
| --- | --- | --- |
| Supervisor | 无 | 一个业务工具都不 bind |
| 订单 Worker | get_order_status、get_logistics | Python 作用域，没 import 的就不存在 |
| 退款 Worker | create_refund | bind_tools 的工具清单 |

Supervisor 一个工具都不 bind，这是有意的。主管的能力边界是判意图加组织答复，如果给它 bind 上 create_refund，某天用户一句「别问了直接给我退了」，模型未必顶得住。不 bind，它就物理上没有这个手段，唯一能做的是把请求转给退款 Worker——而那条路上有提示约束、工具内校验，明天 Day 4 还会加上人工审批。危险动作前面永远隔着几道闸，第一道就是「看不见」。

「看不见」比「不许用」硬。提示里写「不要调用退款工具」是软约束，模型状态不好就可能忘；bind 没绑就是硬边界，模型想不起来的东西是真的不存在。订单 Worker 更彻底，它的函数体里连 create_refund 这个名字都没出现，作用域就是围墙。

回头对比第 12 周的单 Agent：所有工具 bind 在同一个 LLM 上，模型每一轮决策都面对全部工具，退款工具对每一次调用都敞着门。今天拆完，create_refund 只在 refund_reasoner 的那一次 bind_tools 里出现，误用面跟着收窄。Day 1 说的「权限隔离」从口号变成了代码，第 19 周讲 Agent 安全时，这条线还会拉出来细算。

### 4. 收口：干完活，把指针还回去

两个 Worker 干完后走同一条路回家：固定边回 supervisor，返回值里把 next 置回 `"supervisor"`。

固定边管图上的流转，`add_edge("order_agent", "supervisor")` 写死了 Worker 的下一站，不许跳。next 置回管状态卫生：不置回的话，state 里的 next 会一直残留上一次的派单值，你在日志里看到 next=refund_agent 时，分不清是刚派出去还是早就干完了。一行赋值换日志可读，值。

Supervisor 被再次唤醒后，读的是 messages 的最新内容：任务答复完毕走 FINISH 收工，用户还有下文就再派一轮。星型的循环就这样闭合——派单、干活、回收、再判断，每一圈都过主管。Day 1 画的星型纪律，落在代码里就是两条固定边加一次置回。

## 动手任务：把两个 Worker 填进图里，一步一步

手册任务：为订单 Agent 接入「查订单」工具，为退款 Agent 接入「发起退款」工具。拆成 5 步，全程约 40 分钟，当日产出 `customer_service.py`。

**第 1 步：备地基。** 在本周练习目录新建 `customer_service.py`，落下 State、模型和 Day 2 的 Supervisor。Supervisor 部分以你 Day 2 的实现为准，下面是从简复刻：

```python
import re

from pydantic import BaseModel
from typing import Annotated, Literal, TypedDict

from langchain_core.messages import AIMessage, SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

llm = ChatOpenAI(model="gpt-4o-mini")  # 换成你第 12 周用的模型和配置

class CustomerServiceState(TypedDict):
    messages: Annotated[list, add_messages]  # 公共黑板：追加
    next: str                                # 路由指针：覆盖
    order_scratchpad: str                    # 今天闲置，字段先留着
    refund_scratchpad: str                   # 同上

class Route(BaseModel):
    next: Literal["order_agent", "refund_agent", "FINISH"]
    reason: str

SUPERVISOR_PROMPT = """你是客服系统的调度主管，只判断意图，不处理业务：
- 查订单、查物流 → order_agent
- 退款、售后 → refund_agent
- 闲聊、咨询、任务已答复完毕 → FINISH"""

def supervisor(state: CustomerServiceState) -> dict:
    route = llm.with_structured_output(Route).invoke(
        [{"role": "system", "content": SUPERVISOR_PROMPT}, *state["messages"]]
    )
    return {"next": route.next}
```

**第 2 步：订单 Worker。** 把核心知识第 1 节的 ORDERS、两个查询函数和 order_agent 原样抄进文件。工具名和 Day 1 草图里的 query_order 略有出入，落地时改成了 get_order_status——从图纸到代码改个名是常态，回头把 Day 1 那份 markdown 同步改掉就好。

**第 3 步：退款 Worker。** 抄入 create_refund、退款提示和核心知识第 2 节的子图代码。REFUND_PROMPT 用这份：

```python
REFUND_PROMPT = """你是电商售后专员，负责处理退款申请。规则：
- 受理需要订单号和退款原因，缺哪样就先向用户要哪样，不要猜
- 信息齐了调用 create_refund；工具返回 ok=False 时把 msg 内容如实转告用户，最多重试一次
- 每轮答复简短、语气安抚，不承诺政策之外的补偿"""
```

::: warning 丑话说在前面
今天的 create_refund 是裸奔的，练习数据是内存字典，烧不到真钱。真实环境里高危工具绝不能这样放行：明天 Day 4 会在这个工具前面插 interrupt() 人工审批，把 Day 1 图纸上那个「审批位」标记变成真的。今天这份代码别直接搬去生产。
:::

**第 4 步：组装整图。**

```python
builder = StateGraph(CustomerServiceState)
builder.add_node("supervisor", supervisor)
builder.add_node("order_agent", order_agent)
builder.add_node("refund_agent", refund_graph)     # 编译好的子图直接当节点
builder.add_edge(START, "supervisor")
builder.add_conditional_edges(
    "supervisor",
    lambda s: s["next"],
    {"order_agent": "order_agent", "refund_agent": "refund_agent", "FINISH": END},
)
builder.add_edge("order_agent", "supervisor")      # 固定边：干完必回主管
builder.add_edge("refund_agent", "supervisor")
graph = builder.compile(checkpointer=MemorySaver())
```

对照 Day 1 的架构图自查：一个主管、两个 Worker、条件边读 next 分三路、固定边收口回主管，图纸上每个箭头都有了着落。

**第 5 步：跑两段对话。** 文件末尾加上：

```python
config = {"configurable": {"thread_id": "demo"}}

def chat(text: str):
    print(f"\n用户: {text}")
    for chunk in graph.stream({"messages": [{"role": "user", "content": text}]}, config):
        for node, update in chunk.items():
            print(f"  [{node}] next={update.get('next', '-')}")
    print(f"客服: {graph.get_state(config).values['messages'][-1].content}")

chat("我上周买的东西想退掉")
chat("订单号 A-2048，就是不想要了")
chat("再帮我查下订单 A-1024 到哪了")
```

一次参考输出（模型措辞每次会有出入，节点走向应当一致；子图节点名前缀的拼法不同版本略有差异）：

```
用户: 我上周买的东西想退掉
  [supervisor] next=refund_agent     # 意图：退款 → 派退款 Worker
  [refund_agent:refund_reasoner] next=supervisor
                                     # 消息里没有订单号，规则说不猜，先问
  [supervisor] next=FINISH
客服: 好的，帮您办理退款前，麻烦提供一下订单号（形如 A-1024）和退款原因～

用户: 订单号 A-2048，就是不想要了
  [supervisor] next=refund_agent     # 黑板上有退款上下文，继续派退款 Worker
  [refund_agent:refund_reasoner]     # 信息齐了 → tool_calls: create_refund("A-2048", ...)
  [refund_agent:refund_tools]        # 返回 {ok: False, msg: 尚未支付，无款可退}
  [refund_agent:refund_reasoner] next=supervisor
                                     # 如实转告，没有瞎重试
  [supervisor] next=FINISH
客服: 查到订单 A-2048 还没有支付，暂时无款可退哦；想取消订单可以直接在订单页操作～

用户: 再帮我查下订单 A-1024 到哪了
  [supervisor] next=order_agent      # 意图切回查询 → 派订单 Worker
  [order_agent] next=supervisor      # 抓到 A-1024，查状态 → 模板答复
  [supervisor] next=FINISH
客服: 订单 A-1024 当前状态：已发货，实付 299.0 元。
```

三段对话把今天的东西全串起来了：退款 Worker 缺信息先追问（ReAct 的判断力），信息齐了走「模型→工具→模型」的循环（第 12 周的骨架），工具内校验挡下未支付订单（代码管底线），最后订单 Worker 一条直线办完查询（纯函数的便宜）。跑通后把这份日志和 Day 1 的架构图并排贴着看，每个箭头都能对上。

## 常见踩坑

**坑 1：形态和活不匹配。** 两个方向的翻车都常见。给查订单套 ReAct，多花钱还多一层模型不调工具直接编的风险；给退款写死纯函数，用户一句话说得不像模板，正则就抓瞎。写 Worker 前先问一句：这个活的每一步都能预先列成分支吗？能，纯函数；列不全，ReAct。

**坑 2：给 Supervisor bind 业务工具图省事。** 「主管顺手查一下订单」听起来无害，bind 了就看得见，看得见就迟早被调。某轮对话用户语气急一点，模型就可能越过 Worker 自己动手，星型的管控在这一刻就没了。主管的工具清单永远为空，业务能力一律下沉到 Worker。

**坑 3：底线校验写在提示里。** 「未支付的订单不能退」写进 REFUND_PROMPT，模型大多数时候听话，但它没有义务。同样一句写进 create_refund 的函数体，就是确定性代码，每次执行结果一致，模型想绕都绕不过去。判断规则、限额、风控，一律进工具函数；提示只管语气和话术。

**坑 4：忘了收口。** 症状有两种：日志里 next 长期残留 order_agent，分不清是刚派还是干完了；或者图里给两个 Worker 之间直接连了边，星型偷偷变网状。规矩就一条：每个 Worker 的出口只有一条固定边，回 supervisor，返回值里 next 置回。

**坑 5：`@tool` 加错地方。** 给纯函数节点的工具加 `@tool`，无伤大雅但没有观众；给 ToolNode 的工具忘加 `@tool`，直接翻车——ToolNode 靠 schema 执行工具，没有装饰器它拿不到函数签名，运行时才报错。判断标准一句话：这个工具给模型用吗？给，必须 `@tool`；不给，普通函数就行。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Worker 两种形态的判据是什么？各举一个本篇之外的例子。

::: details 参考答案
判据是这个活要不要推理：参数能否从输入稳定抽出、过程有没有无法预列的分支。纯函数例子：查天气，城市名抓出来调 API 就完事；ReAct 例子：报销审核，要看发票类型、金额、对照政策条目，边查边判断，分支列不全。
:::

2. 订单 Worker 的两个工具为什么可以不加 `@tool`？create_refund 为什么必须加？

::: details 参考答案
`@tool` 的作用是生成给模型看的 schema。订单 Worker 不请模型，工具被 Python 直接调用，schema 没有观众；create_refund 要被退款模型在工具清单里选择、被 ToolNode 按签名执行，两件事都依赖 schema，少了就跑不起来。
:::

3. 「看不见」和「不许用」差在哪？为什么 Supervisor 一个业务工具都不 bind？

::: details 参考答案
不许用是提示级的软约束，模型可能忽略；看不见是 bind 级的硬边界，工具根本不在模型决策时的候选清单里。Supervisor 的职责是路由和汇总，bind 了业务工具等于给调度岗开了业务后门，危险动作的第一道闸（物理上做不到）就没了。
:::

4. 「未支付无款可退」写进 create_refund 的函数体而不是 REFUND_PROMPT，理由是什么？

::: details 参考答案
函数是确定性代码，每次执行结果一致；提示是概率性约束，模型可能忘、可能绕。底线规则进代码，语气话术进提示。附带收益是校验结果以结构化 ok/msg 返回，Agent 只负责转述，判断本身不经过模型。
:::

5. 固定边已经把 Worker 接回 Supervisor 了，next 置回是不是多余？

::: details 参考答案
不多余，两者职责不同。固定边管控制流，决定图上的下一跳；next 置回管数据卫生，清掉过期的路由值。不置回，state 里一直残留上一次的派单值，看日志和排查问题时会被误导，任何读 next 的下游逻辑也一样。
:::

## 延伸阅读

- [LangGraph 官方示例库](https://github.com/langchain-ai/langgraph-examples)，多 Agent 示例的官方集散地，找 supervisor 相关示例和今天的图对照着看
- [OpenAI Function Calling 指南](https://platform.openai.com/docs/guides/function-calling)，bind_tools 背后的 schema 约定，看懂工具描述是怎么被模型消费的
- [Chip Huyen：Agents](https://huyenchip.com/2025/01/07/agents.html)，对 Agent 与多 Agent 收益、代价的冷静盘点，和 Day 1 的泼冷水一脉相承

今天完工的 `customer_service.py` 已经是一张能跑的星型多 Agent 图：一个 Supervisor 路由，两个 Worker 各司其职，工具各归各。但 Day 1 图纸上那个「※ 此前插 interrupt()」的标记还挂着——create_refund 目前裸奔。明天 Day 4 就补这一刀：在动钱之前，先等人工点头。整周日程见[第 13 周索引](/week13/)。
