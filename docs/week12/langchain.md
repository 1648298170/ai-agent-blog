# 加餐 · LangChain 生态地图与 LCEL 最小必会

> 加餐定位：本篇不在手册任务清单里，没有当日产出文件，可以当睡前读物。但它补的洞很具体：你已经手写过裸 Function Calling 循环（第 11 周 Day 2）和裸 ReAct 图（[第 12 周 Day 4](/week12/day4)），干活全建在 LangGraph 上，于是「LangChain 生态整体长什么样」「LCEL 是什么」「create_agent 和我手写的东西什么关系」这三件事没人给你讲过。面试官不关心你的课程表，他只会问：你会 LangChain 吗？读完的标准：画得出五个包的分层图，读得懂老项目里的 LCEL，这个问题答得不虚。

## 为什么需要这篇加餐

先看一个事实：你以为自己没用过 LangChain。第 12 周 Day 4 的文件里写着 `from langchain_core.messages import ToolMessage`，[Day 5](/week12/day5) 的 `@tool` 来自 `from langchain_core.tools import tool`，模型的 `ChatOpenAI` 来自 `langchain-openai`。这三个包全是 LangChain 生态的成员。你天天在用，只是没意识到，因为课程让你从引擎层入手，跳过了生态导览。代价在面试桌上看得很清楚：手写过循环的人，反而接不住「你会 LangChain 吗」这个问题。

再看第二个事实：生态在 2025 年 10 月大重组过一轮。LangChain 和 LangGraph 先后发布 1.0，官方推荐收敛成两条路：简单场景用 langchain 包里的 `create_agent` 加 middleware，复杂场景直接上 LangGraph。旧的链式组件和 LCEL 归档进 langchain-classic 遗留包，`langgraph.prebuilt.create_react_agent` 废弃。而你上网搜「LangChain 教程」，前排结果大半还是 0.x 时代写的，教你 LLMChain、AgentExecutor、Memory 老三样。没有一张地图，你分不清手里的教程是新车手册还是报废车手册。

所以本篇目标定为三件事：画地图（五个包各管什么）、教认字（LCEL 会读不会写）、练话术（面试怎么答）。没有动手任务，代码块都是拿来读和随手跑的，环境沿用第 12 周 Day 4 那套：环境变量 `OPENAI_API_KEY` 放 DeepSeek 的 key。

## 生态地图：五个包各管什么

先给结论，这句话值得原样背下来：**LangChain 生态不是一个大框架，是一组分层的库。** 每层职责单一，可以单独安装、单独升级、单独换掉。

五个包逐一对照：

| 包 | 一句话职责 | 你和它的关系 |
|---|---|---|
| `langchain-core` | 基础抽象：消息类型、`@tool`、提示词模板、模型统一接口、Runnable 协议 | 天天在用。Day 4 的 `ToolMessage`、Day 5 的 `@tool` 都从这里来 |
| `langchain` | 1.0 应用层：`create_agent` 快捷方式 + middleware 扩展点 | 本篇主角，单 Agent 快速上线时用 |
| `langchain-classic` | 旧 Chains（LLMChain 一族）与 LCEL 范式的遗留包 | 新项目不装它，接手老项目时会见到 |
| `langgraph` | 编排引擎：StateGraph、节点、条件边、检查点 | 本课程主线，Day 4 整篇跑在它上面 |
| `langsmith` | 可观测：全链路追踪、评估、数据集 | 第 21 周学过，生产排查靠它 |

还有第六个角色不占层：partner 包，每家模型一个对接包（`langchain-openai`、`langchain-anthropic` 等）。你 `pip install langgraph langchain-openai` 那条命令装的就是引擎加对接，图里省掉它们免得看花。

这套分层是 1.0 才有的样子。0.x 时代一个 langchain 包什么都塞：模型对接、链、Agent、记忆、文档加载，装一个包背一整套依赖。重组之后，地基（core）几乎不再变，引擎（langgraph）管编排，应用层（langchain）只留快捷方式，老范式整体封存进 classic。你在课程里走的路线是先踩地基、再开引擎、最后才看一眼方向盘上的一键启动（create_agent），正好把这张图从下往上读了一遍。

## LCEL 最小必会：会读不会写

