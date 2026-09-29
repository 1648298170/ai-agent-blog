# agent-app 架构与实现详解

> 面向学习的实现文档：讲清每个模块**是什么、为什么这么写、踩过什么坑**。
> 配合源码读，效果最好。快速上手（怎么跑）看 [README.md](./README.md)，本文讲"为什么"。

## 1. 这个项目是什么

教程《AI Agent 全栈工程师 23 周》**TypeScript 主线**的可运行落地项目。教程分两条引擎路线：Python（LangGraph，选修）和 Node + TS（推荐主线）——本项目就是主线的完整实现：

- **共享引擎**：手写多步工具循环、RAG 检索、三层记忆（对应教程 week11 的四篇 TS 补篇）
- **两条产品线**：知识库问答（kb）、智能客服（service）（对应 `docs/products/` 的组装说明书）
- **HTTP API 层**：NestJS 服务壳（对应教程 week20 的 BFF 形态）

技术栈：`ai`（Vercel AI SDK 5.0.266）+ `@ai-sdk/openai`（OpenAI 兼容网关，默认智谱 GLM）+ `zod` + TypeScript（NodeNext ESM）+ NestJS 12 + pnpm。

## 2. 一图看懂整体架构

```text
┌──────────────────────  入口层（同一套引擎的两张脸）  ─────────────────────┐
│  CLI（apps/cli，tsx 直跑）               HTTP API（apps/api，NestJS）       │
│  chat / kb / service REPL               /api/chat(stream|kb|service)     │
└──────────────┬──────────────────────────────────┬───────────────────────┘
               │                                  │
               ▼                                  ▼
┌───────────────────────────  应用逻辑层  ─────────────────────────────────┐
│  kb 产品线    入库(切块→向量→快照) + 带引用问答（入库核心在 engine/rag/ingest） │
│  service 产品线 supervisor(硬规则→模型三分类) → 三工人 → 转人工（核心在 engine/service）│
└──────────────┬───────────────────────────────────────────────────────────┘
               ▼
┌───────────────────────────  引擎层 engine/（框架无关）────────────────────┐
│  agent-loop  手写多步工具循环（①入账 ②调度 ③回灌）                        │
│  rag/        递归切块 → 批量嵌入 → 余弦检索 → 引用拼装（+JSON 快照库）      │
│  memory/     会话窗口(超限压缩) / 用户偏好 / 情景记忆                     │
│  llm         OpenAI 兼容网关接入（GLM / Qwen / DeepSeek 可切换）           │
│  trace       执行轨迹开关（▶⚙✓🧭🔎🧠）        json-utils  宽松 JSON 提取  │
└──────────────┬───────────────────────────────────────────────────────────┘
               ▼
┌───────────────────────────  工具层 tools/ ───────────────────────────────┐
│  registry 工具注册表   demo-tools 查订单/建工单/转人工   kb-search 知识检索 │
└──────────────────────────────────────────────────────────────────────────┘
```

**分层的意义**：引擎不知道 HTTP 的存在，产品线不知道 REPL/API 的存在。换存储（内存→pgvector/Redis）、换入口（CLI→Web）都只动一层。

## 3. 目录结构逐项说明

