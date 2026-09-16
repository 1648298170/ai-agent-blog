# 第 18 周 · Day 3：MCP Client 集成——把 Server 的工具喂给 LangGraph Agent

> 对应手册任务：学习「MCP Client 集成到 LangGraph」，动手让 LangGraph Agent 通过 MCP Client 调用 Day 2 写好的 `get_order_status` 工具，当日产出一条跑通的 MCP 工具调用链路。本篇只解决一个问题：工具住在 Server 进程里，Agent 住在你的脚本里，中间这条「发现、翻译、搬运」的路怎么铺，才能让 Agent 用远端工具用得和第 12 周的手写工具一样顺手。

## 今日目标

1. 说得清 MCP Client 在集成里干的三件事：连接、发现、翻译，以及为什么翻译完之后 Agent 分不清 MCP 工具和手写工具
2. 掌握四个知识点：`StdioServerParameters` 的 command/args、`AsyncExitStack` 管理连接生命周期、`load_mcp_tools` 的返回物、多 Server 工具合并挂载
3. 独立跑通「用户问订单 → Agent 自主选 MCP 工具 → 拿回状态」的完整链路，并在日志里指出每一跳

## 概念讲解：为什么需要 Client 这一层

昨天的 Server 已经就绪：一个独立进程，对外暴露 `get_order_status(orderId)`。今天的问题是怎么让 LangGraph Agent 用上它。

先回忆第 12 周（见[本周日程](/week18/) Day 5 那条线）手写工具是怎么接进 Agent 的：`@tool` 装饰器读本地函数的签名和 docstring，当场生成说明书，`bind_tools` 挂到模型上。这条流水线有个前提一直没明说：函数和 Agent 跑在同一个进程里，装饰器伸手就能读到函数定义。

今天这个前提没了。工具在另一个进程里，你的脚本里没有这个函数，`@tool` 无从读起。硬要自己解决也不难：写个子进程通信，约定消息格式，序列化参数，解析返回。一个 Server 忍忍就过去了，可每个 Server 一套约定，N 个 Server 配 M 个 Agent，就是 N×M 套胶水代码，谁也复用不了谁的。

MCP 的解法是把这套胶水标准化：Server 按规范提供两个通用入口，`list_tools` 报工具清单，`call_tool` 接调用请求；Client 统一负责连接、发现、翻译。今天的主角 `langchain-mcp-adapters` 就是官方给的翻译件，它把每个 MCP 工具转成一个 LangChain 工具对象：名字、描述、参数 schema 从 Server 原样搬来，`invoke` 时把调用转发回 Server 进程执行。

于是第 12 周那句结论原样成立：模型看到的是说明书，函数体它一个字都看不见。现在更进一步，连函数体都不在你的机器上，模型照样不知道、也不需要知道。Agent 眼里，MCP 工具和手写工具无差别，这层无差别就是协议的价值：Server 作者和 Agent 作者可以互不相识，靠一份规范协作，工具从「我进程里的函数」变成了「生态里即插即用的零件」。

## 核心知识

本节的代码块围绕 Day 2 的 `order_server.py` 展开，配合动手任务食用。先装依赖：`pip install langchain-mcp-adapters mcp langgraph langchain-openai`。

### 1. 集成原理：四步搬运流水线

整条链路就四步：连接，发现，翻译，组装。

第一步连接。stdio 模式下，Client 不是去连一个已经在跑的 Server，而是按你给的参数把 Server 当子进程拉起来，用标准输入输出当通信通道。参数就是 `StdioServerParameters` 的两个字段：`command` 是启动命令，`args` 是跟在后面的参数，合起来约等于你在终端敲的那一行 `python order_server.py`。

第二步发现。连上之后调 `session.list_tools()`，Server 交回它的工具清单，每条包含名字、描述、参数 schema：

```python
tools_result = await session.list_tools()
# tools_result.tools 大致长这样（示意）：
# [Tool(name='get_order_status',
#       description='根据订单号查询订单状态……',
#       inputSchema={'type': 'object',
#                    'properties': {'orderId': {'type': 'string'}},
#                    'required': ['orderId']})]
```

第三步翻译。`load_mcp_tools(session)` 把上面这份清单整体转成 LangChain 工具列表。对照第 12 周：`@tool` 从本地函数定义里提取三样东西（函数名、docstring、类型注解），`load_mcp_tools` 从远端清单里读同样的三样。来源不同，产物同种。

第四步组装。翻译产物是标准的 LangChain 工具，所以 `create_react_agent(llm, tools)` 原样可用，第 12 周学的 ReAct 图一行不用改。混着挂也行：

