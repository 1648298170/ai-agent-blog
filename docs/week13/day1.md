# 第 13 周 · Day 1：多 Agent 架构设计——Supervisor / Worker，把「谁来干活」也画成图

> 对应手册任务：学习「多 Agent 模式：Supervisor / Worker、Peer-to-Peer」，动手设计一个「客服 Agent + 订单 Agent + 退款 Agent」的协作架构，当日产出架构图。本篇只解决一个问题：第 12 周的单 Agent 已经能调工具、能断点恢复，需求再涨时，先判断该不该拆、拆成什么形状，再把客服系统这张图落到纸面。今天是架构设计日，不写可运行代码，动手全在纸和 Markdown 上。

## 今日目标

1. 说得清什么时候才需要多 Agent：三个拆分信号，以及为什么单 Agent + 好工具能解决 80% 的需求
2. 认得三种拓扑：Supervisor 星型、P2P 网状、层级嵌套，各自的优劣和适用场景
3. 独立画出「客服 Supervisor + 订单 Worker + 退款 Worker」架构图：意图路由、State 设计、工具分级，全部落到纸面

## 概念讲解：先泼冷水——你可能不需要多 Agent

上周收官时，你手里是一套完整的单 Agent：LangGraph 图、几个工具、MemorySaver checkpoint。现在来了个客服需求：查订单、查物流、发起退款、顺便回答常见问题。

第一反应不该是「拆成三个 Agent」。把工具全挂在一个 Agent 上，多半也能跑。事实上单 Agent + 好工具能解决 80% 的需求，这是要先记住的底线，拆分永远是把好刀用在刀刃上。

什么时候单 Agent 开始疼？三个信号。

**信号一：系统提示过载。** 为了让模型 behave 得体，你往系统提示里塞了客服人设、订单规则、退款政策、语气要求，两千 token 起步。模型注意力被摊薄，指令开始互相打架，改一条规则，另一条的输出就变了味。

**信号二：工具超过 15 个。** 模型要从工具列表里选对那一个，工具越多选错率越高。第 10 周选工具靠的是语义匹配，候选池翻倍，混淆就翻倍。查订单和查物流长得像，退款政策和客服口径更像。

**信号三：职责需要不同的模型或不同的权限。** 客服问答用便宜的小模型就够，退款要走贵的大模型还得带审批。塞在一个 Agent 里，等于所有请求都按最贵配置跑，而且退款工具对每一次调用都敞着门。

三个信号中两个，才值得考虑拆。多 Agent 的本质就一句话：把「一个脑子装所有事」换成「几个小脑子各装一摊事，再加一个调度」。代价也直白：token 翻倍、调试面翻倍、一个环节的错会沿着链路传下去。拆分是应对复杂度的手段，不是展示技术的舞台。

## 核心知识

本节出现的代码是设计草稿，给纸面定形用的，明天和后天才会真正跑起来。API 全部是 LangGraph 1.0 语境：多 Agent 在 1.0 里没有任何新魔法，就是 `StateGraph` 的组合拼装，`StateGraph`、`add_node`、`add_conditional_edges` 这些你在第 12 周用熟的原语照常有效。

### 1. 三种拓扑：星型、网状、层级

**Supervisor 星型**：一个主管 Agent 挂中间，Worker 挂四周。用户消息只进主管，主管判断意图分给某个 Worker，Worker 干完把结果交回主管，主管组织语言答复用户。分发和回收都走主管，Worker 之间互不认识。

**P2P 网状**：没有主管，Agent 之间互相移交。订单 Agent 发现用户真实意图是退款，直接把控制权交给退款 Agent。LangGraph 1.0 里这种「更新状态 + 指定下一跳」合一步的动作，用 `Command` 表达，节点返回 `Command(goto="refund_agent", update={...})` 即可。

**层级嵌套**：supervisor 套 supervisor。顶层主管按业务域分发，每个域内部又有自己的小主管带一队 Worker。团队规模大到星型挂不下时才用。