LCEL（LangChain Expression Language）是 0.x 时代的官方组合语法，曾经是所有 LangChain 教程的主角。新项目不必再用它，但两个地方绕不开：面试题和老项目。所以本节目标很明确：**会读不会写。**

它全部的核心就两样东西。

第一，Runnable 统一接口。凡是实现了下面三个方法的对象都叫 Runnable：

| 方法 | 干什么 |
|---|---|
| `invoke(x)` | 同步跑一遍，一个进一个出 |
| `stream(x)` | 流式跑，逐块吐出 |
| `batch([x, y])` | 批量跑，一组输入一组输出 |

三个都有异步孪生兄弟（`ainvoke` / `astream` / `abatch`）。提示词模板、模型、输出解析器，全是 Runnable。

第二，管道符 `|`。它是 `__or__` 运算符重载：`prompt | llm` 返回一个 RunnableSequence，运行时把前一段的输出喂给后一段。就这么多，没有更多魔法。

### 1. 基础链：prompt | llm | parser

```python
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="deepseek-chat",
    base_url="https://api.deepseek.com",
    temperature=0,
)

prompt = ChatPromptTemplate.from_messages(
    [("human", "用一句话向{audience}解释什么是{concept}")]
)
parser = StrOutputParser()

chain = prompt | llm | parser

print(chain.invoke({"audience": "小学生", "concept": "递归"}))
```

读法：`chain.invoke({...})` 一执行，prompt 把变量渲染成一条 HumanMessage，llm 收到消息产出 AIMessage，parser 从 AIMessage 里抽出纯文本。三段都是 Runnable，所以能串。

### 2. 挂工具：管道是直线，不是环

```python
from langchain_core.tools import tool

@tool
def calculator(expression: str) -> str:
    """计算四则运算表达式，例如 '(312 * 46) + 2280'。"""
    try:
        return str(eval(expression, {"__builtins__": {}}, {}))
    except Exception as e:
        return f"无法计算: {e}"

q = ChatPromptTemplate.from_messages([("human", "{question}")])
chain_with_tools = q | llm.bind_tools([calculator])

resp = chain_with_tools.invoke({"question": "(312 * 46) + 2280 等于多少？"})
print(resp.tool_calls)
# [{'name': 'calculator', 'args': {'expression': '(312 * 46) + 2280'}, 'id': 'call_xxx'}]
```

`bind_tools` 返回的还是 Runnable（带工具手册的模型），照样接进管道，`resp.tool_calls` 出来的就是第 11 周你见过的那份结构化调用请求。

但故事到这里就断了：模型要调 calculator，谁去执行？结果怎么回填？回填之后谁再调模型？管道符给不了答案。`|` 串起来的是直线，而执行工具、回填、再次调用是个环。第 11 周 Day 2 你手写 while 补这个环，第 12 周 Day 4 你用条件边补这个环，LCEL 从语法上就没有环。这就是它在 Agent 时代退出官方推荐的根本原因，面试被问「LCEL 为什么被替代」，答案就这一句。

### 3. 流式：统一接口真正值钱的地方

```python
for chunk in chain.stream({"audience": "产品经理", "concept": "LCEL"}):
    print(chunk, end="", flush=True)
```

注意 `chain` 还是例 1 那个对象，一个字没改，只是换了方法调。流式会自动从链尾逐段透传，不用为中间每一段单独写流式逻辑，换 `batch` 还能并发跑一组输入。一份链式定义，三种执行方式白拿，这是 LCEL 设计里真正聪明的一点，也是它当年流行的原因。

认脸清单，见到不慌：`RunnableLambda`（把普通函数包成 Runnable）、`RunnablePassthrough`（把输入原样传下去，常和 `.assign` 一起往下游附带字段）、`RunnableParallel`（并行分支）。不需要会用，读老代码时认得出它们在「包函数、传原值、开分支」就够了。

顺带一句包归属：链类实现（LLMChain、ConversationChain、各种 Memory）在 1.0 里整体搬进了 langchain-classic；管道语法的底层协议 Runnable 留在 langchain-core。所以本节的例子不需要装 classic 包就能跑，`pip install langchain-openai` 已经把 core 带上了。

## create_agent 对照：框架替你写的那 30 行

1.0 应用层的主角是 `create_agent`，位置在 langchain 包里。工具和模型都沿用你认识的写法：

