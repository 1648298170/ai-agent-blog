# 读代码前先读这篇：工具是怎么变成模型的"手脚"的

> 本目录解决 Agent 的"行动力"问题：LLM 本身只会生成文本，是工具让它能查订单、
> 建工单、搜知识库。这是引擎里最小的目录，但工具循环"调度"那一半的入口全在这里
> ——工具长什么样，决定了模型能做什么、做得多安全。
> 一句话哲学：**模型只点名，代码出手**。配合教程
> [week11 主线补篇 · Agent 循环 TS 深入](../../../../../docs/week11/agent-loop-ts.md)。

---

## 一、第一性原理：LLM 是"嘴"，工具是"手脚"

LLM 的输出只能是文本。所谓"Agent 会做事"，是把"模型的文本输出"翻译成"代码执行"的一套协议。拆开是两个问题：

1. **模型怎么知道有哪些工具、该怎么调？**——说明书：工具名 + `description` + `inputSchema`（zod 写的参数图纸），SDK 把它转成 JSON Schema 发给模型
2. **谁来真正执行？**——引擎。模型每轮最多"点名"（吐出 tool-call：工具名 + JSON 参数），执行权始终在代码手里

由此而来的两个工程性质：

- **模型永远不跑代码**：它产出的只是结构化"调用意图"，参数要过 zod 校验才会到 execute
- **说明书与实现天然分离**：`runToolLoop` 喂给模型的是剥掉 execute 的 schema-only 视图（`../agent-loop.ts` 的 `toSchemaTools()`），调度由循环自己做——这正是 `../types.ts` 里"execute 可缺省"语义的实战用法

## 二、核心设计

三条设计原则，每条都能在代码里指出落点：

1. **schema 即图纸，单一真源**：同一个 zod schema，既生成给模型看的参数说明，又校验模型回传的参数——说明书和验货标准是同一张纸，永远不会漂移
2. **演示与真实分层**：demo-tools 全 mock 数据（离线可跑、行为确定），kb-search 是第一个碰网的真工具——与全项目"离线优先"同构
3. **工具表按应用裁剪**：同一批工具，chat 拿 4 个，客服工人各拿 1 个——职责之外的锤子不发，误伤面从工具表上就掐掉

### 文件地图（7 个文件）

| 文件 | 职责 |
| --- | --- |
| `registry.ts` | 极简注册表 `ToolRegistry`：`register` 按名登记（同名覆盖、链式），`getAll()` 吐出 `generateText({ tools })` 要的形状，`names()` 供排障 |
| `demo-tools.ts` | 三个纯数据演示工具：`getOrderStatus` / `createTicket` / `escalateToHuman`（+ `HandoffPack` 接口 + `createDemoTools()` 打包） |
| `kb-search.ts` | `searchKnowledgeBase`：把 rag 的 `searchKnowledge` 包成工具，引用编号由后端分配 |
| `idempotency.ts` | 工具执行幂等层：`IdempotencyRegistry`（scope+参数指纹去重，TTL 窗口）+ `wrapToolsWithIdempotency` 壳——写操作防重复执行 |
| `compose.ts` | 工具壳组合器 `composeToolShells`：洋葱清单声明式叠加（审批外/幂等内的顺序即配置） |
| `index.ts` | 桶导出（`@agent-app/engine/tools` 子路径的公共面） |
| `README.md` | 本文 |

工具的**契约** `AgentTool` 不在本目录，在上级 `../types.ts`（见 3.1）。

### 工具表的实际组装（谁拿了哪几个）

| 消费方 | 工具表 | 出处 |
| --- | --- | --- |
| chat REPL | `{ ...createDemoTools(), searchKnowledgeBase }` 共 4 个 | `apps/cli/src/apps/chat/cli.ts` |
| service 三个工人 | order `{getOrderStatus}` / refund `{createTicket}` / knowledge `{searchKnowledgeBase}` 各 1 个 | `service/workers.ts` 的 `WORKER_TOOLS` |
| MCP 服务器 | 复用 demo-tools + kb-search 同一份定义，逐个 `registerEngineTool` | `mcp/server.ts` |
| selftest | `ToolRegistry` 登记 demo 三件套 → `getAll()` 喂 `runToolLoop` | `apps/cli/src/selftest.ts` |

## 三、各部分原理

### 3.1 AgentTool：schema 即图纸（../types.ts）

