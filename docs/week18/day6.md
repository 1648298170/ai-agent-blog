# 第 18 周 · Day 6：工具审批 UI 升级——让 MCP 工具也过人工这一关

> 对应手册任务：学习「工具审批 UI 升级」，动手「把第 13 周的审批 UI 扩展到 MCP 工具」，当日产出「MCP 审批」。本篇只解决一个问题：第 13 周的审批只覆盖本地 `@tool`，而 MCP 工具跨进程经适配器进图后，同样是图节点里的一次工具调用，`interrupt()` 机制天然通用——真正要补的只有两件事：识别「哪些 MCP 工具高危」，以及让审批卡说清「这是哪个 Server 的什么操作」。补上这块，HITL 就是企业 MCP 落地的最后一块拼图。

## 今日目标

1. 说得清为什么 MCP 工具进图后能直接复用第 13 周的 `interrupt()` / `Command(resume=)` 审批链路
2. 掌握两个新东西：按高危清单统一拦截的 `guarded_tool_node`，以及带 Server 名和预计影响的结构化审批 payload
3. 独立跑通完整流程：退款请求 → MCP `create_refund` 前中断 → 审批卡（Server / 工具 / 金额）→ 批准执行或拒绝道歉

## 概念讲解：为什么 MCP 工具也需要审批

回到第 13 周（见 [第 1 周教程](/week01/) 的学习方法，这里直接讲结论）。那时退款工具是你自己写的 `@tool`，跑在同一个 Python 进程里，你在工具执行前插一段 `interrupt()`，前端弹出审批卡，批准就 `Command(resume=)` 恢复。链路很短，因为一切都归你管。

这周处境变了。客服 Agent 通过 MCP Client 接了三个 Server：crm 管订单，支付管资金，知识库管文档。工具住别的进程里，是别的团队甚至外部供应商写的代码。这时你会发现旧审批有两个洞。

第一个洞，拦不住。第 13 周的审批是写死在「发起退款」这一个工具前面的，相当于给一扇门配了一把锁。MCP 工具根本不是你写的，你不可能在每个 Server 工具的源码里插 `interrupt()`——你连源码都看不到。新工具今天接进图里，明天就可能在没有任何人确认的情况下动账。

第二个洞，看不懂。本地工具的审批卡只需要展示参数，因为审批人和工具作者往往是同一个团队。MCP 场景下审批人看到 `create_refund` 这个名字，第一反应是「谁的接口？在哪个系统里执行？退多少钱？」跨进程意味着责任也跨了进程，审批卡必须能回答「哪个 Server 的哪个工具、预计造成什么影响」，否则审批就成了闭着眼按按钮。

好消息是，底层机制一行都不用改。MCP 工具经适配器（`langchain-mcp-adapters`）加载进图后，对 LangGraph 来说和一个本地 `@tool` 没有任何区别：模型照样产出一条带 `tool_calls` 的 AIMessage，ToolNode 照样执行。而 `interrupt()` 是图层的机制，跟工具住在哪个进程无关。第 13 周学的 LangGraph 1.0 的 `interrupt()` / `Command(resume=)`、审批卡组件、checkpointer 线程恢复，全部白拿。

所以今天真正的工作只有两件：一是把「逐工具写死」改成「按高危清单统一拦在 ToolNode 门口」，这个清单昨天 Day 5 已经准备好了；二是把 interrupt 的 payload 从裸参数升级成结构化审批单，让前端审批卡换几个字段就能复用。

## 核心知识

### 1. 扩展点分析：审批应该拦在哪一层

MCP 工具进图后的调用链是这样的：

```text
用户消息 → Agent 节点（LLM 产出 tool_calls）→ ToolNode → MCP Client → MCP Server（别的进程）
```

`interrupt()` 能暂停的只有图内节点。Server 在另一个进程里，你管不着，也不该管——审批是 Agent 侧的策略，不是 Server 的义务。所以拦截点只有一个自然选择：ToolNode 执行之前。

第 13 周的做法是在单个工具内部写 interrupt，锁是逐门配的。今天换成门口统一安检：不管工具来自本地还是哪个 Server，只要名字在高危清单里，先过人工这一关。这个模式对 MCP 工具和本地工具一视同仁，以后新增高危工具只改清单，不动图。

### 2. 高危识别：CONFIRM_REQUIRED + guarded_tool_node

Day 5 做安全护栏时，你在中间件里给危险工具打过标记，高危清单就从这个标记来（新文件可直接照抄）：

```python
# guardrails.py（Day 5 产出，今天直接复用）
CONFIRM_REQUIRED = {"create_refund", "cancel_order", "delete_customer"}
```

