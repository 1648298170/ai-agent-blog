# 09 · 产品线：把零件组装成客服系统

> 一句话：前面 8 站全是**零件**——循环、模型、工具、记忆、检索、护栏、插口、考卷；
> 这一站看**组装**：一个能上岗的客服机器人。
> 工程哲学一句话：**能枚举的事用代码，判不准的事问模型，接不住的事转人工。**

---

## 它解决什么问题

把一个「什么都能聊」的裸 LLM 直接放到客服窗口，会撞上三堵墙：

```text
① 调度问题 —— 客服是分科的（订单/售后/知识库）。一个模型背全部业务的提示词和
              全部工具，上下文互相干扰、工具张冠李戴
② 确定性问题 —— 用户喊「转人工」「我要投诉」时，容不得模型"偶尔判漏一次"
③ 退路问题 —— AI 一定有接不住的时候；没有退路 = 把用户关在门外
```

最贴切的比喻是医院：**挂号分诊台**（Supervisor）→ **专科医生**（三个工人）→ **转诊单**
（HandoffPack 上下文包）。注意 `RouteTarget` 里 `human` 与三个工人**并列**——转人工是
业务流程的正常一步（「一个特殊 Worker」），不是异常，更不是报错。

## 核心概念（5 分钟版）

### Supervisor 星型调度：两级路由

```text
用户消息 ──► ① 硬规则（纯函数，零 LLM）──命中──► 转人工（建工单 + HandoffPack）
                 │ 全不命中
                 ▼
            ② 模型三分类（generateText + 严格 JSON 指令 + 宽松解析 + 重试一次）
                 │
      ┌──────────┼───────────┐
    order       refund      knowledge      ← 各配「职责提示词 + 最小工具表」
  getOrderStatus createTicket searchKnowledgeBase
```

**① 硬规则优先**（`checkHardRules`，纯函数、可离线单测），优先级是刻意的——
**未解决计数 ≥2 > 转人工关键词 > 高危白名单**（「最需要兜底的排最前」）：

| 常量 | 关键词（代码原文） | 兜什么 |
|---|---|---|
| `UNRESOLVED_SIGNALS` | 不是这个 / 到底 / 还是不行…（共 8 个） | 连续 2 轮未解决——AI 已在原地打转 |
| `HUMAN_REQUEST_KEYWORDS` | 转人工 / 找真人 / 换人工 / 人工客服 / 换个人 | 用户明确要求（说出口前通常已忍了一阵） |
| `HIGH_RISK_KEYWORDS` | 退款争议 / 投诉 / 起诉 / 律师 / 法院 / 媒体 | 高危业务（答错一个字的代价远高于转一百单人工） |

**② 模型只兜模糊地带**：`classifyWithLlm` 做 order/refund/knowledge 三分类。为什么不用
`generateObject`？glm-4-flash 等轻薄模型会**静默无视** `response_format`（见
`json-utils.ts` 头注的踩坑实录）——所以走 `generateText` + JSON 格式硬写进提示词 +
`extractJson` 宽松解析 + zod 校验，不合规自动重试一次，两次都炸才抛错交给降级。

### 工具表按工人裁剪（最小权限）

order 工人只发查订单的锤子，refund 只发建工单的锤子，knowledge 只发知识库检索。
**order 建不了工单不是提示词求它别建，是它手里根本没有这个工具**——误伤面从工具表上
就掐掉，比任何「请不要…」的提示词都可靠。

### HandoffPack：转人工不用复述

转人工上下文包四件套：**工单号**（凭据）、**判定原因**（接手人第一眼）、**用户摘要**
（LLM 压缩，失败降级为原文拼接）、**最近对话**（最近 10 轮逐字文稿）。最毁体验的一幕是
转过去后人工客服第一句「请问有什么可以帮您」——上下文包就是防这个的。

### 降级链路：每一层挂了都有下一层接着

