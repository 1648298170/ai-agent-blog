# 第 13 周 · Day 4：Human-in-the-Loop——让高危操作先过人工审批

> 对应手册任务：学习「Human-in-the-Loop：`interrupt()`」，动手在退款 Agent 调用「发起退款」前插入中断，等待人工确认，当日产出「可中断 Agent」。本篇只解决一个问题：LLM 说「该退」不等于真的该退，退款这种不可逆操作在执行前，图要能停下来，把最后一下拍板权交给人。

## 今日目标

1. 说得清为什么多 Agent 系统需要人工审批这道闸，以及它为什么是企业落地和招聘 JD 里的高频词
2. 掌握 LangGraph 1.0 的三个关键点：`interrupt()` 暂停、`Command(resume=...)` 恢复、恢复时节点「从头重跑」的执行语义
3. 独立改造退款 Agent：触发中断给审批人看信息、批准后真实执行退款、拒签后改口告知用户，全程日志能对上每一步

## 概念讲解：为什么 LLM 拍不了这个板

先复盘昨天的成果：Supervisor 图里挂着两个 Worker，订单 Agent 接了「查订单」工具，退款 Agent 接了「发起退款」工具，用户一句「我要退款」，全链路自动跑通。

跑通之后先别庆祝，想一个场景。凌晨两点，用户说「9 块 9 的衣服有质量问题，要求退款」。LLM 从订单里抽金额，抽错了；或者订单其实过了退款期，它没看出来。退款 Agent 拿着工具就上了，钱直接打回用户账户。第二天你收到的不是感谢，是客诉和对账单。

问题不在于模型笨，在于两件事。

第一，LLM 的判断是概率输出。意图识别、订单抽取、金额核对，每一环都可能错。单环准确率 99%，五六环串起来，出错就不再是「会不会发生」，而是「每天发生几次」。

第二，退款不可逆。查订单查错了，大不了再查一次；钱付出去了，只能走追款流程。对可逆的错误，系统可以自己容忍重试；对不可逆的错误，工程上只有一个稳妥办法：执行前暂停，等人点头再动手。

这就是 Human-in-the-Loop（HITL，人在环里）。它不是「AI 不行所以人来兜底」的权宜之计，而是企业落地的硬需求：财务、医疗、运维，凡是动作不可逆的环节，合规上都要求有人签字。翻一翻大厂 Agent 岗的 JD，「Human-in-the-Loop」「人工审批」「模型风控」出镜率极高。今天这一篇，就是把这些词变成你写得出的代码。

实现 HITL，LangGraph 1.0 给的答案是 `interrupt()` 暂停加 `Command(resume=...)` 恢复。先划版本红线：旧版的 `NodeInterrupt` 写法已废弃，网上大量教程还在用，辨认方法见「常见踩坑」坑 1。另外一件事必须提前强调：`interrupt()` 必须配 checkpointer 才能工作。昨天装它时是给对话存档，今天它从「可选配件」变成「必需品」，原因下面讲。

## 核心知识

### 1. interrupt()：节点里的暂停键

在节点内调用 `interrupt(任意值)`，图会在这一行冻结：

```python
from langgraph.types import interrupt

def refund_node(state: State) -> dict:
    # 组装审批单：审批人拍板要看的字段
    approval_form = {
        "action": "发起退款",
        "order_id": state["order_id"],
        "amount": state["amount"],
        "question": f"确认退款 ${state['amount']} 给订单 {state['order_id']} 的用户？",
    }
    # 按下暂停键：这一行不返回，图在此冻结
    approved = interrupt(approval_form)
    # 恢复之后，才轮到下面的代码执行
```

调用方的视角是这样的：`invoke` 提前返回，返回值里多出一个 `__interrupt__` 字段，第一个元素的 `.value` 就是你传进去的审批单：

```python
result = graph.invoke(inputs, config)
print(result["__interrupt__"][0].value)
# {'action': '发起退款', 'order_id': 'A-1024', 'amount': 99.0,
#  'question': '确认退款 $99.0 给订单 A-1024 的用户？'}
```

三件事记住。一，`interrupt()` 的参数就是审批单，你设计什么字段，审批人就看什么信息，真实项目里审批 UI 渲染的就是这个值。二，它不是抛给你的异常，是 LangGraph 内部接管的暂停，图停下来时断点位置和当前 state 一起写进 checkpointer。三，没挂 checkpointer 一切免谈：暂停的现场没有地方存，恢复时也无从取，这就是开头说「必需品」的原因。checkpointer 按 `thread_id` 区分不同的暂停现场，一张待审单据对应一个 `thread_id`。

### 2. Command(resume=...)：恢复执行，但节点从头重跑

