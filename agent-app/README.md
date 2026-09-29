# agent-app · 教程 TS 主线项目（引擎骨架 + 两条产品线：知识库问答 / 智能客服）

博客教程（`docs/`）"TypeScript 主线"的配套可运行项目。第 1 阶段交付引擎核心，第 2 阶段组装两条产品线：

- **手写多步工具循环**：`generateText` → 入账 → 调度 → 回灌，不依赖任何 Agent 框架
- **RAG 零件**：切块、向量化、内存余弦检索、引用拼装（内存版，第 2 阶段接 pgvector）
- **三层记忆**：会话窗口 / 用户偏好 / 情景记忆（全部内存 Map 实现）
- **演示工具**：查订单、建工单、转人工（HandoffPack 上下文包）
- **产品线一（kb）**：知识库入库 + 带引用问答（`.txt/.md/.pdf` → 切块 → 向量化 → 检索 → `[1][2]` 引用）
- **产品线二（service）**：Supervisor 客服——硬规则转人工 + 三分类路由 + 三工人 + 工单/上下文包

> 📖 **想看实现细节与设计取舍（踩坑实录）？** 读 [ARCHITECTURE.md](./ARCHITECTURE.md) —— 架构图、每个模块的实现讲解、六条踩坑实录、一条消息的完整旅程。

## 快速开始

```powershell
cd agent-app
pnpm install
pnpm build               # 构建工作区包（shared → engine → api；cli 免构建，tsx 直跑源码）

# 1. 无网络自检：切块器 + 余弦检索库 + 会话/偏好/情景存储，不调任何模型
pnpm selftest            # 等价于 pnpm chat --selftest

# 2. 配置密钥后进入聊天 REPL（命令：/exit 退出，/new 新会话）
Copy-Item .env.example .env   # 填入你的智谱 API Key（默认接 GLM 网关，开 https://open.bigmodel.cn 拿 key）
pnpm chat

# 3. 统一入口路由
pnpm cli chat     # 已实现：手写工具循环聊天
pnpm cli kb       # 已实现：知识库问答（先 pnpm kb:ingest 入库）
pnpm cli service  # 已实现：Supervisor 智能客服

# 4. 类型检查
pnpm typecheck
```

> 单仓说明：`pnpm install` 后先 `pnpm build`（引擎/契约包产出 `dist` 供各端消费）。不配 `.env` 也能 `pnpm chat` 启动，首次调用模型时会打印清晰的配置错误提示，不会崩溃。

## 命令与教程周次映射

| 命令 | 作用 | 对应教程 |
| --- | --- | --- |
| `pnpm chat` | readline 聊天 REPL：会话窗口 + 手写工具循环 + 演示工具 | [week11 主线补篇 · Agent 循环 TS 深入](../docs/week11/agent-loop-ts.md) |
| `pnpm chat --selftest` / `pnpm selftest` | 无网络自检（切块 / 余弦检索 / 会话存储） | [week11 · RAG TS 全链路](../docs/week11/rag-ts.md)、[week11 · 记忆 TS 版](../docs/week11/memory-ts.md) |
| `pnpm cli chat` | 入口路由：聊天 | 同 `pnpm chat` |
| `pnpm cli kb` / `pnpm kb` | 知识库问答 REPL：检索 top5 → 带引用回答 | [products · 知识库问答](../docs/products/kb.md)、[week11 · RAG TS](../docs/week11/rag-ts.md) |
| `pnpm kb:ingest <文件>` | 知识库入库：切块 → 向量化 → 快照落盘（.txt / .md / .pdf） | [week11 · RAG TS](../docs/week11/rag-ts.md) |
| `pnpm cli service` / `pnpm service` | 智能客服 REPL：硬规则 + 三分类路由 + 三工人 + 转人工 | [products · 客服系统](../docs/products/service.md) |
| `pnpm test:service` | 客服硬规则离线自测（纯函数断言，无网络） | [products · 客服系统](../docs/products/service.md) |
| `pnpm typecheck` | `tsc --noEmit` 零错误检查 | — |

## 目录结构（pnpm workspace 单仓）