| 哪里挂了 | 降级动作 | 用户看到 |
|---|---|---|
| 模型两次分类输出不合规 | `classifyWithLlm` 抛错 → CLI catch → 直接判 human | 转人工 + 工单 |
| 没配 key / 网关不通 | 同上，reason 写明「按降级预案直接转人工（用户侧不暴露报错）」 | 转人工 + 工单 |
| 工人执行失败 | CLI catch → `doHandoff` | 转人工 + 工单 |
| 摘要模型挂 | `fallbackSummary`（最近 3 条用户消息拼接） | 工单照出 |
| 完全离线 | 工单本就是 mock 实现 | 完整转人工流程 |

降级方向只有一个——**转人工，绝不给报错页**。「降级要降得可用」，这是 service.md
上线检查清单第 8 条，且是写在 catch 分支里可测的行为。

---

## 代码走读（`src/service/`，5 个文件）

| 文件 | 行数 | 要点 |
|---|---|---|
| `supervisor.ts`（L61） | 144 行 | ★ 路由核心：三组**导出的**关键词常量（L29/32/35）+ `matchAnyKeyword` / `isUnresolvedSignal` 纯函数 + `checkHardRules`（L61）+ `classifyWithLlm`（L110）+ `supervise` 总入口（L134）；路由契约 `RouteDecision` / `RouteTarget` / `WorkerRoute` 定义在 `@agent-app/shared`，这里再出口 |
| `workers.ts`（L24/40/58） | 110 行 | `WORKER_PROMPTS` 职责提示词 + `WORKER_TOOLS` 最小工具表 + `runWorker`（复用引擎的 `runToolLoop`）+ `runWorkerStreaming`（SSE 流式路径，同一套提示词/工具表） |
| `handoff.ts`（L66） | 116 行 | `formatTranscript`（L17）→ `buildHandoffPack`（L66，LLM 摘要 + 降级 + mock 工单）→ `formatHandoffPack` 打印块 + `handoffReply` 用户告知 |
| `index.ts` | 7 行 | 桶导出（`@agent-app/engine/service` 子路径公共面）——CLI 与 HTTP API 共用，**app 之间禁止互相 import，公共核心一律进包** |
| `README.md` | — | 本模块深度篇（三堵墙 / 降级链路 / 11 问自测清单） |

### 硬规则判定（`supervisor.ts`，L61–77 全文骨架）

```ts
export function checkHardRules(state: SupervisorState): RouteDecision | null {
  if (state.unresolvedRounds >= 2) {
    return { target: "human", reason: `连续 ${state.unresolvedRounds} 轮未解决，AI 已在原地打转` };
  }
  const request = matchAnyKeyword(state.lastUserMessage, HUMAN_REQUEST_KEYWORDS);
  if (request !== null) {
    return { target: "human", reason: `用户明确要求转人工（关键词「${request}」）` };
  }
  const risk = matchAnyKeyword(state.lastUserMessage, HIGH_RISK_KEYWORDS);
  if (risk !== null) {
    return { target: "human", reason: `命中高危业务白名单（关键词「${risk}」），必须人工处理` };
  }
  return null;   // 全不命中，才轮到模型分类
}
```

一个容易忽略的设计点：**计数不在 supervisor 里**。`SupervisorState` 是纯数据
（`lastUserMessage` + `unresolvedRounds`），计数由 CLI 每轮维护（命中追问信号 +1、正常
提问清零）传进来——状态归应用循环管，判定归纯函数管，所以硬规则能离线单测。

### 模型三分类与重试（`supervisor.ts`，L110 起的骨架）

```ts
export async function classifyWithLlm(history: ChatTurn[]): Promise<RouteDecision> {
  const baseMessages = toModelMessages(history.slice(-10)); // 最近 10 轮够分类用，省 token
  for (let attempt = 1; attempt <= 2; attempt++) {
    const effectiveSystem = attempt === 1
      ? system
      : `${system}\n\n重要：你上一次的回复不是合法 JSON。现在只输出 JSON 对象本身…`;
    const { text } = await generateText({ model: getModel(), system: effectiveSystem, messages: baseMessages });
    try {
      const parsed = routeSchema.parse(extractJson(text)); // z.enum 三选一 + 宽松解析
      return { target: parsed.route, reason: parsed.reason };
    } catch (err) { lastError = …; }
  }
  throw new Error(`模型三分类连续两次未按 JSON 约定输出：${lastError}`); // 上层降级转人工
}
```