审批人拍板后，用同一个 `config` 再 `invoke` 一次，输入换成 `Command`：

```python
from langgraph.types import Command

config = {"configurable": {"thread_id": "case-001"}}
graph.invoke(Command(resume=True), config)    # 放行
graph.invoke(Command(resume=False), config)   # 拒签
```

`resume` 可以是任意值：布尔、一句拒绝理由、甚至 `{"approved": True, "operator": "李四"}`。传什么，节点里 `interrupt()` 就收什么。

真正的难点在恢复的执行语义，先看时序：

```
 你（调用方）           LangGraph（挂 checkpointer）          审批人
    │                          │                               │
    │ invoke(用户输入, config)  │                               │
    │─────────────────────────>│                               │
    │                          │ refund 节点第 1 次执行           │
    │                          │ 组装审批单 → interrupt(审批单)   │
    │                          │ ⏸ 图冻结，断点写入 checkpoint   │
    │<─────────────────────────│                               │
    │ 返回 __interrupt__ 审批单  │                               │
    │                          │                               │
    │          （拿着审批单去审批台展示，多久都行，现场不会丢）        │
    │                          │                               │
    │                          │ invoke(Command(resume=True),   │
    │                          │        同一个 config)           │
    │                          │<──────────────────────────────│
    │                          │ refund 节点第 2 次执行（从头！）   │
    │                          │ interrupt() 直接返回 True       │
    │                          │ 调 issue_refund → 写状态 → END  │
    │<─────────────────────────│                               │
    │ 返回最终 state             │                               │
```

划重点：恢复不是「从 interrupt 那一行接着往下走」，而是整个节点从头重跑。上次中断时，refund 节点里写了一半的 state 已经被丢弃；这次重跑，前面几行原样再执行一遍，跑到 `interrupt()` 调用处，checkpointer 里已经躺着一个待领取的 resume 值，于是这次不再暂停，直接把值返回给节点，代码继续往下走。

这个语义直接决定代码怎么排布：`interrupt()` 之前的代码，审批前后各执行一次。所以「组装审批单」这种便宜又幂等的操作放前面没问题，但 LLM 调用放前面就是 token 花双份，发短信放前面用户就收两条。原则一句话：`interrupt()` 尽量写节点靠前的位置，够组装审批单就行；真实的工具调用一律放在它后面。「先审批，后动作」，本来就是这个模式该有的样子。

### 3. 拒签也是一条正常路径

审批不通过，流程不该崩，也不该沉默。`interrupt()` 的返回值就是审批结果，拿它做分支：`True` 走「调用退款工具」路径；`False`（或一句字符串理由）走「改口」路径，把拒绝原因组织成给用户的话术写回 state。用户那边看到的，是客服从「好的，正在为您办理」变成「抱歉，您的退款申请未通过审核，已为您转人工客服」。Agent 收到拒绝信息后改口，不需要什么特殊机制，一个 `if` 就够了。

## 动手任务：可中断退款 Agent 一步一步

手册任务：在退款 Agent 调用「发起退款」前插入 `interrupt()`，等待人工确认。拆成 5 步，全程约 20 分钟。

**第 1 步：建文件。** 在本周的练习目录新建 `refund_hitl.py`。依赖只有 langgraph 本身：`pip install "langgraph>=1.0"`。下面每一步的代码都往这个文件里加，写完它就是当日产出「可中断 Agent」。

**第 2 步：写 State、工具和退款节点。** 状态里留 `tool_log` 字段记审计日志，真出纠纷时它是你的救命证据：

```python
from typing import TypedDict

from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import interrupt, Command


class State(TypedDict):
    messages: list[str]   # 对话记录，示意
    order_id: str         # 要退的订单
    amount: float         # 退款金额
    tool_log: list[str]   # 审计日志：每次真实工具调用记一笔


def issue_refund(order_id: str, amount: float) -> str:
    """昨天接入的「发起退款」工具，这里用打印代替真实支付接口。"""
    print(f"    [工具] issue_refund(order_id={order_id}, amount={amount}) 真实执行")
    return f"退款 ${amount} 已打回用户账户（流水号 R-{order_id}）"


def refund_node(state: State) -> dict:
    print("  [refund_node] 节点开始执行")  # 留着它，第 4 步要靠它破案
    approval_form = {
        "action": "发起退款",
        "order_id": state["order_id"],
        "amount": state["amount"],
        "question": f"确认退款 ${state['amount']} 给订单 {state['order_id']} 的用户？",
    }
    approved = interrupt(approval_form)  # 高危操作前的暂停键

    if approved is True:
        result = issue_refund(state["order_id"], state["amount"])
        return {
            "messages": [f"客服 Agent：退款已完成，{result}"],
            "tool_log": [f"issue_refund({state['order_id']}, {state['amount']})"],
        }
    reason = approved if isinstance(approved, str) else "人工审核未通过"
    return {
        "messages": [f"客服 Agent：抱歉，您的退款申请未通过（{reason}），已为您转人工客服。"],
        "tool_log": [],
    }
```

