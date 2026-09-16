# 第 12 周 · Day 5：Function Calling 定义 Tool Schema——让模型认识你的工具

> 对应手册任务：学习「Function Calling：定义 Tool Schema」，动手定义 `get_weather(city)` 工具，让 LLM 自主决定是否调用，当日产出「工具调用 Agent」。本篇只解决一个问题：模型读不到你的源码，怎么让它认识一个工具、自己决定用不用、用的时候参数还填不错。

## 今日目标

1. 说得清 Function Calling 的完整链路：schema 随请求发给模型，模型决定调不调，要调就产出结构化调用请求，执行永远发生在你的代码里
2. 掌握四个知识点：`@tool` 装饰器的提取规则（docstring 即 description，注解即 schema）、工具设计四原则、`bind_tools` 挂载、`ToolNode` 接入 ReAct 图
3. 独立完成 `get_weather` 和一个工具调用 Agent：问天气时模型自己调工具，问别的它直接回答

## 概念讲解：为什么需要 Tool Schema

昨天你跑通了裸 ReAct：提示词里写好工具清单，模型输出一段「Action: get_weather[北京]」式的文本，你写解析器抠出工具名和参数，执行完再把结果拼回去。能跑，但有三处脆弱。一是模型输出的是自然语言，格式稍微漂移，解析就崩。二是模型对工具的全部认知来自提示词里那段描述，参数叫什么、什么类型，全靠它猜。三是每加一个工具，提示词和解析器要同步改两处，迟早漏掉一处。

Function Calling 把这件事标准化了。先接受一个核心事实：模型读不到你的 Python 源码，它认识一个工具，靠的是一份说明书——工具叫什么名、干什么用、接受哪些参数、每个参数什么类型。这份说明书用 JSON Schema 表达，随每次请求发给模型。模型看完决定两件事：调不调，调的话参数填什么。要调，它返回的不再是等你解析的文本，而是结构化的调用请求：工具名加参数 JSON。执行永远发生在你的代码里，结果回传，模型接着组织答案。

一句话：模型从不执行任何东西，它只负责填表。你的代码是执行者，模型是决策者。

而把普通 Python 函数变成带说明书的工具，只需要一个装饰器。第 9 周讲装饰器时说过：装饰器不改变函数本身，只在外面附加能力。`@tool` 把这个思想兑现到了极致——docstring 即 description，类型注解即 schema。函数签名和文档字符串本来就是你该写的东西，现在一份代码同时服务两个读者：Python 解释器和 LLM。这是 Python 声明式风格最漂亮的一次落地。

## 核心知识

本节的代码块都是独立示例，可以逐段贴进 Python 解释器对照着看。最终完整文件以下面的动手任务为准。

### 1. @tool：docstring 即 description，注解即 schema

```python
from langchain_core.tools import tool

@tool
def get_weather(city: str) -> str:
    """查询指定城市当前的天气。

    当用户问到某个城市的天气、气温、要不要带伞时调用。
    参数 city 是城市名，如「北京」「上海」。
    返回 JSON 字符串，含 temp（气温，摄氏度）、condition（天气状况）、humidity（湿度）。
    查不到该城市时，返回带 error 字段的 JSON。
    """
    ...  # 实现见动手任务
```

装饰完，检查三样东西：

```python
print(get_weather.name)         # get_weather
print(get_weather.description)  # 整段 docstring 原样变成工具描述
print(get_weather.args)         # {'city': {'title': 'City', 'type': 'string'}}
```

关键一行是 `@tool`：它读取函数签名和 docstring，自动生成一份 JSON Schema。函数名即工具名，docstring 即 description，`city: str` 即参数 schema（参数名、类型、必填）。模型看到的说明书就是这三样组装出来的，函数体它一个字都看不见——所以函数体里是调真实 API 还是查模拟数据，对模型完全透明，随时可以替换。

两点补充。第一，装饰后的 get_weather 不再是普通函数，而是一个 StructuredTool 对象，但依然能用 `.invoke({"city": "北京"})` 直接调用，方便你绕开模型单独测试。第二，没有类型注解的参数生成不了 schema，`def get_weather(city)` 这种裸参数在 @tool 这里直接报错——类型注解不是可有可无的装饰，是 schema 的原料。