然后是今天的主角，一个包住 ToolNode 的审批闸门：

```python
import uuid

from langchain_core.messages import ToolMessage
from langgraph.prebuilt import ToolNode
from langgraph.types import interrupt


def summarize_impact(call: dict) -> dict:
    """把工具参数翻译成审批人看得懂的「预计影响」。"""
    args = call["args"]
    if "amount" in args:
        return {"action": "资金变动", "detail": f"退款金额 ¥{args['amount']}"}
    return {"action": "不可逆操作", "detail": "涉及字段：" + ", ".join(args.keys())}


def make_guarded_tool_node(tools: list, high_risk: set[str]):
    tool_node = ToolNode(tools)

    def guarded(state):
        calls = state["messages"][-1].tool_calls
        risky = [c for c in calls if c["name"] in high_risk]
        if not risky:
            return tool_node.invoke(state)  # 低危调用，直接放行

        call = risky[0]
        decision = interrupt({
            "type": "tool_approval",
            "server": call["name"].split("__", 1)[0],
            "tool": call["name"].split("__", 1)[-1],
            "args": call["args"],
            "impact": summarize_impact(call),
        })

        if decision.get("approved"):
            return tool_node.invoke(state)  # 批准：透传给真正的 ToolNode 执行

        # 拒绝：每个 tool_call 都必须有一条 ToolMessage 回应，一个都不能悬空
        return {"messages": [
            ToolMessage(
                content=f"人工审批未通过（{decision.get('reason', '未说明')}），未执行。",
                tool_call_id=c["id"],
            )
            for c in calls
        ]}

    return guarded
```

关键一行是 `if c["name"] in high_risk`：审批的粒度从「某个具体工具」抽象成了「一个名字集合」，本地工具和 MCP 工具在这里被同一行代码对待。批准分支 `return tool_node.invoke(state)` 是透传，闸门自己不执行任何工具；拒绝分支给每个 `tool_call_id` 都合成一条 ToolMessage，让模型知道「人工拒绝了」，它自然会向用户道歉并给出替代方案，而不是傻等一个永远不会来的执行结果。

`call["name"].split("__", 1)` 是在拆 MCP 工具名。多 Server 场景下适配器会把工具命名为 `server名__工具名`（如 `crm__create_refund`），单 Server 保持原名。前缀规则以你实际加载后的名字为准，动手任务第 1 步会先打印确认，别凭记忆写。

### 3. 审批信息增强 + 前端复用

对比一下两代 interrupt payload。第 13 周，本地工具，能跑但不体面：

```python
decision = interrupt({"tool": "create_refund", "args": {"order_id": "A-1024", "amount": 199}})
```

第 18 周，MCP 场景，升级成一张结构化审批单：多了 `type`（前端按它区分中断类型）、`server`（谁的工具）、`impact`（人话翻译的预计影响）。字段就这四个，不多不少——审批人在卡片上要做的判断是「允不允许」，不是「审阅代码」。

前端那边，第 13 周的 Next.js 审批卡组件 `ApprovalCard` 原样复用，它只认 props，不关心数据从哪个进程来。改的只有字段映射：

```tsx
{/* 第 13 周的 ApprovalCard 不动，只换数据源字段 */}
<ApprovalCard
  title={`${approval.server} / ${approval.tool}`}
  fields={[
    { label: "MCP Server", value: approval.server },
    { label: "工具", value: approval.tool },
    { label: "参数", value: JSON.stringify(approval.args) },
    { label: approval.impact.action, value: approval.impact.detail }, // 退款金额 ¥199
  ]}
  onApprove={() => resume({ approved: true })}
  onReject={(reason) => resume({ approved: false, reason })}
/>
```

`resume` 里最终走的就是第 13 周同一条恢复通道：带着同一个 `thread_id`，`graph.invoke(Command(resume={...}), config)`。从这里你该看明白了：今天没有发明任何新机制，只是把旧机制的入口拓宽、信息加厚。

## 动手任务：MCP 审批 一步一步

手册任务：把第 13 周的审批 UI 扩展到 MCP 工具。拆成 5 步，全程约 30 分钟（需要 Day 2 的 crm Server 能跑起来）。

**第 1 步：建文件，加载工具，先打印名字。** 新建 `mcp_approval.py`，用 Day 3 的方式把 MCP 工具拉进图：

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "crm": {
        "transport": "stdio",
        "command": "python",
        "args": ["crm_server.py"],  # Day 2 的产出
    }
})

