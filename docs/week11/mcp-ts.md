# 主线补篇 · MCP TypeScript SDK：把工具接入升级为标准协议

> 定位：第 18 周把 MCP 的概念模型建完了，落地用的是 Python SDK；本篇给 TS 主线补课——用官方 `@modelcontextprotocol/sdk` 把同一套协议在 TypeScript 侧跑通，从写第一个 Server 开始，终点是把 MCP 工具直接接进[第 11 周 Day 4](/week11/day4) 的 AI SDK 工具循环。只解决一个问题：概念你都懂了，但还没用 TS 写过一个能被 Agent 连上的 MCP Server。

## 概念回顾：只留三句话

三角色：Host 是你的 Agent 程序，Client 是它内嵌的协议连接器（一条连接一个），Server 是工具提供方——「Agent 作为 Client，业务 API 作为 Server」，方向别搞反。三原语：Tools 是模型可调用的函数，Resources 是只读数据源，Prompts 是预置提示模板。完整的概念地图和 N×M 变 N+M 的账，第 18 周 Day 1 画过，模糊了就回去看：[MCP 协议全景](/week18/day1)。那一周是 Python 落地，本篇换语言不换理解，直接兑现。

## 第一个 MCP Server：registerTool + registerResource

先算账：订单查询这个能力，第 18 周前是每个 Agent 手写一份胶水；现在包装一次 MCP Server，公司里所有支持 MCP 的客户端都能连它。TS 侧的原料是 Anthropic 维护的官方 SDK `@modelcontextprotocol/sdk`——名字容易抄错，是 `modelcontextprotocol`，中间没有 `center`。

```bash
mkdir order-mcp && cd order-mcp
npm init -y
npm i @modelcontextprotocol/sdk zod express
npm i -D tsx typescript @types/node @types/express
```

建 `orders.ts`，把业务能力注册成 MCP 的 Tools 和 Resources。注册逻辑单独成文件，因为下一节换传输时还要复用：

```ts
// orders.ts —— 业务能力的 MCP 包装，两种传输共用
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// 假装是数据库；换 PG 就是这里的一次 query，其余代码一个字不用动
const orders: Record<string, { status: string; amount: number; updatedAt: string }> = {
  "A-1024": { status: "已发货", amount: 199, updatedAt: "2026-09-17 09:30" },
  "A-1025": { status: "待支付", amount: 58, updatedAt: "2026-09-17 11:00" },
};

export function buildServer(): McpServer {
  const server = new McpServer({ name: "order-server", version: "0.1.0" });

  // 工具：模型决定调用。inputSchema 用 zod 写，SDK 负责翻译成协议格式
  server.registerTool(
    "get_order_status",
    {
      title: "订单状态查询",
      description: "根据订单号查询订单的当前状态与金额。查不到时返回错误说明。",
      inputSchema: { orderId: z.string().describe("订单号，形如 A-1024") },
    },
    async ({ orderId }) => {
      const order = orders[orderId];
      if (!order) {
        return {
          isError: true,
          content: [{ type: "text", text: `订单 ${orderId} 不存在` }],
        };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ orderId, ...order }) },
        ],
      };
    }
  );

  // 资源：只读数据源，应用代码控制读取时机，不交给模型「执行」
  server.registerResource(
    "orders",
    "orders://all",
    { description: "当前全部订单的只读列表", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(orders, null, 2) }],
    })
  );

  return server;
}
```

对照着看很眼熟：`registerTool` 的三个参数就是第 11 周 Day 4 `tool()` 的三件套——名字与描述、zod schema、execute 函数，只是搬过了进程边界。返回值固定是 `content` 数组，文本结果就放 `type: "text"` 块里，协议靠它跨语言传输。

stdio 传输三行接上：

```ts
// stdio.ts —— 本机形态：Host 把它拉起来当子进程，走标准输入输出
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./orders.js";

const transport = new StdioServerTransport();
await buildServer().connect(transport);
```

一条纪律：stdio 模式下 stdout 是协议通道，`console.log` 会把协议报文打花。调试日志一律走 `console.error`，它占的是 stderr。

不急着写 Client，先用官方调试器验收。MCP Inspector 是个本地 Web UI，连上 Server 就能手动列工具、填参数、点运行：

```bash
npx @modelcontextprotocol/inspector npx tsx stdio.ts
```

打开它提示的 `http://localhost:6274`，左边确认传输是 STDIO，点 Connect；Tools 标签里 List Tools 应该出现 `get_order_status`，填 `orderId: A-1024` 点 Run，右边能看到返回的 JSON 文本。Resources 标签里能翻出 `orders://all`。Server 在没有 Agent 的情况下被完整验收过了，这是 MCP 相比手写胶水最实用的红利：工具方可独立测试。