| 维度 | Supervisor 星型 | P2P 网状 | 层级嵌套 |
| --- | --- | --- | --- |
| 控制流 | 主管集中分发、回收 | Agent 互相移交 | 逐层下达 |
| 适合场景 | 入口统一、职责边界清晰 | 少量对等专家、对话主导流程 | 队伍大、按业务域分组 |
| 主要代价 | 主管是瓶颈和单点 | 边数随 Agent 平方涨，全局难跟踪 | 链路长，延迟和 token 叠加 |
| 客服系统 | 选它 | 不选 | 暂时用不上 |

判断口诀：有明确入口、要统一管控，选星型；专家对等、流程靠对话自然推进，选网状；两个都超过五个 Worker，考虑层级。

### 2. Supervisor 的本质是意图路由器

星型里主管不干活，只干两件事：判断用户意图、收回结果组织答复。判意图这件事，你在第 11 周已经打过底：让 LLM 带结构化输出，把「派给谁」变成一个受约束的字段，而不是从自由文本里猜。

```python
from typing import Literal
from pydantic import BaseModel

class Route(BaseModel):
    next: Literal["order_agent", "refund_agent", "FINISH"]
    reason: str   # 让模型给出路由理由，调试时的救命稻草

def supervisor(state) -> dict:
    route = llm.with_structured_output(Route).invoke(
        [{"role": "system", "content": ROUTER_PROMPT}, *state["messages"]]
    )
    return {"next": route.next}
```

`Literal` 把 next 锁死在三个值里，模型想发明第四个 Worker 都没有出口。路由出口接到条件边上，就是第 12 周学的那套：

```python
builder.add_conditional_edges(
    "supervisor",
    lambda s: s["next"],
    {"order_agent": "order_agent", "refund_agent": "refund_agent", "FINISH": END},
)
```

看出来没有，Supervisor 模式没有新 API。所谓多 Agent 图，就是节点多了几个、条件边的分叉多了几条，骨架和第 12 周那张单 Agent 图一模一样。

### 3. Worker 的本质是缩小版单 Agent

每个 Worker 就是第 12 周那个「调模型 + 执行工具」的单 Agent，只是提示变短、工具变少。拆分最大的收益在这里兑现：**权限隔离**。工具不挂在同一个 Agent 上，模型就永远碰不到不属于它的工具。

工具要分级。今天只分两档：只读和高危。只读工具查数据，错了顶多答非所问；高危工具动钱动状态，错了要真金白银赔。退款就是高危，今天的架构图先标出来，Day 4 再在它前面插 `interrupt()` 做人工审批，这是本周下半场的主菜。

| 工具 | 归属 Worker | 风险级别 | 备注 |
| --- | --- | --- | --- |
| `query_order` | 订单 Agent | 只读 | 查订单状态 |
| `query_logistics` | 订单 Agent | 只读 | 查物流轨迹 |
| `initiate_refund` | 退款 Agent | 高危 | 动钱，Day 4 前必须加审批 |

### 4. State：一块黑板，三个格子

多 Agent 图的 State 是全员共享的黑板，设计原则是「共享的少、私有的分」：

```python
from typing import Annotated, TypedDict
from langgraph.graph.message import add_messages

class CustomerServiceState(TypedDict):
    messages: Annotated[list, add_messages]  # 对话主线：追加语义，全员的公共记忆
    next: str                                # 路由指针：覆盖语义，supervisor 写、条件边读
    order_scratchpad: str                    # 订单 Agent 的草稿纸：覆盖语义，别人不读不写
    refund_scratchpad: str                   # 退款 Agent 的草稿纸：同上
```

四个字段三种角色。`messages` 是追加的账本，谁说过话都在上面，Supervisor 靠它判意图，Worker 靠它接上下文。`next` 是只在当下有效的指针，第 12 周讲过的覆盖语义，天然适配。两个 scratchpad 是各 Worker 的私有草稿，比如订单 Agent 拆解查询条件的中间过程，写在自己格子里，不弄脏公共黑板。第 12 周那句判断标准继续成立：一直攒着的账本用 reducer，只在当下有效的指针和草稿用覆盖。

