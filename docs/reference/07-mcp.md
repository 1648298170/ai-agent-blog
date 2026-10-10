# 07 · MCP：把别人家的工具接进来

> 一句话：MCP（Model Context Protocol）是 Anthropic 推的工具接入行业标准——**JSON-RPC 之上的工具发现协议**。没有它，M 个客户端 × N 个工具 = M×N 份胶水；有了它 = M+N：工具方实现一次 Server，客户端方实现一次 Client，中间说同一种话。
> 本目录 `src/mcp/` 三个文件一个闭环：**server**（把自家工具暴露出去）/ **client**（连别人的服务器）/ **adapter**（把 MCP 工具适配成自家 `AgentTool`）。

---

## 它解决什么问题

两个真实痛点，一进一出：

```text
出方向：你写了个查订单工具，想让 Claude Desktop / Cursor 也能用——
        为每个客户端写一套胶水？schema、校验、传输各写一份，改一处漏一处。
进方向：别人有个现成的 MCP 服务器（天气 / 数据库 / 搜索）——
        想并进自己的 Agent，按对方的私约对接一次？

解法：两边都说 MCP——Server 暴露 tools/resources 原语，
      Client 用 listTools / callTool 四个动词发现并调用它们。
```

**头牌原则**：协议的全部复杂性（JSON-RPC、传输、握手、双通道结果）都被压在三个文件的**边界**上——进了自家地界，MCP 工具就是统一的 `AgentTool`，`runToolLoop` 一行未改。这不是口号，是测试断言（`test/mcp-client.spec.ts` 让剧本模型对 MCP 适配工具发起调用，`onStep` 采集到的输出与本地工具形状无差别）。

---

## 核心概念（5 分钟版）

### 三个文件一个闭环

| 文件 | 方向 | 职责 |
|---|---|---|
| `server.ts` | 出 | 引擎工具 → MCP 服务器：三工具 zod 直传 + `docs://kb/{docId}` 资源模板 + stdio 挂载 |
| `client.ts` | 进 | 外部 MCP 服务器 → 桥：`McpClientBridge`（spawn + initialize 握手 + listTools） |
| `adapter.ts` | 进 | MCP 工具描述符 → 引擎 `AgentTool`：JSON Schema 照单全收 + 结果映射 |

### 四个必懂的概念

**① stdio 传输**：MCP 消息就是 stdin/stdout 上**换行分隔的 JSON-RPC 帧**（一行一帧）。纪律：stdout 归协议所有，任何日志只能走 stderr——在 stdout 打一行启动横幅 = 往协议流里塞脏字节，客户端解析当场崩。

**② 发现协议**：Client `listTools` 拿到工具描述符（名字 + 描述 + JSON Schema 参数图纸），运行时发现——接新服务器不改客户端一行代码。校验责任在 **Server 侧**：SDK 按声明的 inputSchema 校验后才回调 execute。

**③ 照单全收**：外部服务器的 schema 是 JSON Schema（我们不认识、也不可能预知），适配器不复制不改写——`adapter.ts` **刻意不 import zod**：一旦引了 zod 就等于替服务器「翻译」schema，翻译即失真。

**④ 双通道输出**：MCP 工具结果有 `content`（文本 JSON，给人和旧客户端读）与 `structuredContent`（原对象，给程序读）两条；适配器优先消费后者——自家狗粮两头对上。

---

## 代码走读（`src/mcp/`，4 个文件）

| 位置 | 内容 | 要点 |
|---|---|---|
| `registerEngineTool`（server.ts L69） | 引擎工具 → MCP 注册 | 收窄检查 `inputSchema instanceof z.ZodType` 后**同一个 zod 对象**直传（单一真源，零复制） |
| `createMcpServer`（server.ts L111） | ★ 服务器工厂 | 注册 getOrderStatus / createTicket / searchKnowledge 三工具 + kb 资源模板 |
| `connectStdio`（server.ts L165） | stdio 挂载 | 只挂 StdioServerTransport；横幅留给 CLI 入口打 stderr |
| `McpClientBridge`（client.ts L41） | 桥的形状 | `{ name, tools, close }`——stdio 与 in-memory 两条通道同一张脸 |
| `createMcpClientBridge`（client.ts L85） | ★ stdio 桥 | spawn 子进程 + initialize 握手 + listTools + 逐个适配 |
| `mcpToolToAgentTool`（adapter.ts L92） | ★ 适配器 | JSON Schema 原样透传 + 结果四级映射 |
| `McpToolCaller`（adapter.ts L29） | 依赖倒置接缝 | 能 callTool 即是「客户端」——测试桩不需要任何传输层 |

### 出方向：把引擎工具暴露出去（`server.ts` L86-L104，骨架）

