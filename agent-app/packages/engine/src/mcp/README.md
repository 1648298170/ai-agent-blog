# 读代码前先读这篇：MCP 是什么，为什么工具要上协议

> 本目录解决 Agent 的"工具孤岛"问题，价值是**双向**的：**出方向**把引擎既有
> 工具暴露成标准 MCP 服务器（Claude Desktop / Cursor / 任何 MCP 客户端即插即用），
> **进方向**把任何外部 MCP 服务器的工具并进自己的工具表（`agent-loop` 一行未改）。
> 与 `rag/`、`memory/` 同一套工程哲学：**协议在边界上被消化，agent-loop 零感知**——
> schema 单一真源（zod 只写一份）、离线优先（测试用 InMemoryTransport 走真实
> JSON-RPC 往返，但零网络零 spawn）。
> 配合教程 [week18 · MCP 协议 + 工具生态](../../../../../docs/week18/index.md)
> （教程主线是 Python FastMCP / LangGraph，本项目为官方 TS SDK
> `@modelcontextprotocol/sdk` 的同题材适配，命令行为可直接跑）。

---

## 一、第一性原理：手写 N 个工具，还是接整个生态

没有协议时，工具的每一次跨进程复用都是一次**点对点集成**：想让 Claude Desktop
用你的查订单工具，为它写一套胶水；想让 Cursor 用，再写一套；反过来想用别人的
天气工具，也得按对方的私约对接一次。M 个客户端 × N 个工具 = M×N 份胶水，
每份都要维护 schema、校验、传输——改一处漏一处。MCP 把这压成 **M+N**：
工具方实现一次 Server，客户端方实现一次 Client，中间说同一种话。

那种"话"一句话讲清：**JSON-RPC 2.0 之上的发现协议——Server 暴露
tools / resources 两类原语，Client 用 listTools / callTool /
listResources / readResource 四个动词发现并调用它们**。stdio 传输下，
这些消息就是**换行分隔的 JSON**（一行一帧），stdout 归协议、日志只能走 stderr。

协议替三个工程问题定了标准答案：

1. **格式谁定？** 协议定（JSON-RPC + MCP 的消息形状），双方只填内容
2. **校验谁做？** Server 侧——按声明的 inputSchema 校验后才回调 execute，
   Client 不必信任模型给的参数
3. **工具怎么被发现？** 运行时 listTools 发现，接新服务器不改客户端一行代码

## 二、核心设计：协议消化在边界上，循环零感知

| 文件 | 方向 | 职责 |
| --- | --- | --- |
| `server.ts` | 出 | 引擎工具 → MCP 服务器：三工具 zod 直传 + `docs://kb/{docId}` 资源模板 + stdio 挂载 |
| `client.ts` | 进 | 外部 MCP 服务器 → 桥：stdio spawn / InMemory 同进程对两条通道，同一桥形状 |
| `adapter.ts` | 进 | MCP 工具描述符 → 引擎 `AgentTool`：JSON Schema 照单全收 + 结果映射 |
| `index.ts` | — | 桶导出（`@agent-app/engine/mcp` 子路径的公共面） |

外围文件（不在本目录，但属于同一条链路）：

| 文件 | 职责 |
| --- | --- |
| `apps/cli/src/apps/mcp-server/cli.ts` | `pnpm mcp:server` 入口：createMcpServer + connectStdio，横幅打 stderr |
| `apps/cli/src/apps/chat/cli.ts`（`--mcp` 段） | 工具表合并：重名 MCP 胜出 + 中文告警 + 退出清理 |
| `scripts/mcp-dogfood.mjs` | 狗粮冒烟（真模型 + 真子进程，非 vitest）：`pnpm test:mcp-dogfood` |
| `test/mcp-server.spec.ts` | 出方向协议往返测试：InMemoryTransport 对连，零网络 |
| `test/mcp-client.spec.ts` | 进方向桥与适配器测试：含"循环不可区分"头号断言 |

