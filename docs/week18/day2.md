# 第 18 周 · Day 2：第一个 MCP Server——用官方 SDK 暴露一个 Tool

> 对应手册任务：学习「MCP Server 实现：暴露一个 Tool」，动手「用 MCP SDK 写一个 `get_order_status(order_id)` 工具，再补一个 `create_refund`」，当日产出「一个可运行、可用官方 Inspector 调通的 MCP Server（`order_service.py`）」。本篇只解决一个问题：昨天画在架构图右侧的订单 Server，今天用几十行 Python 真正落地。协议层的一切——JSON-RPC 编解码、工具清单下发、2026-07-28 无状态规范的头部路由——官方 SDK 全部封装，你只管把业务能力写成普通函数。

## 今日目标

1. 说得清 `@mcp.tool()` 装饰器做了什么：docstring 和类型注解如何自动变成模型可读的 schema
2. 掌握三个操作：用 FastMCP 起一个 Server、stdio 与 streamable-http 两种方式跑起来、用 MCP Inspector 手动调用工具
3. 独立完成 `order_service.py`：`get_order_status` 查第 4/10 周那个 PG 库，`create_refund` 作为明天审批环节的伏笔，两个工具都在 Inspector 里调通

## 概念讲解：为什么几行代码就是一个 Server

先想一个问题：不用 SDK，裸写一个 MCP Server 要做多少事？你得监听传输通道、解码 JSON-RPC 消息、分发请求、把工具清单和参数 schema 按协议格式下发，还得踩昨天坑 4 说的那些版本坑——规范 2026-07-28 无状态化之后，会话握手没了，改成 `Mcp-Method` 这类头部路由，细节全埋在协议文本里。这些活和你的业务没有半点关系，但每一样都躲不开。

官方 SDK 的价值就在这：`pip install "mcp[cli]"` 装好，上面所有事都归它管。你写的只是一个普通 Python 函数，加一个装饰器声明「这是工具」。SDK 读函数签名，把类型注解转成 JSON Schema，把 docstring 转成工具描述，Client 连上来时自动下发。模型在决定调不调、怎么传参之前，读的就是这两样东西。

这个体验你其实熟悉。第 12 周写 `@tool` 时就是这样：函数加 docstring，框架生成 schema，模型照着调用。今天只是把同一套声明式玩法换个库：装饰器从 `@tool` 换成 `@mcp.tool()`，声明的还是那三件套——名字、描述、参数 schema。声明式之美是跨库通用的：你声明「是什么」，框架负责「怎么暴露」。

还有一个昨天留下的疑问今天必须了结。Day 1 坑 3 说「只读数据做成 Resources」，订单状态查询是只读的，凭什么做成 Tool？因为判断标准不是「读还是写」，而是「谁决定这次调用、参数从哪来」。知识库文档是静态数据，应用代码什么时候要、拿来干什么都清楚，归 Resources；订单状态查询的参数是「哪个订单」，这个信息只存在于对话里——用户刚说了「帮我看看 ORD-1001」，只有模型能把它挖出来填进去，所以必须由模型触发，就是 Tool。

## 核心知识

本节的代码块都是独立示例，可以直接跑。最终完整文件以下面的动手任务为准。

### 1. FastMCP 起步：装饰器即声明

```python
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("demo")

@mcp.tool()
def add(a: int, b: int) -> int:
    """两数相加，返回整数和"""
    return a + b

if __name__ == "__main__":
    mcp.run()  # 默认 stdio 传输
```

五行实现、五行声明，一个合法的 MCP Server 就有了。关键一行是 `@mcp.tool()`：SDK 拿到函数后做两件事——把 docstring「两数相加，返回整数和」作为工具描述，把 `a: int, b: int` 解析成参数 schema（`a` 是 integer、必填，`b` 同理）。Client 连上来列工具时，这两样一字不少地下发，模型照着决定怎么调。

返回值类型建议永远标 `str`。MCP 工具结果对模型来说就是文本，结构化数据先 `json.dumps` 再返回，比返回裸 dict 或 ORM 对象稳得多，原因在坑 3 展开。参数名用 Python 惯例的 snake_case 就好，schema 会原样保留参数名，模型看到的就是 `order_id`。

### 2. 传输：stdio 本地跑，streamable-http 上网

