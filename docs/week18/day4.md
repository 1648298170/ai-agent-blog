# 第 18 周 · Day 4：MCP Resources——把数据源标准化暴露

> 对应手册任务：学习「MCP Resources：暴露数据源」，动手「把知识库文档作为 MCP Resource 暴露，Agent 可读取」，当日产出「Resource 集成」。本篇只解决一个问题：Day 2/3 的 Tools 解决了「让模型动手」，没解决「让模型看见」——数据要么硬塞 prompt，要么背上 RAG 的重资产，要么错位成 Tool 浪费轮次。Resources 给数据第三条路：每个数据源一个 URI、一份标准清单，谁需要谁读取。今天把第 14 周的知识库文档挂上地址，让 Agent 自己决定读哪份。

## 今日目标

1. 说得清 Resource 和 Tool 的边界：副作用判据一锤定音，查订单是 Resource、退款是 Tool，不再犹豫
2. 掌握三个实现点：`@mcp.resource` 与 URI scheme、`{doc_name}` 动态模板一码多文档、`resources/list` 的发现机制
3. 独立完成知识库 Resource Server，在 Inspector 里亲眼看一次资源清单，并把读取包成工具，让 Agent 自主决定读不读、读哪份

## 概念讲解：数据为什么需要自己的原语

Day 2 给订单 Server 挂了 `get_order_status`，Day 3 让 LangGraph 调通了它，模型会「做事」了。但 Agent 还有另一类需求没着落：看数据。客服 Agent 答题前要翻知识库，运维 Agent 下判断前要看配置和日志。这些数据怎么给到模型，你手里目前有三条路，条条有毛病。

第一条，写进 system prompt。最直接，也最僵硬：不管这轮对话用不用得上，每条请求都背着全部文档跑，token 按最贵的交；文档一更新就得改代码重新部署。

第二条，走 RAG。第 14 周学的整套流程，检索相关的几段塞进上下文。适合海量文档，但前置资产不轻：解析、切块、Embedding、pgvector 一个不能少。更关键的是，检索什么、塞多少，全由应用写死，模型没有发言权——它甚至不知道自己没看到什么。

第三条，做成 Tool。能跑，但 Day 1 坑 3 已经点名这是错位：只读查询让模型每轮「决定」一次调不调，白白消耗工具轮次，还把数据和动作搅在一起，权限没法分开管。

Resources 是第四条路：数据不塞、不嵌、不执行，而是挂在 URI 上，配一份清单协议。知识库的每篇文档变成 `knowledge://docs/rag-overview` 这样的地址，客户端先拉清单看有什么，再按地址取正文。数据从「prompt 的一部分」变成「有名字、可发现、按需读取的独立资源」，这就是「把数据源标准化暴露」的意思。

## 核心知识

本节的代码块是独立片段，完整可跑版本以动手任务为准。

### 1. Resource vs Tool：副作用判据一锤定音

Day 2 的 `get_order_status` 其实踩在边界上。一个能力该做成哪个原语，只问一句话：**执行之后，外部世界的状态变了吗？**

| 能力 | 执行后世界变了？ | 原语 |
| --- | --- | --- |
| 查知识库文档 | 没变，读十遍还是那些字 | Resource |
| 查订单状态 | 没变，订单一个字节没动 | Resource |
| 申请退款 | 变了，资金和订单状态都动了 | Tool |
| 重启服务 | 变了 | Tool |

「查订单为什么也是 Resource」——很多人凭直觉觉得它连着业务系统，该是 Tool。错。「查」字不决定原语，改不改世界才决定。退款之后数据库不一样了，可能还要通知支付网关，这是动作；查询是无痕的只读操作，语义上就是一次 GET。所以严格按判据，`get_order_status` 更正统的暴露方式是 Resource（比如模板 `order://status/{order_id}`），Day 2 拿它练 Tool 是取一个最小例子，实践中大量 Server 也这么干，不算错——但两条线的权限模型完全不同：Tool 要确认、要审计，Resource 可以放心缓存，这条边界你必须心里有数。

再补一刀防抬杠：副作用看的是外部世界，不是「模型上下文变长了」。任何操作都会往对话里添内容，那不算副作用，否则天下没有纯的只读。

### 2. Resource 三件套：URI、内容、清单