```python
import datetime
from langchain.agents import create_agent
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="deepseek-chat",
    base_url="https://api.deepseek.com",
    temperature=0,
)

@tool
def calculator(expression: str) -> str:
    """计算四则运算表达式，例如 '(312 * 46) + 2280'。"""
    try:
        return str(eval(expression, {"__builtins__": {}}, {}))
    except Exception as e:
        return f"无法计算: {e}"

@tool
def get_current_time() -> str:
    """获取当前的日期和时间，格式为 'YYYY-MM-DD HH:MM:SS'。"""
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

agent = create_agent(
    model=llm,               # 也可以传字符串，如 "openai:gpt-4o"，用哪家配哪家的 key
    tools=[calculator, get_current_time],
    system_prompt="你是严谨的计算助手，涉及计算必须调工具。",
)

result = agent.invoke(
    {"messages": [{"role": "user", "content": "(312 * 46) + 2280 等于多少？"}]}
)
print(result["messages"][-1].content)
```

两个工具就是第 12 周 Day 4 第 2 步的原班人马。现在对照那天你手写的东西：

| 第 12 周 Day 4 手写 | create_agent 幕后替你做的 |
|---|---|
| `builder.add_node("agent", call_agent)` | 内置 agent 节点（bind_tools 调模型） |
| `TOOL_REGISTRY` + `call_tools` 回填 ToolMessage | 内置工具执行（等价 ToolNode） |
| `should_continue` + `add_conditional_edges` | 按 `tool_calls` 有无路由 |
| `builder.compile()` | 返回值本身就是编译好的图 |

一句话说透：**你手写的那约 30 行装配与路由，就是 create_agent 一行调用在幕后生成的东西。** 它返回的 agent 是一个编译好的 LangGraph 图，所以 Day 4 学过的 `.stream`、checkpointer、recursion_limit，对它全部照用。学手写不是为了拒绝快捷方式，是为了快捷方式对你不再是黑盒：哪天它行为不对，你知道底下每根线怎么接。

middleware 是 1.0 给这张快捷图配的扩展机制，一段话讲清：middleware 是挂在 Agent 执行过程上的钩子，能在消息进出和工具调用前后插手，把「往 ReAct 循环上加横切能力」这件要撬开图才能做的事变成配置项。两个典型：`SummarizationMiddleware` 在历史超过阈值时自动把旧对话折叠成摘要；`HumanInTheLoopMiddleware` 在指定工具执行前暂停等人批准。用法都是塞进列表：

```python
from langchain.agents.middleware import SummarizationMiddleware

agent = create_agent(
    model=llm,
    tools=[calculator, get_current_time],
    middleware=[
        SummarizationMiddleware(max_tokens=4000),  # 历史过长自动摘要压缩
    ],
)
```

::: tip 运行前
`pip install langchain langchain-openai`，它会自动带上 langchain-core 与 langgraph。key 的规矩同第 12 周 Day 4。
:::

最后收个尾：`langgraph.prebuilt.create_react_agent` 在 LangGraph 1.0 里废弃了，官方迁移路径就是 `create_agent`。Day 4 顺带提过一句，这里给全貌。老代码里见到它，知道是前身即可。

## 选型决策：先问直线还是环

| 你的需求 | 用什么 | 理由 |
|---|---|---|
| 单 Agent，标准 ReAct 够用，要快 | `create_agent` | 一行拿到标准图，横切能力交给 middleware |
| 多 Agent、复杂状态、非标准路由 | LangGraph 手写图 | create_agent 的图结构固定，骨架动不了 |
| 直线流程（翻译、抽取、分类） | 纯模型调用，LCEL 可选 | 直线不需要环，新项目 LCEL 非必需 |
| 维护 0.x 老项目 | langchain-classic | 会读 LCEL 就够，别往老代码里续写新 LCEL |

判断标准只有一条：要的是直线还是环。直线根本用不上 Agent，一次模型调用解决；是环就从 create_agent 起步，等发现图骨架必须自己定义（多个 Agent 汇聚、任意位置打断、非标准分支回退）再降到 LangGraph 手写。方向别搞反：手写不是更高级，是更底层，能站在快捷方式上就别重新发明轮子。

### 面试防御话术