```text
agent-app/
├── packages/
│   ├── engine/                      # @agent-app/engine：框架无关引擎（tsc 构建出 dist + .d.ts）
│   │   └── src/
│   │       ├── config.ts            # 手动读 .env（不引 dotenv），导出类型化配置
│   │       ├── llm.ts               # createOpenAI({ apiKey, baseURL }) → chat / embedding 模型
│   │       ├── agent-loop.ts        # 手写 runToolLoop + ToolLoopAgent 类封装
│   │       ├── types.ts             # AgentTool 类型（ai 的 tool() + zod）
│   │       ├── trace.ts / json-utils.ts
│   │       ├── rag/                 # RAG 零件：types / chunker / embedder / 内存库 / retrieve / persistence / ingest（入库核心）
│   │       ├── memory/              # 三层记忆：session / preference / episodic（内存版）
│   │       ├── tools/               # registry / demo-tools / kb-search
│   │       └── service/             # 客服产品核心：supervisor / workers / handoff（CLI 与 API 共用）
│   └── shared/                      # @agent-app/shared：纯类型契约（SSE 事件 / 错误体 / 路由 / HandoffPack）
├── apps/
│   ├── cli/                         # @agent-app/cli：tsx 直跑（chat / kb / service REPL + selftest）
│   │   └── src/                     # index.ts 路由 + apps/chat|kb|service + selftest.ts
│   ├── api/                         # @agent-app/api：NestJS BFF（tsc 编译后 node dist 运行）
│   │   └── src/                     # main / app.module / chat|kb|service 控制器与服务
│   └── web/                         # 占位：week20 Next.js 前端（消费 @agent-app/shared 的 SSE 类型）
├── .env.example                     # 三家 OpenAI 兼容网关（DeepSeek / Qwen / GLM）配置示例
├── samples/                         # 入库样例：company-faq.md（制度 FAQ）、dummy.pdf（PDF 样例）
└── package.json / tsconfig.base.json / pnpm-workspace.yaml   # workspace 根：脚本统一从根目录跑（cwd = agent-app）
```

## 产品线一 · 知识库问答（kb）

两步走：先入库，再提问。对应教程 [products/kb.md](../docs/products/kb.md)（零件组装）与 [week11 · RAG TS](../docs/week11/rag-ts.md)（链路实现）。

```powershell
# 1. 入库：读文件 → 切块 → 向量化 → 落盘快照（支持 .txt / .md / .pdf）
pnpm kb:ingest .\samples\company-faq.md
pnpm kb:ingest .\samples\dummy.pdf     # PDF 样例同样可入库

# 2. 提问 REPL（等价 pnpm cli kb）
pnpm kb
```

REPL 效果与边界：

- **带引用回答**：检索 top5，命中的块编号拼进 prompt，模型只依据资料作答并在句末标注 `[1][2]`，末尾打印引用来源（编号由后端分配，模型编不了出处）
- **老实说不知道**：知识库里没有相关内容时直说不知道，不硬编（边界探测类问题的信任分水岭）
- **降级预案**：LLM 挂了返回检索原文 + 出处，不给报错页；embedding 失败打印中文配置提示
- **跨进程共享**：入库与问答是两个进程，知识库快照落在 `.data/kb-store.json`（内存检索 + 文件快照）

## 产品线二 · 智能客服（service）

Supervisor 路由 + 三个业务工人 + 转人工退路，对应教程 [products/service.md](../docs/products/service.md)。

```powershell
pnpm service        # 等价 pnpm cli service
pnpm test:service   # 硬规则离线自测（纯函数断言，无网络）
```

REPL 里可以试：

```text
订单 A-1024 到哪了？      → LLM 分类 order → 查订单工具 → 回答
退款怎么申请？            → LLM 分类 refund → 建工单工具 → 回答
出差住宿标准是多少？      → LLM 分类 knowledge → 知识库检索 → 带引用回答
转人工                    → 硬规则命中：建工单 + HandoffPack，直接人工（不问模型）
我要投诉你们              → 高危白名单命中：直接人工
（连续两句「到底怎么办」）  → 连续 2 轮未解决：直接人工
```

设计要点：

- **硬规则优先于模型**：转人工/投诉关键词、连续 2 轮未解决，纯函数判定，零 LLM 调用、行为可测（`pnpm test:service`）
- **模型只兜模糊地带**：generateObject 三分类（order / refund / knowledge）+ reason
- **工具表按工人裁剪**：order 只发查订单的锤子，refund 只发建工单的锤子，knowledge 只发知识库检索
- **转人工 = 业务流程的正常一步**：建工单 + HandoffPack 上下文包（工单号 / 原因 / 用户摘要 / 最近对话），接手人不用用户复述
- **降级链路**：模型路由不可用时直接转人工而不是报错（service.md 上线检查清单第 8 条）

## 执行轨迹（trace）

想看 Agent 每一步在干什么：开启轨迹后，循环的每一步（模型调用 → 工具调度 → 结果回灌）、Supervisor 路由判定、RAG 检索命中、记忆压缩事件都会打到 stderr（对应教程 week11「手写循环每步可插日志」与 week20「Thought / Action / Observation」思想）。

```powershell
pnpm service --trace                 # 方式一：CLI 传参
$env:AGENT_TRACE = "1"; pnpm api     # 方式二：环境变量（HTTP API 服务端日志同样生效）
```