**头牌原则：MCP 工具与本地工具对循环不可区分。** `runToolLoop` 只认
`Record<string, AgentTool>`（description / inputSchema / execute 三件套），
不问工具出身。JSON-RPC、传输、握手、双通道结果……协议的全部复杂性都被压在
server / client / adapter 三个文件的**边界**上；循环、评估、观测链路
（`onStep`）都不知道 MCP 存在。这不是口号，是测试断言：`mcp-client.spec.ts`
的头号用例让剧本模型（借自 `evals/fixtures.ts` 的 `createScriptedModel`）
对 MCP 适配工具发起调用，`runToolLoop` 零改造地调度回灌，`onStep` 采集到的
输出与本地 zod 工具形状无差别。

## 三、各部分原理

### 3.1 Server 暴露（server.ts）：zod 直传 + 动态资源 + 惰性装配

- **zod 直传，单一真源**：`registerEngineTool` 先收窄检查
  `inputSchema instanceof z.ZodType`（不是 zod 属编码错误，当场炸而不是静默
  降级），然后把**同一个 zod 对象**递给 `server.registerTool`——官方 TS SDK
  直接吃 zod，schema 不复制不改写。本地循环与 MCP 客户端看到同一张参数图纸，
  改名改参只改 `demo-tools.ts` / `kb-search.ts` 一处。SDK 在回调前已按
  inputSchema 校验解析参数，execute 拿到的就是合法入参。
- **为什么只有三个工具**：getOrderStatus / createTicket / searchKnowledge；
  `escalateToHuman` 刻意不注册——转人工是客服会话内的动作（HandoffPack 要吃
  会话上下文），MCP 是无会话的协议边界，挂出去只会收到缺上下文的空调用。
- **双通道输出**：`content`（文本 JSON，给人和不支持 structuredContent 的
  客户端读）+ `structuredContent`（原对象，给程序读）。出方向写一次，
  进方向的适配器优先消费 structuredContent——自家狗粮两头对上。
  ai v5 要求的 `toolCallId` / `messages` 在 MCP 侧无对应概念，填合成值
  （`mcp-${name}-${randomUUID()}` 与空数组，这三个工具都不消费它们）。
- **ResourceTemplate 而非静态注册**：`docs://kb/{docId}` 用资源模板是刻意的——
  文档在运行时增删（入库/下架），静态注册只在构造瞬间拍一次快照会立刻过期；
  模板的 list 回调让每次 `listResources` 现查 `listDocs()`，读时现调
  `readDoc(docId)`，客户端永远看到知识库的当前真相。全文按块 index 升序拼回
  （测试故意乱序入库，专抓排序缺失）。
- **resolveStore 的 pristine-default 探测与懒装配**：模块加载时快照
  `retrieve.ts` 的出厂内存库引用；首次真正用存储时若全局还是这个出厂库
  （宿主没 `setRagStore`），才按 env 工厂换库（默认 json 快照，
  `RAG_STORE=pgvector` 切 PG）——与 kb CLI 启动行为逐字一致；测试注入的
  种子库（引用已变）绝不覆盖。装配后幂等。
- **stdio 纪律**：stdout 归协议所有（换行分隔的 JSON-RPC 帧），任何日志只能走
  stderr——在 stdout 打一行启动横幅 = 往协议流里塞脏字节，客户端解析当场崩。
  所以 `connectStdio` 只挂 StdioServerTransport，横幅留给 CLI 入口打 stderr。
  `pnpm mcp:server` 起的就是标准 stdio MCP 服务器，Claude Desktop / Cursor
  这类客户端可直接挂载（Windows 下配置命令同样记得 `cmd /c` 包层）。

### 3.2 Client 消费（client.ts）：两条通道，同一个桥形状

- **StdioClientTransport 桥**（spawn 子进程，真实外部服务器/狗粮）与
  **InMemory 变体**（Client ↔ McpServer 同进程对，离线测试与嵌入式场景），
  返回同一个 `McpClientBridge`（name / tools / close），下游不感知差异。
  InMemory 有顺序铁律（P1 实证）：**server 先 connect，client 后 connect**——
  client 的 connect 会立刻发 initialize，server 没挂上传输就成了发往虚空的
  超时请求。