`supervise` 是对外的唯一约定：先 `checkHardRules`，命中直接返回（trace 打
`🧭 硬规则命中（不问模型）`）；全不命中才 `classifyWithLlm`。硬规则优先不是顺手，是这个模块的宪法。

### 三个工人（`workers.ts`，L40–67 摘录）

```ts
const WORKER_TOOLS: Record<WorkerName, AgentToolSet> = {
  order: { getOrderStatus },          // 只给查订单的锤子
  refund: { createTicket },           // 只给建工单的锤子
  knowledge: { searchKnowledgeBase }, // 只给知识库检索
};

export async function runWorker(name: WorkerName, input: WorkerInput): Promise<string> {
  const result = await runToolLoop({
    model: createModel(),
    system: WORKER_PROMPTS[name],     // 职责提示词：边界 + 拒答出口
    messages: buildMessages(input),   // 历史去尾截 20 轮 + 本轮拼末尾
    tools: WORKER_TOOLS[name],
    maxSteps: DEFAULT_MAX_STEPS,      // 库级默认 5（agent-loop.ts 导出），magic number 不散落
  });
  return result.text;
}
```

第 1 站学的工具循环在这里原样复用——产品层薄到 `workers.ts` 只有 110 行，
**引擎零件备得好，产品层就薄**。

### 转人工上下文包（`handoff.ts`，L66 起的骨架）

```ts
export async function buildHandoffPack(input: { reason: string; turns: ChatTurn[] }): Promise<ServiceHandoffPack> {
  const transcript = formatTranscript(input.turns);           // 最近 10 轮逐字文稿
  let userSummary: string;
  try {
    const { text } = await generateText({ model: getModel(), system: PACK_PROMPT, prompt: transcript });
    userSummary = text.trim() || fallbackSummary(input.turns);
  } catch {
    userSummary = fallbackSummary(input.turns);              // 摘要挂了也要转得出去
  }
  const ticketId = await createHandoffTicket(`转人工：${input.reason}`, userSummary); // mock 工单，离线可用
  return { ticketId, reason: input.reason, userSummary, recentTranscript: transcript, createdAt: new Date().toISOString() };
}
```

摘要提示词 `PACK_PROMPT` 里写死「禁止添加对话中没有出现的信息」——摘要幻觉出一句
「用户已确认收货」会把接手人带进沟里。

---

## 跑起来验证（先跑再读，体感翻倍）

```powershell
cd agent-app
pnpm test:service    # 第一步：硬规则离线自测（node:assert 纯函数断言，零网络零模型）
pnpm service         # 第二步：REPL 实战（需配好 .env；启动横幅自带试玩建议）
```

`pnpm test:service` 跑的是 `apps/cli/src/apps/service/__tests__.ts`：转人工关键词 /
高危白名单 / 连续未解决计数 / 关键词匹配器等分组断言，全部只测导出的纯函数——
「转人工四条触发路径各实测一例」是 service.md 上线检查清单第 1 条。

`pnpm service` 进 REPL 后按这个顺序试（对应启动横幅的建议）：

```text
订单 A-1024 到哪了       → 🧭 模型分类 order  → 查订单工具 → 回答
退款怎么申请             → 🧭 模型分类 refund → 建工单工具 → 回答
出差住宿标准是多少       → 🧭 模型分类 knowledge → 知识库检索（先 pnpm kb:ingest 入库）
转人工                   → 🧭 硬规则命中（不问模型！）⇒ human，打印工单块
我要投诉你们             → 🧭 高危白名单命中 ⇒ human
（连续两句「到底怎么办」） → 🧭 计数 ≥2 ⇒ human
```

想亲眼看路由判定，开 trace：