```ts
// server.ts L69 registerEngineTool —— 同一份 zod schema：本地循环与 MCP 客户端
// 看到同一张参数图纸，改名改参只改 demo-tools.ts 一处
server.registerTool(
  name,
  { description: engineTool.description ?? name, inputSchema }, // zod 直传，SDK 直接吃
  async (args) => {
    const output = await execute(args, { toolCallId: `mcp-${name}-${randomUUID()}`, messages: [] });
    return {
      content: [{ type: "text", text: JSON.stringify(output) }], // 文本通道：给人/旧客户端
      structuredContent: output,                                  // 结构通道：给程序
    };
  },
);
```

只有三个工具注册（L121-124）；`escalateToHuman` 刻意不注册——转人工是客服会话内的动作（HandoffPack 要吃会话上下文），MCP 是无会话的协议边界。知识库走 `ResourceTemplate("docs://kb/{docId}")`（L130）：文档运行时增删，静态注册拍快照会过期，模板的 list 回调每次现查 `listDocs()`。

### 进方向：spawn + 握手 + 收尸（`client.ts` L85-L105，骨架）

```ts
export async function createMcpClientBridge(options: StdioMcpBridgeOptions): Promise<McpClientBridge> {
  const name = [options.command, ...(options.args ?? [])].join(" ");
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    // SDK 的 env 是「整体替换」而非合并：只传覆盖项会丢 PATH，cmd /c pnpm 当场解析失败
    env: options.env === undefined ? undefined : { ...getDefaultEnvironment(), ...options.env },
  });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport); // connect 内部 start()：spawn + initialize 握手
    const tools = await listAndAdapt(client); // listTools + 逐个 mcpToolToAgentTool
    return { name, tools, close: () => client.close() };
  } catch (err) {
    await client.close().catch(() => {}); // 连接失败先收掉已 spawn 的子进程，不留孤儿
    throw describeConnectError(name, err);
  }
}
```

**close 的收尾序列**（L26-32 头注释，从 SDK 1.31.0 源码核实）：`client.close()` → 先 `child.stdin.end()`（优雅 EOF）等 2s → SIGTERM 再等 2s → SIGKILL。stdio 服务器读完 stdin 自然退出。

### 适配器：四级瀑布（`adapter.ts` L92-L149，简化到脉络）

```ts
export function mcpToolToAgentTool(caller: McpToolCaller, descriptor: McpToolDescriptor): AgentTool {
  return tool({
    description: descriptor.description ?? descriptor.name,
    inputSchema: jsonSchema<unknown>(descriptor.inputSchema), // 原始 JSON Schema 原样透传
    execute: async (input) => {
      // 入参收窄：运行时只放行「对象或缺省」（模型传数组/字符串当场中文报错）
      const result = await caller.callTool({ name: descriptor.name, arguments: args });
      if (result.isError === true) throw new Error(`MCP 工具 ${descriptor.name} 返回错误：…`);
      if (isPlainObject(result.structuredContent)) return result.structuredContent; // ① 结构通道
      const text = joinTextContent(result.content);
      if (text !== undefined) return text;                       // ② text 块按序拼接
      if (result.content === undefined && result.toolResult !== undefined)
        return result.toolResult;                                // ③ 旧协议兼容兜底
      throw new Error(`…无法映射的内容…`);                        // ④ 宁可报错不静默吞掉
    },
  });
}
```

`isError` 翻译成异常是刻意的：协议约定服务器侧失败也走正常返回、靠 isError 标记——翻译成异常，引擎循环的 errorOutput 通道（✗ 观察）才能接住它。

### 接线：工具表合并（`apps/cli/src/apps/chat/cli.ts` L139-L157）

`--mcp` 的值按空白切分，桥就绪后才进 REPL。合并就一行 `{ ...local, ...mcpTools }`——**重名时 MCP 版本胜出**（显式接入的外部服务器优先）并打中文警告：静默覆盖会让「为什么查订单走的是 MCP」变成悬案。红队加固后另有 `AGENT_GUARD_MCP_STRICT=1` 严格模式：重名跳过 MCP 版、本地胜出（E7 证明「警告不是闸」，恶意服务器一个重名就能接管内置工具）。

### 踩坑实录：Windows 的 `cmd /c`（重要）

`StdioClientTransport` 用 `spawn` 且**不开 shell**：Windows 上 pnpm/npx 是 `.cmd` 垫片，直唤会 ENOENT/EINVAL。解法不是全局 `shell: true`（等于给命令行开注入口），而是**文档化命令形态**：`--mcp "cmd /c pnpm mcp:server"`，让 cmd.exe 当垫片层——这不是 bug 是安全纪律。macOS/Linux 直接写命令。

---

## 跑起来验证（先跑再读，体感翻倍）

