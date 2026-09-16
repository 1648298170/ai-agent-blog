# 第 21 周 · Day 4：死循环防御与最大步数控制——别让一个请求烧穿一天预算

> 对应手册任务：学习「死循环防御 + 最大步数控制」，动手在 LangGraph 中设置 `recursion_limit`，超限时优雅终止，当日产出「死循环防御」。本篇只解决一个问题：Agent 的控制流是模型当场决定的，模型没有「我已经试过五次」的可靠自觉，一个必失败的工具、一条写漏的条件边，就能让它转进死循环，一次 run 烧掉正常请求几十倍的钱；限流拦的是请求频率，拦不住这种「只有一个请求、但它不结束」的事故，你必须自己画线。

## 今日目标

1. 说得清死循环的三种形态：工具反复失败死磕、两节点条件边互踢、A→B→C→A 隐蔽环，以及为什么传统重试上限和限流都救不了它
2. 掌握四层纵深防御：图级 `recursion_limit` 兜底步数、工具级连续失败禁用、预算级 token 止损、监控级长 run 打标
3. 独立复现一次真实事故（必失败工具让 Agent 跑飞），再逐层加防御把它拦下，最后用测试验证三种死循环形态都逃不掉

## 概念讲解：为什么 Agent 会转到停不下来

先看一个真实感很足的场景。限流配额上线第二天，凌晨两点一条告警把你叫醒：单租户 token 消耗异常。你打开 [Day 1](/week21/) 接好的 trace，看到一棵难看的树：用户问「查一下订单 X-999 发没发货」，Agent 调 `query_order`，工具报错「订单不存在」，模型看到错误，换了个参数格式再调，又错，再调……直到撞上框架默认的 25 步上限才停下来。这一次 run 的 token 消耗是正常请求的三十倍。更坏的消息是，白天有人反馈过「复杂任务跑到一半被掐」，某个同事好心把 `recursion_limit` 调到了 100，于是这次它烧了一百步的钱。

限流为什么没拦住？限流拦的是「每秒多少个请求」，而这里从头到尾只有一个请求，它只是不结束。重试上限为什么没拦住？重试库管的是「抛异常的重试」，而这里每一步都正常返回，工具的错误信息被包成消息喂回模型，图一次都没崩。这是 Agent 特有的事故：死循环不是程序异常，栈是好的，每一步都在正常执行，只是永远到不了终点。

为什么会这样？普通服务的控制流是工程师写的 `for` 和 `while`，循环条件你定的；Agent 的控制流是模型现场决定的，工具报错在它眼里不是「放弃信号」，而是「一条新信息」，于是再试一次。第 12 周搭图时埋过一句伏笔：环是合法的，ReAct 就靠环工作，`recursion_limit` 默认 25 是最后一道闸，死循环的系统性防御留到生产化再讲。今天兑现。

防御之前，先把敌人的形状认清。死循环只有三种形态，能对号入座，防御就不会跑偏。

**形态一：工具失败死磕。** 模型用几乎相同的参数反复调一个必失败的工具。工具返回的错误越含糊（比如只说「查询失败」），模型越倾向于「再试试」，因为它看不出换个什么参数能成。

**形态二：两节点互踢。** A 的条件边说去 B，B 的条件边说回 A。经典翻车：质检节点不通过就打回重写，但「通过」依赖的字段上游从来没人写，条件永远为假。每条边单看都有道理，合起来是个没有出口的乒乓球。

**形态三：A→B→C→A 隐蔽环。** 写初稿、评审、修改，改完回初稿，流程再正当不过。终止条件是评审打分达标，而评审模型永远打 6 分。这种环最阴险：trace 里每一圈都「像在干活」，步数告警响了你去翻日志，第一眼还以为它挺努力。

认清形状后结论就直了：这三种环都不能等它自己出错，因为它不出错；只能在旁边画线。四条线互相独立，任何一条失守，下一条还在：图级限步数、工具级限失败、预算级限钱、监控级做事后回收。今天一层层装上。

