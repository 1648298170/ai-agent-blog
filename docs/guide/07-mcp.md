# 07 · MCP 标准插口

> **这一站解决工具的孤岛问题**：每个 Agent 各造一套私有工具协议，接一家写一次胶水。学完你将得到一个双向 MCP 闭环——把自家工具开放出去、把别人家的工具接进来——而且工具循环一行不改。

**前置**：[05 · 工具层加固](/guide/05-tools-hardening)（先知道一张好工具表长什么样，再来谈怎么接外部的表）
**配套跑起来**：`pnpm mcp:server`（自家工具上协议）+ `pnpm chat --mcp "cmd /c pnpm mcp:server" --trace`（自家 REPL 吃自家服务器，狗粮闭环）
**深读**：[参考库 · MCP 集成深读](/reference/07-mcp)（协议往返、close 序列、护栏装配的逐行走读）

---

## 一、为什么要 MCP：一根万能数据线

回想 USB 出现之前：每台手机一根专用数据线，抽屉里缠成一团。工具生态当年就是这个惨状——想让 Claude Desktop 用你的查订单工具？按它的私约写一套胶水。想让 Cursor 也用？再写一套。反过来想用别人家的天气工具？又得按对方的格式对接一次。

M 个客户端 × N 个工具，就是 **M×N 根线**——每根都要自己维护格式、校验、传输，改一处漏一处。

**MCP（Model Context Protocol，Anthropic 推的行业标准）把它压成 M+N**：工具方实现一次 Server，客户端方实现一次 Client，中间说同一种话。

这门「话」一句话讲清：**JSON-RPC 之上的工具发现协议**。Server 摆出 tools / resources 两类东西，Client 用 `listTools`（列菜单）、`callTool`（下单）这几个动词来发现并调用。协议替三个老大难问题定了标准答案：

1. **格式谁定？** 协议定。双方只管填内容，不用再协商；
2. **参数校验谁做？** 服务器做。它按自己声明的 inputSchema 校验后才执行——客户端不必信任模型瞎给的参数；
3. **工具怎么被发现？** 运行时 `listTools` 问一声就行。接一个新服务器，客户端一行代码不用改。

本项目的价值是**双向**的，`packages/engine/src/mcp/` 三个文件一个闭环：

| 文件         | 一句话角色         | 职责                                                        |
| ------------ | ------------------ | ----------------------------------------------------------- |
| `server.ts`  | **开放窗口**（出） | 把自家工具挂成 MCP 服务器，Claude Desktop / Cursor 即插即用 |
| `client.ts`  | **接线员**（进）   | 连接外部服务器：spawn 子进程 + 握手 + 列工具                |
| `adapter.ts` | **翻译官**（翻译） | 把外来的工具翻译成自家 `AgentTool` 三件套                   |

## 二、三个文件怎么串成一条流水线

先看一条消息的完整旅程，你就明白三个文件各自站在哪：

```text
你问「订单 A-1024 到哪了」
  → 模型说：我要调 getOrderStatus
  → 工具循环照常调 execute            ← 循环根本不知道有 MCP
  → 翻译官（adapter）把调用变成 MCP 的 callTool
  → 接线员（client）通过管道发给另一个进程
  → 那头是开放窗口（server）→ 执行的还是同一个真实工具
  → 结果沿来路返回，模型看到答案，组织语言回复你
```

> 这段旅程是「狗粮」场景——自家聊天程序接自家 MCP 服务器，一条链路把出方向和进方向全跑了一遍。

### 开放窗口（server.ts）：挂出去的是同一批工具

关键做法：工具的 zod schema **原对象直传**给 SDK，不复制不改写。本地循环和外部客户端看的是**同一张参数图纸**，改名改参只改一处：

```ts
// packages/engine/src/mcp/server.ts（节选）
server.registerTool(
  name,
  { description: engineTool.description ?? name, inputSchema }, // 同一份 zod
  async (args) => {
    const output = await execute(args /* ... */);
    return {
      content: [{ type: "text", text: JSON.stringify(output) }], // 给人和旧客户端读
      structuredContent: output, // 给程序读
    };
  },
);
```

三个细节各有讲究：

- **只挂三个工具**：`escalateToHuman`（转人工）刻意不挂。转人工要吃会话上下文（HandoffPack），而 MCP 是无会话的协议边界——挂出去只会收到缺上下文的空调用；
- **结果写两份**：`content` 是文本（给人看），`structuredContent` 是原对象（给程序看）。自家翻译官优先吃后者，两头正好对上；
- **除了工具还开资源**：`docs://kb/{docId}` 是个「动态目录」——每次列出、每次读取都现查知识库（`listDocs()` / `readDoc()`）。文档运行时会增删，注册时拍一张静态快照，下一秒就过期。

### 接线员（client.ts）：三步装好一座桥

```ts
// packages/engine/src/mcp/client.ts（节选）
await client.connect(transport); // 内部：spawn 子进程 + initialize 握手
const tools = await listAndAdapt(client); // listTools → 逐个交给翻译官
return { name, tools, close: () => client.close() };
```

任何一步失败，都先 `client.close()` 把已经拉起来的子进程收掉再报错——**失败的桥不留孤儿进程**。

测试用的是 InMemory 变体：Client 和 Server 同进程对连，走的是真实 JSON-RPC 往返，但不 spawn、不碰网。`test/mcp-server.spec.ts` 与 `test/mcp-client.spec.ts` 全程离线——这就是「离线优先」铁律在协议层的落法。