```python
from langchain_core.tools import tool

@tool
def get_current_time() -> str:
    """获取当前本地时间"""
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M")

all_tools = [get_current_time] + mcp_tools  # 手写的和 MCP 的混在一起
agent = create_react_agent(llm, all_tools)
```

Agent 选工具只看说明书，`get_current_time` 在本进程执行，`get_order_status` 要跨进程往返，它毫无感知。

### 2. langchain-mcp-adapters：完整代码逐行讲

```python
import asyncio
from contextlib import AsyncExitStack

from langchain_openai import ChatOpenAI
from langchain_mcp_adapters.tools import load_mcp_tools
from langgraph.prebuilt import create_react_agent
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

server_params = StdioServerParameters(
    command="python",          # 拉起 Server 用的命令
    args=["order_server.py"],  # Day 2 的 Server 文件
)

async def main():
    llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

    async with AsyncExitStack() as stack:
        # 1. 连接：拉起 Server 子进程，拿到读写两个流
        read, write = await stack.enter_async_context(stdio_client(server_params))
        # 2. 会话：把流包成 ClientSession，完成协议握手
        session = await stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        # 3. 发现 + 翻译：拉工具清单，转成 LangChain 工具
        tools = await load_mcp_tools(session)
        print([(t.name, t.description) for t in tools])
        # 4. 组装：从这里开始和第 12 周一模一样
        agent = create_react_agent(llm, tools)
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": "帮我查一下订单 A-001 的状态"}]}
        )
        print(result["messages"][-1].content)

asyncio.run(main())
```

四块内容值得逐个点破。

`stdio_client(server_params)` 返回的不是连接对象，而是一个异步上下文管理器，进上下文才拉起子进程，出来时负责杀掉它。`enter_async_context` 把它登记进 `AsyncExitStack`，这样退出 `async with` 时统一收尾。为什么不直接写两层嵌套的 `async with`？能写，但 Server 一多嵌套层数跟着涨，退出栈是平铺管理多条连接的标准做法，今天两个连接已经能看出苗头。

`ClientSession(read, write)` 把裸流升级成协议会话，`initialize()` 是握手：交换版本、确认能力。它自己也是上下文管理器，同样入栈。

`load_mcp_tools(session)` 是翻译件本体，注意它是个协程，必须 `await`。返回的列表里每个元素都是 LangChain 工具对象，`.name`、`.description`、`.args_schema` 都能直接访问。

最后是易错点也是铁律：`agent.ainvoke` 写在 `async with` 里面。连接必须活到图跑完，出了这个块，子进程没了，工具就成了空壳。原理在坑 1 里展开。

::: tip 规范版本
本周[首页](/week18/)提醒过：MCP 规范 2026-07-28 版已转向无状态协议，initialize 握手在新规范里移除。但你 pip 装到的官方 Python SDK 和 langchain-mcp-adapters 目前仍沿用 initialize 流程，跟着本文走即可，规范落地到 SDK 是渐进的，以装到的版本为准。
:::

### 3. 运行验证：在日志里看清 MCP 调用链

跑通不看结果，看链路。把最后一步的打印换成遍历整个消息列表：

```python
for msg in result["messages"]:
    msg.pretty_print()
```

输出大致长这样（示意，具体格式随版本略有差异）：

```
================================[1] HumanMessage================================
帮我查一下订单 A-001 的状态
=================================[1] AiMessage=================================
Tool Calls:
  get_order_status (call_ab12...)
 Call ID: call_ab12...
  Args:
    {'orderId': 'A-001'}
================================[1] ToolMessage=================================
订单 A-001：已发货，预计 9 月 19 日送达
=================================[1] AiMessage=================================
订单 A-001 已发货，预计 9 月 19 日送达。
```

对着日志数一数这条链有几跳：用户提问，模型读说明书决定调 `get_order_status`，ReAct 图里的 ToolNode 执行这个工具，工具内部把调用转成 `session.call_tool("get_order_status", {"orderId": "A-001"})`，经 stdio 流写进 Server 子进程，Server 里的函数查到结果原路送回，ToolMessage 落进消息列表，模型读到结果组织成自然语言。你没有写过一行调度代码，工具的选择、参数的填法全是 Agent 自主的。看清楚这一点，「把工具喂给 Agent」这句话就从比喻变成了事实。

### 4. 多 Server 集成：N+M 生态此时真实可感