## 核心知识

本节的代码互相衔接，可以先贴进一个文件里跑通看效果，最终完整版以下面的动手任务为准。

### 1. 图级：recursion_limit，把「最多走几步」写进法律

`recursion_limit` 限的是超步（superstep）数：图执行一轮节点算一步，ReAct 里「agent 思考 + 执行工具」一圈是两步。第 12 周说过，默认 25。默认值是兜底不是设计，生产要按场景显式收紧，一般 15 到 30：客服查单类任务两三轮工具就该答完，15 够了；多工具编排留 30。估算公式：预期最大工具轮数乘 2，再加 5 的余量。

```python
from langgraph.errors import GraphRecursionError  # 注意：不在 langchain 里，在 langgraph.errors

try:
    result = graph.invoke(inputs, config={"recursion_limit": 15})
except GraphRecursionError:
    result = graceful_finish(inputs)  # 优雅终止，见第 5 节，绝不是把异常透传成 500
```

关键在 `except GraphRecursionError` 这一行：撞限是预期内的运行结果，不是程序 bug，所以要接住、翻译、体面收尾。它和 `raise` 出去变成 500 是同一次事故的两种用户体验，分水岭就在这一行。

### 2. 工具级：同名工具连续失败 3 次，就地禁用

图级止损有个尴尬：一个撞满 15 步的 run 已经烧了十几轮 LLM 调用的钱。工具级防御的目标是让形态一在第 4 步就转向。做法是包住 `ToolNode`，数同名工具的连续失败次数，达到阈值就改写工具返回，明令模型收尾：

```python
from collections import defaultdict
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.prebuilt import ToolNode

class FailureGuardToolNode:
    """同名工具连续失败 max_streak 次，改写返回并禁用该工具，逼模型换路或直接作答"""

    def __init__(self, tools: list, max_streak: int = 3):
        self.inner = ToolNode(tools)          # handle_tool_errors 默认 True，异常会转成错误 ToolMessage
        self.max_streak = max_streak
        self.streak = defaultdict(int)
        self.banned: set[str] = set()

    def invoke(self, state: dict) -> dict:
        result = self.inner.invoke(state)
        patched = []
        for msg in result["messages"]:
            if not isinstance(msg, ToolMessage):
                patched.append(msg)
                continue
            failed = getattr(msg, "status", "success") == "error"
            if failed:
                self.streak[msg.name] += 1
            else:
                self.streak[msg.name] = 0      # 成功一次就清零：说明模型已经换对了路
            if msg.name in self.banned or self.streak[msg.name] >= self.max_streak:
                self.banned.add(msg.name)
                patched.append(ToolMessage(
                    content=(
                        f"工具 {msg.name} 已连续失败 {self.max_streak} 次，本会话已禁用，"
                        "不要再调用它。请基于已有信息直接回答，或明确告知用户无法完成。"
                    ),
                    tool_call_id=msg.tool_call_id,
                    name=msg.name,
                ))
            else:
                patched.append(msg)
        return {"messages": patched}
```

关键在数的是「连续」失败而不是总失败次数：失败三次后成功一次，说明模型换路成功了，账应该清零；总次数会把「试错后成功」的健康行为也误杀。禁用消息本身就是提示词工程，明确说「不要再用、直接作答」，模型基本会顺势收尾。它收不了尾也没关系，图级 limit 在后面兜着。

### 3. 预算级：会话 token 预算，钱是最硬的止损

步数少不等于花钱少：一个爱写长答案的模型，三步就能烧掉别家十步的钱。[Day 2](/week21/) 已经把每次调用的 `usage` 记进了 `llm_usage` 表，今天把同一份数据前移到运行时当刹车：