```text
agent-app/                        # pnpm workspace 根（packages/* + apps/*）
├── packages/
│   ├── engine/                   # @agent-app/engine：框架无关引擎（构建出 dist + .d.ts）
│   │   └── src/
│   │       ├── config.ts         # 手动解析 .env（不引 dotenv），类型化四件套配置
│   │       ├── agent-loop.ts     # ★ 手写多步工具循环 + ToolLoopAgent（本文 4.1）
│   │       ├── llm.ts            # createOpenAI({apiKey, baseURL}) → 聊天/嵌入模型单例
│   │       ├── trace.ts          # 轨迹开关：AGENT_TRACE=1 或 --trace，输出走 stderr
│   │       ├── json-utils.ts     # extractJson：宽松解析模型回复里的 JSON（本文 8.3）
│   │       ├── rag/
│   │       │   ├── types.ts      # 契约：Chunk / RagStore（换 pgvector 的接缝）
│   │       │   ├── chunker.ts    # 递归切块：段落→句子→硬切，500/80 滑窗重叠
│   │       │   ├── embedder.ts   # 批量嵌入（32/批）+ 中文配置错误提示
│   │       │   ├── store.memory.ts # 内存余弦检索库（NaN 安全）
│   │       │   ├── retrieve.ts   # searchKnowledge + formatCitations（+setRagStore 换库接缝）
│   │       │   ├── persistence.ts # JsonRagStore：内存检索 + 文件快照，跨进程共享
│   │       │   └── ingest.ts     # 入库核心：extract + ingestSource（CLI 与 API 共用主干）
│   │       ├── memory/
│   │       │   ├── types.ts      # 契约：SessionStore / PreferenceStore / EpisodicStore
│   │       │   ├── session.memory.ts    # 窗口截断 + 超 40 条滚动摘要压缩（可注入假摘要器）
│   │       │   ├── preference.memory.ts # (userId, key) → value 长表 + 限长护栏
│   │       │   └── episodic.memory.ts   # 情景记忆：向量相似 top3 召回
│   │       ├── tools/
│   │       │   ├── registry.ts   # ToolRegistry：名字 → 工具
│   │       │   ├── demo-tools.ts # getOrderStatus / createTicket / escalateToHuman
│   │       │   └── kb-search.ts  # searchKnowledgeBase（knowledge 工人专用锤子）
│   │       ├── service/          # 客服产品核心（CLI 与 HTTP API 共用，禁止 app 互相 import）
│   │       │   ├── supervisor.ts # 硬规则 → 模型三分类路由
│   │       │   ├── workers.ts    # order / refund / knowledge 三工人
│   │       │   └── handoff.ts    # 转人工：建工单 + HandoffPack 上下文包
│   │       └── types/pdf-parse.d.ts # pdf-parse 子路径导入的类型补丁（坑，见 8.2）
│   └── shared/                   # @agent-app/shared：纯类型契约（SSE 事件 / 错误体 / 路由 / HandoffPack）
├── apps/
│   ├── cli/                      # @agent-app/cli：tsx 直跑源码（无构建产物）
│   │   └── src/                  # index.ts CLI 路由 + selftest.ts + apps/chat|kb|service REPL
│   ├── api/                      # @agent-app/api：NestJS 层（本文第 7 节；tsc 编译后 node dist 运行）
│   │   └── src/                  # main / app.module / chat|kb|service 控制器与服务
│   └── web/                      # 占位：week20 Next.js 前端（消费 @agent-app/shared 的 SSE 类型）
├── samples/                      # 入库样例（company-faq.md 制度 FAQ / dummy.pdf）
├── .env / .env.example           # 网关配置（默认 GLM：open.bigmodel.cn/api/paas/v4）
└── package.json / tsconfig.base.json / pnpm-workspace.yaml  # 根脚本统一从 agent-app 跑（cwd 决定 .env/.data 位置）
```

## 4. 引擎层实现细节（学习的核心）

### 4.1 手写工具循环 `agent-loop.ts` —— 全项目的心脏

> 📦 **单仓化**：engine 已独立为 @agent-app/engine 包（packages/engine），边界层经包子路径导入（如 `@agent-app/engine/agent-loop`）；supervisor / workers / handoff 等客服产品核心与 RAG 入库核心同在引擎包内，CLI 与 HTTP API 共用。

Agent 的本质就一句话：**模型说要干嘛 → 你替它干 → 把结果喂回去 → 重复，直到模型直接回答**。SDK 能帮你转，但教程坚持手写一遍，因为审计、审批、缓存、追踪都发生在这一圈的某个点上。

