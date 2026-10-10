# 读代码前先读这篇：AI 客服的路由——什么交给规则，什么交给模型，什么交还给人

> 本目录解决客服系统的"分诊"问题：一条用户消息进来，先由**确定性硬规则**把关，
> 全不命中才交给 **LLM 三分类**，两者都接不住就**体面地转人工**——退路本身是产品的一部分。
> 配合教程 [products · 客服系统](../../../../../docs/products/service.md)（Supervisor 星型 / 硬规则 / HandoffPack / 上线检查清单）
> 与 week11 补篇 [Agent 循环 TS 深入](../../../../../docs/archive/weeks/week11/agent-loop-ts.md)（工人手里的工具循环）。
> 工程哲学一句话：**能枚举的事用代码，判不准的事问模型，接不住的事转人工**。

---

## 一、第一性原理：一个"什么都能聊"的 LLM，不等于一个能上岗的客服

把一个裸 LLM 直接放到客服窗口，会撞上三堵墙，每一堵墙对应本目录的一块拼图：

1. **调度问题**——客服是分科的（订单 / 售后 / 知识库）。让一个模型背全部业务的提示词
   和全部工具，上下文互相干扰、工具张冠李戴。**先分诊，再处理**：Supervisor（`supervisor.ts`）。
2. **确定性问题**——有些场景绝不容许模型"偶尔判漏一次"：用户喊"转人工"、"我要投诉"。
   数数和关键词匹配，**代码数得比模型准、零成本零延迟、行为完全可测**——这类判断必须
   排在任何 LLM 调用前面。这就是硬规则（`checkHardRules`）。
3. **退路问题**——AI 一定有接不住的时候。没有退路的 AI 客服等于把用户关在门外；
   退路的底线是"转过去不用复述"（`handoff.ts` 的上下文包）。

一个准确的比喻是医院：**挂号分诊台**（Supervisor）→ **专科医生**（三个工人）→ **转诊单**
（HandoffPack）。特别注意：`RouteTarget` 里 `human` 与三个工人**并列**——转人工是业务流程的
正常一步（"一个特殊 Worker"），不是异常，更不是报错。

## 二、核心设计：Supervisor 星型调度

整个 `service/` 目录对外只有一个动作：每轮消息 → 路由 → 工人或转人工。

```
用户消息 ──► ① 硬规则（纯函数，零 LLM）──命中──► 转人工（建工单 + HandoffPack）
                 │ 全不命中
                 ▼
            ② 模型三分类（generateText + 严格 JSON 指令 + 宽松解析）
                 │
      ┌──────────┼───────────┐
    order       refund      knowledge      ← 各配"职责提示词 + 最小工具表"
  getOrderStatus createTicket searchKnowledgeBase
```

| 角色 | 文件 | 一句话职责 |
| --- | --- | --- |
| 分诊台 | `supervisor.ts` | 三组关键词常量 + 硬规则纯函数 + 模型三分类 + `supervise` 总入口 |
| 三个专科工人 | `workers.ts` | order / refund / knowledge 各配职责提示词与**裁剪过的工具表** |
| 转诊单 | `handoff.ts` | 建工单 + HandoffPack 上下文包（摘要失败有降级） |
| 总装（消费者） | `apps/cli/src/apps/service/cli.ts` | REPL 循环：维护计数、降级链路、会话回写 |

### 本目录文件地图（5 个文件）

| 文件 | 职责 |
| --- | --- |
| `supervisor.ts` | 路由核心：`HUMAN_REQUEST_KEYWORDS` / `HIGH_RISK_KEYWORDS` / `UNRESOLVED_SIGNALS` 三组常量；`matchAnyKeyword` / `isUnresolvedSignal` / `checkHardRules` 纯函数；`classifyWithLlm` 模型兜底；`supervise` 总入口（按契约再出口 `RouteDecision` / `RouteTarget` / `WorkerRoute`） |
| `workers.ts` | 三个业务工人：`WORKER_PROMPTS` 职责提示词 + `WORKER_TOOLS` 最小工具表 + `runWorker`（复用引擎的手写工具循环） |
| `handoff.ts` | 转人工：`formatTranscript` 文稿 → `buildHandoffPack` 组装（LLM 摘要 + 降级 + mock 工单）→ `formatHandoffPack` 打印块 + `handoffReply` 用户告知 |
| `index.ts` | 桶导出（`@agent-app/engine/service` 子路径的公共面，CLI 与 HTTP API 共用） |
| `README.md` | 本文 |