- **env 合并保 PATH**：SDK 的 env 参数是**整体替换**而非合并——只传
  `{ FOO: 1 }` 会把 PATH 一起丢掉，`cmd /c pnpm` 当场解析失败。桥里显式
  `{ ...getDefaultEnvironment(), ...options.env }`：继承默认安全变量，
  再叠加调用方覆盖项。
- **close 杀子进程的既定序列**（从 SDK 1.31.0 源码核实，写在文件头）：
  `client.close()` → `transport.close()`：先 `child.stdin.end()`（优雅 EOF）
  等 2s → SIGTERM 再等 2s → SIGKILL。stdio 服务器读完 stdin 自然退出。
  已知边界：Windows 无进程组杀，外部服务器若无视 EOF，杀 cmd.exe 收不了它的
  孙进程——传输暴露 pid getter 供审计兜底，桥里不加双杀的黑科技。
- **Windows 的 `cmd /c` 是文档约定不是硬编码**：StdioClientTransport 用
  `spawn` 且不开 shell，Windows 上 pnpm/npx 是 `.cmd` 垫片，直唤 ENOENT/
  EINVAL。解法不是全局 `shell: true`（等于给命令行开注入口），而是文档化
  命令形态 `--mcp "cmd /c pnpm mcp:server"`，让 cmd.exe 当垫片层——桥本身
  保持传输用法上的正统。
- **连接失败不留孤儿**：连上但 listTools 失败时先 `client.close()` 收掉已
  spawn 的子进程再抛带修复指引的中文错误。

### 3.3 适配器（adapter.ts）：照单全收 + 依赖倒置

> 导出入口：`mcpToolToAgentTool(caller, descriptor)`——依赖倒置的两个参数都是最小结构接口（`McpToolCaller` / `McpToolDescriptor`），SDK 的 Client 与测试假件都能直接喂进来。

- **JSON Schema 照单全收**：生态里外部服务器的 schema 是 JSON Schema
  （不认识、也不可能预知）。适配器不复制不改写：ai 的 `jsonSchema()` 把原始
  JSON Schema 包装成 SDK 认识的 Schema 对象，原样透传给模型（参数图纸由
  服务器说了算），校验责任也在服务器侧。本文件**刻意不 import zod**——
  一旦引了 zod 就等于替服务器"翻译"schema，翻译即失真。
- **结果映射四级瀑布**：① structuredContent（结构化结果，原样上抛）→
  ② text 内容块按序拼接（纯文本工具的常规形态）→ ③ toolResult 兜底
  （2024-11-05 旧协议兼容形状）→ ④ 都没有 → 中文报错（图片/音频类工具
  暂未适配，宁可报错也不静默吞掉）。
- **isError → 中文错误**：协议约定服务器侧执行失败也走正常返回、靠 isError
  标记（不抛异常）——适配器翻译成异常，引擎循环的 errorOutput 通道
  （✗ 观察）才能接住它。传输层失败（服务器死了/管道断了）同样包装成中文
  并保留原始信息，让使用者知道下一步查什么。
- **依赖倒置最小接口**：适配器只依赖 `McpToolCaller`（能 callTool 即是
  "客户端"）——真实链路传 SDK Client 实例（结构兼容，零包装），单元测试传
  手写的桩对象就能测 isError / 内容映射，不需要任何传输层。
- **入参收窄**：静态类型 unknown（照单全收），运行时只放行对象或缺省——
  模型若传数组/字符串，MCP 侧的 arguments 也装不下，当场中文报错。

### 3.4 chat --mcp 接线（apps/cli/src/apps/chat/cli.ts）

- **启动期装配**：`--mcp` 的值按空白切分（首 token = 命令，其余 = 参数），
  `createMcpClientBridge` 完成 spawn + initialize + listTools + 适配，全部
  就绪才进 REPL——连接失败当场退出码 1 + 修复指引，不带着半残的工具表聊天。