**被问「你会 LangChain 吗」，低分答法是背组件名**：「用过 LLMChain、AgentExecutor、Memory」。这套话术停在 0.x，2026 年说出口等于自曝没跟进版本。高分答法是分层：

> 会，但要分层说。LangChain 生态不是一个框架，是一组库：langchain-core 提供消息、工具、模型接口这些地基抽象；LangGraph 是编排引擎；langchain 1.0 在上面提供 create_agent 加 middleware 的快捷方式。我生产里用 LangGraph，ReAct 循环自己手写过，检查点、人工介入都在图上落过地。旧的 Chains 和 LCEL 在 1.0 之后拆进了 langchain-classic 遗留包，新项目不该再用。

面试官从这段话里听到三件事：你知道生态怎么分层、你知道自己生产里在用什么、你知道版本怎么变。背 API 的知识半年就过期，分层认知不会，这就是版本敏感度比 API 熟练度值钱的原因。

**被追问「LCEL 是什么」**，别背语法，讲本质：核心是 Runnable 统一接口加管道符。Runnable 是实现了 invoke、stream、batch 的对象，管道符把 Runnable 串成序列，前一段输出接后一段输入；价值是一份代码同时获得同步、流式、批量三种执行方式；局限是没有循环，装不下 Agent 的环，所以 1.0 之后归入 classic 时代。

**被追问「create_react_agent 用过吗」**，答：它在 LangGraph 1.0 废弃了，官方迁移到 `langchain.agents.create_agent`，middleware 取代了原来一堆零散参数。然后补一句「等价的图我自己手写过」。最后这半句最值钱。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 五个包各自的职责，一句话一个？

::: details 参考答案
langchain-core：地基抽象（messages、@tool、模型接口、Runnable）；langchain：1.0 应用层（create_agent + middleware）；langchain-classic：旧 Chains 与 LCEL 的遗留收容所；langgraph：编排引擎（StateGraph、节点、条件边、检查点）；langsmith：可观测（追踪与评估）。
:::

2. LCEL 管道符 `|` 的本质是什么？为什么 prompt、模型、解析器能串起来？

::: details 参考答案
`__or__` 运算符重载，`prompt | llm` 返回 RunnableSequence，运行时前一段的输出作为后一段的输入。能串的前提是每段都是 Runnable，即实现了 invoke/stream/batch 统一接口。
:::

3. create_agent 和第 12 周 Day 4 手写的 ReAct 图是什么关系？

::: details 参考答案
等价。create_agent 幕后生成的就是 agent ⇄ tools 两节点加条件边那张图，手写的装配与路由约 30 行正是它替你生成的部分；返回值本身就是编译好的 LangGraph 图，invoke、stream、checkpointer 照用。
:::

4. 为什么旧 Chains 和 LCEL 被归进 langchain-classic？

::: details 参考答案
它们是为直线流程设计的组合方案，管道没有循环，装不下 Agent 的环。1.0 把主线收敛到 create_agent 与 LangGraph 图编排，旧范式整体封存进 classic 包，只为维护遗留系统而存在。
:::

5. 什么场景不该用 create_agent？

::: details 参考答案
图骨架需要自定义的场景：多 Agent 协作与汇聚分流、不止「工具执行前批一下」的复杂人机回环、非标准路由与分支回退，这些必须手写 LangGraph。另外纯直线流程根本不需要 Agent，直接调模型就够。
:::

## 延伸阅读

- [LangChain 官方概览](https://docs.langchain.com/oss/python/langchain/overview)，1.0 之后 create_agent 与 middleware 的权威文档，本篇对照一节的原出处
- [LangGraph 官方概览](https://docs.langchain.com/oss/python/langgraph/overview)，引擎层全景，课程主线的官方版本
- [LCEL 官方文档](https://docs.langchain.com/oss/python/lcel/overview)，接口清单都在这，读老项目前扫一遍
- 站内回看：[第 12 周 Day 4](/week12/day4) 的手写 ReAct 与 [第 12 周 Day 5](/week12/day5) 的 `@tool`，是本篇所有对照的另一半

这篇加餐没有代码产出，带走两句话就够：生态是一组分层的库，不是一个大框架；旧物会读，新物会选。下次被问「你会 LangChain 吗」，从分层开始答。