### 数据契约（住在 `@agent-app/shared`，CLI 与 HTTP API 的响应形状同源）

| 契约 | 形状 | 为什么存在 |
| --- | --- | --- |
| `WorkerRoute` | `"order" \| "refund" \| "knowledge"` | 三分类能**枚举**——枚举得了的就别用自由文本 |
| `RouteTarget` | `WorkerRoute \| "human"` | human 与工人并列：路由是四路分支，不是 try/catch |
| `RouteDecision` | `{ target, reason }` | reason 转人工时写进工单，是接手人的第一眼信息 |
| `ServiceHandoffPack` | `{ ticketId, reason, userSummary, recentTranscript, createdAt }` | 转人工上下文包：接手人不用用户复述 |

## 三、各部分原理

### 3.1 硬规则：确定性的事，一行代码胜过一次模型调用（supervisor.ts）

三组**导出的**关键词常量，各兜一类"必须转"的场景：

| 常量 | 关键词（代码原文） | 兜的是什么 |
| --- | --- | --- |
| `HUMAN_REQUEST_KEYWORDS` | 转人工 / 找真人 / 换人工 / 人工客服 / 换个人 | 用户明确要求——"这三个字出现之前，用户通常已经忍了一阵" |
| `HIGH_RISK_KEYWORDS` | 退款争议 / 投诉 / 起诉 / 律师 / 法院 / 媒体 | 高危业务——"答错一个字的代价远高于转一百单人工" |
| `UNRESOLVED_SIGNALS` | 不是这个 / 答非所问 / 没解决 / 没帮我 / 到底 / 还是不行 / 你没听懂 / 我问的 | 追问未解决的**计数原料**——命中说明 AI 在原地打转 |

三个纯函数构成判定链：`matchAnyKeyword`（消息含任一关键词则返回该词，否则 null）→
`isUnresolvedSignal`（这条算不算一次"追问未解决"）→ `checkHardRules`（总判定）。

`checkHardRules` 的**优先级顺序是刻意的**：未解决计数（`>= 2`）> 明确要求 > 高危白名单，
注释原话"最需要兜底的排最前"——测试里专门验证了"转人工 + 计数 3"同时命中时，
reason 报的是未解决轮数。

两个容易被忽略的设计点：

- **计数不在 supervisor 里**。`SupervisorState` 是纯数据（`lastUserMessage` +
  `unresolvedRounds`），计数由 CLI 每轮维护（命中信号 +1，正常提问清零）并传进来。
  状态归应用循环管，判定归纯函数管——所以 `__tests__.ts` 能离线把四条触发路径各实测一例。
- **为什么硬规则必须排在 LLM 前面**：这类"必须转"的场景，容不得模型偶尔判漏一次；
  关键词匹配零 LLM 成本、零延迟、行为可测。让模型做模型擅长的事，**别让它替你数数**。

### 3.2 模型三分类：模糊地带才轮到模型（classifyWithLlm）

硬规则筛剩下的正常业务话术（"订单 A-1024 到哪了" / "退款怎么申请"）交给 LLM：

- **输出是选择题不是问答题**：`routeSchema` 用 `z.enum` 把 route 锁死为三选一——
  "能枚举就硬，枚举不了再软"，枚举是防幻觉的第一道墙。
- **要看上下文**：分类喂的是最近 10 轮窗口（`history.slice(-10)`，省 token），
  否则一句"那退款呢"会分错类。