```python
class TokenBudgetExceeded(Exception):
    pass

class BudgetedLLM:
    """包住任意 chat 模型：会话累计 token 超预算就抛错"""

    def __init__(self, inner, budget: int = 20_000):
        self.inner, self.budget, self.used = inner, budget, 0

    def bind_tools(self, tools):
        self.inner = self.inner.bind_tools(tools)
        return self

    def invoke(self, messages, **kw):
        resp = self.inner.invoke(messages, **kw)
        usage = getattr(resp, "usage_metadata", None) or {}
        self.used += usage.get("total_tokens", 0)
        if self.used > self.budget:
            raise TokenBudgetExceeded(f"会话已用 {self.used} tokens，超出预算 {self.budget}")
        return resp
```

关键在预算独立于步数：它不看过程只看账，所以能兜住前三层全部失守的极端情况，比如模型每步都「正常成功」，只是话痨到破产。预算该设多大没有玄学，拿 [Day 2](/week21/) 攒的成本日报表，看正常请求的 P95 乘个两三倍起步。

### 4. 监控级：把超过 20 步的 run 打标，喂回评估集

前三层是拦人，这一层是收尸。没被拦下的长 run（比如 20 步上下、最终勉强完成的）是金子：它们暴露了 prompt 缺陷、工具描述不清、路由判断含糊。在运行结束后检查步数，超阈值就落一条记录：

```python
import json, time

def flag_long_run(state: dict, run_id: str, threshold: int = 20) -> None:
    steps = len(state.get("messages", []))
    if steps > threshold:
        record = {
            "run_id": run_id,
            "steps": steps,
            "ts": time.time(),
            "last_message": str(state["messages"][-1].content)[:200],  # 留个案发现场
        }
        with open("long-runs.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
```

这直接呼应第 16 周讲评估时的那句话：评估数据从哪来？很大一部分来自线上 trace 的日积月累。`long-runs.jsonl` 攒一个月，就是一张「我的 Agent 在哪类问题上容易打转」的自查清单，哪类问题高频出现，哪类 prompt 或工具就该回去返工。

### 5. 优雅终止：失败也要体面

四层防御最终都汇到同一个出口：把中断翻译给用户。三条底线。

第一，错误信息产品化。用户看到的应该是「这个问题比预想的复杂，我已尝试多步仍未完全解决，先中止以免你久等」，而不是 `GraphRecursionError: Recursion limit of 15 reached` 的堆栈，更不是 500 页面。异常细节留给日志和 trace。

第二，保留已完成的部分。跑了十步，前三步查到的数据对用户仍然有价值，扔掉等于让用户白等。用 `stream` 收集现场，撞限后从最后一个快照里捞出成功的工具结果：

```python
def graceful_reply(state: dict) -> str:
    done = [
        f"· {m.name}: {str(m.content)[:80]}"
        for m in state["messages"]
        if isinstance(m, ToolMessage)
        and getattr(m, "status", "success") != "error"
        and not str(m.content).startswith("Error")
    ]
    partial = "\n".join(done) if done else "本次没有拿到可用的中间结果"
    return (
        "这个问题比预想的复杂，我尝试了多步仍未完全解决，先中止以免你久等。\n"
        f"以下是已经完成的部分：\n{partial}\n"
        "建议把问题拆小一点再来，比如一次只查一个订单号。"
    )
```

第三，给用户下一步的建议。「拆小问题」这句不是客气话，是唯一真正降低复现概率的手段：问题越小，Agent 需要的步数越少，离所有限制线越远。失败体面了，用户才肯回来再试一次。

## 动手任务：复现事故，再逐层拦下它

手册任务：在 LangGraph 中设置 `recursion_limit`，超限时优雅终止。拆成 6 步，全程约 40 分钟。产出文件 `loop_guard.py`，测试可以写在同文件底部或单独的 `test_loop_guard.py`。

**第 1 步：建文件、装依赖。** 新建 `loop_guard.py`，装好 `pip install langchain-openai langgraph`，配好 `OPENAI_API_KEY`（沿用 [Day 1](/week21/) 的环境）。文件顶部放导入：

```python
from collections import defaultdict

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import ToolNode, create_react_agent
from typing import Annotated, TypedDict
import operator
```