### 2. 工具设计四原则

工具定义得好不好，直接决定模型用得准不准。四条原则，按重要性排。

**单一职责。** 一个工具只做一件事。get_weather 就只查天气。「查完天气顺便推荐穿搭」不是工具的事，是模型的事：它拿到天气结果自己就能推荐，这正是它擅长的。

**描述写给模型看。** 模型靠 description 决定「什么时候该用我」，这是它唯一的信息来源。坏描述长这样：「获取天气」——什么时候调？参数填什么格式？返回什么？一概不知。好描述写清楚适用时机、参数含义、返回内容和单位。自检标准：一个没见过你代码的人，只凭这段描述能不能正确使用这个工具。这个「人」就是模型。

**参数越少越好。** 每个参数都是模型要填的空，多一个就多一次填错的机会。一个 city 参数能解决的，别拆成 city、province、country、unit 四个。必填的才留在签名里，选填的想清楚再加。

**返回结构化字符串或 JSON。** 模型读的是文本。`json.dumps(...)` 出来的字符串，字段名清晰稳定，模型解析得最稳。别返回 Python 对象、datetime、bytes，序列化行为不可控，模型读不懂就等于白查。

### 3. bind_tools：挂载工具，交出决策权

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o-mini")  # 接法和昨天跑通 ReAct 时一致
llm_with_tools = llm.bind_tools([get_weather])
```

bind_tools 把工具的 schema 挂到模型实例上，可以挂多个：`llm.bind_tools([get_weather, search_hotel, send_email])`。挂载之后，「调不调、调哪个、参数填什么」三个决策全部移交模型。你的代码里没有、也不该有 `if "天气" in question` 这种分支——那是昨天的思路，今天决策权在模型手上。

顺带一句生态：LangChain 内置了一批现成工具，搜索（DuckDuckGo）、百科（Wikipedia）、向量检索（retriever 的 as_retriever）都有，真实项目先找轮子，找不到再造。

### 4. ToolNode：接管昨天的执行器

昨天你的执行器要干四件事：解析模型输出、找到对应函数、执行、把结果拼回对话。今天这四步打包给 ToolNode：

```python
from langgraph.prebuilt import ToolNode

tool_node = ToolNode([get_weather])
```

它读取上一条 AIMessage 的 tool_calls 字段（一个列表，每项含 name、args、id），逐个调用对应工具，把每个结果包成 ToolMessage 追加进消息列表。昨天手写的解析器，今天整体下岗，你只剩下接线员的活：把节点连成图。

## 动手任务：工具调用 Agent 一步一步

手册任务：定义 `get_weather(city)` 工具，让 LLM 自主决定是否调用。拆成 5 步，全程约 20 分钟。

**第 1 步：建文件。** 在本周练习目录新建 `tool_agent.py`，下面每一步的代码都往这个文件里加。依赖昨天已经装过（langgraph、langchain-openai），没装的话补一句 `pip install -U langgraph langchain-openai`。

**第 2 步：定义 get_weather，先当普通工具测。** 数据用模拟的，重点在结构：正常时返回结果 JSON，查不到时返回错误信息字符串，两种都是「结果」，都不抛异常：

```python
import json
from langchain_core.tools import tool

@tool
def get_weather(city: str) -> str:
    """查询指定城市当前的天气。

    当用户问到某个城市的天气、气温、要不要带伞时调用。
    参数 city 是城市名，如「北京」「上海」。
    返回 JSON 字符串，含 temp（气温，摄氏度）、condition（天气状况）、humidity（湿度）。
    查不到该城市时，返回带 error 字段的 JSON。
    """
    fake_db = {
        "北京": {"temp": 22, "condition": "晴", "humidity": 40},
        "上海": {"temp": 26, "condition": "多云", "humidity": 65},
        "广州": {"temp": 31, "condition": "雷阵雨", "humidity": 85},
    }
    data = fake_db.get(city)
    if data is None:
        return json.dumps({"error": f"查不到城市「{city}」，请确认城市名"}, ensure_ascii=False)
    return json.dumps({"city": city, **data}, ensure_ascii=False)