`mcp.run()` 怎么跑，取决于谁来连你：

```python
mcp.run()                    # stdio：Host 把这个脚本当子进程拉起，
                             # 通过 stdin/stdout 管道收发协议消息
mcp.run("streamable-http")   # HTTP 服务：监听网络端口，路径默认 /mcp
```

stdio 的机制：Host（你的 Agent 程序或 Inspector）把 `python order_service.py` 作为子进程启动，往它的 stdin 写请求，从 stdout 读响应。零部署、零端口，适合本地开发和一个 Host 独占的场景。streamable-http 则把 Server 跑成常驻网络服务，地址形如 `http://127.0.0.1:8000/mcp`，跨机器、多消费方共享时用它。选型还是 Day 1 那句话：同机 stdio，跨网 Streamable HTTP。HTTP 只有这一个选项，老的 HTTP+SSE 已废弃，旧教程里见到直接换掉。

### 3. 与 REST API 的对比：给谁消费

写到这里你可能觉得：这不就是把 REST 接口换了个写法？差得远，两张脸面向两种消费者：

| 维度 | MCP Server | REST API |
| --- | --- | --- |
| 消费者 | 模型，程序自动读 schema | 程序员，人读文档 |
| 接口描述 | JSON Schema 自动生成，连接即下发 | OpenAPI 文档单独维护，靠人阅读 |
| 发现方式 | Client 连上就列出全部工具 | 开发者查文档，手写调用代码 |
| 参数从哪来 | 模型根据对话现场决定 | 开发者提前写死在代码里 |

一句话：REST 是给人看的 API，文档写得再好也要程序员读完再翻译成代码；MCP 是给模型看的 API，schema 连着描述一起塞给模型，它当场就知道有什么能力、怎么传参。这是定位差异，不是替代关系——MCP Server 内部该查库查库、该调 REST 调 REST，只是把「对外的那张脸」从人类文档换成机器 schema。你的订单服务完全可以两边并存：REST 继续伺候 App 前端，MCP 伺候 Agent。

## 动手任务：`order_service.py` 一步一步

手册任务：写一个查订单状态的 MCP 工具，再补一个退款工具。拆成 5 步，全程约 35 分钟。

**第 1 步：备环境、建表。** 装依赖：

```bash
pip install "mcp[cli]" sqlalchemy "psycopg[binary]"
```

PG 用第 4 周 docker compose 起的那台，psql 连进 `agent_db`（第 4 周的老办法，docker compose exec 或本机 psql 都行），建两张表塞三条数据：

```sql
CREATE TABLE IF NOT EXISTS orders (
  order_id   TEXT PRIMARY KEY,
  status     TEXT NOT NULL,          -- paid / shipped / delivered / refunded
  amount     NUMERIC(10, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refunds (
  refund_id  SERIAL PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(order_id),
  amount     NUMERIC(10, 2) NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO orders (order_id, status, amount) VALUES
  ('ORD-1001', 'paid', 199.00),
  ('ORD-1002', 'shipped', 89.50),
  ('ORD-1003', 'delivered', 1299.00);
```

**第 2 步：起骨架，写 `get_order_status`。** 新建 `order_service.py`，这就是当日产出文件，后面每步往里加：

```python
import json

from sqlalchemy import create_engine, text
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("order-service")

# 复用第 10 周的连接串
engine = create_engine("postgresql+psycopg://jerry:dev123456@localhost:5432/agent_db")


@mcp.tool()
def get_order_status(order_id: str) -> str:
    """按订单号查询订单状态、金额与下单时间。

    Args:
        order_id: 订单编号，格式如 ORD-1001
    """
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT order_id, status, amount, created_at FROM orders WHERE order_id = :oid"),
            {"oid": order_id},
        ).mappings().fetchone()

    if row is None:
        return json.dumps({"found": False, "order_id": order_id}, ensure_ascii=False)
    return json.dumps({"found": True, **row}, ensure_ascii=False, default=str)
```

关键在两处。docstring 第一行是给模型的功能说明，Args 段逐个解释参数——模型传参靠它，写得越准传得越对。查不到时返回 `{"found": false}` 而不是抛异常，模型读得懂这个结构，会转告用户「查无此单」。`default=str` 是给 `Decimal` 和时间戳兜底的，坑 3 展开。