- **generateText + 严格 JSON 指令 + 宽松解析 + 重试一次**：这是本项目的"网关无关"模式
  （与 `json-utils.ts` 头注释的 glm-4-flash 故事同款）：`generateObject` 依赖网关的
  `response_format` 结构化输出，轻薄模型/网关会**静默无视**导致解析炸裂；改为把 JSON
  格式硬约定写进提示词，回复先过 `extractJson`（取第一个 `{` 到最后一个 `}`，容忍
  markdown 围栏与前后废话）再 zod 校验。不合规自动重试一次——第二次的 system 提示
  追加"你上一次的回复不是合法 JSON"——两次仍失败才抛错，交给上层降级（见 3.5）。

`supervise` 是对外的唯一约定：先 `checkHardRules`，命中直接返回（trace 打 `🧭 硬规则命中（不问模型）`）；
全不命中才 `classifyWithLlm`。硬规则优先不是"顺手"，是这个模块的宪法。

### 3.3 三个工人：一把钥匙开一把锁（workers.ts）

每个工人 = **一份职责提示词 + 一张最小工具表**，跑在引擎第 1 阶段备好的 `runToolLoop` 上：

| 工人 | 工具表（全部家当） | 职责提示词里的边界与出口 |
| --- | --- | --- |
| order | `getOrderStatus` | 只处理订单/物流/发货；查不到如实告知，**禁止编造订单信息** |
| refund | `createTicket` | 只处理退款退货售后；争议无法判定时**建议用户转人工，不要自行承诺** |
| knowledge | `searchKnowledgeBase` | 回答前**先检索**，只依据检索结果作答，句末标 `[1][2]`；检索不到**老实说不知道** |

**最小权限原则**：order 工人建不了工单——不是提示词求它别建，是它手里根本没有这个工具。
误伤面从工具表上就掐掉，比任何"请不要…"的提示词都可靠。knowledge 工人则直接复用 `rag/`
的整套检索（引用编号由后端分配，模型只被允许回标 `[n]`，编不了出处）。

两个细节：`buildMessages` 把历史窗口**去掉最后一条**（本轮输入单独拼在末尾）并截最近
20 轮防上下文爆炸；`maxSteps: 5` 给工具循环设上限，防止模型原地转圈。`workers.ts` 全文
只有 66 行——**引擎零件备得好，产品层就薄**。

### 3.4 转人工：不是失败，是流程的正常一步（handoff.ts）

"最毁体验的一幕是转过去后人工客服第一句'请问有什么可以帮您'"——所以转人工必须带
**上下文包**（`ServiceHandoffPack` 四件套）：工单号（凭据）、判定原因（接手人第一眼）、
用户摘要（LLM 压缩）、最近对话（最近 10 轮逐字文稿，`formatTranscript`）。

`buildHandoffPack` 的流水线与三处防御：

1. 拼文稿 → LLM 摘要。摘要提示词**必须带"禁止添加对话中没有出现的信息"**——
   摘要幻觉出一句"用户已确认收货"会把接手人带进沟里；
2. 摘要失败 → `fallbackSummary`：直接拼接最近 3 条用户消息，"不猜、不编，只交出可信的已知"；
3. 建工单调的是 `createTicket` 的 execute（mock 实现，**离线也能完成转人工**），
   工单 subject 里带上判定原因，接手人扫一眼就知道为什么转过来。

对用户这一侧，`handoffReply` 说清三件事：已转接、工单号、无需重复描述。
`formatHandoffPack` 产出的打印块，就是将来接真实工单系统时的 payload。

### 3.5 降级链路：每一层挂了都有下一层接着

降级方向只有一个——**转人工，绝不给报错页**。用户侧看到的永远是业务动作，不是技术故障：

| 哪里挂了 | 降级动作（代码位置） | 用户看到 |
| --- | --- | --- |
| 模型两次输出不合规 | `classifyWithLlm` 抛错 → CLI catch → decision 直接判 human | 转人工 + 工单 |
| 没配 key / 网关不通（supervise 抛错） | 同上，reason 写明"按降级预案直接转人工（用户侧不暴露报错）" | 转人工 + 工单 |
| 工人执行失败（模型不可用） | CLI catch → `doHandoff`，reason 写明工人处理失败 | 转人工 + 工单 |
| 摘要模型挂 | `buildHandoffPack` catch → `fallbackSummary` 原文拼接 | 工单照出（摘要变拼接） |
| 完全离线 | 工单本就是 mock，无网也能走完转人工 | 完整转人工流程 |