关键在 `approved = interrupt(approval_form)` 这一行：它前面的代码只负责把审批单攒齐，真正的工具调用 `issue_refund` 被压在它后面。「审批单在前，动作在后」，这就是 HITL 节点的标准形态。

**第 3 步：建图、挂 checkpointer、触发中断。** 在文件末尾继续写：

```python
builder = StateGraph(State)
builder.add_node("refund", refund_node)
builder.add_edge(START, "refund")
builder.add_edge("refund", END)

# interrupt 的硬前提：编译时必须挂 checkpointer
graph = builder.compile(checkpointer=MemorySaver())

# —— 第 1 幕：用户申请退款，图中断 ——
config = {"configurable": {"thread_id": "case-001"}}
result = graph.invoke(
    {"messages": ["用户：衣服有质量问题，要求退款"],
     "order_id": "A-1024", "amount": 99.0, "tool_log": []},
    config,
)
print("审批单：", result["__interrupt__"][0].value)
```

运行后应该看到两行输出：节点开始执行的打印，和你的审批单。注意 `[工具]` 一行没有出现，图停住了，工具没被碰。

**第 4 步：放行，读日志破案。** 紧接着写第 2 幕，模拟审批人核对后点「批准」：

```python
# —— 第 2 幕：审批人核对后放行 ——
result = graph.invoke(Command(resume=True), config)
print("最终回复：", result["messages"][-1])
print("审计日志：", result["tool_log"])
```

完整日志拼起来看：

```
  [refund_node] 节点开始执行
审批单： {'action': '发起退款', 'order_id': 'A-1024', 'amount': 99.0, 'question': '确认退款 $99.0 给订单 A-1024 的用户？'}
  [refund_node] 节点开始执行        ← 又打印了一次：节点从头重跑了
    [工具] issue_refund(order_id=A-1024, amount=99.0) 真实执行
最终回复： 客服 Agent：退款已完成，退款 $99.0 已打回用户账户（流水号 R-A-1024）
审计日志： ['issue_refund(A-1024, 99.0)']
```

`节点开始执行` 出现两次，这就是「从头重跑」语义的直接证据。第二次跑到 `interrupt()` 时拿到了 `True`，一路走到工具调用。审批单在前、动作在后，所以重跑的唯一代价只是重复组装一次审批单，工具只执行了一遍。

**第 5 步：换一单拒签，看 Agent 改口。** 新起一个 `thread_id`（对应一张新单据），这次审批人给的是一句拒绝理由：

```python
# —— 第 3 幕：另一单，审批人拒签 ——
config2 = {"configurable": {"thread_id": "case-002"}}
graph.invoke(
    {"messages": ["用户：要求退款"], "order_id": "B-2048",
     "amount": 1580.0, "tool_log": []},
    config2,
)
result2 = graph.invoke(Command(resume="订单已过退款期"), config2)
print("最终回复：", result2["messages"][-1])
print("审计日志：", result2["tool_log"])
```

输出里 `[工具]` 一次都不会出现，最终回复是改口话术：退款申请未通过（订单已过退款期），已转人工客服。`resume` 传的是字符串，节点里 `isinstance(approved, str)` 把它接成了拒绝理由，这就是拒签路径。同一个节点，两张审批单，批准与拒绝两种结局，代码一个字没改。

::: tip 运行与进阶
`python refund_hitl.py` 直接跑，三幕会按顺序打印。想更贴近真实审批：把第 2 幕的 `invoke(Command(resume=...))` 挪进审批回调里，图会一直停在断点等它，现场存在 checkpointer 里，隔天恢复都行。生产环境把 `MemorySaver` 换成 `SqliteSaver` 或 `PostgresSaver`（`langgraph-checkpoint-postgres`），审批窗口就能横跨服务重启。
:::

## 常见踩坑

**坑 1：见到 `NodeInterrupt`，立刻关掉那篇教程。** 旧写法是在节点里 `raise NodeInterrupt(...)`，这个 API 已废弃。1.0 的正解两条：节点内调 `interrupt(审批单)` 暂停，`graph.invoke(Command(resume=...), config)` 恢复，都从 `langgraph.types` 导入。老教程还有个特征是教你用 `graph.update_state()` 手改状态来「模拟」审批，1.0 的 resume 值走的是正门，语义清晰得多。不确定手里的教程新旧，先跑 `pip show langgraph` 对一下版本。