print(get_weather.invoke({"city": "北京"}))
# {"city": "北京", "temp": 22, "condition": "晴", "humidity": 40}
print(get_weather.invoke({"city": "火星"}))
# {"error": "查不到城市「火星」，请确认城市名"}
```

工具本身工作正常，再去接模型。这一步先单独跑一遍 print，确认输出和注释一致。

**第 3 步：看模型怎么「填表」。** 先不建图，直接观察模型挂上工具后的反应：

```python
from langchain_openai import ChatOpenAI
from langchain_core.messages import HumanMessage

llm = ChatOpenAI(model="gpt-4o-mini")
llm_with_tools = llm.bind_tools([get_weather])

ai = llm_with_tools.invoke([HumanMessage(content="北京今天适合穿短袖吗？")])
print(ai.content)     # 通常是空字符串，模型此刻不说话，只填表
print(ai.tool_calls)  # [{'name': 'get_weather', 'args': {'city': '北京'}, 'id': 'xxx', 'type': 'tool_call'}]
```

注意 ai.content 和 ai.tool_calls 的分工：模型决定调用工具时，答案不在 content 里，而在 tool_calls 里——工具名、参数全都结构化好了，没有一行需要你解析。换成「1 + 1 等于几？」再试，tool_calls 是空列表，答案直接写在 content 里。「是否调用」的决策，在这一层就已经发生了。

**第 4 步：组装 ReAct 图。** chat 节点调模型，ToolNode 执行工具，条件边看 tool_calls 决定走哪边：

```python
from langgraph.graph import StateGraph, START, END, MessagesState
from langgraph.prebuilt import ToolNode

def chat(state: MessagesState):
    return {"messages": [llm_with_tools.invoke(state["messages"])]}

def should_use_tool(state: MessagesState):
    last = state["messages"][-1]
    return "tools" if last.tool_calls else "end"

tool_node = ToolNode([get_weather])

builder = StateGraph(MessagesState)
builder.add_node("chat", chat)
builder.add_node("tools", tool_node)
builder.add_edge(START, "chat")
builder.add_conditional_edges("chat", should_use_tool, {"tools": "tools", "end": END})
builder.add_edge("tools", "chat")
graph = builder.compile()
```

图和昨天手写的 ReAct 同构：chat 有 tool_calls 就去 tools，执行结果回到 chat，模型再看一眼；没有 tool_calls 就直接结束。变化只有一个：执行环节从手写函数换成 ToolNode。路由依据就是 tool_calls 这个字段——langgraph.prebuilt 里有个现成的 tools_condition 干的就是 should_use_tool 的活，这里自己写一遍，是为了让你亲眼看见路由的判断依据。

**第 5 步：跑两个问题，对照路径。**

```python
for question in ["北京今天适合穿短袖吗？", "1 + 1 等于几？"]:
    print("=" * 40, question)
    result = graph.invoke({"messages": [("user", question)]})
    for m in result["messages"]:
        m.pretty_print()