```ts
for (let step = 1; step <= maxSteps; step++) {          // maxSteps 是保险丝，默认 5
  const result = await generateText({ model, messages, tools: schemaTools, system });

  if (result.toolCalls.length === 0) {
    return { text: result.text, messages, steps: step }; // 模型开口了 → 出口
  }

  messages.push(...result.response.messages);           // ① 入账：模型的调用意图
  for (const call of result.toolCalls) {                // ② 调度：本地执行工具
    const output = jsonOutput(await tool.execute(call.input, { toolCallId, messages }));
    messages.push({ role: "tool", content: [/* ③ 回灌：tool-result 消息 */] });
    onStep?.({ step, toolCall, output });               // 观察钩子（SSE/轨迹都挂这）
  }
}
throw new Error(`步数用完（${maxSteps}），模型仍在要工具`); // 防死循环
```

三个必懂的细节（都是踩坑换来的）：

1. **为什么喂给模型的是 schema-only 视图？** `ai@5.0.266` 如果把带 `execute` 的工具直接传给 `generateText`，SDK 会**自动执行**并把 tool-result 合入 `response.messages`——和我们的手写调度重复入账。所以 `toSchemaTools()` 只保留 `description` + `inputSchema`，执行权握在自己手里。这正是教程手写版「工具只写 schema 不写 execute」的等价实现。
2. **tool-result 的 output 有形状约束**：这版类型收紧为 `LanguageModelV2ToolResultOutput`——正常结果 `{type:"json", value}`，失败 `{type:"error-json", value}`。失败也要结构化地喂回去，模型才能"看出这是失败"并换策略，而不是当成功数据编故事。
3. **`onStep` 是纯观察钩子**：回灌落账后才广播，订阅方（SSE 端点、轨迹）看到的永远是已提交状态。不传时行为与旧版完全一致。

`ToolLoopAgent` 类是教程里 SDK 版 `stopWhen: isStepCount(5)` 的对照物：消息历史收进类里，调用方只给 prompt 拿 text。

### 4.2 RAG 四件套（`engine/rag/`）

> 📐 **先原理后实现**：这个模块的数学原理（Embedding 为什么能让"语义"变"坐标"、余弦相似度公式手算、Top-K 与 HNSW 的关系）单独写在 [`packages/engine/src/rag/README.md`](./packages/engine/src/rag/README.md)——读代码前先读它，本文只讲工程实现。

**切块 `chunker.ts`**：递归切块，三级瀑布——

1. 空行分段（中文文档最自然的边界）
2. 段内按句末标点（`。！？!?.;；`）分句，句子累加到 500 字封顶成块
3. 单句仍超上限（典型：一长串没标点的文本）→ 滑动窗口硬切，**步长 = maxLen − overlap**，保证相邻块恒定共享 80 字重叠

重叠的意义：横跨切口的句子在相邻两块各留一份，**两种问法都能检索到**。单句超上限时不拦腰切（教程取舍：宁可这块长一点，保句子完整）。

**嵌入 `embedder.ts`**：`embedMany` 一次 32 条批量（一块一个请求是几百次 HTTP 往返的错误姿势）；缺 key / 网关不通时抛**带配置指引的中文错误**，错误信息本身就是排障文档。

**检索库 `store.memory.ts` + `retrieve.ts`**：余弦相似度 top-k。两个设计点：

- `setRagStore()` 是**换库接缝**：现在挂内存 Map，将来换 pgvector 检索代码一行不改
- 引用编号由**后端分配**（`[1] 标题` 来自检索结果，不是模型说的）——来源标题在模型手里是可以被编造的素材，在检索结果里才是事实

**快照 `persistence.ts`**：`JsonRagStore` 装饰器包住内存库，upsert/deleteDoc 时把全量 chunk 写进 `.data/kb-store.json`。入库和问答是两个进程，靠这个文件共享知识库——内存版的权宜，接口不变，换 pgvector 时删掉这层即可。