```powershell
cd agent-app
# 前置：pnpm build + .env 配好智谱 API Key

# ① 狗粮自测：自己的 REPL 接自己的 MCP server（真子进程 + 真模型）
pnpm chat --mcp "cmd /c pnpm mcp:server" --trace
#   启动横幅会列出「已接入 MCP 服务（N 个工具：getOrderStatus, createTicket, searchKnowledge）」
#   问「订单 A-1024 到哪了」→ ⚙ 行动调 getOrderStatus（走的是 MCP 子进程！）+ 重名覆盖警告
#   /exit 退出 → 桥按 stdin EOF → SIGTERM → SIGKILL 序列收掉服务器进程

# ② 单看服务器本身（stdio JSON-RPC，起起来等客户端连；日志走 stderr）
pnpm mcp:server

# ③ 狗粮冒烟脚本（真模型 + 真子进程，独立于 vitest）
pnpm test:mcp-dogfood

# ④ 离线协议测试（InMemoryTransport 同进程对连，走真实 JSON-RPC 往返，零网络零 spawn）
pnpm test:engine
```

---

## 设计取舍（面试级追问）

| 追问 | 回答 |
|---|---|
| 适配器为什么刻意不 import zod？ | 接进来的 schema 是 JSON Schema；引 zod 即「翻译」，翻译即失真。`jsonSchema()` 原样透传，参数校验责任在服务器侧（SDK 按声明的 schema 校验后才回调 execute） |
| 为什么重名时 MCP 胜出而不是本地？ | 显式接入的外部服务器是使用者的明确意图，优先尊重——但必须打警告说清楚覆盖了谁；strict 模式（H9）反向：重名跳过 MCP 版，从根上消灭遮蔽语义 |
| 为什么 escalateToHuman 不注册成 MCP 工具？ | 转人工要吃会话上下文（HandoffPack），MCP 是无会话的协议边界——挂出去只会收到缺上下文的空调用 |
| stdio 传输为什么日志只准走 stderr？ | stdout 归协议所有（换行分隔的 JSON-RPC 帧）；往 stdout 打日志 = 塞脏字节，客户端解析当场崩 |
| close 为什么要三段序列（EOF→SIGTERM→SIGKILL）？ | 先礼后兵：优雅 EOF 让服务器自然清理（2s）→ SIGTERM（2s）→ SIGKILL 兜底。直接杀进程会留下半写的状态 |
| 知识库资源为什么用 ResourceTemplate 而不是静态注册？ | 文档运行时增删（入库/下架），静态注册只在构造瞬间拍一次快照会立刻过期；模板的 list 回调现查 `listDocs()`，客户端永远看到当前真相 |
| Windows 下不开 shell:true 是为什么？ | `shell: true` 等于给命令行开注入口（命令注入面）。文档化 `cmd /c` 前缀让垫片显式可见，桥本身保持 spawn 用法正统 |

---

## 自测题（先凭记忆答，再看文末答案）

1. MCP 工具被适配成 `AgentTool` 之后，`runToolLoop` 需要改哪几行才能调度它？为什么？
2. Windows 下 `--mcp "pnpm mcp:server"` 为什么会 ENOENT？正确写法是什么，为什么不干脆 `shell: true`？
3. MCP 协议约定服务器侧执行失败「不抛异常、靠 isError 标记返回」——适配器把它翻译成什么？为什么？

<details><summary>答案</summary>

1. 一行都不用改。`runToolLoop` 只认 `Record<string, AgentTool>`（description / inputSchema / execute 三件套），不问工具出身——协议复杂性被压在 server / client / adapter 三个文件的边界上，这就是「循环零感知」（`mcp-client.spec.ts` 的头号断言）。
2. StdioClientTransport 用 `spawn` 且不开 shell，而 Windows 上 pnpm/npx 是 `.cmd` 垫片，spawn 直唤 `.cmd` 会 ENOENT。正确写法是 `--mcp "cmd /c pnpm mcp:server"` 让 cmd.exe 当垫片层；不开 `shell: true` 是因为它等于给命令行开注入口（安全纪律）。
3. 翻译成异常。引擎循环的 errorOutput 通道（✗ 观察）靠异常接住失败并回灌给模型——如果当普通返回值，失败就会被当成正常结果混进上下文，模型分不清「查询失败」和「查询成功但没数据」。

</details>

---

## 延伸阅读

- [../../packages/engine/src/mcp/README.md](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/packages/engine/src/mcp/README.md) —— 本模块原理篇：M+N 数学 + 14 问自测清单
- [ARCHITECTURE.md](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/ARCHITECTURE.md) —— 整体架构图与踩坑实录
- [01-agent-loop.md](./01-agent-loop.md) —— 适配后的工具在哪里被调度（循环为什么零感知）
- [../archive/weeks/week11/mcp-ts.md](../archive/weeks/week11/mcp-ts.md) —— 教程 TS 主线的 MCP 篇
- [../archive/weeks/week18/index.md](../archive/weeks/week18/index.md) —— MCP 协议 + 工具生态周（Day 1 概念 / Day 5 安全护栏 / Day 6 人工审批）
