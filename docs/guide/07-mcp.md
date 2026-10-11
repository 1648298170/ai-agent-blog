# 07 · MCP 标准插口

> **这一站解决工具的孤岛问题**：每个 Agent 各造一套私有工具协议，接一家写一次胶水。学完你将拥有一个双向 MCP 闭环——把自家工具暴露成标准服务器、把别人家的服务器接进自己的工具表——而且工具循环一行不改。

**前置**：[05 · 工具层加固](/guide/05-tools-hardening)（先知道一张好工具表长什么样，再来谈怎么接外部的表）
**配套跑起来**：`pnpm mcp:server`（自家工具上协议）+ `pnpm chat --mcp "cmd /c pnpm mcp:server" --trace`（自家 REPL 吃自家服务器，狗粮闭环）
**深读**：[参考库 · MCP 集成深读](/reference/07-mcp)（协议往返、close 序列、护栏装配的逐行走读）

---

## 一、为什么：不发明私有协议

回想 USB 出现之前：每台手机一根专用数据线，抽屉里缠成一团。工具生态曾经也是这样——想让 Claude Desktop 用你的查订单工具，按它的私约写一套胶水；想让 Cursor 用，再写一套；反过来想用别人的天气工具，又得按对方的格式对接一次。M 个客户端 × N 个工具，就是 M×N 根线。

**MCP（Model Context Protocol，Anthropic 推的行业标准）把它压成 M+N**：工具方实现一次 Server，客户端方实现一次 Client，中间说同一种话。那门「话」一句话讲清：JSON-RPC 之上的工具发现协议——Server 暴露 tools / resources 两类原语，Client 用 `listTools` / `callTool` 等四个动词发现并调用。协议还替三个工程问题定了标准答案：

1. **格式谁定？** 协议定（JSON-RPC 消息形状），双方只填内容；
2. **校验谁做？** 服务器侧——按声明的 inputSchema 校验后才回调 execute，客户端不必信任模型给的参数；
3. **工具怎么被发现？** 运行时 `listTools` 发现——接一个新服务器，客户端一行代码不用改。

本项目的价值是**双向**的，对应 `packages/engine/src/mcp/` 的三个文件一个闭环：

| 文件 | 方向 | 职责 |
|---|---|---|
| `server.ts` | 出 | 自家工具 → MCP 服务器：`createMcpServer()` 注册工具与资源，`connectStdio()` 挂标准输入输出 |
| `client.ts` | 进 | 外部服务器 → 桥：`McpClientBridge`（name / tools / close）负责 spawn 子进程 + initialize 握手 + listTools |
| `adapter.ts` | 翻译 | MCP 工具描述符 → 自家 `AgentTool`：参数图纸照单全收 |

## 二、核心形态：三个文件怎么闭环

**出方向**（`server.ts`）：引擎工具的 zod schema **原对象直传**给 SDK——本地循环与外部客户端看到同一张参数图纸，改名改参只改一处（单一真源）：

```ts
// packages/engine/src/mcp/server.ts（节选）
server.registerTool(
  name,
  { description: engineTool.description ?? name, inputSchema }, // 同一份 zod
  async (args) => {
    const output = await execute(args, { toolCallId: `mcp-${name}-${randomUUID()}`, messages: [] });
    return {
      content: [{ type: "text", text: JSON.stringify(output) }], // 给人和旧客户端读
      structuredContent: output,                                  // 给程序读
    };
  },
);
```

三个细节各有讲究：

- 注册的只有三个工具（`getOrderStatus` / `createTicket` / `searchKnowledge`）——`escalateToHuman` 刻意不挂：转人工要吃会话上下文（HandoffPack），MCP 是无会话的协议边界，挂出去只会收到缺上下文的空调用；
- **双通道输出**：`content`（文本 JSON）+ `structuredContent`（原对象）——下面的适配器优先消费后者，自家狗粮两头对上；
- 除了工具还暴露**资源**：`docs://kb/{docId}` 资源模板，list 时现查 `listDocs()`、读时现调 `readDoc()`——文档运行时会增删，静态注册拍快照会立刻过期。

**进方向**（`client.ts`）：桥的装配就三步——连接、发现、翻译：

```ts
// packages/engine/src/mcp/client.ts（节选）
await client.connect(transport);          // connect 内部：spawn 子进程 + initialize 握手
const tools = await listAndAdapt(client); // listTools → 逐个适配成 AgentTool
return { name, tools, close: () => client.close() };
```

任何一步失败都先 `client.close()` 收掉已 spawn 的进程再抛中文错误——**失败的桥不留孤儿进程**。测试用的是 InMemory 变体（Client 与 Server 同进程对连，走真实 JSON-RPC 往返但零 spawn 零网络）——`test/mcp-server.spec.ts` 与 `test/mcp-client.spec.ts` 全程离线，这是「离线优先」铁律在协议层的落法。

**翻译层**（`adapter.ts`）是整个设计的教学点：**适配器模式**——外部协议再怪，进自家地界就是统一的 `AgentTool` 三件套（description / inputSchema / execute）。MCP 的 schema 是 JSON Schema，适配器用 `jsonSchema()` 原样透传、**刻意不 import zod**——一旦引了 zod 就等于替服务器「翻译」schema，翻译即失真；参数校验的责任明明白白留在服务器侧。结果映射是一条四级瀑布：`structuredContent` → text 内容块按序拼接 → 旧协议 `toolResult` 兜底 → 都没有就报错（宁可报错也不静默吞掉）；服务器侧执行失败靠 `isError` 标记返回，适配器把它翻译成异常——引擎循环的 `✗ 观察` 错误通道才能接住。