**第 2 步：造一个必失败的工具，复现事故。** 先亲眼看它跑飞，后面每层防御的效果才有对比：

```python
@tool
def query_order(order_id: str) -> dict:
    """查询订单物流状态。order_id 形如 A-001。"""
    raise ValueError(f"订单 {order_id} 不存在，请检查单号")  # 模拟后端永远查不到

llm = ChatOpenAI(model="gpt-4o-mini")
agent = create_react_agent(llm, [query_order])

result = agent.invoke(
    {"messages": [("user", "帮我查订单 X-999 的物流，查不到就换几种单号格式再试，直到查到为止")]}  # 故意怂恿它死磕
)
```

跑之前想清楚会看到什么：`ToolNode` 默认把工具异常转成错误消息喂回模型，模型看不到「放弃」的理由，就会一直试，直到默认的 25 步上限引爆 `GraphRecursionError`。如果这次它中途自己放弃了，别奇怪，模型行为本来就有随机性，把提示改得更「执着」一点再跑。这个实验的意义恰恰是：不能赌模型自觉，得赌你画的线。跑完去 LangSmith 看那棵树，把步数记下来，第 4 步要对比。

**第 3 步：图级收紧 + 优雅终止。** `create_react_agent` 返回的图同样吃 config。用 `stream` 收集现场，撞限后体面收尾：

```python
def run_with_guard(graph, inputs: dict, recursion_limit: int = 15) -> dict:
    state = inputs
    try:
        for chunk in graph.stream(inputs, config={"recursion_limit": recursion_limit}, stream_mode="values"):
            state = chunk  # values 模式下每块都是完整快照，异常时手里留着最后现场
        return {"status": "ok", "messages": state["messages"]}
    except GraphRecursionError:
        return {"status": "stopped", "reply": graceful_reply(state), "messages": state["messages"]}

if __name__ == "__main__":
    out = run_with_guard(agent, {"messages": [("user", "帮我查订单 X-999 的物流，直到查到为止")]})
    print(out.get("reply") or out["messages"][-1].content)
```

再跑一次。这次没有异常炸屏，用户拿到的是一段人话加已完成的部分。事故还是那个事故，体验已经是两种产品。

**第 4 步：工具级禁用，让它在第 4 步转向。** 把第 2 节的 `FailureGuardToolNode` 抄进文件，然后手搭一个最小的 ReAct 图，把守卫接到工具节点上：

```python
class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], operator.add]

llm_bound = BudgetedLLM(ChatOpenAI(model="gpt-4o-mini"), budget=20_000).bind_tools([query_order])
guard = FailureGuardToolNode([query_order], max_streak=3)

def agent_node(state: AgentState):
    return {"messages": [llm_bound.invoke(state["messages"])]}

def route(state: AgentState):
    last = state["messages"][-1]
    return "tools" if getattr(last, "tool_calls", None) else END

builder = StateGraph(AgentState)
builder.add_node("agent", agent_node)
builder.add_node("tools", guard.invoke)
builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", route)
builder.add_edge("tools", "agent")
guarded_graph = builder.compile()

out = run_with_guard(guarded_graph, {"messages": [("user", "帮我查订单 X-999 的物流，直到查到为止")]})
print(len(out["messages"]), "条消息")  # 对比第 2 步的 25 条左右（默认上限），通常骤降到 10 条以内
```

同一个必失败工具，同一个怂恿死磕的 prompt，步数从撞满上限变成几步收尾。这就是纵深的意义：图级防御让事故在 15 步结束，工具级让它在大约 4 步结束，钱差着三倍。

**第 5 步：预算级 + 监控级。** `BudgetedLLM` 已经在第 4 步顺手包上了（这就是第 3 节的代码），现在让 `run_with_guard` 也接住它，并在运行结束后打标：

```python
# run_with_guard 里再加一个分支（放在 except GraphRecursionError 旁边）：
#    except TokenBudgetExceeded as e:
#        return {"status": "stopped", "reply": "本次对话的开销已达上限，先到这里。请开一个新对话继续。", ...}

# 运行结束后：
flag_long_run(out, run_id="run-20260917-001")
```