- **工具表合并**：本地表与 MCP 适配表在类型层已是同一张脸（ai 的 ToolSet），
  `{ ...local, ...bridge.tools }` 完事；**重名时 MCP 胜出**（显式接入的外部
  服务器优先），但必须把覆盖了谁说清楚——静默覆盖会让"为什么查订单走的是
  MCP"变成悬案，所以打中文警告。
- **退出清理**：`/exit` 与 EOF 两条退出路径汇合后先 `await mcpBridge?.close()`
  （SDK 序列收子进程）再返回——不带活的 MCP 子进程退出留下孤儿。
- **狗粮证据**：`pnpm chat --mcp "cmd /c pnpm mcp:server" --trace`——引擎的
  聊天代理通过客户端桥消费引擎自己的 MCP 服务器，进出两个方向在同一条
  stdio 管线上互验。`pnpm test:mcp-dogfood` 已实测：真实 GLM 模型选择调用
  MCP 来源的 getOrderStatus（trace 的 `⚙ 行动 step 1 → 要调 1 个工具：
  getOrderStatus` 事件为证），重名覆盖警告与 `✓ 观察` 回灌都在案，干净退出
  码 0。它独立于 vitest 而存在，正因为这条链路要真 spawn + 真模型，不满足
  离线铁律。

## 四、原理 → 代码对照表（学习自测清单）

| 你应该能回答 | 对应实现 |
| --- | --- |
| 工具为什么要上协议？一句话？ | 本文第一节：点对点集成 M×N 份胶水 → 协议化 M+N，schema/校验/发现协议全包 |
| server 端 schema 为什么敢直传 zod？ | `server.ts` `registerEngineTool`：收窄检查后同一 zod 对象递给 registerTool（SDK 直接吃 zod），单一真源零复制 |
| 为什么 escalateToHuman 不挂出去？ | `server.ts` 头注释：转人工吃会话上下文（HandoffPack），MCP 是无会话边界 |
| content 与 structuredContent 各给谁读？ | `server.ts` 双通道：文本 JSON 给人/旧客户端，原对象给程序；适配器①优先消费后者 |
| 知识库资源为什么用 ResourceTemplate？ | `server.ts`：文档运行时增删，静态注册拍快照会过期；模板 list 回调现查 listDocs |
| resolveStore 怎么做到"宿主的库绝不覆盖"？ | `server.ts`：模块加载时快照出厂库引用，只有引用仍 === 出厂库才按 env 换库 |
| stdio 的 stdout 里跑的是什么？日志为什么走 stderr？ | 换行分隔的 JSON-RPC 帧；stdout 打日志 = 塞脏字节，客户端解析当场崩 |
| Windows 为什么要 `cmd /c`？为什么不开 shell:true？ | `client.ts` 头注释：spawn 不开 shell 直唤 .cmd 会 ENOENT；shell:true 是注入口，文档化命令形态才是正解 |
| SDK 的 env 为什么必须合并 getDefaultEnvironment？ | `client.ts`：env 是整体替换，只传覆盖项会丢 PATH，cmd /c pnpm 解析失败 |
| close 收子进程的三段序列？ | `client.ts` 头注释（SDK 1.31.0 源码核实）：stdin EOF 等 2s → SIGTERM 等 2s → SIGKILL |
| 适配器为什么刻意不 import zod？ | `adapter.ts`：接进来的 schema 是 JSON Schema，引 zod 即"翻译"，翻译即失真；jsonSchema() 原样透传 |
| isError 为什么翻译成异常而不是当返回值？ | `adapter.ts`：引擎循环的 errorOutput 通道（✗ 观察）靠异常接住失败 |
| 重名工具谁胜出？为什么要警告？ | `chat/cli.ts` `mergeMcpTools`：MCP 胜出（显式接入优先）+ console.warn——静默覆盖变悬案 |
| 测试怎么零网络验证协议？ | 两个 spec：InMemoryTransport 同进程对连，走真实 JSON-RPC 往返，不 spawn 不碰网 |