每个 Resource 两样必备：URI（唯一地址，scheme 自己定，避开 `file://`、`http://` 这些既有约定就好）和内容（文本或二进制，带 MIME 类型）。发现靠两条协议方法：`resources/list` 列静态资源，`resources/templates/list` 列模板。读取一条：`resources/read`，传 URI 得内容。整个语义就是 HTTP 的只读子集。

静态和模板的区别看 URI 里有没有 `{}`。`knowledge://docs/index` 是静态资源，一个地址一份内容；`knowledge://docs/{doc_name}` 是模板，地址里的占位符按次填充，一个定义服务一族地址，这就是「一码多文档」。

### 3. Agent 侧消费：包成工具，把选择权交给模型

Day 1 的原语表里写了 Resources 的触发方是「应用代码控制」。这是规范原生模式：应用组装 prompt 时决定读哪个资源塞进去。但还有第二条路：把「读资源」包成一个普通 Tool 暴露给模型，读不读、读哪份、什么时候读，模型自己判断。两条路就是推和拉：

| 维度 | RAG（推模式） | Resource（拉模式） |
| --- | --- | --- |
| 谁决定给模型什么 | 应用与检索算法 | 模型自己 |
| 数据进入上下文的时机 | 请求前自动嵌入 | 模型判断需要时主动取 |
| token 成本 | 每次都花，不管用不用 | 按需花 |
| 前置设施 | 解析 / 切块 / Embedding / 向量库 | 现成的文件或数据库 |
| 擅长 | 海量文档、模糊语义匹配 | 少量文档、精确按名引用 |

选型一句话：几十篇文档、名字说得清，拉模式便宜直接；成千上万篇、问题本身是模糊的（「哪几段讲了退款时效」），推模式才是正解。两者还能叠加：RAG 粗筛出文档名，Resource 把选中的全文按需拉进来。

### 4. 版本红线：Roots 和 Sampling 别再学

老教程的 Resources 章节几乎必带两个「配套概念」：Roots（客户端把自己文件系统的目录暴露给 Server）和 Sampling（Server 反向借用客户端的模型做生成）。2026-07-28 版规范已把两者连同 Logging 一起列入废弃清单，时间线见[本周 Day 1](/week18/)。今天全程用不到它们，遇到拿它们当核心机制的教程，直接按旧版处理。

## 动手任务：把第 14 周知识库挂上 URI

手册任务：把知识库文档作为 MCP Resource 暴露，Agent 可读取。拆成 5 步，全程约 30 分钟，产出两个文件：`knowledge_server.py` 与 `agent_client.py`。

**第 1 步：备料。** 建目录 `week18-day4/`，里面再建 `knowledge/`，把第 14 周练习产出的几篇 Markdown 笔记拷进去。手头没有就现写两篇占位，文件名一律用英文：

```markdown
<!-- knowledge/chunking-notes.md -->
# 切块策略笔记
固定长度切块实现最简单，边界常切断句子；递归切块优先按段落、再按句子回退，检索质量更好。
```

```markdown
<!-- knowledge/vector-search-notes.md -->
# 向量检索笔记
pgvector 建表时给 embedding 列声明向量维度；查询用余弦距离排序，LIMIT k 取最相似的 Top-K。
```

**第 2 步：写 Server。** 先 `pip install "mcp[cli]"`，然后新建 `knowledge_server.py`：

```python
import re
from pathlib import Path

from mcp.server.fastmcp import FastMCP

KNOWLEDGE_DIR = Path(__file__).parent / "knowledge"

mcp = FastMCP("knowledge-base")


@mcp.resource("knowledge://docs/index")
def list_docs() -> str:
    """知识库目录：列出所有可读文档"""
    names = sorted(p.stem for p in KNOWLEDGE_DIR.glob("*.md"))
    return "\n".join(f"- {n}" for n in names)


@mcp.resource("knowledge://docs/{doc_name}")
def get_doc(doc_name: str) -> str:
    """按名称读取一篇知识库文档（Markdown 全文）"""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", doc_name):
        raise ValueError(f"非法文档名：{doc_name}")
    path = KNOWLEDGE_DIR / f"{doc_name}.md"
    if not path.is_file():
        raise ValueError(f"文档不存在：{doc_name}")
    return path.read_text(encoding="utf-8")


if __name__ == "__main__":
    mcp.run(transport="stdio")
```

