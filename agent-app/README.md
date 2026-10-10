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
| `pnpm chat --mcp "cmd /c pnpm mcp:server"` | 聊天 REPL 接入外部 MCP 服务器（spawn stdio 子进程，工具表自动合并） | —（MCP 专题教程规划中） |
| `pnpm cli chat` | 入口路由：聊天 | 同 `pnpm chat` |
| `pnpm cli kb` / `pnpm kb` | 知识库问答 REPL：检索 top5 → 带引用回答 | [products · 知识库问答](../docs/products/kb.md)、[week11 · RAG TS](../docs/week11/rag-ts.md) |
| `pnpm kb:ingest <文件>` | 知识库入库：切块 → 向量化 → 快照落盘（.txt / .md / .pdf） | [week11 · RAG TS](../docs/week11/rag-ts.md) |
| `pnpm cli service` / `pnpm service` | 智能客服 REPL：硬规则 + 三分类路由 + 三工人 + 转人工 | [products · 客服系统](../docs/products/service.md) |
| `pnpm test:service` | 客服硬规则离线自测（纯函数断言，无网络） | [products · 客服系统](../docs/products/service.md) |
| `pnpm infra:up` / `pnpm infra:down` | 真实持久化基座：pgvector(pg16) + redis(7) 容器起停 | [week14](../docs/week14/index.md)、[week17](../docs/week17/index.md) |
| `pnpm test:infra` | 基础设施集成测试（RUN_INFRA_TESTS=1，需先 `infra:up`） | week14 / week17 实战 |
| `pnpm typecheck` | `tsc --noEmit` 零错误检查 | — |
| `pnpm verify` | 聚合自检一条命令：typecheck → engine/api 测试 → selftest → examples 类型检查 → 架构红线 | — |
| `pnpm examples` | 跑两个最小可运行示例（最小 Agent / 自定义工具，需先 `pnpm build` + 配好 key） | [engine/docs/EXTENDING.md](packages/engine/docs/EXTENDING.md) |
| `pnpm eval` | 跑评测考卷（76 例三档判分，无 key 自动跳过需网关的档位） | [week16/evals-ts.md](docs/week16/evals-ts.md) |

## 目录结构（pnpm workspace 单仓）