```

第一个问题的预期链路：HumanMessage → AIMessage（tool_calls 里是 get_weather）→ ToolMessage（那段 JSON）→ AIMessage（最终回答，比如「北京 22 度，晴，穿短袖没问题」）。第二个问题：AIMessage 的 tool_calls 为空，条件边直奔 end，工具全程没被碰过。同一段代码，两条路径，决策全是模型做的。这就是「让 LLM 自主决定是否调用」的落地形态。

::: tip 运行命令
执行 `python tool_agent.py`。API key 按你昨天的接法配置；换成 DeepSeek、Qwen、GLM 等支持 tool calling 的模型，代码一行不用改，主流模型都支持这套标准协议。
:::

## 常见踩坑

**坑 1：docstring 空着，或者写给同事看。** @tool 的全部魔力在于把 docstring 变成 description。空 docstring 等于把说明书寄了个空信封，模型不知道工具什么时候该用，要么乱调，要么该调不调。「获取天气」这种一句话注释也一样：它假设读者看得见函数体，但模型看不见。适用时机、参数格式、返回内容、单位，描述里一样都不能省。

**坑 2：工具出错就抛异常。** 查不到城市就 `raise ValueError`，结果就是整张图炸掉，用户看到一屏 traceback。正确做法你已经写过了：把错误也当成一种结果，返回错误信息字符串。模型读到 error 字段，会自己决定下一步——换个城市名重试，或者告诉用户「这个城市我查不到」。记住分工：异常用于你的代码本身出了 bug；业务上查无数据不是异常，是结果。这是 Agent 容错的关键设计，第 13 周专门展开。

**坑 3：返回值不是给模型读的格式。** 图省事直接 `return dict`、return 一个 ORM 对象、返回值里夹带 datetime 或图片 bytes，模型拿到序列化不确定的东西，轻则浪费 token，重则读不懂开始编造。统一 `json.dumps` 成字符串，字段名用稳定的英文，长文本先截断——工具返回值是给模型的输入，不是给你的调试日志。

**坑 4：bind 了工具又替模型做决定。** 有人挂完 bind_tools，转身又写 `if "天气" in question: 调工具 else: 直接回复`。那 Function Calling 就白接了，你只是把 if/else 换了个地方写。决策权交给模型的意思是：你的代码里只有「模型说话」和「工具执行」两种节点，没有任何关于「该调哪个工具」的业务判断。提示词只需要交代你是谁、能干什么，剩下的交给模型。

**坑 5：工具粒度失控。** `get_weather_and_recommend_and_translate` 一个工具三个参数干三件事，听起来省事，实际每个参数的填错概率在相乘。参数超过四五个、职责超过一件，就拆。模型在多个小而清晰的工具里做选择，远比在一个大而糊的工具里填参数可靠。反过来也一样：两个工具描述高度重叠，模型会犹豫不决，要么合并，要么把描述里的适用场景划清界限。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `@tool` 从函数定义里提取了哪三样信息？模型实际「看到」的工具是什么形态？

::: details 参考答案
函数名变成工具名 name；docstring 变成描述 description；参数类型注解变成参数 schema parameters（参数名、类型、是否必填）。模型看到的是这三样组装成的一份 JSON Schema 说明书，随请求发送；函数体对模型完全不可见。
:::

2. 工具描述写给谁看？「获取天气」这个描述错在哪？

::: details 参考答案
写给模型看，模型只凭 description 决定什么时候用这个工具。「获取天气」的信息量约等于零：没写适用时机（用户问什么时该调）、参数格式（城市名怎么填）、返回内容（JSON 字段、温度单位）。自检标准：一个没见过你代码的人只看描述，能否正确使用这个工具。
:::

3. `bind_tools` 之后，「是否调用、调用哪个」由谁决定？这和代码里写 if/else 分发有什么本质区别？

::: details 参考答案
由模型在运行时决定，依据是每个工具的 schema 和用户提问。if/else 是把决策规则硬编码进你的代码，规则一变就得改代码；Function Calling 把决策交给模型，加新工具只要 bind 上去，代码零改动，模型自己会读说明书做选择。
:::

4. 工具查不到数据时，该 raise 还是该 return？为什么？

::: details 参考答案
该 return，返回包含错误信息的结构化字符串。raise 会把整张图的执行炸掉，用户直接看到异常；return 错误信息则把「怎么办」交还给模型，它可以重试、改参数或如实告知用户。原则：代码 bug 用异常，业务上的「查无结果」是正常结果，用返回值。
:::

5. ToolNode 接管了昨天手写执行器的哪几步？路由函数依据什么字段判断走哪条边？

::: details 参考答案
接管四步：解析 AIMessage 的 tool_calls、找到对应工具、执行、把结果包装成 ToolMessage 追加回消息列表。路由依据是最后一条 AIMessage 的 tool_calls 字段：非空走向工具节点，为空直接结束。
:::

## 延伸阅读

- [LangChain 官方文档：Tools 概念](https://python.langchain.com/docs/concepts/tools/)，@tool、StructuredTool、工具接口的权威定义，本篇第一、二节的原始出处
- [LangChain：自定义工具指南](https://python.langchain.com/docs/how_to/custom_tools/)，用 Pydantic 模型定制 args_schema、参数校验等进阶写法，工具复杂了再来看
- [LangGraph 官方文档](https://langchain-ai.github.io/langgraph/)，ToolNode、tools_condition 与预构建 create_react_agent 的细节，今天手拼的这张图就是 create_react_agent 的展开形式

今天的 `tool_agent.py` 留好。第 13 周讲 Agent 容错时，我们会回来改造 get_weather 的错误分支，把「返回错误字符串」升级成带重试与降级的完整方案。