**第 3 步：补一个高危工具 `create_refund`。** 光查不够，再给模型一个能改世界的能力，明天审批环节的主角就是它：

```python
@mcp.tool()
def create_refund(order_id: str, reason: str) -> str:
    """为订单创建退款申请。高危操作：会写入真实退款单，金额取订单实付金额。

    Args:
        order_id: 要退款的订单编号
        reason: 退款原因，会原样写入退款单，请如实概括
    """
    with engine.begin() as conn:
        order = conn.execute(
            text("SELECT status, amount FROM orders WHERE order_id = :oid"),
            {"oid": order_id},
        ).mappings().fetchone()
        if order is None:
            return json.dumps({"ok": False, "error": "订单不存在"}, ensure_ascii=False)
        if order["status"] not in ("paid", "shipped"):
            return json.dumps({"ok": False, "error": f"状态 {order['status']} 不可退款"}, ensure_ascii=False)

        refund = conn.execute(
            text("INSERT INTO refunds (order_id, amount, reason) VALUES (:oid, :amt, :r) RETURNING refund_id"),
            {"oid": order_id, "amt": order["amount"], "r": reason},
        ).mappings().fetchone()

    return json.dumps({"ok": True, "refund_id": refund["refund_id"], "amount": str(order["amount"])}, ensure_ascii=False)
```

注意 docstring 第一句就写「高危操作」。这不是写给人的注释，是写给模型的警告，它会影响模型调用前的谨慎程度和向用户确认的倾向。最后在文件末尾加启动代码：

```python
if __name__ == "__main__":
    mcp.run()  # 先用 stdio，第 5 步再切 HTTP
```

**第 4 步：用 Inspector 手动调通。** 别急着接 Agent，先跑官方调试器：

```bash
npx @modelcontextprotocol/inspector
```

浏览器会自动打开 Inspector 界面。Transport Type 选 STDIO，Command 填 `python`，Arguments 填 `order_service.py`，点 Connect。左侧切到 Tools，点 List Tools，应该能看到 `get_order_status` 和 `create_refund`，描述和参数 schema 都在。选中 `get_order_status`，`order_id` 填 `ORD-1001`，Run Tool，下方返回 `{"found": true, "status": "paid", ...}`。再拿 `ORD-9999` 调一次，看 `found` 变成 `false`。最后调一次 `create_refund`，回 psql 里 `SELECT * FROM refunds`，确认退款单真写进去了。

「先 Inspector 后 Agent」是本周的调试纪律：Inspector 帮你确认协议层通没通、schema 长什么样、边界参数返回什么。这层干净了，明天接 Agent 再出问题，嫌疑就只剩模型侧一个，排查范围小一半。

**第 5 步：切 streamable-http 再跑一遍。** 把启动代码换成：

```python
if __name__ == "__main__":
    mcp.run("streamable-http")  # http://127.0.0.1:8000/mcp
```

重新运行脚本，它现在是个常驻 HTTP 服务。Inspector 重开，Transport Type 选 Streamable HTTP，URL 填 `http://127.0.0.1:8000/mcp`，Connect，重复第 4 步的调用。想换端口或只监听本机，构造时传参：`FastMCP("order-service", host="127.0.0.1", port=9000)`。两种方式都跑通，选型就有了体感：本地开发、单 Host，stdio 什么都不用配；Server 要部署到测试机、给多个 Agent 共用，streamable-http 是唯一正解。

::: tip 环境小抄
装的是 `mcp[cli]` 时，`mcp dev order_service.py` 也能直接拉起 Inspector，效果和 npx 一样。npx 的好处是不挑 Python 环境，团队里谁都能跑。
:::

## 常见踩坑

**坑 1：stdio 模式下用 print 调试。** stdio 传输里 stdout 是协议通道，你 print 一句，协议消息流就脏了，Client 解析直接失败，症状是莫名其妙的连接错误。调试输出一律走 logging，它默认写 stderr，不占协议通道。同理，直接 `python order_service.py` 会看到程序一动不动——别慌，它在等 stdin 里的协议消息，stdio 模式下这是正常行为，想看结果就用 Inspector 连它。