```text
agent-app/
├── packages/
│   ├── engine/                      # @agent-app/engine：框架无关引擎（tsc 构建出 dist + .d.ts）
│   │   ├── src/
│   │   │   ├── config.ts            # 手动读 .env（不引 dotenv），导出类型化配置
│   │   │   ├── llm.ts               # createOpenAI({ apiKey, baseURL }) → chat / embedding 模型
│   │   │   ├── agent-loop.ts        # 手写 runToolLoop + ToolLoopAgent 类封装
│   │   │   ├── types.ts             # AgentTool 类型（ai 的 tool() + zod）
│   │   │   ├── trace.ts / json-utils.ts / errors.ts / logger.ts
│   │   │   ├── rag/                 # RAG 零件：types / chunker / embedder / 内存库 / retrieve / persistence / ingest（入库核心）
│   │   │   ├── memory/              # 三层记忆：session / preference / episodic（内存版）
│   │   │   ├── tools/               # registry / demo-tools / kb-search / idempotency（幂等）/ compose（壳组合器）
│   │   │   ├── mcp/  guardrails/  evals/   # 标准插口 / 安全员 / 考试系统（各自带 README）
│   │   │   └── service/             # 客服产品核心：supervisor / workers / handoff（CLI 与 API 共用）
│   │   ├── examples/                # 最小可运行示例（minimal-agent / custom-tool），pnpm examples 一键跑
│   │   └── docs/                    # 教学文档（总览 + 九站深讲 + 成熟度矩阵 + 扩展指南）
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

## 接入外部 MCP 服务器（--mcp）

聊天 REPL 可以把**任何** MCP 服务器的工具并进自己的工具表（stdio 子进程方式）：

```powershell
pnpm chat --mcp "cmd /c pnpm mcp:server" --trace   # 狗粮：接我们自己的 pnpm mcp:server
```

要点：

- **MCP 工具与本地工具对循环不可区分**：`--mcp` 会 spawn 服务器进程、`listTools`、把每个工具的 JSON Schema 适配成引擎 `AgentTool`（`engine/mcp/adapter.ts` 照单全收，参数校验责任在服务器侧），合并进工具表后 `runToolLoop` 一行未改——重名时 MCP 版本胜出并打印警告
- **Windows 下命令要包一层 `cmd /c`**：stdio 传输用 `spawn` 且不开 shell，`pnpm`/`npx` 是 `.cmd` 垫片，直唤会 ENOENT；这不是 bug 是安全纪律，包一层就好（macOS/Linux 直接写命令）
- 退出 REPL（`/exit` 或 Ctrl-Z 回车 / EOF）时桥会按 stdin EOF → SIGTERM → SIGKILL 的序列收掉服务器进程
- 真模型 + 真子进程的冒烟：`pnpm test:mcp-dogfood`（离线单测见 `engine/test/mcp-client.spec.ts`）

## 配置说明

复制 `.env.example` 为 `.env` 后填写。**默认接智谱 GLM**（OpenAI 兼容协议，聊天 + embeddings 一站式），也可三选一：

| 厂商 | baseURL | 聊天模型示例 | embedding 模型 |
| --- | --- | --- | --- |
| 智谱 GLM（默认） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `embedding-3` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | ❌ 无 embeddings 接口 |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `text-embedding-v3` |

> 查询与入库必须用同一个 EMBEDDING_MODEL，混用则检索失真；换网关时 embedding 模型要跟着换。

## 真实持久化（Docker）

week14（pgvector）+ week17（Redis 记忆）实战落地：**同一套接口（`RagStore` / `SessionStore` / `PreferenceStore` 签名一行未改），三份实现**——内存（selftest/离线）、JSON 快照（默认）、pgvector/Redis（真实持久化），由环境变量一键切换，业务代码零改动。

### 1. 起基础设施

```powershell
pnpm infra:up      # docker compose up -d：pgvector/pgvector:pg16 + redis:7-alpine（含 healthcheck）
docker compose ps  # 等两个服务 healthy
pnpm infra:down    # 用完关掉（数据卷保留；docker compose down -v 才删数据）
```

端口选择（实测本机后写死在 compose 注释里）：**postgres 映射宿主机 5433**（本机 5432 已被常驻容器 `my-postgres` 占用，避免冲突）、**redis 直通 6379**。默认连接串与之对齐：`PG_CONNECTION_STRING=postgres://agent:agent@localhost:5433/agent`、`REDIS_URL=redis://localhost:6379`。

### 2. 切换存储（env 开关，默认 = 改造前的离线行为）

| 环境变量 | 可选值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `RAG_STORE` | `memory` / `json` / `pgvector` | `json` | 知识库：内存 / `.data/kb-store.json` 快照 / PostgreSQL+pgvector（HNSW 余弦检索） |
| `SESSION_STORE` | `memory` / `redis` | `memory` | 会话窗口：内存 Map / Redis list（`agent:sess:{id}`，TTL 24h 续期，跨进程共享） |
| `PREFERENCE_STORE` | `memory` / `pg` | `memory` | 用户偏好：内存 Map / PG `user_preferences` 表（行级 upsert） |
| `EPISODIC_STORE` | `memory` / `pgvector` | `memory` | 情景记忆：内存数组 / PG `episodic_memories` 表（`<=>` 余弦 top-k 召回历史会话摘要） |
| `PG_CONNECTION_STRING` | 连接串 | `postgres://agent:agent@localhost:5433/agent` | 三个 PG 实现共用（pgvector 两个表 + 偏好长表） |
| `REDIS_URL` | 连接串 | `redis://localhost:6379` | Redis 会话存储用 |
| `EMBEDDING_DIM` | 整数 1~16000 | `2048` | 建表时固定（GLM embedding-3 = 2048 维）。换维度模型须 `DROP TABLE kb_chunks` 全库重嵌；另 ANN 索引（HNSW/IVFFlat）只支持 ≤2000 维，超限时检索自动走精确顺序扫描 |

