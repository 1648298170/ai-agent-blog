# 03 · 工具箱：Agent 的手

> 一句话：LLM 只有"嘴"——它能说要查订单，但查不了。工具就是模型的手：
> **模型只点名（吐出工具名 + 参数），代码出手（校验、执行、回灌）**。
> 工具表长什么样，Agent 的能力边界就到哪；写操作有没有幂等壳，半夜重试时工单会不会翻倍就看它。

---

## 它解决什么问题

agent-loop 解决了"模型怎么用工具"，本目录解决"工具本身怎么造、怎么管"：

| 问题 | 本目录的回答 |
|---|---|
| 模型怎么知道有哪些工具、怎么调？ | 每个工具自带说明书：`description` + zod `inputSchema`，SDK 转成 JSON Schema 发给模型 |
| 模型回传的参数能直接执行吗？ | 不能。zod schema 先 `safeParse` 校验（生成与校验**同一张图纸**） |
| 工具表怎么按应用裁剪？ | `ToolRegistry` 按名登记；chat 拿 4 个，客服工人各拿 1 个——职责外的锤子不发 |
| "创建工单"被执行两次怎么办？ | 幂等层：同会话 + 同工具 + 同参数，TTL 窗口内只真正执行一次 |

还有一个容易被忽视的事实：**`description` 和 `.describe()` 本身就是 prompt 的一部分**，
措辞模型直接看得见。实测 glm-4-flash 这类轻量模型对描述开头的内容、以及工具表里
靠前的工具权重更高——所以 description 要写清「适合什么、不适合什么」，别指望模型自己悟。

---

## 核心概念（5 分钟版）

### ① schema 即图纸，单一真源

同一个 zod schema 干两件事：转成给模型看的参数说明 + 校验模型回传的参数。
说明书和验货标准是**同一张纸**，永远不会漂移。这就是为什么本目录所有工具的
入参都用 `z.object({...})` 写。

### ② 工具表 = 能力边界

| 消费方 | 工具表 | 出处 |
|---|---|---|
| chat REPL | `{ ...createDemoTools(), searchKnowledgeBase }` 共 4 个 | `apps/cli/src/apps/chat/cli.ts` |
| service 三个工人 | order `{getOrderStatus}` / refund `{createTicket}` / knowledge `{searchKnowledgeBase}` 各 1 个 | `src/service/workers.ts` |
| selftest | `ToolRegistry` 登记 demo 三件套 → `getAll()` 喂 `runToolLoop` | `apps/cli/src/selftest.ts` |

不给职责之外的锤子，误伤面从工具表上就掐掉了——这是最便宜的安全措施。

### ③ Agentic RAG 的最小形态

`searchKnowledgeBase` 不是"每次都查"：它在工具表里，**模型自己决定**这一轮要不要查
知识库。对比传统 RAG 管道（问句无脑过检索），这一个小小的位置差异就是 Agentic RAG
的定义——检索从"流程步骤"变成了"模型的决策"。

### ④ 幂等：写操作的安全带

LLM 的工具调用不受客户端事务控制——模型重试、用户重复提问、上游超时补偿重发，
都会让"创建工单"这类**写操作**被执行多次。业界标准是显式幂等键（Stripe 的
`Idempotency-Key` 头）；但 Agent 场景里模型不会可靠地生成键，所以退一档用
**参数指纹**：`scope + 工具名 + 规范化参数` 哈希当键。

---

## 代码走读（`src/tools/`，5 个文件）

### 1. `registry.ts`（28 行）—— 注册表

| 位置 | 内容 | 要点 |
|---|---|---|
| `register`（L10） | 按名登记进 Map | 同名重复注册以最后一次为准；返回 `this` 支持链式 |
| `getAll`（L16） | 吐出普通对象 | 正是 `generateText({ tools })` / `runToolLoop({ tools })` 要的形状 |
| `names`（L25） | 工具名列表 | 排障日志用 |