**坑 2：docstring 敷衍。** 「查订单」三个字当描述，模型只能靠猜：要不要传状态？编号什么格式？描述和 Args 写得具体，模型传参就准。判断标准：把 docstring 单独拿给一个没见过你代码的同事，他能不能不问你就正确调用。读者从程序员换成模型，说明书反而要写得更细。

**坑 3：返回 ORM 对象或裸 dict。** 工具返回值最终要序列化成文本给模型读，`Decimal`、`datetime` 这些类型随时让序列化炸掉。最稳的纪律：返回值类型就标 `str`，函数体内 `json.dumps(..., ensure_ascii=False, default=str)`，中文原样输出，特殊类型降级成字符串。模型读 JSON 字符串毫无压力，你也不用和序列化报错搏斗。

**坑 4：把「只读用 Resources」记成教条。** 昨天的话没错，但前提要记全：应用代码主动读的静态数据才归 Resources。参数藏在对话里、必须模型现场决定的查询，哪怕只读也是 Tool，`get_order_status` 就是例子。判断标准永远是「谁决定调用、参数从哪来」，不是「有没有副作用」。

**坑 5：高危工具裸奔。** `create_refund` 今天已经在真实写库了，靠什么拦住模型的一次幻觉？眼下只有两道软防线：docstring 里的高危声明和状态校验。这不够。明天补硬防线——把它接进 Agent 的审批链路，高危调用必须过用户确认。在那之前，这个 Server 只在自己机器上跑，别部署。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. `@mcp.tool()` 从函数的哪两样东西生成工具 schema？分别变成什么？

::: details 参考答案
docstring 和类型注解。docstring 整体（第一行最重要）成为工具描述，Args 段成为参数说明；参数的类型注解被解析成 JSON Schema 的字段类型和必填标记。Client 列工具时这些全部下发，模型调用前读的就是它们，所以质量直接决定模型用得对不对。
:::

2. stdio 和 streamable-http 的通信机制分别是什么？各适合什么场景？

::: details 参考答案
stdio：Host 把 Server 当子进程拉起，用 stdin/stdout 管道收发协议消息，零部署零端口，适合本地开发和同机单 Host。streamable-http：Server 常驻监听网络端口（默认路径 /mcp），适合跨机器部署、多个 Agent 共享。老的 HTTP+SSE 已废弃，不用再选。
:::

3. 为什么工具返回值用 `json.dumps` 后的字符串，而不是直接返回 dict？

::: details 参考答案
工具结果对模型是文本，返回字符串最稳。dict 里常混着 `Decimal`、`datetime` 等不可直接 JSON 序列化的类型，问题会拖到序列化那一刻才炸；在函数体内主动 `json.dumps(..., default=str)`，把序列化时机和兜底策略握在自己手里，返回类型也能如实标注为 `str`。
:::

4. MCP Server 和 REST API 的核心定位差异是什么？为什么不是替代关系？

::: details 参考答案
消费者不同：REST 给程序员消费，人读 OpenAPI 文档再手写调用代码；MCP 给模型消费，schema 和描述随连接自动下发，模型现场决定怎么调。MCP Server 内部照样查库、调 REST，只是对外接口从人类文档换成机器 schema。两边常并存，各自伺候各自的消费者。
:::

5. stdio 模式下为什么不能 print 调试？直接运行脚本为什么挂住不动？

::: details 参考答案
stdout 是 stdio 传输的协议通道，print 会把杂质插进协议消息流，Client 解析失败。调试走 logging（stderr）。直接运行挂住是正常的：Server 在等 stdin 里的协议消息，stdio 模式下它本来就该被 Host 或 Inspector 当子进程拉起，而不是单独运行。
:::

## 延伸阅读

- [MCP 官网](https://modelcontextprotocol.io)，协议与各语言 SDK 文档总入口，概念篇配合[本周 Day 1](/week18/) 对照着看
- [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)，官方 Python SDK 仓库，README 里的 FastMCP 示例是本篇写法的权威出处
- [modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)，Inspector 仓库，除了手动调用工具，还能看协议消息明细，明天排查 Client 问题用得上

今天的 `order_service.py` 和两张表留好。明天写 Client 侧：把这台 Server 接进 Agent 主循环，再给 `create_refund` 加上用户审批，让它从「能调」升级成「敢调」。