一个 Agent 通常不止吃一个 Server。客服 Agent 既查订单又查知识库，就是订单 Server 加知识库 Server。adapters 提供了 `MultiServerMCPClient`，把「拉起多个子进程、各建各的会话」打包成一次声明：

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

async with MultiServerMCPClient(
    {
        "order": {  # Day 2 的订单 Server
            "transport": "stdio",
            "command": "python",
            "args": ["order_server.py"],
        },
        "kb": {  # 知识库 Server，今天先拿同款文件占位感受一下
            "transport": "stdio",
            "command": "python",
            "args": ["kb_server.py"],
        },
    }
) as client:
    tools = client.get_tools()  # 两个 Server 的工具合并成一个列表
    print([t.name for t in tools])  # ['get_order_status', 'search_kb', ...]
    agent = create_react_agent(llm, tools)
    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "订单 A-001 什么状态？退货政策是什么？"}]}
    )
```

`get_tools()` 返回的是合并后的列表，2 加 3 共 5 个工具一起 bind 给模型，Agent 按问题自己分头去调。数一数改动量：换一个配置字典，Agent 代码零改动。MCP 拼的是 N 个 Server、M 个 Agent 的网络，任何人写的 Server 你一行配置就能接入，这个 N+M 此刻不再是个口号。传输方式也不限于 stdio，远程 Server 换 `streamable_http` transport，Agent 侧照样不动。

## 动手任务：`mcp_client_demo.py` 一步一步

手册任务：让 LangGraph Agent 通过 MCP Client 调用 Day 2 的工具。拆成 5 步，全程约 25 分钟。

**第 1 步：备好环境和 Server。** 在练习目录执行 `pip install langchain-mcp-adapters mcp langgraph langchain-openai`，把 Day 2 的 `order_server.py` 放到同目录。先单独验证它：`python order_server.py` 能启动不报错（stdio Server 通常静默等待输入，不报错就是好消息），Ctrl+C 退出。

**第 2 步：建文件，写连接参数。** 新建 `mcp_client_demo.py`，把 import 和 `StdioServerParameters` 抄进来。注意 `args` 里的相对路径以你运行脚本的目录为基准，拿不准就写绝对路径；虚拟环境里最稳的做法是 command 直接填该环境 python 解释器的绝对路径。

**第 3 步：搭退出栈和会话。** 抄 `main()` 的骨架：`AsyncExitStack`、两次 `enter_async_context`、`session.initialize()`。此时先在后面补一句 `print(await session.list_tools())` 跑一遍，亲眼确认子进程拉起来了、工具清单拿回来了，再删掉这句。分两段验证，出错时你知道错在哪一半。

**第 4 步：翻译并组装 Agent。** 加上 `load_mcp_tools`、`create_react_agent` 和 `ainvoke`，打印 `result["messages"][-1].content`。到这里就是核心知识第 2 节的完整代码。

**第 5 步：换遍历打印，看完整链路。** 把打印换成 `for msg in result["messages"]: msg.pretty_print()`，再问一个工具答不了的问题（比如「你好」）对比：这次日志里没有 ToolMessage，模型直接回答。两种日志各看一遍，你就知道 Agent 什么时候走 MCP、什么时候不走。

::: tip 自查标准
跑通的标准不是最后一句回答正确，而是你能对着日志说出：模型为什么选这个工具、参数从哪来、ToolMessage 的内容经历了哪几跳才回到模型嘴里。说不全就回到核心知识第 3 节再数一遍。
:::

## 常见踩坑

**坑 1：连接在图运行前就关了。** 新手第一大坑，症状极具迷惑性：工具清单打印得好好的，Agent 一调工具就报连接关闭之类的错。看反面教材：

```python
async def load_tools():
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await load_mcp_tools(session)  # 出了 with，子进程被回收