`AgentTool<INPUT, OUTPUT> = Tool<z.output<INPUT>, OUTPUT>`。加这层映射的原因：ai v5 的 `Tool` 泛型收的是"解析后的类型"而非 schema 类型——映射之后 `AgentTool<typeof mySchema>` 与 `Tool<z.infer<typeof mySchema>>` 等价，写工具时直接传 schema 即可。三个要点（都写在 types.ts 头注释里）：

- **inputSchema 用 zod 写**：生成与校验同一张图纸——模型看到的说明由它转出，模型回传的参数由它把关
- **execute 可缺省**：不写 execute，SDK 认为调度方自己执行。本项目正是这个用法：`toSchemaTools()` 把带 execute 的工具表剥成 schema-only 视图再喂 `generateText`，执行由循环调度（直接喂带 execute 的工具，SDK 会替你执行、与手写调度重复入账——`agent-loop.ts` 头注释）
- **OUTPUT 默认 any**：`toModelOutput` 对 OUTPUT 逆变，收窄成 unknown 会让具体工具塞不进注册表，与 ai 官方 Tool 的默认保持一致

顺带导出 `AgentToolSet`（= ai 的 `ToolSet`，名字到工具的表，`workers.ts` 的工具表类型就是它）和 `ModelMessage` 统一出口。

### 3.2 demo-tools.ts：为什么用纯数据演示

头注释一句话点破："数据全是 mock：本阶段验证的是「工具循环 + 调度」这条路，不是业务本身"。三个工具：

- `getOrderStatus(orderId)`：查固定 mock 订单表（`ORDERS` 三条：A-1024 已发货 / A-2048 仓库打包中 / B-0001 已签收）；查不到返回 `status: "未找到"` 并提示核对订单号——老实说找不到，不编
- `createTicket(subject, description)`：返回 `TK-日期-序号` 工单号（`nextTicketId()` 日期 + 进程内递增序号，保证不重复）
- `escalateToHuman(reason, transcript)`：返回 `HandoffPack`（ticketId / reason / transcript / createdAt）——转人工的体验分水岭：接手人第一眼就有完整背景，用户不用复述

**为什么纯数据**：① 离线——selftest 不碰网络就能跑通整个工具循环；② 确定——固定订单表让 selftest 能逐字断言工具输出（"已发货，明天 18 点前送达"）；③ 教学友好——读实现时注意力放在 schema 与返回形状上，不被业务噪声干扰。另注意 `description` 和 `.describe()` 本身就是 prompt 的一部分，措辞模型直接看得见。

### 3.3 kb-search.ts：第一个"真"工具 + 引用编号

`searchKnowledgeBase(query, k?)` 把 `rag/retrieve.ts` 的 `searchKnowledge` 包成工具：k 限 1~10、默认 5（与 HTTP API 的 DTO 约束同口径）。返回 `{ query, hitCount, hits }`，每个 hit 带 `no / title / text / score`（score 保留 3 位小数，是排查检索质量的第一手数据）。

关键设计是**引用编号由后端分配**（week15 Day 4 溯源思想）：`no: i + 1` 在 execute 里编好，description 只允许模型"引用哪块就标注对应编号，如 [1][2]"——编号与标题的映射始终握在代码手里，模型编不了页码。

它是本目录唯一会碰网的工具（检索要过 embedding），所以评测夹具刻意不用它（见 3.5）。

### 3.4 registry.ts：工具表的组装

`ToolRegistry` 只有 30 行：`register(name, tool)` 按名登记进 Map（同名重复注册以最后一次为准，返回 `this` 支持链式）；`getAll()` 吐出普通对象——正是 `generateText({ tools })` / `runToolLoop({ tools })` 要的形状；`names()` 给排障日志。头注释写明定位："应用侧各建各的 registry，工具列表按应用职责裁剪，互不干扰"。

诚实地说：目前产品线的工具表用**对象字面量**直接拼（见第二节组装表），`ToolRegistry` 的活跃消费方是 selftest——在那里验证"registry 吐出的表与手写循环兼容"。它的价值是给"按名登记"这个需求留了标准挂点：后续 MCP 接入、动态启停工具时，30 行的它就是扩展点。

### 3.5 对照：评测为什么另造一套夹具工具（../evals/fixtures.ts）

`createEvalTools()` 造了三个电商语义工具（search_orders / query_logistics / create_ticket），不复用本目录的真工具。头注释给了三条理由：① kb-search 会触发 embedding 网络调用，离线铁律被破；② 工具名即断言对象，评测要稳定词表，与演示工具的命名解耦，两边改名互不误伤；③ execute 全部返回固定 JSON（连工单号都固定为 `TK-EVAL-0001`——真 demo-tools 的时间戳+序号正是不确定性来源），打分 100% 可复现。