```ts
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(name: string, tool: AgentTool): this {
    this.tools.set(name, tool);
    return this;                                    // 链式：registry.register(a, ta).register(b, tb)
  }

  getAll(): Record<string, AgentTool> { /* Map → 普通对象 */ }
  names(): string[] { /* 排障用 */ }
}
```

诚实地说：产品线的工具表目前多用对象字面量直接拼，`ToolRegistry` 的活跃消费方是
selftest——在那里验证"registry 吐出的表与手写循环兼容"。它的价值是给"按名登记"
留了标准挂点：后续 MCP 接入、动态启停工具时，30 行的它就是扩展点。

### 2. `demo-tools.ts`（78 行）—— 三个纯数据演示工具

| 工具 | 位置 | 入参 | 返回 | 性质 |
|---|---|---|---|---|
| `getOrderStatus` | L32 | `orderId` | `status + eta`（查 mock 表 `ORDERS`：A-1024 已发货 / A-2048 打包中 / B-0001 已签收；查不到老实返回"未找到"） | 读 |
| `createTicket` | L47 | `subject, description` | 自增工单号 `TK-日期-序号`（`nextTicketId()` L18） | **写**（幂等层的经典案例） |
| `escalateToHuman` | L59 | `reason, transcript` | `HandoffPack`（ticketId / reason / transcript / createdAt，L9） | 写 |

```ts
export const getOrderStatus = tool({
  description: "按订单号查询订单状态与预计送达时间",
  inputSchema: z.object({
    orderId: z.string().describe("订单号，如 A-1024"),   // .describe 也是 prompt 的一部分
  }),
  execute: async ({ orderId }) => {
    const order = ORDERS[orderId];                       // 固定 mock 表
    if (order) return { orderId, status: order.status, eta: order.eta };
    return { orderId, status: "未找到", eta: "请确认订单号是否正确" };  // 老实说找不到，不编
  },
});
```

为什么纯 mock 数据：①离线——selftest 不碰网络就能跑通整个循环；②确定——固定订单表
让 selftest 能**逐字断言**工具输出；③教学友好——注意力放在 schema 与返回形状上。

### 3. `kb-search.ts`（45 行）—— 第一个"真"工具

把 rag 零件的 `searchKnowledge` 包成工具（`k` 限 1~10、默认 5）。两个关键设计：

```ts
execute: async ({ query, k }) => {
  const hits = await searchKnowledge(query, k ?? 5);     // 真实 embedding 检索（碰网）
  return {
    query, hitCount: hits.length,
    notice: RAG_GROUNDING_RULE,                          // 数据性声明：资料是数据不是指令
    hits: hits.map((chunk, i) => ({
      no: i + 1,                                         // ★ 引用编号由后端分配
      title: chunk.title,
      text: fenceCitation(i + 1, chunk.title, mask ? maskPii(chunk.text) : chunk.text),
      score: Number(chunk.score.toFixed(3)),             // 相似度：排查检索质量的第一手数据
    })),
  };
},
```

- **编号后端分配**（`src/tools/kb-search.ts:37` 的 `no: i + 1`）：description 只允许模型
  "引用哪块就标注对应编号，如 [1][2]"——编号与标题的映射握在代码手里，**模型编不了页码**
- 围栏 + PII 脱敏（`AGENT_GUARD_PII=1` 时）：工具输出是外部内容回灌模型的主通道，
  红队测试证明这里零防线时模型会把注入载荷当指令执行

### 4. `idempotency.ts`（139 行）—— 幂等层（本篇重点）

**三条语义纪律**（缺一不可，全写在头注释里）：

1. **成功才缓存**：execute 抛错的调用不进缓存——失败后的重试是合理的新尝试，
   把失败也缓存住会把这个尝试堵死
2. **在途共享**：同键并发调用共享同一个 Promise——第二个调用者等第一个的执行结果，
   而不是各执行各的