### 翻译官（adapter.ts）：外来工具变成自家三件套

这是整个设计的教学点，就是**适配器模式**：外部协议再怪，进了自家地界，统一成 `AgentTool` 三件套（description / inputSchema / execute）。两个原则：

- **照单全收**：外来的参数图纸是 JSON Schema，翻译官用 `jsonSchema()` 原样透传，**刻意不 import zod**。一旦引了 zod，就等于你替服务器「翻译」说明书——翻译即失真。参数校验的责任明明白白留在服务器侧；
- **错误要说人话**：服务器执行失败时，协议不抛异常，而是在正常返回里带个 `isError` 标记。翻译官把它翻译成异常——引擎循环的 `✗ 观察` 错误通道才接得住。所有报错都包装成中文并保留原始信息，让你知道下一步查什么。

拿到结果后，映射是一条**四级瀑布**，从上往下试：

```text
① structuredContent 结构化对象 → 原样上抛（正主）
② content 里的 text 文本块     → 按序拼接（纯文本工具的常规形态）
③ toolResult 旧协议兜底字段    → 兼容老服务器
④ 都没有                       → 中文报错（宁可报错，也不静默吞掉）
```

## 三、跑起来：亲眼看它工作

```powershell
cd agent-app
pnpm chat --mcp "cmd /c pnpm mcp:server" --trace   # 自家 REPL 接自家服务器
# 启动会打印：已接入 MCP 服务（3 个工具：getOrderStatus, createTicket, searchKnowledge）
# 再问「订单 A-1024 到哪了」——trace 里 ⚙ 行动 调的就是 MCP 来源的 getOrderStatus

pnpm test:mcp-dogfood    # 真模型 + 真子进程的冒烟（独立于 vitest，需配 key）
```

两个值得盯的细节：

1. 本地本来就有一个同名的 `getOrderStatus`，合并时 **MCP 版本胜出并打警告**（`mergeMcpTools`）。为什么必须警告？静默覆盖会让「为什么查订单走的是 MCP」变成悬案。想反过来让本地胜出，设 `AGENT_GUARD_MCP_STRICT=1` 走严格模式。
2. 并入之后，`runToolLoop` **一行未改**——循环不问工具出身，这就是「插口」二字的全部含义。`mcp-client.spec.ts` 的头号断言就叫「循环不可区分」：让剧本模型对 MCP 适配工具发起调用，`onStep` 采集到的输出与本地 zod 工具形状无差别。

## 四、踩坑实录：Windows 的 ENOENT

**现象**：Windows 上 `--mcp "pnpm mcp:server"` 直接报 ENOENT——这命令在终端明明能跑。

**根因**：stdio 传输底层用 `spawn` 且**不开 shell**。Windows 的 `pnpm`/`npx` 不是 exe，是 `.cmd` 垫片脚本；`spawn("pnpm")` 找的是一个叫 pnpm 的可执行文件，当然找不到。

**为什么不开 shell 算了**：`shell: true` 等于把整条命令行交给 shell 解释——命令行里任何特殊字符都成了注入口。这条是**安全纪律，不是 bug**。正解是包一层垫片：

```powershell
pnpm chat --mcp "cmd /c pnpm mcp:server" --trace   # 让 cmd.exe 当垫片层（macOS/Linux 直接写命令）
```

同一族的坑还有三个，答案都写在文件头注释里：

1. **stdout 归协议所有**：stdio 模式下，stdout 这根管道专门跑协议消息（一行一个 JSON）。往里面 print 一句「服务器启动了！」就是往数据流里塞脏字节，客户端解析当场崩——所以日志只能走 stderr（`pnpm mcp:server` 的横幅就打在 stderr）；
2. **SDK 的 env 是整体替换不是合并**：只传 `{ FOO: 1 }` 会把 PATH 一起丢掉，`cmd /c pnpm` 当场解析失败。桥里显式 `{ ...getDefaultEnvironment(), ...options.env }`——继承默认变量，再叠加覆盖项；
3. **子进程收尾三段式**：退出 REPL 时按既定序列收服务器（从 SDK 1.31.0 源码核实）：先 `stdin.end()` 发优雅 EOF 等 2 秒 → SIGTERM 再等 2 秒 → 还不死就 SIGKILL。不带活的 MCP 子进程退出，留下孤儿。

最后一道组装题：安全护栏（[06 站](/guide/06-safety)的四件套）在 chat CLI 里**只给 MCP 来源的工具套闸**。为什么？本地工具是自己写的代码；外部服务器是控制不了的面——schema 它说了算、执行体跑在它的进程里。**信任边界在哪，闸就装在哪。**

## 五、动手任务（做完才算通关）

1. 跑通狗粮命令，数一数 trace 里 `⚙ 行动` 调的工具走的是哪一路（提示：看重名警告）。
2. 故意把命令写成 `--mcp "pnpm mcp:server"`（不包 `cmd /c`），亲眼看一次 ENOENT 与中文修复指引；再用一个 MCP 客户端（如 Claude Desktop）挂载 `pnpm mcp:server`。
3. **改造**：给 `tools/demo-tools.ts` 加一个新工具并注册进 `server.ts`，重启狗粮验证 MCP 客户端能发现它、且本地循环行为不变。

## 自测题（先凭记忆答，再展开）

1. 翻译官为什么刻意不 import zod？参数校验的责任在谁？
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