> 🐘 **pgvector 实现已就位（week14 实战）**：`store.pgvector.ts`（kb_chunks 表 + `<=>` 余弦检索）与 env 工厂 `store.factory.ts` 均在库——`RAG_STORE=pgvector` 一键切换，`json`（默认）行为不变。

### 4.3 三层记忆（`engine/memory/`）

> 🧠 **先原理后实现**：Agent 为什么没记忆、三层各自解决什么问题、压缩的取舍——单独写在 [`packages/engine/src/memory/README.md`](./packages/engine/src/memory/README.md)，读代码前先读它。

| 层 | 存什么 | 键 | 本实现 | 教程对应 |
| --- | --- | --- | --- | --- |
| 短期 | 会话窗口（最近 20 轮） | sessionId | Map + 超限压缩 | Redis + TTL |
| 长期 | 用户偏好（"喜欢简洁回复"） | (userId, key) | Map 长表 | PG 表 upsert |
| 情景 | 相似历史对话 | 向量相似 | Map + 余弦 top3 | pgvector |

短期记忆的**压缩**最有讲头（`session.memory.ts`）：

- 消息超过 **40 条**触发：最老的溢出部分让 LLM 压成 ≤150 字摘要，以一条合成 `system` 轮（`[会话摘要] ` 前缀）挂在窗口头，最近 20 条原样保留
- **滚动**：已有摘要会并入下一轮的压缩 prompt（"已有摘要：…"），信息不因压缩断档
- **可测试性**：摘要器是构造函数可注入参数（`new InMemorySessionStore({ summarize })`）——自检注入假摘要器，离线覆盖"压缩成功"和"失败降级"两条路径，不打一次真 API
- **降级**：没 key / 网关不通 → 退回纯窗口截断，绝不炸主流程

> 🟥 **Redis / PG 实现已就位（week17 实战）**：`session.redis.ts`（`agent:sess:{id}` list + TTL 24h 续期）与 `preference.pg.ts`（user_preferences 行级 upsert）共用 `compression.ts` 这一份压缩算法——`SESSION_STORE=redis` / `PREFERENCE_STORE=pg` 一键切换，默认 `memory` 行为不变（情景记忆 pgvector 版为后续路线）。

### 4.4 小零件

- **`config.ts`**：手动解析 `.env`（只认 `KEY=VALUE`，环境变量优先），不引 dotenv——依赖越少越接近教程"看得见全部机制"的要求
- **`trace.ts`**：`AGENT_TRACE=1` 或 `--trace` 开启，输出走 **stderr**（stdout 保持干净可管道）；一行布尔判断，关闭时热路径零开销
- **`json-utils.ts`**：`extractJson` 从模型回复里抠 JSON（容忍 ```json 围栏和前后废话）。存在理由见坑实录 8.3

## 5. 工具层：锤子怎么造、怎么发

```ts
export const getOrderStatus = tool({
  description: "查询订单状态与预计送达时间",
  inputSchema: z.object({ orderId: z.string().describe("订单号，如 A-1024") }),
  execute: async ({ orderId }) => ({ orderId, status: "已发货", eta: "预计 18 点前送达" }), // mock
});
```

- **zod schema 是给模型看的 API 文档**：`description` 写得越准，模型调参越不容易跑偏
- **工具按工人裁剪**（最小权限思想）：order 工人只发查订单的锤子，refund 工人只发建工单的——模型手里锤子越少，乱调工具的空间越小

## 6. 两条产品线的实现

### 6.1 知识库问答 kb

```text
入库：读文件(.txt/.md/.pdf) → chunkText 切块 → embed 批量向量 → JsonRagStore.upsert（快照落盘）
问答：问题 → searchKnowledge top5
      → 空结果？老实说"知识库里没有"（边界问题的信任分水岭，不硬编）
      → 命中块编号拼进 prompt → system 约束"只依据资料回答，句末标 [1][2]"
      → 答案 + formatCitations 引用块