tools = asyncio.run(load_tools())  # 拿到了工具，连接已经死了
agent = create_react_agent(llm, tools)
asyncio.run(agent.ainvoke(...))    # 清单在，肉身没了，一调用就炸
```

`load_mcp_tools` 转出来的工具不复制工具本体，只持有「回 Server 调用」的引用，连接一断引用就悬空。规则一句话：图在跑，连接就得活着，`ainvoke` 必须在 `async with` 或退出栈的作用域内执行。

**坑 2：把 `StdioServerParameters` 当成「连已启动的 Server」。** 它的语义是「帮我拉起子进程」。你在别的终端开着一个 Server 再跑 Client，连的也不是它，而是新拉的一个，stdio 模式一对一，互不干扰。由此带来三个推论：command 必须是当前环境里敲得动的命令；相对路径按运行目录解析；虚拟环境的包装在哪个解释器上，command 就得指向哪个解释器。排查这类问题最快的办法是把 command 和 args 拼成一行，自己在终端敲一遍。

**坑 3：握手和 await 的顺序纪律。** `load_mcp_tools` 必须排在 `session.initialize()` 之后，没握手就拉清单，行为未定义。另一类低级但高发的错是漏 `await`：`tools = load_mcp_tools(session)` 拿到的是协程对象而不是工具列表，报错信息往往指到很远的下游，很难第一时间联想到这里。异步代码里见到可疑的「对象不能这样用」，先检查 await。

**坑 4：高估 MCP 工具的特殊性。** 有人接完 MCP 工具，觉得它金贵，给图单独开分支、单独写调用逻辑。完全不必：翻译产物就是普通 LangChain 工具，第 12 周的 ToolNode、第 13 周的审批和校验那一套，对 MCP 工具原样生效，一行不用改。本周 Day 5 给 MCP 调用加安全护栏，用的也还是这条老路。

**坑 5：多 Server 工具重名。** 订单 Server 和知识库 Server 都提供 `search`，合并 bind 后模型看到的说明书里就有两个同名工具，选哪个全凭运气。命名权握在 Server 作者手里，约定俗成的做法是加前缀：`order_search`、`kb_search`。在 Client 侧过滤或改名都是治标，Server 端起好名才是治本。接入第三方 Server 前先 `print([t.name for t in tools])` 看一眼清单，冲突早发现。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. MCP Client 在集成链路里干了哪几件事？哪一步让「Agent 眼里无差别」成立？

::: details 参考答案
三件事：按 `StdioServerParameters` 拉起 Server 子进程并建立会话（连接）；调 `list_tools` 拿工具清单（发现）；把清单转成 LangChain 工具对象（翻译）。翻译这步是无差别的来源：名字、描述、schema 和手写工具同一格式，模型和 ReAct 图都只认说明书，不认工具的出身。
:::

2. `StdioServerParameters(command, args)` 决定了什么？它和「连接一个已经在跑的 Server」有什么区别？

::: details 参考答案
它决定 Client 以子进程方式拉起哪个 Server：command 加 args 等于终端里启动 Server 的那行命令。区别在于 stdio 模式不连接任何已存在的进程，每个 Client 各拉各的子进程、各走各的标准输入输出，所以 Server 文件路径和解释器路径都必须在参数里写对。
:::

3. 为什么 `agent.ainvoke` 必须写在 `AsyncExitStack` 的 `async with` 里面？

::: details 参考答案
`load_mcp_tools` 产出的工具只是持有指向 Server 会话的引用，本体还在子进程里。`async with` 一退出，栈按后进先出关闭会话、回收子进程，引用悬空，之后 Agent 每次调工具都会失败。所以连接的存活期必须覆盖图的整个运行期，ainvoke 就得留在作用域内。
:::

4. 第 12 周的 `@tool` 和今天的 `load_mcp_tools`，工具说明书分别从哪里来？

::: details 参考答案
`@tool` 就地读本地函数：函数名即工具名，docstring 即描述，类型注解即参数 schema。`load_mcp_tools` 从远端拿：Server 端定义工具时已经备好了这三样，Client 通过 `list_tools` 拉回清单再转格式。来源一近一远，产物同种，这是 Agent 侧代码不用改的根本原因。
:::

5. 同时接两个 Server 时工具重名怎么办？在哪一层解决最合适？

::: details 参考答案
合并 bind 前先打印工具名清单检查冲突。根治在 Server 端：给工具名加领域前缀（`order_search`、`kb_search`），因为命名权在 Server 作者手里，说明书也是它出的。Client 侧过滤或改名只是补救，多 Client 接入时每个都要补一遍。
:::

## 延伸阅读

- [langchain-mcp-adapters](https://github.com/langchain-ai/langchain-mcp-adapters)，本篇主角的仓库，README 里有多 Server、HTTP transport 的完整示例，值得对照今天的手写版看一遍
- [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk)，`ClientSession`、`StdioServerParameters`、stdio_client 的权威文档，Day 2 用的是它的 Server 侧，今天用的是 Client 侧
- [MCP 官方规范](https://modelcontextprotocol.io/specification)，协议本身的设计文档，配合本周 Day 1 的架构图读，很多 API 名字的设计动机都在里面

今天的 `mcp_client_demo.py` 留好，Day 4 会把知识库文档作为 MCP Resource 暴露，Agent 获取数据的方式将从「调工具」扩展到「读资源」，Client 这套连接管理代码直接复用。