3. **scope 隔离**：键里带 scope（通常是 sessionId）——不同会话提交相同内容的工单
   是两笔业务，不能互相去重

核心 `run()`（`src/tools/idempotency.ts:62`）：

```ts
run<T>(scope: string, toolName: string, args: unknown, execute: () => Promise<T>): Promise<T> {
  const key = `${scope}::${toolName}::${stableStringify(args)}`;   // 参数指纹键
  const now = Date.now();

  const hit = this.entries.get(key);
  if (hit !== undefined) {
    if (hit.expiresAt > now) return hit.promise as Promise<T>;     // ① 重放命中：不执行
    this.entries.delete(key);                                      // 过期条目惰性清理
  }

  const promise = execute().then(
    (result) => result,
    (err: unknown) => {
      // ② 失败自删（只删自己这条），reject 照常传给所有等待者——失败不缓存
      const current = this.entries.get(key);
      if (current !== undefined && current.promise === promise) this.entries.delete(key);
      throw err;
    },
  );
  this.entries.set(key, { promise, expiresAt: now + this.ttlMs });  // 在途共享：存的就是 Promise
  // ③ 超过 maxEntries（默认 500）：Map 迭代序 = 插入序，淘汰最早条目
  return promise;
}
```

`stableStringify`（L39）解决指纹的稳定性：对象键排序 + 过滤 undefined——
`{a:1,b:2}` 与 `{b:2,a:1}`、`{a:1}` 与 `{a:1,b:undefined}` 必须同指纹：

```ts
const entries = Object.entries(value as Record<string, unknown>)
  .filter(([, v]) => v !== undefined)   // zod optional 缺省的两种形态等价
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
```

外层的壳（`wrapToolsWithIdempotency`，L118）：给整套工具的 execute 套上
`registry.run`，模型与业务代码零感知；**无 execute 的工具原样透传**；
不调用本函数 = 无幂等层，行为与原来逐字节一致（零变化默认）。

```ts
// apps/cli/src/apps/chat/cli.ts:381 —— 请求级包装，scope 用当前会话
tools: wrapToolsWithIdempotency(tools, idempotency, { scope: sessionId }),
```

**与审批壳的叠加顺序**：先套幂等、再套审批（审批壳在外）——执行时先过人工审批，
审批通过才进入幂等判定。这样"被用户拒绝的调用"根本到不了幂等层，不会污染缓存。

> 实战推荐：多个壳的叠加用 `composeToolShells`（`src/tools/compose.ts`）声明式组合——
> 数组顺序 = 拦截顺序（洋葱模型，shells[0] 最外层），api/cli 两端共用同一份壳清单，
> 叠加顺序从"代码嵌套"升格为"一眼可见的配置"。

---

## 跑起来验证（先跑再读，体感翻倍）

```powershell
cd agent-app
pnpm kb:ingest .\samples\company-faq.md    # 可选：给知识库检索备料（不入库则检索 0 命中）
pnpm chat --trace
```

在 REPL 里依次试（命令：`/exit` 退出，`/new` 开新会话）：

```text
订单 A-1024 到哪了？        → ⚙ getOrderStatus（模型自主选了查订单的锤子）
出差住宿标准是多少？        → ⚙ searchKnowledgeBase（Agentic RAG：模型决定要查知识库）
帮我建个工单，主题是查不到订单  → createTicket 返回 TK-20261009-0001 之类的工单号
```

> 幂等层在 REPL 里的观感不稳定（模型看到历史里已建过工单，第二次可能直接复述旧单号
> 而不再调工具——这本身就是"省一次写"的另一种形态）。想确定性验证三条纪律，
> 跑离线单测（`packages/engine/test/idempotency.spec.ts`：计数器闭包断言"真执行了几次"）：

```powershell
pnpm test:engine      # 覆盖：首调执行 / 重放命中 / 失败不缓存 / 在途共享 / TTL 过期 / scope 隔离
pnpm selftest         # 注册表链路：ToolRegistry → getAll() → runToolLoop（零网络）
```