```powershell
pnpm service --trace    # 盯 🧭 行：硬规则命中 / 模型分类 / 重试，三种都有
```

**降级演练**（最有体感的一步）：把 `.env` 里的 key 清空再 `pnpm service`，输入「转人工」——
不报错、不白屏，照样打出完整工单块（mock 工单 + 摘要降级为原文拼接）。这就是「降级要降得可用」。

---

## 设计取舍（面试级追问）

| 追问 | 回答 |
|---|---|
| 为什么硬规则必须排在模型前面？ | 「必须转」的场景容不得模型偶尔判漏：关键词匹配零 LLM 成本、零延迟、行为完全可测。让模型做模型擅长的事，**别让它替你数数** |
| 路由为什么用 generateText 不用 generateObject？ | generateObject 依赖网关 `response_format`，glm-4-flash 会静默无视导致解析炸裂。格式写进提示词 + `extractJson` 宽松解析 + zod 校验 + 重试一次，任何 OpenAI 兼容网关行为一致 |
| 三分类为什么喂最近 10 轮而不是只喂最新一条？ | 分类要看上下文，否则追问「那退款呢」会分错类；截 10 轮是精度与 token 的折中 |
| order 工人为什么建不了工单？ | 工具表按工人裁剪（最小权限）：误伤面从工具表上掐掉，比提示词里求它别建可靠得多 |
| 转人工为什么要带 HandoffPack？ | 退路的底线是「转过去不用复述」：工单号/原因/摘要/最近对话四件套让接手人直接上手，`reason` 写进工单是接手人的第一眼信息 |
| 模型挂了为什么是转人工不是报错？ | 用户侧看到的永远是业务动作，不是技术故障——降级写在 catch 分支里，可测且上线前必须演练 |
| 这段代码为什么住在 engine 包？ | CLI REPL 与 HTTP API（`/api/service`）共用同一套产品逻辑，app 之间禁止互相 import；连响应形状都同源（契约在 `@agent-app/shared`） |

---

## 自测题（先凭记忆答，再看文末答案）

1. `supervise` 的两级路由各自判定什么？三条硬规则的优先级顺序是什么、为什么这样排？
2. order 工人为什么不可能建工单？这体现了什么设计思想？
3. 摘要模型挂掉后，转人工还能完成吗？HandoffPack 里的 `userSummary` 装的是什么？

<details><summary>答案</summary>

1. 第一级 `checkHardRules` 纯函数硬规则（零 LLM），第二级 `classifyWithLlm` 三分类兜
   模糊地带。优先级：未解决计数 ≥2 > 明确要求转人工 > 高危白名单——「最需要兜底的排
   最前」：AI 原地打转时用户耐心已见底，即使用户没喊转人工也该转。
2. `WORKER_TOOLS` 按工人裁剪：order 的工具表里只有 `getOrderStatus`。最小权限思想——
   不靠提示词约束，靠「手里根本没有这个工具」从物理上掐掉误伤面。
3. 能。`buildHandoffPack` 的 catch 会降级到 `fallbackSummary`：拼接最近 3 条用户消息
   （「不猜、不编，只交出可信的已知」）；工单是 mock 实现不走网络——完全离线也能走完
   转人工流程。
</details>

---

## 延伸阅读

- [src/service/README.md](../src/service/README.md) ——本模块深度篇：三堵墙、降级链路全表、11 问自测清单、2.5 小时学习路线
- `docs/products/service.md`——教程产品线篇：Supervisor 星型 / 上线检查清单（仓库外层 `ai-agent-blog/docs/products/`，`npm run docs:dev` 起博客看）
- [ARCHITECTURE.md](../../../ARCHITECTURE.md) ——「一条消息的完整旅程」与六条踩坑实录
- [01-agent-loop.md](./01-agent-loop.md) ——工人手里的 `runToolLoop` 就是第 1 站那个循环
- [08-evals.md](./08-evals.md) ——路由套件断言的正是本篇的 `checkHardRules`；`pnpm eval` 里看它的 8 条路由用例