这正是 service.md 上线检查清单的第 8 条：**降级链路必须在上线前演练**——"模型挂了直接
转人工而不是报错"不是口头承诺，是写在 catch 分支里的行为，且可测。

### 3.6 总装：一条消息的旅程（apps/cli/src/apps/service/cli.ts）

引擎只提供零件，**状态活在应用循环里**：`unresolvedRounds` 计数、`cs_` 前缀的会话
（`/new` 时会话与计数一起清零）、每轮先 append 用户消息再 `getWindow(20)`。以用户
第二次说"到底怎么办啊"为例：

```
① append 用户消息 → 取窗口 20 轮
② isUnresolvedSignal("到底怎么办啊") = true → unresolvedRounds 2
③ supervise → checkHardRules：计数 ≥2 命中 → human（不问模型）
④ doHandoff：buildHandoffPack → 打印工单块 → handoffReply → 回写会话
⑤ 计数清零（已转出去，接手人从新上下文开始）
```

HTTP API（`apps/api` 的 `/api/service`）复用同一套 `supervise` / `runWorker` /
`buildHandoffPack`——这正是这段代码住在 engine 包的原因：**app 之间禁止互相 import，
公共核心一律进包**；连响应形状都同源（契约在 `@agent-app/shared`）。

## 四、原理 → 代码对照表（学习自测清单）

| 你应该能回答 | 对应实现 |
| --- | --- |
| 为什么硬规则必须排在 LLM 分类前面？ | `supervisor.ts` 头注释：确定性 / 零成本零延迟 / 可测，容不得模型偶尔判漏 |
| 三条硬规则的优先级？为什么未解决计数排最前？ | `checkHardRules` 判定顺序 + 注释"最需要兜底的排最前"；`__tests__.ts` 双命中用例 |
| "连续未解决"的计数存在哪、谁维护？ | `SupervisorState` 纯数据入参；`cli.ts` 每轮 `isUnresolvedSignal(input) ? +1 : 0` |
| 路由为什么用 generateText 而不是 generateObject？ | `json-utils.ts` 头注释：glm-4-flash 等静默无视 response_format；格式写进提示词 |
| 模型输出不合规怎么办？重试时提示词怎么变？ | `classifyWithLlm` 两次循环：第二次 system 追加"只输出 JSON 对象本身" |
| order 工人为什么建不了工单？ | `WORKER_TOOLS` 按工人裁剪：误伤面从工具表上掐掉（最小权限） |
| knowledge 工人的 `[1][2]` 引用编号谁分配？ | `tools/kb-search.ts`：编号由后端分配，模型只负责回标 |
| 转人工后接手人靠什么不用用户复述？ | `buildHandoffPack`：工单号 / 原因 / 用户摘要 / 最近对话四件套 |
| 摘要模型挂了，转人工还能完成吗？ | `fallbackSummary`（最近 3 条用户消息拼接）+ createTicket 为 mock，离线可用 |
| supervise 抛错（没配 key）用户会看到报错页吗？ | `cli.ts` catch → decision human，"用户侧不暴露报错" |
| CLI 与 HTTP API 为什么能共用这套逻辑？ | `index.ts` 头注释：公共核心进引擎包；契约在 `@agent-app/shared` 同源 |

能全答上来，再往下读实现代码；答不上来，回到对应章节。

## 五、推荐学习顺序（总计约 2~2.5 小时）

设计原则与隔壁 `rag/`、`memory/` 相同：**先纯函数后碰网、先离线后在线**——硬规则全程
不需要 API Key，学不会随时停在离线区。

```text
原理 → 纯函数（离线）→ 自测 → 模型侧 → 工人 → 转人工 → 总装 → 实战
```