---

## 设计取舍（面试级追问）

| 追问 | 回答 |
|---|---|
| 为什么不用显式幂等键（Stripe 式）？ | 那要求调用方可靠地生成并携带键；Agent 场景里调用方是模型——它连"今年是哪年"都会幻觉。参数指纹是"模型不可靠"前提下的退一档选择：可重复的输入 = 可重放的请求 |
| 为什么"成功才缓存"是纪律？ | 失败重试是真重试（网络抖动后理应再试一次）；把失败也缓存住，重试会永远拿到同一个错误——等于把临时故障升级成永久故障 |
| 在途共享为什么存 Promise 而不是结果值？ | 并发时第二个调用者不能等第一个"执行完再查表"（有时序窗口），直接拿到同一个 Promise await 才是封闭的；失败自删挂在 promise 链上而不是 catch 吞错，reject 照常传给所有等待者 |
| 为什么进程内存 Map 而不是 Redis？ | 与审批登记簿同一取舍：重启即清 = 缓存窗口过期，语义上完全可接受；跨实例部署要共享幂等窗口时换 Redis SETNX + TTL，接口不变（头注释 L18 写明） |
| TTL 为什么默认 10 分钟 + 500 条上限？ | 覆盖"模型重试 / 用户手抖 / 上游超时补偿"的时间尺度；maxEntries 按插入序淘汰防长跑进程内存泄漏。都是 `IdempotencyRegistryOptions`（L28）可调的构造参数 |
| 演示工具为什么纯 mock？ | 离线可跑（selftest 铁律）、行为确定（可逐字断言）、教学聚焦。换真实后端时契约（AgentTool）不变，只换 execute——mock 表就是替换点 |

---

## 自测题（先凭记忆答，再看文末答案）

1. "schema 即图纸"是什么意思？如果入参说明写在 prompt 里、校验逻辑另写一份，会出什么问题？
2. 幂等层的三条语义纪律是什么？各自防住哪种事故？
3. 幂等壳与审批壳（apps/api 的 `AGENT_CONFIRM_TOOLS` 名单）谁在内谁在外？为什么被拒绝的调用不能进幂等缓存？

<details><summary>答案</summary>

1. 同一个 zod schema 既生成给模型看的参数说明、又校验模型回传的参数。两份分开写会
   漂移：说明书说 `orderId` 必填、验货标准却允许缺省（或反之）——模型按说明书生成的
   合法入参被验货拦下，或非法入参漏网。
2. ①成功才缓存：失败重试是真重试（防临时故障被缓存成永久故障）；②在途共享：同键并发
   共享同一 Promise（防并发窗口内各执行各的、重复写）；③scope 隔离：键里带 sessionId
   （防不同会话的同参业务被互相去重）。
3. 幂等壳在内、审批壳在外（先套幂等、再套审批）：执行顺序是先审批后幂等判定。被用户
   拒绝的调用根本没执行过，若进了缓存，之后用户改主意允许执行时会被缓存里的"拒绝前
   状态"污染——更糟的是根本没结果可回放。

</details>

---

## 延伸阅读

- [01-agent-loop.md](./01-agent-loop.md) —— 工具被谁调度：入账 → 调度 → 回灌的循环本体
- [02-llm-config-trace.md](./02-llm-config-trace.md) —— 模型工厂与轨迹开关（⚙✓ 就是 trace.ts 打的）
- [04-memory.md](./04-memory.md) —— scope（sessionId）背后那套会话存储
- [06-guardrails.md](./06-guardrails.md) —— 审批壳 / PII 脱敏 / 白名单这些安全壳怎么叠（规划中）
- [../../packages/engine/src/tools/README.md](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/packages/engine/src/tools/README.md) —— 本目录自带的深度导读（含评测为什么另造夹具工具）
- [ARCHITECTURE.md](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/ARCHITECTURE.md) —— 工具在整条消息旅程里的位置