关键在装饰器里的 URI：不带 `{}` 的 `index` 是静态资源，带 `{doc_name}` 的是模板，FastMCP 自动把函数参数绑定成模板变量。客户端读 `knowledge://docs/chunking-notes` 时，FastMCP 抽出 `chunking-notes` 作为参数调用函数返回正文。正则那三行是底线校验，防止 `doc_name` 里塞 `../` 去读目录外的文件——Resource 是只读的，但只读不等于可以乱读。

**第 3 步：Inspector 验证。** 执行：

```bash
npx @modelcontextprotocol/inspector python knowledge_server.py
```

浏览器打开它给出的地址，左侧 Connect，切到 Resources 页签。List Resources 能看到 `knowledge://docs/index`；下方的 Resource Templates 列着 `knowledge://docs/{doc_name}`，点开填一个 `doc_name`（比如 `chunking-notes`）再点 Read，右侧就是文档全文。这一眼很关键：你的数据现在有了标准化的地址和清单，任何 MCP 客户端不写一行胶水代码就能发现并读取它。

顺带解开一个高频疑问：为什么资源列表里看不到每篇文档？因为它们由模板定义，走的是 `resources/templates/list`，静态清单里只有 index。这是刻意设计——目录用一个静态资源当，正文一族交给模板管，下一步的 Agent 就靠这个目录找文档。

**第 4 步：Agent 侧包工具。** 新建 `agent_client.py`：

```python
import asyncio

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from langchain_core.tools import tool

SERVER = StdioServerParameters(command="python", args=["knowledge_server.py"])


@tool
async def list_knowledge_docs() -> str:
    """列出知识库中所有可读的文档名，返回目录"""
    async with stdio_client(SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            result = await session.read_resource("knowledge://docs/index")
            return result.contents[0].text


@tool
async def read_knowledge_doc(doc_name: str) -> str:
    """按文档名读取知识库文档全文。不确定有哪些文档时，先调用 list_knowledge_docs。"""
    async with stdio_client(SERVER) as (read, write):
        async with ClientSession(read, write) as session:
            result = await session.read_resource(f"knowledge://docs/{doc_name}")
            return result.contents[0].text
```

两个 `@tool` 都是薄包装，内部就是 MCP ClientSession 的 `read_resource` 调用。`read_knowledge_doc` 的描述里特意写了「先调用 list_knowledge_docs」——工具描述就是模型的说明书，这句提示能明显减少它瞎猜文档名。连接管理上，示例为了聚焦每次新起一条 stdio 连接；生产里应复用一条长连接，别为每次工具调用都付一次进程启动的开销。

**第 5 步：让模型自己决定读什么。** 在 `agent_client.py` 末尾追加：

```python
async def main():
    from langchain_openai import ChatOpenAI
    from langgraph.prebuilt import create_react_agent

    llm = ChatOpenAI(model="gpt-4o-mini")
    agent = create_react_agent(llm, [list_knowledge_docs, read_knowledge_doc])

    result = await agent.ainvoke(
        {"messages": [{"role": "user", "content": "知识库里有哪些笔记？把切块那篇读一下，给我总结两句。"}]}
    )
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
```

运行 `python agent_client.py`，观察输出里的工具调用轨迹：模型先调 `list_knowledge_docs` 看目录，再调 `read_knowledge_doc` 取正文，最后才作答。没有一行代码告诉它「先查目录再读文档」，这条决策链是它看着两个工具的描述自己排出来的。这就是拉模式和 RAG 最大的不同：应用只提供「能读」，读不读、读哪份，模型现场判断。

::: tip 跑不起来的排查
单独跑 `python knowledge_server.py` 应该静默等待，stdio 模式不打印任何东西，属正常。Inspector 连不上，先确认本机 Python 命令名（Windows 下可能是 `py`）。Agent 报 Resource not found，多半是 `doc_name` 和文件名对不上——模板按 `{doc_name}.md` 找文件，少个横杠都算另一个名字。
:::

## 常见踩坑

**坑 1：拿「是不是查询」当判据。** 查文档、查订单、查报表全是 Resource；创建订单、退款、发邮件全是 Tool。判据只有一个：执行后外部世界变没变。凡是「执行两次结果一样、不留任何痕迹」的，都是 Resource 候选。别看动词，看后果。