这反过来印证本目录的定位：**工具是"锤子"，循环才是被评的"手"**——轨迹评测评的是模型选没选对锤子、循环按什么顺序执行，不是锤子本身的实现。

## 四、原理 → 代码对照表（学习自测清单）

| 你应该能回答 | 对应实现 |
| --- | --- |
| 模型怎么"知道"一个工具怎么用？ | `description` + `inputSchema`（demo-tools.ts 每个工具的前两行），SDK 转成 JSON Schema 发给模型 |
| 为什么说"schema 即图纸"？生成与校验怎么就同一张了？ | `../types.ts` 头注释：zod schema 既转模型侧说明，又校验回传参数 |
| execute 不写会怎样？本项目谁在"调度"？ | `../types.ts`（SDK 认为调度方自己执行）+ `agent-loop.ts` 的 `toSchemaTools()`：剥 execute、循环自己调度 |
| 演示工具为什么用固定 mock 数据？ | `demo-tools.ts` 的 `ORDERS` 固定三条；`selftest.ts` 因此能逐字断言工具输出 |
| 转人工返回的 HandoffPack 里有什么、为什么？ | `demo-tools.ts` 的 `escalateToHuman`：ticketId/reason/transcript/createdAt，接手人的第一眼信息 |
| 引用编号 [1][2] 是模型写的吗？ | `kb-search.ts` execute 里 `no: i + 1` 后端分配，模型只被允许回标 |
| chat 和客服工人各拿哪些工具？为什么不一样？ | chat 4 个（`chat/cli.ts`）；工人各 1 个（`service/workers.ts` 的 `WORKER_TOOLS`）——职责外不发，误伤面掐掉 |
| 评测为什么不用真工具？ | `../evals/fixtures.ts` 头注释三条：离线铁律 / 词表解耦 / 确定性 |

## 五、推荐学习顺序（总计约 1 小时）

```text
契约 → 演示工具 → 真工具 → 组装 → 实战
```

| 步骤 | 文件 | 学什么 | 通关标准 | 时间 |
| --- | --- | --- | --- | --- |
| **0** | 本文 | schema 即图纸 / 点名与出手分离 | 能回答第四节 8 问 | 15min |
| **1** | `../types.ts` | AgentTool 的类型映射与 execute 可缺省语义 | 能说出 `AgentTool<typeof schema>` 等价于什么 | 10min |
| **2** | `demo-tools.ts` | 三个工具的 schema 写法 + HandoffPack | 合上文件能写出 escalateToHuman 的返回形状 | 15min |
| **3** | `kb-search.ts` | 真工具的包装 + 引用编号后端分配 | 能指出"模型编不了页码"的实现位置 | 10min |
| **4** | `registry.ts` + 第二节组装表 | 工具表按应用裁剪：chat 4 个 / 工人各 1 个 / MCP 复用 | 不看答案能复述组装表 | 10min |
| **5** | 动手实战 | `pnpm chat --trace` 问「订单 A-1024 到哪了？」 | 在 trace 里亲眼看到 ⚙ 行动（getOrderStatus）与 ✓ 观察（已发货） | 10min |

## 六、随时可回的加油站

- **zod / ai 的 Tool 类型看不懂** → `../types.ts` 头注释逐行就是答案（含 OUTPUT 为何默认 any）
- **引用编号 / 检索溯源忘了** → `kb-search.ts` 头注释；整套检索数学在 `../rag/README.md`
- **工具是怎么被调度的** → `../agent-loop.ts` 头注释：①入账 ②调度 ③回灌
- **某文件读不懂** → 每个文件头部注释 = 该文件的小地图

## 七、扩展路线

| 现在 | 路线 | 状态 |
| --- | --- | --- |
| 三个纯数据工具 | 换成真实后端（真订单 API / 真工单系统）：契约（AgentTool）不变，只换 execute | 教学留白——mock 数据表就是替换点 |
| 本地工具 | MCP：`mcp/server.ts` 已把这套工具逐个 `registerEngineTool` 暴露给任何 MCP 客户端，描述不复制，改名改参只改 demo-tools / kb-search 一处 | 已实现 |
| 无差别执行 | 工具审批：HTTP API 层按 `AGENT_CONFIRM_TOOLS` 名单（默认 `createTicket`）在 execute 前挂起等人工裁决，引擎一行未改 | 已实现（apps/api） |
| 30 行注册表 | 按需扩展：分类、描述导出、动态启停——`AgentTool` 契约不用动 | 按需 |