## Streamable HTTP：让工具服务跨网络

stdio 的隐含前提是 Server 跟 Host 住在同一台机器——Host 拉子进程。可订单 Server 是要给多台机器上的 Agent 连的，部署形态得是网络服务。MCP 当前的标准 HTTP 传输叫 Streamable HTTP（取代了旧的 HTTP+SSE 双通道），SDK 内置了 `StreamableHTTPServerTransport`，拿 Express 挂一个 `/mcp` 路由即可，注册逻辑原样复用：

```ts
// http.ts —— 网络形态：同一个 buildServer，换传输上线
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./orders.js";

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server: McpServer = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // 无状态模式：每请求一套新实例，演示与水平扩展够用
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// 规范定义了这两个方法；无状态模式下直接回 405
app.get("/mcp", (_req, res) => res.status(405).json({ error: "no SSE" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "no session" }));

app.listen(3001, () => console.error("MCP server on http://localhost:3001/mcp"));
```

`npx tsx http.ts` 起服务。同一份业务注册，stdio 与 HTTP 两种形态随意切换——这就是协议分层的价值：`buildServer` 里没有一行代码知道自己跑在哪种传输上。

## MCP Client 接入：listTools、callTool，再进 AI SDK 循环

Server 就绪，回到 Agent 侧。Host 里的 Client 负责连接：连本机 stdio Server 用 `StdioClientTransport`（一行 `command` 加 `args` 拉子进程），连网络 Server 用 `StreamableHTTPClientTransport`。演示走 HTTP，跨网络才是协议的本意。先把完整流程手动走一遍，看清协议层发生什么：

```ts
// client.ts —— 手动走一遍：连、发现、调用、读资源
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "agent-client", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:3001/mcp")
);

await client.connect(transport); // 握手：初始化请求、能力协商

const { tools } = await client.listTools(); // 发现：拿到名字、描述、JSON Schema
console.log(tools.map((t) => `${t.name}: ${t.description}`));

const result = await client.callTool({  // 调用：参数原样进 Server 的 execute
  name: "get_order_status",
  arguments: { orderId: "A-1024" },
});
console.log(result.content); // [{ type: "text", text: '{"orderId":"A-1024",...}' }]

const { contents } = await client.readResource({ uri: "orders://all" });
console.log(contents[0].text);

await client.close();
```

三步对应三个动词：connect（握手）、listTools（发现）、callTool（调用）。工具列表是运行时拉取的，不是写死在代码里的——Server 明天加一个工具，Agent 不改一行代码就能用上。

接下来是本篇的落点：把 MCP 工具变成 AI SDK 的 `tool()`，让它直接进第 11 周 Day 4 的工具循环。适配函数薄到只有一个，做三件事——description 借 MCP 的，schema 你手写 zod，execute 转发 `callTool`：

```ts
// agent.ts —— 薄适配：MCP 工具进 AI SDK 工具循环
import { generateText, isStepCount, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function wrapMcpTool(
  client: Client,
  def: { name: string; description: string; schema: z.ZodObject<z.ZodRawShape> }
) {
  return tool({
    description: def.description,
    inputSchema: def.schema,
    execute: async (args) => {
      const result = await client.callTool({ name: def.name, arguments: args });
      return result.content; // text 块交回循环，模型看得懂
    },
  });
}

const client = new Client({ name: "agent-client", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://localhost:3001/mcp"))
);

const tools = {
  get_order_status: wrapMcpTool(client, {
    name: "get_order_status",
    description: "根据订单号查询订单的当前状态与金额",
    schema: z.object({ orderId: z.string().describe("订单号，形如 A-1024") }),
  }),
};

const { text } = await generateText({
  model: openai.chat("gpt-4o-mini"),
  prompt: "帮我看看订单 A-1024 发货了没",
  tools,
  stopWhen: isStepCount(5),
});
console.log(text); // 模型先调 get_order_status，拿到结果再回答
```

循环转起来的机制 Day 4 已经讲透：模型要工具、SDK 执行 `execute`、结果回传、继续推理。现在 `execute` 的身体在另一个进程甚至另一台机器上，循环本身无感。两点补充：连第三方 Server、对参数没把握时，AI SDK 的 `inputSchema` 也接受 `jsonSchema()` 包装，把 `listTools` 返回的 JSON Schema 直接喂进去；但自家 Server 建议手写 zod，参数在 Agent 侧再过一道校验，坏参数拦在你这里，不至于打穿到 Server。另外 AI SDK 后来出了 `experimental_createMCPClient`，把连接管理也收编了——本篇先手写，知道它替你做了什么，再决定用不用。