降级：LLM 挂了 → 交出检索原文 + 出处（链路上哪段活着就交哪段的产出）
```

PDF 解析的坑见 8.2。`pdf-parse` 必须从 `pdf-parse/lib/pdf-parse.js` 子路径导入——包入口文件在 CJS 环境会误跑自检代码。

### 6.2 智能客服 service

```text
用户消息 → 维护「连续未解决」计数（用户说"不是这个/到底怎么办" +1，否则清零）
        → supervise：
           ① 硬规则（纯函数，零 LLM，优先级从高到低）：
              连续 2 轮未解决 → human
              用户明确要求（转人工/找真人…） → human
              高危白名单（投诉/退款争议/起诉/律师/媒体…） → human
           ② 全不命中 → 模型 JSON 三分类（order/refund/knowledge + reason）
        → 工人：runToolLoop + 该工人专属工具表 → 回复
        → human：建工单 + HandoffPack {工单号, 原因, 用户摘要, 最近对话}
```

两条铁律：

- **硬规则永远排在模型前面**。"连续两轮没解决"是计数、"用户喊转人工"是关键词——代码数得比模型准，零成本零延迟行为可测。模型只兜模糊地带（"别让它替你数数"）
- **转人工是业务流程的正常一步，不是异常**。模型路由不可用时**直接转人工而不是报错**（service.md 上线检查清单第 8 条的降级链路）——用户侧永远看到"已转接"，看不到堆栈

## 7. HTTP API 层（NestJS）

引擎和产品逻辑零改动，外面套一层服务壳：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/chat` | 非流式对话（runToolLoop + 会话记忆） |
| GET | `/api/chat/stream` | SSE：`session → step(工具调用/结果) → delta(答案分片) → done` |
| POST | `/api/kb/ingest` | multipart 上传入库（字段 `file`） |
| POST | `/api/kb/query` | `{question, topK?}` → `{answer, citations}` |
| POST | `/api/service/message` | `{sessionId?, message}` → `{route, reply, handoff?}` |

关键实现决策：

- **tsx 跑不了 NestJS**：NestJS 构造器注入依赖 `emitDecoratorMetadata`，而 tsx/esbuild 不支持。方案：`experimentalDecorators + emitDecoratorMetadata` 开进 apps/api 的 tsconfig，`pnpm api = 构建 @agent-app/engine + @agent-app/api 后 node apps/api/dist/main.js`（见坑 8.4）
- **SSE 复用 `onStep`**：循环每步的工具调用/结果直接变成 `{type:"step"}` 事件——week20 的 Thought/Action/Observation 面板数据源
- **全局异常过滤器**：引擎抛出的中文错误统一转 `{statusCode, message, hint}`，LLM/配置类错误附 `.env` 配置指引——CLI 和 API 一套错误礼仪
- **DTO 校验**：class-validator 装饰器（`@IsString @IsNotEmpty`）+ 全局 ValidationPipe，脏输入 400 挡在门外

## 8. 踩坑实录（最值钱的部分）

### 8.1 SDK 自动执行工具 → 重复入账

带 `execute` 的工具直接给 `generateText`，SDK 执行完把结果合进 `response.messages`，手写循环再灌一遍 → 同一调用意图出现两次。解法：schema-only 视图（见 4.1）。

### 8.2 pdf-parse 的两个坑

包入口 `index.js` 含调试自检代码（CJS 下打印输出）；必须 `import "pdf-parse/lib/pdf-parse.js"` 子路径。且它无 TS 类型、不导出类型 → 手写 `packages/engine/src/types/pdf-parse.d.ts` 补声明。

### 8.3 glm-4-flash 无视 response_format → generateObject 必挂

`generateObject` 依赖网关的 `response_format` 结构化输出。**智谱网关 + glm-4-flash 静默无视它**：模型收到 JSON schema 指令却照常闲聊回复（实测原话在分析"A-1024 是什么协议"），JSON 解析必炸。解法（`json-utils.ts` + supervisor 重写）：