**坑 2：没挂 checkpointer，interrupt 直接歇菜。** `compile` 时不传 checkpointer，中断现场无处保存，`interrupt()` 根本无法工作。昨天装 checkpointer 是为了对话存档，今天它是 HITL 的地基：停在哪个节点、审批单是什么、当时的 state，全存在里面。再啰嗦一句，`MemorySaver` 数据在内存，进程一退全丢，本地练习够用，审批要过夜就必须换持久化实现。

**坑 3：以为恢复是「从 interrupt 那一行继续」。** 实际是整个节点从头重跑，`interrupt()` 这次直接吐出 resume 值。后果很具体：interrupt 之前的代码执行两遍。LLM 调用放前面，token 花双份；发短信放前面，用户收两条。排布原则见核心知识第 2 节：审批单在前，动作在后。

**坑 4：恢复时换了 thread_id，图一脸茫然。** checkpointer 按 `thread_id` 找断点，触发中断和恢复必须用同一个 `config`。反过来这也是它的好处：多单并发审批时，每个 `thread_id` 对应一张独立待审单据，互不干扰。明天 Web UI 的待审批列表，一行就是一个 `thread_id`。

**坑 5：审批单字段太抠，审批人只能盲签。** `interrupt()` 的参数就是审批界面上的那行字，只传一句「确认吗？」等于没传。action（要干什么）、order_id 和 amount（对谁、多少钱）、question（一句人话），这四样是底线。审批单设计得越全，HITL 才越像审批，而不是走形式的橡皮图章。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么 `interrupt()` 必须配 checkpointer？checkpointer 在 HITL 里存的到底是什么？

::: details 参考答案
图暂停后，「停在哪个节点、审批单是什么、当时的 state」这些现场数据必须持久化，恢复时按 thread_id 取回。checkpointer 存的就是断点现场。没有它，暂停的信息无处安放，恢复也无从谈起，interrupt 机制无法工作。
:::

2. 审批通过后，refund 节点从哪里开始执行？`interrupt()` 这次返回什么？

::: details 参考答案
从头执行，不是从 interrupt 那一行续。整个节点重跑一遍，跑到 `interrupt()` 调用处时不再暂停，直接把 `Command(resume=X)` 里的 X 作为返回值交给节点，代码继续往下走。上次中断时节点写了一半的 state 已被丢弃，重跑时全部重来。
:::

3. 拒签时 `resume=False`，Agent 怎么「改口」告知用户？

::: details 参考答案
`interrupt()` 的返回值就是审批结果，节点里用它做分支：True 走调用退款工具的路径，False 走改口路径，把拒绝原因组织成婉拒话术写回 state 的 messages。简单的 if 分支就够；要更自然的解释，也可以把拒绝原因塞回 messages 再让 LLM 组织一次语言。
:::

4. 一篇教程满足什么特征，你就该怀疑它写的是 LangGraph 1.0 之前的机制？

::: details 参考答案
节点里 `raise NodeInterrupt(...)` 是最明显的标志，该 API 已废弃。1.0 的正解是节点内调用 `interrupt(审批单)` 暂停、`graph.invoke(Command(resume=...), config)` 恢复，两者都从 `langgraph.types` 导入。用 `update_state` 手改状态模拟审批的，也多半是老思路。
:::

5. `interrupt()` 之前写了一行发短信的代码，审批通过后短信发了几条？怎么改？

::: details 参考答案
两条。恢复时节点从头重跑，interrupt 之前的代码等于执行两遍。把不可重复的副作用挪到 `interrupt()` 之后，先审批后动作，本来就是 HITL 的正确顺序；实在挪不动的，保证它幂等。
:::

## 延伸阅读

- [LangGraph 官方文档：Human-in-the-Loop 概念](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)，interrupt 与 Command 的执行模型、设计动机，本篇语义部分的原始出处
- [LangGraph How-to：工具调用前人工审批](https://langchain-ai.github.io/langgraph/how-tos/human_in_the_loop/review-tool-calls/)，官方把 `interrupt()` 放进工具函数内部的完整示例，和本篇的节点内写法互补
- [LangGraph API 参考：types 模块](https://langchain-ai.github.io/langgraph/reference/types/)，`interrupt`、`Command`、`Interrupt` 的签名和字段说明，写审批 UI 时常来查

今天产出的可中断 Agent 留好。明天（Day 5）把这条审批流接到 Next.js Web UI：左边用户提问，右边弹出审批单，审批人点「批准/拒绝」，按钮背后就是今天的 `Command(resume=True/False)`。控制台里的两次 invoke，摇身一变成两次点击，完整日程见[第 13 周总览](/week13/)。