写进 `.env` 或临时环境变量都行（环境变量优先）。示例——CLI 切 pgvector + Redis：

```powershell
$env:RAG_STORE = "pgvector"; $env:SESSION_STORE = "redis"
pnpm kb:ingest .\samples\company-faq.md    # 入库直写 PG（真实 GLM embedding）
pnpm kb                                     # 问答检索走 PG 的 <=> 余弦 + HNSW
Remove-Item Env:RAG_STORE, Env:SESSION_STORE   # 清掉开关，立刻回到默认离线行为
```

不配置任何开关 = `json` + `memory`，与引入真实持久化之前的行为**完全一致**（离线优先原则：没装 Docker 的机器照常跑）。

### 3. 跑基础设施集成测试

```powershell
pnpm test:infra    # = RUN_INFRA_TESTS=1 下跑 engine 的 vitest（Windows 用 node 包装脚本设 env，无 cross-env）
```

覆盖：pgvector upsert / score 排序 / docId 过滤 / deleteDoc / NULL 向量跳过；Redis append/getWindow / **TTL 续期**（`ttl` > 0）/ clear / 压缩（注入假 Summarizer）与降级。服务没起时套件自动 skip 并打印原因，不影响普通 `pnpm test`。

### 4. 验证数据真的在里面

```powershell
docker compose exec postgres psql -U agent -c "select count(*) from kb_chunks"       # PG 里的知识块数
docker compose exec redis redis-cli --scan --pattern "agent:sess:*"                  # 会话 key
docker compose exec redis redis-cli ttl "agent:sess:<sessionId>"                     # TTL > 0（24h 续期）
docker compose exec postgres psql -U agent -c "select session_id, summary, created_at from episodic_memories order by seq desc limit 5"   # 最近归档的情景记忆（EPISODIC_STORE=pgvector 时写入）
```

### 5. 一键全栈（Docker）

上面两步的「全都要」版：一条命令把 pg + redis + api + web 四个容器全拉起来（api/web 挂在 `app` profile 下，不带 profile 的 `docker compose up -d` = `pnpm infra:up` 行为分毫不变）。

```powershell
pnpm stack:up     # = docker compose --profile app up -d --build：构建两镜像并起全栈
pnpm stack:logs   # 跟看 api + web 日志
pnpm stack:down   # 只撤 api + web，pg/redis 原地不动（数据卷照旧保留）
```

- 上来什么：`postgres` / `redis`（同上）+ `api`（NestJS BFF，:3000，健康检查 `/api/health`，Swagger `/api/docs`）+ `web`（Next.js standalone，:3001）
- 存储开关在 compose 里替你设好（RAG/情景=pgvector、会话=redis、偏好=pg）；模型 key 从 `.env` 经变量替换流入容器，`.env` 永不进镜像
- 地址方向记住一句话：**容器互访用服务名**（api 连 `postgres:5432`），**浏览器访问用宿主机端口**（页面里是 `localhost:3000`——浏览器跑在你的机器上，不在 compose 网络里）

## web 客户端（Next.js · 教程第 20 周前端形态）

`apps/web`：手写 scaffold 的 Next.js 15 前端（App Router + React 19 + Tailwind v4，非 create-next-app），消费上面这套 BFF API。week20 架构边界：**前端只见契约**——类型全部来自 `@agent-app/shared`（SSE 事件、kb/service 响应形状），不依赖 `@agent-app/engine`；前端零密钥，所有 LLM / embedding 调用都发生在 BFF 侧。

### 启动

```powershell
# 前置：BFF 起在 3000
pnpm api                                # 或分步：pnpm build 后 node apps/api/dist/main.js
pnpm --filter @agent-app/web dev        # 前端开发服务器（默认 3000；端口走进程环境变量 PORT）
```

环境变量 `NEXT_PUBLIC_API_BASE`（默认 `http://localhost:3000`）：BFF 地址，Next 构建期内联；部署时改地址只需带着它重新 `pnpm --filter @agent-app/web build`。