**坑 2：模板资源在资源列表里找不到。** `resources/list` 只列静态资源，模板走 `resources/templates/list`，FastMCP 按 URI 里有没有 `{}` 自动归类。如果你的资源「消失」了，先确认自己看的是哪份清单。配套的最佳实践：给每个模板配一个静态 index 资源当目录，客户端和模型都不用瞎猜。

**坑 3：URI 参数不校验，目录穿越随便进。** `{doc_name}` 会原样拼进路径，传 `../config` 就能摸到 `knowledge/` 之外的文件。Resource 只读，不代表只读就安全——服务器上的配置文件、密钥文件也「只读」。示例里那三行正则白名单是底线，正式项目再叠加路径 resolve 后校验父目录。

**坑 4：拿拉模式硬扛海量文档。** 拉模式的前提是「目录看得过来」：几十篇、名字自解释，模型 list 一眼就能挑。文档上了千篇，目录本身就撑爆上下文，模型挑文档的准确率也靠不住，这时回 RAG。两条路的分界不是信仰，是文档数量和问题形态。

**坑 5：顺着老教程去学 Roots/Sampling。** 这两个概念在旧教程里和 Resources 形影不离，但 2026-07-28 规范已将它们列入废弃清单。今天用不到，本周后面的安全护栏也用不到。判断教程新旧，先翻它讲不讲 `initialize` 握手，时间线见[本周 Day 1](/week18/)。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 「查订单状态」和「申请退款」分别该做成什么原语？判据是什么？

::: details 参考答案
查订单是 Resource，退款是 Tool。判据是副作用：执行后外部世界状态是否被改变。查询无痕且幂等，退款会让资金和订单状态实际变化。注意副作用看外部世界，不看模型上下文有没有新增内容，否则没有操作是纯只读。
:::

2. 用 `@mcp.resource("knowledge://docs/{doc_name}")` 定义的资源，为什么在 Inspector 的资源列表里看不到？去哪找？

::: details 参考答案
URI 带 `{}` 的是模板资源，走 `resources/templates/list` 通道，静态资源清单 `resources/list` 不包含它。Inspector 里在 Resources 页签的 Resource Templates 分组，填入参数后可以试读。这也是为什么给模板配一个静态 index 目录资源是常见做法。
:::

3. 把 `read_resource` 包成 Tool 之后，Day 1 说的「Resources 由应用控制」还算数吗？

::: details 参考答案
规范原生模式确实是应用控制（推），包成工具后决定权移交给模型（拉）。这是实践中的常见折衷，不违反协议——协议管的是 Server 怎么暴露数据，不管 Host 怎么消费。要害是想清楚推拉各自的适用面：海量模糊检索用 RAG 推，少量精确引用让模型拉，两者可叠加。
:::

4. RAG 和 Resource 拉模式各适合什么场景？各举一个例子。

::: details 参考答案
RAG 适合海量文档加模糊语义问题，比如「哪几段讨论了退款时效」，上千篇 Wiki 里找相关段落；拉模式适合少量文档加按名精确引用，比如十几篇产品文档里的「把《计费说明》读给我」。前者检索器决定给什么，后者模型自己挑。
:::

5. `knowledge://docs/{doc_name}` 里的 `{doc_name}`，值由谁在什么时候填？

::: details 参考答案
客户端在 `resources/read` 时把完整 URI（如 `knowledge://docs/chunking-notes`）发给 Server，FastMCP 解析模板、抽出 `chunking-notes` 作为参数调用函数。模板定义在 Server，填参发生在客户端的读取请求里，一个函数服务一族地址。
:::

## 延伸阅读

- [MCP 官方文档：Resources 概念](https://modelcontextprotocol.io/docs/concepts/resources)，Resource 与模板的协议语义原始出处，静态/动态资源、MIME 类型、发现机制都在这一页
- [MCP Python SDK（含 FastMCP）](https://github.com/modelcontextprotocol/python-sdk)，今天 `@mcp.resource` 装饰器的实现库，README 里的资源示例可与本文对照
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)，调试所有 MCP Server 的标配工具，第 3 步全靠它，本周后面几天还会反复用

今天的 `knowledge_server.py` 和 `agent_client.py` 留好，[本周 Day 5](/week18/) 要给工具调用链加输入校验和 PII 脱敏，`read_knowledge_doc` 这种「参数直拼 URI」的入口正是第一个要上护栏的地方。