| 步骤 | 文件 | 学什么 | 通关标准（能做到才往下走） | 时间 |
| --- | --- | --- | --- | --- |
| **0** | 本文（原理篇） | 星型调度 + 三堵墙 + 降级链路 | 能回答第四节 11 问 | 20min |
| **1** | `supervisor.ts` 前半 | 三组常量 + `matchAnyKeyword` / `isUnresolvedSignal` / `checkHardRules` | 能说出三条硬规则的优先级与各自兜底的场景 | 25min |
| **2** | ✋ 动手验证 | 硬规则离线全测 | `pnpm test:service` 全绿，且能说出 5 组测试各在测什么（无任何网络请求） | 10min |
| **3** | `supervisor.ts` 后半 | `routeSchema` / `ROUTER_PROMPT` / `classifyWithLlm` / `supervise` | 能解释为什么不用 generateObject、重试时提示词加了什么 | 25min |
| **4** | `workers.ts` | 职责提示词三要素 + 最小工具表 + `runWorker` | 能画出 order 工人收到的 messages 长什么样（去尾 20 轮 + 本轮） | 20min |
| **5** | `handoff.ts` | 四件套 + 摘要降级 + 工单流水线 | 能说出摘要失败后，包里的 userSummary 装的是什么 | 25min |
| **6** | `apps/cli/src/apps/service/cli.ts` | 总装：计数维护 / 两条降级 catch / 会话回写 | 能复述一条"转人工"消息从输入到工单打印的完整旅程（本文 3.6） | 20min |
| **7** | 🚀 全链路实战 | 真实路由流动 | `pnpm service --trace` 跑通，亲眼看 🧭 路由行 | 20min |

### 第 7 步实战命令（最有体感的一步）

在 `agent-app/` 目录下（无 key 也能启动 REPL；分类需配好 `.env`）：

```powershell
pnpm service --trace
```

REPL 里按顺序试（启动横幅同款建议）：`订单 A-1024 到哪了`（模型分类 order → 工具循环）→
`退款怎么申请`（refund → 建工单）→ 再来一句 `转人工`（🧭 硬规则命中，**不问模型**）——
trace 里"硬规则命中（不问模型）"这一行，就是第 1 步学的优先级在真实流量里的样子。

## 六、随时可回的加油站

- **路由判定想亲眼看** → `pnpm service --trace`，盯 `🧭` 行：硬规则命中 / 模型分类 / 重试，三种都有
- **JSON 解析那套为什么这么绕** → `json-utils.ts` 头注释（glm-4-flash 故事）；同一个"边界"思想在 `../rag/README.md` 第七节也出现
- **工具循环忘了** → `workers.ts` 只是薄封装，循环本体在 `../agent-loop.ts` + 教程 week11 补篇 [Agent 循环 TS 深入](../../../../../docs/archive/weeks/week11/agent-loop-ts.md)
- **某文件读不懂** → 每个文件头部注释就是该文件的小地图，"为什么"都写在代码旁边

## 七、扩展路线

| 现在 | 可去的方向 | 依据（都已在代码里留了缝） |
| --- | --- | --- |
| 关键词写死在三组导出常量 | 规则配置化：运营改关键词 / 阈值不用重新发版 | 常量已导出，`checkHardRules` 只吃 `SupervisorState`，替换数据源不动判定逻辑 |
| `createTicket` 为 mock 工单 | 接真实工单系统 | `handoff.ts` 注释原话：`formatHandoffPack` 这份打印块"接真实工单系统时就是 payload"；`ServiceHandoffPack` 契约在 shared，web 端 `/service` 页已在渲染工单卡片 |
| 路由与工人共用一个模型 | 大小模型分工：路由这种轻任务用小模型省钱 | `llm.ts` 的 `createModel(modelId?)` 参数注释点名"路由场景里大小模型分工" |
| 三个工人 | 加第四个工人（如物流异常专席） | `WORKER_PROMPTS` / `WORKER_TOOLS` 都是 `Record<WorkerName, …>`：加一个键 + 一张提示词 + 一张工具表，路由 schema 加一个枚举值即可 |

走完这条线，再回看第一节的三堵墙：调度、确定性、退路——每堵墙都对应一段你能亲手改的代码，这就是"读得懂"和"改得动"之间的距离。