## 动手任务：画「客服 + 订单 + 退款」协作架构图，一步一步

手册任务：设计协作架构，产出架构图。拆成 5 步，全程约 25 分钟，工具是纸笔或空白 Markdown。

**第 1 步：划边界，列工具表。** 把客服系统要做的事全列出来：查订单、查物流、发起退款、查退款政策、闲聊兜底。按职责分组：前两条是订单域，第三四条是退款域，最后一条留给 Supervisor 自己。然后照上文那张表填一遍工具名、归属、风险级别。边界判断标准：换一个 Worker 也不影响其他 Worker 的职责清单，就算划清了。

**第 2 步：选拓扑，写理由。** 客服系统选 Supervisor 星型，三条理由写在图旁边：入口统一，用户只认一个客服；意图分类是天然单点，集中在主管一处维护；退款高危路径要管控，所有请求过主管，审计有唯一链路。顺手反证一下：选 P2P 会怎样？订单 Agent 直接把退款工具的调用权接过来，审批就没了着落点，不选。

**第 3 步：设计 State。** 照上面的 `CustomerServiceState` 抄一遍，每个字段后面用自己的话注明：谁写、谁读、什么更新语义。这一行注释明天写代码时就是文档。

**第 4 步：设计路由。** 写下 Supervisor 的三个出口（order_agent / refund_agent / FINISH）和对应条件边映射，再把 `Route(BaseModel)` 的字段定义抄上。FINISH 出口负责闲聊和常见问题，Supervisor 直接组织答复然后收工。

**第 5 步：画图，自查。** 把前面四步的产出拼成一张完整架构图，文字版长这样：

```
                 ┌────────┐
                 │  用户  │
                 └───┬────┘
                     ▼
           ┌───────────────────┐
           │    Supervisor     │  意图路由器：结构化输出选 Worker
           │   （客服 Agent）  │  闲聊/FAQ 自己答，答完走 FINISH
           └──┬──────┬──────┬──┘
              │      │      │   条件边：读 state["next"]
        订单类意图  退款类意图  其他 → FINISH → END
              ▼      ▼
       ┌──────────┐ ┌──────────┐
       │ 订单 Agent│ │ 退款 Agent│
       └────┬─────┘ └────┬─────┘
        查订单(只读)   发起退款(高危)
        查物流(只读)   ※ Day 4 在此之前插 interrupt() 人工审批
              │           │
              └─────┬─────┘
                    ▼  固定边：结果回到 Supervisor
           Supervisor 收结果 → 组织答复 → END
```

画完按四要素自查：节点齐不齐（1 主管 + 2 Worker + START/END）；边标清没有（条件边标意图，固定边标回流）；State 流向明不明确（messages 全程共享，next 只在主管出口有效）；风险标注了没有（高危工具挂审批标记）。四条全过，架构图交付。

::: tip 交付物
建议把这张图和工具表存成 `customer-service-architecture.md`，放在本周练习目录。明天 Day 2 照图写 Supervisor 节点，Day 3 写两个 Worker，Day 4 在退款出口插 `interrupt()`，图就是本周的施工蓝图，别只存在脑子里。
:::

## 常见踩坑

**坑 1：为多而多。** 看了 demo 觉得多 Agent 帅，三个工具的小场景也拆三个 Agent。先过一遍三个信号：提示过载了吗，工具过 15 个了吗，需要不同模型或权限了吗？一个都没中，回去把单 Agent 的工具写好。多 Agent 每加一个节点，token 和调试面都是真金白银。

**坑 2：Supervisor 什么都想管。** 图纸好看点，把查订单逻辑、退款政策全塞进 Supervisor 的提示，Worker 沦为摆设。这是把单 Agent 的上帝提示换了个地方上帝。主管只做意图判断和结果汇总，业务知识一律下沉到对应 Worker 的提示和工具里。

**坑 3：Worker 之间私聊。** 订单 Agent 查完顺手把控制权直接甩给退款 Agent，星型偷偷退化成网状。审计链路断了，Supervisor 对流转失去感知，出问题查不清谁派的话。星型纪律只有一条：所有流转过主管，Worker 之间的信息共享靠 `messages` 黑板，不靠私下移交。