## 多 Server 与生命周期

真实 Host 连的不止一个 Server，三件事要做对。

连接复用：Client 建连是有成本的（握手、会话），别每个请求都 connect 一遍。用一张 Map 当登记簿，连过的复用：

```ts
const registry = new Map<string, Client>();

async function ensureConnected(name: string, url: string) {
  const existing = registry.get(name);
  if (existing) return existing;
  const client = new Client({ name: "agent-host", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  registry.set(name, client);
  return client;
}

const orders = await ensureConnected("orders", "http://localhost:3001/mcp");
const kb = await ensureConnected("kb", "http://localhost:3002/mcp");
```

进程退出清理：Host 退出前把所有连接关掉。stdio 连接尤其要关——不关的话子进程会残留成孤儿：

```ts
async function shutdown() {
  for (const client of registry.values()) await client.close();
  registry.clear();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

断线处理：连接断了，缓存的工具列表跟着失效——继续按旧列表调用只会报错，Server 重启后工具可能已增删。套路是调用处捕获错误，重连一次，重新 `listTools` 对表，缓存的工具映射全部重建。工具列表是快照不是订阅，别在启动时拉一次就烧死在上下文里。

## 安全提醒

第 18 周 Day 5-6 的两条护栏，TS 侧一条都不能省。入口校验：`registerTool` 的 zod schema 是第一道门，但它只拦「格式不对」，拦不住「格式合法、值有恶意」——`orderId` 传别人的订单号，schema 笔画都不皱一下。Server 的 `execute` 里要做业务校验：格式、归属、权限，一层层过。高危审批：退款、删数据这类工具别裸奔进工具循环，先过人工确认这一关，做法第 18 周 Day 6 已经演示过（[Day 5 脏参数防御](/week18/day5)、[Day 6 审批 UI](/week18/day6)）。要看到这两条护栏在生产系统里的完整拼装，去[落地实战三：客服系统](/products/service)。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Host、Client、Server 三角色里，你的 Agent 程序是哪个？一个 Host 连三个 Server，需要几个 Client？

::: details 参考答案
Agent 程序是 Host；Client 是 Host 内嵌的连接器，一条连接配一个，连三个 Server 就是三个 Client。方向记住「不跑模型的那方是 Server」。
:::

2. stdio 和 Streamable HTTP 各适合什么部署形态？stdio 模式下为什么不能用 `console.log` 打日志？

::: details 参考答案
stdio 是 Host 拉子进程，适合本机与同机部署；Streamable HTTP 是网络服务，跨机器复用。stdio 下 stdout 是协议通道，日志会污染协议报文，调试日志走 stderr。
:::

3. `registerTool` 里用 zod 写的 `inputSchema`，客户端 `listTools` 拿到的是什么？适配回 AI SDK 的 `tool()` 时有哪两种给法？

::: details 参考答案
拿到的是 JSON Schema 格式的参数描述。适配时可以手写 zod（自家 Server，参数清楚，还多一道校验），也可以用 `jsonSchema()` 把 listTools 返回的 JSON Schema 直接包进去（第三方 Server，参数未知）。
:::

4. 连接断开后，缓存的工具列表会出什么问题？处理套路是什么？

::: details 参考答案
列表失效，按旧列表调用报错，且 Server 端工具可能已增删。套路：调用处捕获错误，重连一次，重新 `listTools`，重建工具映射。工具列表是快照不是订阅。
:::

5. Host 进程退出前为什么要显式 `client.close()`？stdio 连接不关的后果是什么？

::: details 参考答案
清理协议层的会话与连接，释放资源。stdio 连接不关，Server 子进程会残留成孤儿进程占着机器。
:::

## 延伸阅读

- [MCP TypeScript SDK 仓库](https://github.com/modelcontextprotocol/typescript-sdk)，本篇主角的一手文档，Server/Client 与两种传输的完整示例都在
- [MCP 官方文档](https://modelcontextprotocol.io)，协议本身的规范与概念说明
- [AI SDK 文档：MCP Tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)，`experimental_createMCPClient` 的官方用法，本篇手写适配的官方收编版

概念全景回[第 18 周](/week18/)看，工具循环的机制回[第 11 周 Day 4](/week11/day4)看——本篇就是把这两头焊在一起的 TS 补篇。进度见[本周日程](/week11/)。