## 三、跑起来（先体感）

```powershell
cd agent-app
pnpm chat --mcp "cmd /c pnpm mcp:server" --trace   # 自家 REPL 接自家服务器
# 启动会打印：已接入 MCP 服务（3 个工具：getOrderStatus, createTicket, searchKnowledge）
# 再问「订单 A-1024 到哪了」——trace 里 ⚙ 行动 调的就是 MCP 来源的 getOrderStatus

pnpm test:mcp-dogfood    # 真模型 + 真子进程的冒烟（独立于 vitest，需配 key）
```

两条细节值得盯：

1. 本地本就有同名的 `getOrderStatus`，合并时 **MCP 版本胜出并打警告**（`mergeMcpTools`，`apps/cli/src/apps/chat/cli.ts`）——静默覆盖会让「为什么查订单走的是 MCP」变成悬案；想反过来保留本地版，设 `AGENT_GUARD_MCP_STRICT=1` 走严格模式。
2. 并入之后的 `runToolLoop` **一行未改**——循环不问工具出身，这就是「插口」二字的全部含义。`mcp-client.spec.ts` 的头号断言就叫「循环不可区分」：剧本模型对 MCP 适配工具发起调用，`onStep` 采集到的输出与本地 zod 工具形状无差别。

## 四、踩坑实录：Windows 的 ENOENT

**现象**：Windows 上 `--mcp "pnpm mcp:server"` 直接报 ENOENT——命令明明在终端能跑。

**根因**：stdio 传输底层用 `spawn` 且**不开 shell**。Windows 的 `pnpm`/`npx` 不是 exe，是 `.cmd` 垫片脚本；`spawn("pnpm")` 找的是名为 pnpm 的可执行文件，当然找不到。

**为什么不开 shell 算了**：`shell: true` 等于把整条命令行交给 shell 解释——命令行里任何特殊字符都成了注入口。这条是**安全纪律，不是 bug**。正解是把命令包一层垫片：

```powershell
pnpm chat --mcp "cmd /c pnpm mcp:server" --trace   # 让 cmd.exe 当垫片层（macOS/Linux 直接写命令）
```

同一族的坑还有三个，答案都写在文件头注释里：

1. **stdout 归协议所有**：stdio 传输的 stdout 跑的是换行分隔的 JSON-RPC 帧，服务器往 stdout 打一行启动横幅 = 往协议流里塞脏字节，客户端解析当场崩——日志只能走 stderr（`pnpm mcp:server` 的横幅就打在 stderr）。
2. **SDK 的 env 是整体替换不是合并**：只传 `{ FOO: 1 }` 会把 PATH 一起丢掉，`cmd /c pnpm` 当场解析失败——桥里显式 `{ ...getDefaultEnvironment(), ...options.env }`。
3. **子进程收尾三段式**：退出 REPL 时桥按 `client.close()` 的既定序列收服务器（从 SDK 1.31.0 源码核实）：先 `stdin.end()` 发优雅 EOF 等 2s → SIGTERM 再等 2s → SIGKILL——不带活的 MCP 子进程退出留下孤儿。

最后一道组装题：安全护栏（[06 站](/guide/06-safety)的四件套）在 chat CLI 里**只给 MCP 来源的工具套闸**——本地演示工具是自己写的代码，外部服务器是控制不了的面：schema 它说了算、执行体在它进程里。**信任边界在哪，闸就装在哪。**

## 五、动手任务（做完才算通关）

1. 跑通狗粮命令，数一数 trace 里 `⚙ 行动` 调的工具走的是哪一路（提示：看重名警告）。
2. 故意把命令写成 `--mcp "pnpm mcp:server"`（不包 `cmd /c`），亲眼看一次 ENOENT 与中文修复指引；再用一个 MCP 客户端（如 Claude Desktop）挂载 `pnpm mcp:server`。
3. **改造**：给 `tools/demo-tools.ts` 加一个新工具并注册进 `server.ts`，重启狗粮验证 MCP 客户端能发现它、且本地循环行为不变。

## 自测题（先凭记忆答，再展开）

1. 适配器为什么刻意不 import zod？参数校验的责任在谁？
2. 工具表合并时重名谁胜出？为什么必须打警告？
3. Windows 下为什么要 `cmd /c`？为什么解法不是 `shell: true`？

<details><summary>答案</summary>

1. 接进来的 schema 是外部服务器的 JSON Schema，引 zod 即「翻译」，翻译即失真——`jsonSchema()` 原样透传；校验责任在服务器侧（SDK 按声明的 inputSchema 校验后才回调 execute）。
2. MCP 版本胜出（显式接入的外部服务器优先）；静默覆盖会让「为什么这个工具走的是 MCP」变成悬案，所以必须 console.warn（严格模式下则跳过 MCP 版本、本地胜出）。
3. Windows 的 pnpm/npx 是 .cmd 垫片，spawn 不开 shell 直唤找不到可执行文件（ENOENT）；`shell: true` 等于给命令行开注入口，是安全纪律问题——文档化命令形态（包一层 cmd.exe 垫片）才是正解。

</details>

---

## 延伸

- [参考库 · MCP 集成深读](/reference/07-mcp) —— 协议往返测试、close 序列、安全护栏只闸 MCP 工具的理由
- 归档周教程：[week18 · MCP 协议 + 工具生态](/archive/weeks/week18/) · [week11 · MCP TS 版](/archive/weeks/week11/mcp-ts)
- 下一站：[08 · 评估框架：跑分说话](/guide/08-evals) —— 插口接好了，怎么证明它没接坏？上秤