**坑 4：State 搞成大杂烩。** 两个极端都错：只留一个 messages，Worker 的中间过程没处写，只好全挤进公共对话，主管判意图的噪声变大；或者所有字段全共享，A 的草稿被 B 覆盖。记住「共享的少、私有的分」：主线一条，指针一个，草稿一人一张。

**坑 5：高危工具当普通工具。** `initiate_refund` 没有任何护栏就画进图里，模型幻觉一起，钱就出去了。只读工具可以裸奔，高危工具必须在架构图上标出审批位，哪怕今天只是个标记。设计日不留这个标记，实现日大概率也想不起来。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 什么时候才需要多 Agent？三个信号分别是什么？

::: details 参考答案
系统提示过载，指令互相打架；工具超过 15 个，模型选择错误率飙升；职责需要不同的模型或不同的权限，混在一起要么浪费要么危险。三个信号中两个才值得拆。反过来，单 Agent + 好工具能解决 80% 的需求，拆分是应对复杂度的手段，不是默认选项。
:::

2. Supervisor 星型和 P2P 网状各自的优劣？客服系统为什么选星型？

::: details 参考答案
星型控制流集中，分发回收都过主管，入口统一、易于审计，代价是主管是瓶颈和单点；网状由 Agent 互相移交，灵活、对话推进自然，代价是边数随 Agent 数平方增长，全局难跟踪。客服系统入口统一、意图分类天然单点、退款高危路径要管控审计，所以选星型。
:::

3. 为什么说 Supervisor 的本质是意图路由器？它靠什么保证路由结果合法？

::: details 参考答案
Supervisor 不执行业务，只判意图和汇总结果。它用 LLM 结构化输出（第 11 周的内容）产出 `next` 字段，类型是 `Literal["order_agent", "refund_agent", "FINISH"]`，取值被锁死在合法出口集合里，模型无法发明不存在的 Worker；`next` 再由条件边消费，完成分流。
:::

4. `messages`、`next`、`order_scratchpad` 三个字段各自的角色和更新语义是什么？

::: details 参考答案
`messages` 是全员的公共记忆，`add_messages` 追加语义，谁说过话都留在账上；`next` 是路由指针，覆盖语义，supervisor 写、条件边读，只在当下有效；`order_scratchpad` 是订单 Agent 的私有草稿，覆盖语义，其他节点不读不写。原则：共享的少、私有的分；攒账本用 reducer，指针和草稿用覆盖。
:::

5. 订单 Agent 和退款 Agent 的工具为什么一个只读一个高危？这个区别在架构图上如何体现，未来如何落地？

::: details 参考答案
只读工具查数据，最坏结果是答非所问；`initiate_refund` 动钱动状态，模型一次幻觉就是真实损失，所以标为高危。架构图上在高危工具旁标注审批位（今天可以只是文字标记），Day 4 用 `interrupt()` 把标记落成真的 Human-in-the-Loop 中断，人工批准后才放行。
:::

## 延伸阅读

- [LangGraph 官方文档](https://docs.langchain.com/oss/python/langgraph/overview)，多 Agent 章节讲 Supervisor 与 Agent 移交的官方姿势，读完会发现全是你已会的 StateGraph 原语
- [Anthropic：Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)，把「工作流与 Agent 该何时出手」讲得最透的一篇，本篇「先泼冷水」的立场与它一致
- [Anthropic：多 Agent 研究系统的工程实践](https://www.anthropic.com/engineering/built-multi-agent-research-system)，一个真实生产级多 Agent 系统的得失复盘，重点看它如何谈 token 成本和编排误差

今天画的架构图是本周的施工蓝图：明天 Day 2 照图实现 Supervisor 节点和路由，Day 3 补齐两个 Worker 和工具，Day 4 给退款加上 `interrupt()` 人工审批，Day 5 上前端审批界面，Day 6 容错，Day 7 迎阶段三里程碑。整周日程见[第 13 周索引](/week13/)。纸面功夫到位了，明天动手才不慌。