预算触发的文案和步数触发的不同：预算是「这次到这，下次再来」，步数是「问题太复杂，建议拆小」。用户拿到的建议要和真实原因对得上，不然拆了问题照样超预算。

**第 6 步：三种形态各写一条测试。** 形态一的端到端行为依赖真模型，不适合进自动化测试，那就直接测守卫本身的逻辑；形态二和三不涉及 LLM，是纯图行为，确定性测：

```python
import pytest

def _tool_call_state(order_id="X-999"):
    return {"messages": [AIMessage(content="", tool_calls=[
        {"name": "query_order", "args": {"order_id": order_id}, "id": "call_1"}
    ])]}

def test_form1_tool_guard_bans_after_three_failures():
    g = FailureGuardToolNode([query_order], max_streak=3)
    last = None
    for _ in range(3):
        last = g.invoke(_tool_call_state())
    assert "已禁用" in last["messages"][-1].content

def _pingpong_graph():
    class S(TypedDict):
        rounds: int
    b = StateGraph(S)
    b.add_node("draft", lambda s: {"rounds": s.get("rounds", 0) + 1})
    b.add_node("review", lambda s: {"rounds": s.get("rounds", 0) + 1})
    b.add_edge(START, "draft")
    b.add_conditional_edges("draft", lambda s: "review")      # 无条件去评审
    b.add_conditional_edges("review", lambda s: "draft")      # bug：永远打回，忘了写出口
    return b.compile()

def _review_cycle_graph():
    class S(TypedDict):
        score: int
        rounds: int
    b = StateGraph(S)
    b.add_node("draft", lambda s: {"rounds": s.get("rounds", 0) + 1})
    b.add_node("review", lambda s: {"score": 6})              # 模拟永远打 6 分的评审
    b.add_node("revise", lambda s: {"rounds": s.get("rounds", 0) + 1})
    b.add_edge(START, "draft")
    b.add_edge("draft", "review")
    b.add_conditional_edges("review", lambda s: END if s["score"] >= 8 else "revise")
    b.add_edge("revise", "draft")
    return b.compile()

def test_form2_pingpong_hits_limit():
    with pytest.raises(GraphRecursionError):
        _pingpong_graph().invoke({"rounds": 0}, config={"recursion_limit": 10})

def test_form3_review_cycle_hits_limit():
    with pytest.raises(GraphRecursionError):
        _review_cycle_graph().invoke({"rounds": 0, "score": 0}, config={"recursion_limit": 12})
```

::: tip 运行方式
四条测试函数名都以 test_form 或 test_tool 开头，用 `pytest loop_guard.py -k "form or guard" -v` 一次跑全，全程离线（不调真模型），几秒结束。形态二、三的图故意不带任何防御包装，就是要验证裸图撞上 `recursion_limit` 必被拦：这是图级防御对所有环形态一视同仁的证明。
:::

## 常见踩坑

**坑 1：把 recursion_limit 当节点调用次数。** 它数的是超步：一轮节点执行算一步，agent 和 tools 各算一步，一圈 ReAct 是 2。默认 25 听着不少，折算成工具轮数只有十二轮左右。想清楚你的 Agent 最多需要几轮工具，再乘 2 加余量去设，别拍脑袋。

**坑 2：except Exception 一把抓。** `GraphRecursionError` 和 `TokenBudgetExceeded` 要分开接：两种中断给用户的建议不同（拆问题对比开新会话），给监控的字段也不同（步数触发对比预算触发）。拿一个宽泛的 `except Exception` 全吞了，等于把两种事故现场混在一起，告警和统计全废。

**坑 3：让工具异常直接穿透图。** 有人觉得「工具抛错让整个 run 崩掉，不也算止损吗」。不算，这是事故升级：用户看到 500，已完成的部分也没了，trace 里断在一半。正确姿势是 `ToolNode` 默认的行为，异常转错误消息让模型知情，再由守卫计数决定是否禁用。你自己写工具节点时别把这层丢了。