```text
generateText + 提示词里硬约定 JSON 格式 → extractJson 宽松解析（剥围栏/容忍废话）
→ zod safeParse 校验 → 不合规自动重试一次（附"你上次没按格式"提醒）→ 仍失败才抛错降级
```

教训：**跨网关的代码不能依赖网关特性，格式约束要写进提示词**。DeepSeek/Qwen/GLM 行为立刻一致。

### 8.4 tsx 与 NestJS 装饰器元数据

tsx/esbuild 不发 `emitDecoratorMetadata` → NestJS 构造器注入拿不到参数类型 → 启动即崩。解法：API 走 tsc 编译后 `node dist`（CLI 照旧 tsx，快）。**同一个仓库两种运行时是取舍而非不统一**。

### 8.5 tool-result 的 output 形状

`ai@5` 收紧为 `{type:"json"|"error-json", value}`，教程示例的裸对象编译不过。失败也走 `error-json` 结构化回灌——模型需要"知道失败了"。

### 8.6 测试管道的中文编码

PowerShell 管道向 node stdin 写中文默认 GBK，node 按 UTF-8 读成乱码 → 关键词匹配全失效。测试时先 `$OutputEncoding = [Text.Encoding]::UTF8`。（真实 TTY 交互不受影响。）

## 9. 一条消息的完整旅程（串起来看）

以 `pnpm service --trace` 里输入「订单A-1024到哪了」为例：

```text
用户输入 "订单A-1024到哪了"
  → service/cli：append 会话；isUnresolvedSignal("订单A-1024到哪了") = false → 计数清零
  → supervisor.checkHardRules：无关键词、计数 0 → null（纯函数，0ms）
  → classifyWithLlm：generateText(GLM) + JSON 指令
      🧭 路由 → 硬规则全不命中，交给模型三分类…
      🧭 路由 → 模型分类：order（查询订单状态）
  → workers.runOrderWorker → runToolLoop（工具表只有 getOrderStatus）
      ▶ 思考 step 1 → 调用模型（上下文 1 条消息，可用工具 1 个）
      ⚙ 行动 step 1 → getOrderStatus({"orderId":"A-1024"})
      ✓ 观察 step 1 → {"status":"已发货","eta":"预计 18 点前送达"}   ← ②③回灌
      ▶ 思考 step 2 → 调用模型（上下文 3 条消息）                    ← 模型看到结果了
      ◆ 完成 → 模型给出最终回答（25 字，共 2 步）
  → append 助手回复进会话 → 打印给用户
```

整个链条里每一步都有观测点（trace）和失败退路（降级），这就是"生产思维写 demo"的落地。

## 10. 与教程的映射 & 扩展路线

| 模块 | 教程出处 |
| --- | --- |
| 手写工具循环 / ToolLoopAgent / 多 Agent 模式 | week11/agent-loop-ts.md |
| RAG 全链路（切块/嵌入/检索/引用/降级） | week11/rag-ts.md |
| 三层记忆（窗口压缩/偏好/情景） | week11/memory-ts.md |
| 客服 Supervisor / 硬规则 / HandoffPack / 降级链路 | docs/products/service.md |
| 知识库引用问答 / 降级预案 | docs/products/kb.md |
| NestJS BFF / SSE 流式 | week20 |

**扩展路线**（接口都已留好缝）：

1. 换真存储：`RagStore` → pgvector 实现，`SessionStore` → ioredis 实现，业务代码一行不改
2. Next.js 前端：SSE 端点已按 `step/delta/done` 事件吐数据，前端直接消费
3. MCP 工具生态：week11/mcp-ts.md 的 `registerTool` 接进 `tools/registry`
4. 评估与生产化：promptfoo 评估集（week16）、限流/成本计量（week21）

---

*本文由实现过程沉淀而成；源码中文注释与本文互为对照，遇到不一致以源码为准并欢迎修正文档。*