轨迹图标约定：

| 图标 | 含义 | 示例 |
| --- | --- | --- |
| ▶ | 思考（调用模型） | `▶ 思考 step 1 → 调用模型（上下文 1 条消息，可用工具 1 个）` |
| ⚙ | 行动（工具调用意图） | `⚙ 行动 step 1 → 要调 1 个工具：getOrderStatus({"orderId":"A-1024"})` |
| ✓ / ✗ | 观察（工具返回 / 失败） | `✓ 观察 step 1 → getOrderStatus 返回：{...}` |
| ◆ | 完成 | `◆ 完成 → 模型给出最终回答（25 字，共 2 步）` |
| 🧭 | 路由判定 | `🧭 路由 → 硬规则命中（不问模型）：… ⇒ human` |
| 🔎 | 知识库检索 | `🔎 检索 → 「…」命中 5 块，top1：《…》相似度 0.83` |
| 🧠 | 记忆压缩 | `🧠 会话 cs_xxx 超过 40 条：压缩 21 条旧消息为滚动摘要…` |

> 顺带修复：模型三分类原来走 `generateObject`（依赖网关 response_format 结构化输出），`glm-4-flash` 会静默无视导致解析失败；现改为 `generateText` + 严格 JSON 指令 + 宽松解析（`engine/json-utils.ts`）+ 不合规自动重试一次，任何 OpenAI 兼容网关行为一致。

## 配置说明

复制 `.env.example` 为 `.env` 后填写。**默认接智谱 GLM**（OpenAI 兼容协议，聊天 + embeddings 一站式），也可三选一：

| 厂商 | baseURL | 聊天模型示例 | embedding 模型 |
| --- | --- | --- | --- |
| 智谱 GLM（默认） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `embedding-3` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | ❌ 无 embeddings 接口 |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `text-embedding-v3` |

> 查询与入库必须用同一个 EMBEDDING_MODEL，混用则检索失真；换网关时 embedding 模型要跟着换。

## HTTP API（NestJS · 教程第 20 周 BFF 形态）

引擎与产品逻辑不变，外面套一层 NestJS 服务壳（模块 / 控制器 / DTO 校验 / 全局异常过滤），对应教程 [week20](../docs/week20/index.md) 的 BFF 架构层：

```powershell
pnpm api        # 等价：构建 @agent-app/engine + @agent-app/api 后 node apps/api/dist/main.js，默认端口 3000（PORT 可改）
```

| 方法 | 路径 | 作用 | 离线（无 .env）行为 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查 | 正常 |
| POST | `/api/chat` | 非流式对话（手写工具循环 + 会话记忆） | 500 + 中文配置提示 |
| GET | `/api/chat/stream?message=` | SSE 流式对话：`session` → `step`（工具调用/结果）→ `delta`（答案分片）→ `done` | SSE `error` 事件 + 配置提示 |
| POST | `/api/kb/ingest` | multipart 文件上传入库（字段名 `file`，支持 .txt/.md/.pdf） | 500 + embeddings 配置提示 |
| POST | `/api/kb/ingest-path` | 服务端本地路径入库（开发用） | 同上 |
| POST | `/api/kb/query` | 知识库问答 `{ question, topK? }` → `{ answer, citations }` | 500 + 配置提示 |
| POST | `/api/service/message` | 客服消息 `{ sessionId?, message }` → `{ route, reply, handoff? }` | **降级转人工出工单**（完整可用） |

curl 冒烟示例：

```powershell
curl http://localhost:3000/api/health
curl -X POST http://localhost:3000/api/service/message -H "Content-Type: application/json" -d '{\"message\":\"转人工\"}'
curl -N "http://localhost:3000/api/chat/stream?message=订单A-1024到哪了"
curl -X POST http://localhost:3000/api/kb/ingest -F "file=@samples/company-faq.md"
```

实现说明：

- **装饰器元数据**：NestJS 依赖注入需要 `emitDecoratorMetadata`，而 tsx/esbuild 不支持，因此 API 走 `tsc` 编译后以 `node apps/api/dist/main.js` 运行（`pnpm build` + `pnpm api`）
- **引擎零改动复用**：控制器/服务直接调用 `@agent-app/engine` 的 `runToolLoop` / `searchKnowledge` / `supervise` / `buildHandoffPack`（客服与入库核心上移引擎包，CLI 与 HTTP API 共用同一套产品逻辑），HTTP 层只是同一套产品逻辑的另一张脸
- **后续扩展**（教程 week20 完整范围，本项目未实现）：认证 / 多租户 RBAC / 限流，以及 Next.js 前端（`useChat` + 审批 UI）