**坑 4：只装一层就收工。** `recursion_limit` 能止血，不能省钱到最优：撞满 15 步的 run 一样烧 15 步的钱。工具级让它在第 4 步转向，预算级兜住「步数少但每步都贵」的场景，监控级把漏网案例攒成评估集。四层不是四选一，是四道独立的闸。

**坑 5：优雅终止变成优雅吞错。** 对用户说人话没问题，但对日志和 trace 要留全案发现场：哪层防御触发、走了几步、最后三条消息是什么、run_id 是多少。给用户的产品文案和给系统的结构化记录是两份输出，少一份，下次事故你还得凌晨爬起来翻半天。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `recursion_limit` 默认值是多少？它计数的单位是什么？生产环境怎么定这个数？

::: details 参考答案
默认 25。单位是超步（superstep），一轮节点执行算一步，ReAct 一圈「agent + tools」是 2 步。定值思路：预期最大工具轮数 × 2 + 5 的余量，一般场景 15 到 30，客服查单类 15 够用，多工具编排留 30。显式设置的意义是把它从「框架兜底」变成「产品决策」，别让别人随手调大。
:::

2. 工具级防御为什么数「连续失败」而不是「总失败次数」？

::: details 参考答案
连续失败意味着模型困在原地，没有从错误里学到任何东西，继续放行只是烧钱；而「失败几次后成功一次」说明模型已经换对了路，是健康的试错行为，计数应当清零。数总次数会把健康试错也误杀，模型被迫过早放弃本来能做成的任务。
:::

3. 有了步数限制，为什么还必须有 token 预算这层？

::: details 参考答案
步数和成本只是相关，不是等价：长输出的模型三步就能烧掉别家十步的钱，「每步都正常成功」的 run 一样可能超支。预算只看累计花费，不依赖对过程的任何假设，所以能兜住其他层全部失守的极端情况，是成本上最硬的一道闸。
:::

4. 优雅终止要给用户哪三样东西？

::: details 参考答案
一，产品化的错误解释：说「任务过于复杂已中止」，不给堆栈不给 500；二，已完成的部分：跑了十几步，前几步查到的中间结果对用户仍有价值，用 stream 快照保留并展示；三，下一步建议：比如「把问题拆小、一次只查一个订单」，这是真正降低复现概率的行动指引。同时给系统侧留完整现场（触发层、步数、末尾消息、run_id），用户文案和日志记录是两份输出。
:::

5. 三种死循环形态分别是什么？哪种从 trace 上最难看出来，为什么？

::: details 参考答案
工具反复失败死磕、两节点条件边互踢、A→B→C→A 隐蔽环。最难看出的是隐蔽环：互踢环两个节点来回弹跳，模式极其明显；隐蔽环每一圈都经过「写初稿、评审、修改」这类正经节点，单看每步都像在干活，只有拉通看步数和状态变量（比如分数始终是 6）才能发现出口条件永远不成立。这正是监控级「超 20 步打标」存在的理由：让人眼不需要盯着每棵树。
:::

## 延伸阅读

- [LangGraph 官方概念文档：图与超步](https://langchain-ai.github.io/langgraph/concepts/low_level/)，`recursion_limit`、超步计数、`GraphRecursionError` 的原始定义都在这里
- [LangChain 工具调用概念](https://python.langchain.com/docs/concepts/tools/)，`ToolNode` 的错误处理行为（`handle_tool_errors`）和 `ToolMessage.status` 字段的官方说明
- [LangSmith 文档](https://docs.smith.langchain.com/)，按步数过滤 run、配置异常告警，把今天第 4 层监控做成平台能力

今天的产出 `loop_guard.py` 留好：`FailureGuardToolNode` 和 `run_with_guard` 是两个可以直接搬进生产图的零件，明天给 Agent 装日志指标告警时，步数和预算触发的记录会直接进 Prometheus 指标。