## 五、推荐学习顺序（总计约 2 小时）

```text
原理 → 最小的适配器 → 出方向 → 进方向 → 接线 → 测试 → 动手狗粮
```

| 步骤 | 文件 | 学什么 | 通关标准 |
| --- | --- | --- | --- |
| 0 | 本文 | 双向价值 + 头牌原则（边界消化协议） | 能回答第四节 14 问 |
| 1 | `adapter.ts` | 最小的一个文件：照单全收 + 依赖倒置 + 四级映射 | 能说出"为什么不 import zod"与 McpToolCaller 的接缝意义 |
| 2 | `server.ts` | 出方向：zod 直传 / 资源模板 / 惰性装配 / stdio 纪律 | 能解释 pristine-default 探测与 ResourceTemplate 的 list 回调 |
| 3 | `client.ts` | 进方向：两条通道 / env 合并 / close 序列 / Windows 纪律 | 能复述 close 三段序列与 cmd /c 是文档约定的理由 |
| 4 | `apps/mcp-server/cli.ts` + chat 的 `--mcp` 段 | 两端入口：横幅走 stderr、工具表合并、退出清理 | 能说出重名时谁胜出、连接失败时退出码是多少 |
| 5 | 两个 `test/*.spec.ts` | 协议往返怎么离线测；头号断言"循环不可区分"长什么样 | 能指出剧本模型从哪借来、断言的 output 为什么是结构化对象 |
| 6 | ✋ 动手 | `pnpm test:mcp-dogfood`（需 .env 配 key） | 亲眼看到 ⚙ 行动调 getOrderStatus + 重名警告 + 退出码 0 |

## 六、随时可回的加油站

- **协议原语（tools/resources）忘了** → week18 [Day 1 概念篇](../../../../../docs/week18/day1.md)；Day 2/3 是 Python FastMCP / LangGraph 对照版
- **stdio / close 序列看不懂** → `client.ts` 文件头注释（从 SDK 1.31.0 源码核实的原话）
- **测试怎么不 spawn 就测协议** → 两个 spec 的 beforeAll：InMemoryTransport.createLinkedPair + server 先 connect
- **实现读不懂** → 每个文件头部注释 = 该文件的小地图，"为什么"都写在代码旁边

## 七、扩展路线（安全闭环已落地）

| 方向 | 内容 | 状态 |
| --- | --- | --- |
| 安全护栏 | week18 Day 5：本目录隔壁 `../guardrails/`——白名单 / 注入扫描 / 人工确认 / PII 脱敏四件套；chat CLI 的装配**只给 MCP 来源的工具套闸**（`AGENT_GUARD_*` 环境开关，全关 = 零变化，与引入前逐字节一致） | ✅ 已实现 |
| 人工审批 | week18 Day 6：apps/api 的 SSE `approval` 事件 + `POST /api/chat/approve` 裁决端点（`AGENT_CONFIRM_TOOLS` 名单，默认 createTicket；60s 超时自动拒绝）——引擎 `agent-loop.ts` 一行未改，API 层对工具表包壳实现 | ✅ 已实现 |
| streamable-http 传输 | 服务器要部署到别的机器、给多个 Agent 共用时的正解（week18 Day 2 的选型对照：本地单 Host 用 stdio 什么都不用配）。注意 week18 周索引的提醒：MCP 规范 2026-07-28 版已改为无状态协议（移除 initialize 握手）——本目录基于 SDK 1.31.0（有握手的版本），升级时留意规范版本差 | ⏳ |
| prompts 原语 | MCP 三大原语的第三个（Server 暴露可复用 prompt 模板）；本项目只用了 tools + resources 两个 | ⏳ |

**安全为什么只闸 MCP 工具**：外部服务器是我们控制不了的面——schema 它说了算、
执行体在它进程里；本地演示工具是自己写的代码。信任边界在哪，闸就装在哪
（chat CLI 的护栏装配段注释原话）。