tools = await client.get_tools()
print([t.name for t in tools])  # 关键一步：看清工具进图后到底叫什么
```

关键就是最后那行 `print`。高危清单里的名字必须和这里打印出来的完全一致，`crm__create_refund` 和 `create_refund` 差一个前缀，安检就是摆设。以打印结果为准，回头校对 `CONFIRM_REQUIRED`。

**第 2 步：落高危清单和影响摘要。** 把上面核心知识里的 `CONFIRM_REQUIRED` 和 `summarize_impact` 加进文件（Day 5 已有 `guardrails.py` 就直接 import）。

**第 3 步：写闸门，组图。** 加入 `make_guarded_tool_node`，然后组装：

```python
from langchain.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph, MessagesState
from langgraph.prebuilt import ToolNode, tools_condition

builder = StateGraph(MessagesState)
builder.add_node("agent", call_model)  # 绑定了 MCP 工具的模型节点（Day 3 的写法）
builder.add_node("tools", make_guarded_tool_node(tools, CONFIRM_REQUIRED))
builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", tools_condition)
builder.add_edge("tools", "agent")
graph = builder.compile(checkpointer=InMemorySaver())
```

关键一行是 `make_guarded_tool_node(tools, CONFIRM_REQUIRED)`：闸门包住了所有工具（本地和 MCP 一锅端），清单一改，拦截范围立刻跟着变。

**第 4 步：命令行跑完整流程。** 先批准线：

```python
from langgraph.types import Command

config = {"configurable": {"thread_id": "demo-1"}}

result = graph.invoke(
    {"messages": [{"role": "user", "content": "帮我把订单 A-1024 退了，199 元"}]},
    config,
)
print(result["__interrupt__"][0].value)
# {'type': 'tool_approval', 'server': 'crm', 'tool': 'create_refund',
#  'args': {'order_id': 'A-1024', 'amount': 199}, 'impact': {...'退款金额 ¥199'}}