### 三个页面

| 路由 | 功能 |
| --- | --- |
| `/`（智能对话） | SSE 流式对话：fetch + ReadableStream 手解析（不用 EventSource，便于携带 sessionId 与读错误体）；`session`→`step`（思考过程面板，Thought/Action/Observation 三段式，可折叠）→`token`（逐段追加正文，`[1][2]` 引用标记原样保留）→`done`/`error`（红色错误 + hint）；顶部显示 sessionId + 「新会话」 |
| `/kb`（知识库管理） | 上传入库（前端扩展名闸 + multipart，成功显示「N 块入库」并刷新列表）、文档列表（标题 / docId / 块数 / 删除，confirm 确认后刷新）、问答试用（answer + 引用列表 no/title/score，`degraded=true` 显示黄色「降级：检索原文」徽标 + hint） |
| `/service`（智能客服） | 对话式：每条回复带路由徽标（订单蓝 / 退款紫 / 知识库绿 / 转人工琥珀）+ reason；`route=human` 渲染工单卡片（工单号 / 原因 / 用户摘要 / 最近对话 / 时间）；sessionId 经 localStorage 跨刷新保持 |

响应式：移动端单列 + 底部 tab 导航（64px 触达区），桌面端顶栏导航 + 限宽 `max-w-4xl`（kb 页双栏）。字体走系统栈（刻意不用 `next/font/google`，构建离线可行）。

## HTTP API（NestJS · 教程第 20 周 BFF 形态）

引擎与产品逻辑不变，外面套一层 NestJS 服务壳（模块 / 控制器 / DTO 校验 / 全局异常过滤），对应教程 [week20](../docs/week20/index.md) 的 BFF 架构层：

```powershell
pnpm api        # 等价：构建 @agent-app/engine + @agent-app/api 后 node apps/api/dist/main.js，默认端口 3000（PORT 可改）
```

| 方法 | 路径 | 作用 | 离线（无 .env）行为 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查 | 正常 |
| POST | `/api/chat` | 非流式对话（手写工具循环 + 会话记忆） | 500 + 中文配置提示 |
| GET | `/api/chat/stream?message=` | SSE 流式对话：`session` → `approval`（高危工具待审批，week18 Day 6）→ `step`（工具调用/结果）→ `token`（答案分片）→ `done` | SSE `error` 事件 + 配置提示 |
| POST | `/api/chat/approve` | 工具审批裁决 `{ sessionId, approvalId, approved }` → `{ approvalId, approved }`；未知/过期/超时已自动拒绝 → 404 中文错误 | 404 `{ statusCode, message }` |
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
- **工具审批（week18 Day 6）**：引擎的 `agent-loop.ts` 一行未改——API 层把传给 `runToolLoop` 的工具表先包壳：命中 `AGENT_CONFIRM_TOOLS` 名单（默认 `createTicket`，置空关闭）的工具，execute 前发 `approval` SSE 事件并挂起，等 `POST /api/chat/approve` 裁决（允许放行 / 拒绝回结构化拒绝值，模型可见）；`AGENT_CONFIRM_TIMEOUT_MS`（默认 60s）超时自动拒绝。登记簿在进程内存里，多流并发按 UUID 各挂各的、sessionId 匹配才唤醒
- **Swagger 文档**：交互式 API 文档挂在 `http://localhost:3000/api/docs`（OpenAPI JSON 见 `/api/docs-json`，DTO 的 `@ApiProperty` 中文描述自动汇成 Schema）
- **测试**：`pnpm test:api` 跑 vitest 单测 + e2e（18 个用例，引擎模型调用全 mock，零网络）
- **优雅关闭**：`app.enableShutdownHooks()` 已启用——SIGINT/SIGTERM 时先走 Nest 生命周期销毁钩子再退出；启动/异常日志统一走 Nest `Logger`（带时间戳与上下文）
- **后续扩展**（教程 week20 完整范围，本项目未实现）：认证 / 多租户 RBAC / 限流，以及 Next.js 前端（`useChat` + 审批 UI）