result = graph.invoke(Command(resume={"approved": True}), config)
print(result["messages"][-1].content)  # Agent：已为你发起退款，退款单号 R-2088……
```

换个 `thread_id` 再跑一次，这次拒绝：

```python
result = graph.invoke(Command(resume={"approved": False, "reason": "金额超过当日限额"}), config)
print(result["messages"][-1].content)
# Agent：抱歉，这笔退款没有通过审批（原因：金额超过当日限额），需要我帮你转人工客服吗？
```

注意两次的差别只在 resume 的值：批准走闸门透传、ToolNode 真执行 MCP 调用；拒绝走合成 ToolMessage、Agent 收到拒绝原因后自己组织道歉。两条路你都应该亲眼看到。

**第 5 步：接前端。** 把第 13 周的审批界面拉起来，`ApprovalCard` 组件一行不改，只把数据源换成第 3 节的 TSX 映射。浏览器里重复第 4 步的流程：输入退款请求 → 卡片显示「crm / create_refund，退款金额 ¥199」→ 点批准或填原因拒绝。

::: tip 运行前提
第 1 步的 stdio 方式会自动拉起 `crm_server.py`，保持 Day 2 的代码能独立运行即可。`__interrupt__` 键是 LangGraph 1.0 里读取中断 payload 的位置，版本低于 1.0 的写法不同，先确认 `pip show langgraph`。
:::

## 本周拼图总览：MCP 生产链路全景

到这里，本周六天凑成了一条完整的生产链路：

| 拼图 | 天 | 解决什么 |
| --- | --- | --- |
| Server 写好 | Day 2 | 业务能力以标准协议暴露，`get_order_status` / `create_refund` 可被任何 Client 调用 |
| Agent 接入 | Day 3 | LangGraph 经适配器加载 MCP 工具，跨进程调用对模型透明 |
| 资源暴露 | Day 4 | 知识库文档变成 MCP Resource，数据和工具走同一扇门 |
| 护栏 + 审批 | Day 5 / Day 6 | 进来的输入有校验、出去的输出有脱敏、高危动作有人签字 |

单独看每一块都不复杂，难的是全部就位：少任何一块，这条链路都上不了生产。没有护栏，Agent 会被恶意参数打穿；没有审批，一次幻觉的退款就是真金白银的事故。明天 Day 7 把这条链路整理成 MCP 工具接入清单，那就是下周 Agent 安全自查的底稿。

## 常见踩坑

**坑 1：高危清单里的名字和实际工具名对不上。** `MultiServerMCPClient` 在多 Server 场景给工具加 `server__` 前缀，单 Server 不加；版本升级也可能调整规则。清单写 `create_refund`、进图的名字是 `crm__create_refund`，闸门检查 `in high_risk` 永远是 False，高危工具静默放行，比不拦更危险——因为你以为拦了。对策就一条：第 1 步的 `print([t.name for t in tools])` 不能省。

**坑 2：恢复时开了新线程。** `interrupt()` 暂停的图状态挂在 `thread_id` 对应的 checkpoint 上。恢复必须用同一个 `config` 传 `Command(resume=...)`；如果你重新 `invoke` 一个新的用户消息，图会从头跑一遍，Agent 再调一次工具，再次中断，死循环。判断标准：批准操作的前端请求里，thread_id 要和发起会话的那次完全一致。

**坑 3：拒绝分支漏合成 ToolMessage。** 模型的 AIMessage 里带了 `tool_call`，OpenAI 的接口要求每个 `tool_call_id` 必须有对应的工具结果，下轮请求才会被接受。拒绝时如果只中断不回应，恢复后模型一拿这串消息就报 400。上面的实现里列表推导对 `for c in calls` 的每个调用都给了 ToolMessage，包括同批没被拦的低危调用，一个都不能少。

**坑 4：审批卡把原始 args 全甩给审批人。** `{"order_id": "A-1024", "amount": 199}` 对写代码的人是清楚的，对值班客服不是。审批单上最值钱的是 `impact` 那一行人话：资金变动、退款金额 ¥199。`summarize_impact` 现在只认 `amount` 字段，你业务里的不可逆动作（删数据、改权限）也应该各给一条翻译规则。

**坑 5：高危清单放错了边。** 清单由接入方（Agent 侧）持有，而不是写在 MCP Server 里。同一个 crm Server，测试环境的 Agent 可以全放行，生产环境必须拦退款——严格度是调用方的策略，一个 Server 会面对不同严格度的客户，把策略焊死在 Server 里，两边都别扭。Day 5 的中间件在 Client 侧打标，正是这个用意。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. MCP 工具跑在另一个进程里，为什么 LangGraph 的 `interrupt()` 审批机制照样管用？

::: details 参考答案
因为 MCP 工具经适配器加载进图后，对图来说就是一个普通工具：模型产出带 `tool_calls` 的 AIMessage，ToolNode 执行调用，跨进程这件事被 MCP Client 隔离在图的下游。`interrupt()` 作用在图节点内部，与工具的实现住在哪个进程无关，所以第 13 周的审批链路可以原样复用。
:::

2. `make_guarded_tool_node` 的批准和拒绝分支各返回什么？拒绝分支为什么必须给每个 tool_call 合成 ToolMessage？

::: details 参考答案
批准分支 `return tool_node.invoke(state)`，把状态透传给真正的 ToolNode 执行；拒绝分支返回合成的 ToolMessage 列表。必须逐个回应是因为模型 API 要求 AIMessage 里的每个 `tool_call_id` 都有对应工具结果，悬空一个，下一轮请求就报 400。合成的消息内容里带上拒绝原因，模型会据此向用户解释并给出替代方案。
:::

3. 为什么要先打印 `[t.name for t in tools]` 再写高危清单？

::: details 参考答案
工具进图后的名字由适配器决定：多 Server 时带 `server__` 前缀，单 Server 时是原名，规则还可能随版本变。高危清单按名字精确匹配，名字差一个前缀，检查就永远落空，高危工具静默放行。以打印结果为准，不凭记忆。
:::

4. 审批 payload 里的 `impact` 字段是干什么的？为什么不直接展示 args？

::: details 参考答案
`impact` 是把机器参数翻译成审批人能秒懂的预计影响，比如「资金变动：退款金额 ¥199」。审批人要做的判断是允不允许这个动作，不是读参数表；原始 args 留在卡片上供追溯，但决策依据应该是人话。跨团队、跨系统的 MCP 场景里这一点尤其重要。
:::

5. 用一句话说清本周 MCP 生产链路的四块拼图。

::: details 参考答案
Day 2 把业务能力写成 Server，Day 3 让 Agent 接入跨进程工具，Day 4 把数据源作为 Resource 暴露，Day 5 和 Day 6 给进出的数据加护栏、给高危动作加人工审批——暴露、接入、数据、安全四块凑齐，才算一条能上生产的链路。
:::

## 延伸阅读

- [LangGraph 官方文档：Human-in-the-loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/)，`interrupt()` 与 `Command(resume=)` 的权威说明，第 13 周和今天共用这一套
- [langchain-mcp-adapters](https://github.com/langchain-ai/langchain-mcp-adapters)，MCP 工具加载进 LangGraph 的适配器源码，工具命名规则以这里为准
- [MCP 规范](https://modelcontextprotocol.io/specification)，注意 2026-07-28 版已改为无状态协议，读规范时先对版本

今天的产出 `mcp_approval.py` 和升级后的审批卡留好，下周做 Agent 安全自查时，这条「护栏 + 审批」的 MCP 链路就是现成的检查对象。
