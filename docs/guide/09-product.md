# 09 · 产品线组装：客服系统

> **这一站解决「零件怎么变成能上岗的产品」**：循环、记忆、RAG、护栏、插口、考卷——前六站全是零件，这一站总装。学完你将拥有一套两级路由 + 三工人 + 转人工退路的完整客服系统，以及「降级要降得可用」的组装纪律。

**前置**：[08 · 评估框架](/guide/08-evals)（组装完的系统靠考卷看守）+ [02 · 手写工具循环](/guide/02-agent-loop)（工人手里的发动机）
**配套跑起来**：`pnpm service`（话术实测）+ `pnpm test:service`（硬规则纯函数离线自测，node:assert、零网络）
**深读**：[参考库 · 客服产品线深读](/reference/09-service)（模块走读 + 上线检查清单）· [产品页 · 客服系统](/products/service)

---

## 一、为什么：组装视角看系统

把裸 LLM 放到客服窗口，会撞上三堵墙：**调度**（客服是分科的，一个模型背全部业务的提示词和工具会互相干扰、张冠李戴）、**确定性**（「转人工」「我要投诉」这类场景容不得模型偶尔判漏一次）、**退路**（AI 一定有接不住的时候，没有退路等于把用户关在门外）。

解法的形状是一个**星型**——像一台总机交换机：所有来电先进总机（Supervisor），总机按规则转分机（三个工人），转不出去就亲自接（转人工）：

```text
用户消息 ──► ① 硬规则（纯函数，零 LLM）──命中──► 转人工（建工单 + HandoffPack）
                 │ 全不命中
                 ▼
            ② 模型三分类（order / refund / knowledge）
                 │
      ┌──────────┼───────────┐
    order       refund      knowledge    ← 各配职责提示词 + 最小工具表
```

`packages/engine/src/service/` 三个文件各管一段：`supervisor.ts`（分诊）、`workers.ts`（三工人）、`handoff.ts`（转诊单）。状态活在应用循环里（CLI 维护计数与 `cs_` 会话），判定逻辑是纯数据入参——所以才能离线单测。

## 二、核心形态：两级路由 + 最小权限 + 上下文包

**① 硬规则优先（纯函数零 LLM）**。「连续两轮没解决」是计数、「明确要求」是关键词——代码数得比模型准、零成本零延迟、行为完全可测，必须排在任何 LLM 调用前面：

```ts
// packages/engine/src/service/supervisor.ts（节选）
export function checkHardRules(state: SupervisorState): RouteDecision | null {
  if (state.unresolvedRounds >= 2)
    return { target: "human", reason: `连续 ${state.unresolvedRounds} 轮未解决，AI 已在原地打转` };
  const request = matchAnyKeyword(state.lastUserMessage, HUMAN_REQUEST_KEYWORDS);
  if (request !== null) return { target: "human", reason: `用户明确要求转人工（关键词「${request}」）` };
  const risk = matchAnyKeyword(state.lastUserMessage, HIGH_RISK_KEYWORDS);
  if (risk !== null) return { target: "human", reason: `命中高危业务白名单（关键词「${risk}」），必须人工处理` };
  return null;   // 全不命中，才轮到模型
}
```

优先级是刻意的：**未解决计数 ≥2 > 转人工关键词（转人工/找真人/换人工/人工客服/换个人）> 高危白名单（退款争议/投诉/起诉/律师/法院/媒体）**——最需要兜底的排最前。计数本身不在 supervisor 里：`SupervisorState` 是纯数据，CLI 每轮按「命中追问信号 +1、正常提问清零」维护后传进来——状态归应用循环管，判定归纯函数管。

**② 模糊地带才问模型**。`classifyWithLlm` 用 `generateText` + 严格 JSON 指令 + 宽松解析（`extractJson`）+ zod 三分类校验（`z.enum` 把 route 锁死为三选一——能枚举就硬），输出不合规自动重试一次（第二次的 system 追加「你上一次的回复不是合法 JSON」），两次仍失败才抛错交给降级。为什么不用 `generateObject`？glm-4-flash 这类轻薄模型会静默无视网关的 `response_format`——格式必须写进提示词才网关无关。分类喂的是最近 10 轮窗口，否则一句「那退款呢」会分错类。

**③ 工具表按工人裁剪——最小权限思想**：

```ts
// packages/engine/src/service/workers.ts（节选）
const WORKER_TOOLS: Record<WorkerName, AgentToolSet> = {
  order:     { getOrderStatus },        // 只给查订单的锤子
  refund:    { createTicket },          // 只给建工单的锤子
  knowledge: { searchKnowledgeBase },   // 只给检索
};
```

order 工人建不了工单——不是提示词求它别建，是它手里**根本没有这个工具**。误伤面从工具表上就掐掉，比任何「请不要…」的提示词都可靠。职责提示词同时写清边界与出口：order「查不到如实告知，禁止编造订单信息」、refund「争议无法判定时建议转人工，不要自行承诺」、knowledge「先检索、只依据检索结果作答、句末标 [1][2]、检索不到老实说不知道」。工人本体只是 `runToolLoop` 的薄封装（全文件 66 行，`maxSteps` 用库默认 5）——引擎零件备得好，产品层就薄。

**④ 转人工带上下文包（HandoffPack 四件套）**。最毁体验的一幕是转过去后人工第一句「请问有什么可以帮您」。`handoff.ts` 的 `buildHandoffPack` 组装**工单号 / 判定原因 / 用户摘要 / 最近对话（最近 10 轮文稿）**——接手人不用用户复述。摘要提示词明写「禁止添加对话中没有出现的信息」（摘要幻觉出「用户已确认收货」会把接手人带进沟里）；摘要模型挂了降级为最近 3 条用户消息拼接——不猜、不编，只交出可信的已知。`RouteTarget` 里 `human` 与三个工人**并列**——转人工是业务流程的正常一步，不是异常，更不是报错。

## 三、跑起来（先体感）

```powershell
cd agent-app
pnpm service          # 无 key 也能启动；分类需配好 .env
pnpm test:service     # 硬规则全部离线断言（纯函数 + node:assert，零网络）
```

REPL 里按这个顺序试五句话，正好覆盖全部路由路径：

```text
订单 A-1024 到哪了？     → 模型分类 order → 徽标亮起 → 查订单工具 → 回答
出差住宿标准是多少？     → knowledge → 知识库检索 → 带引用回答
我要投诉你们            → 高危白名单命中，直接人工（不问模型）
转人工                  → 硬规则命中：建工单 + 打印 HandoffPack
（连续两句「到底怎么办」）→ 计数 ≥2 → 直接人工
```

`pnpm service --trace` 里盯 `🧭 路由` 行，能看到「硬规则命中（不问模型）」与「模型分类」两种判定的原话——第 1 节的优先级在真实流量里的样子。

## 四、降级链路：降级要降得可用

组装视角最重要的一课：**每一层挂了都有下一层接着，降级方向只有一个——转人工，绝不给报错页**：

| 哪里挂了 | 用户看到 |
|---|---|
| 模型两次输出不合规 / 没配 key / 网关不通 | 转人工 + 工单（reason 写明按降级预案处理，用户侧不暴露报错） |
| 工人执行失败（模型不可用） | 转人工 + 工单 |
| 摘要模型挂 | 工单照出（摘要降级为原文拼接） |
| 完全离线 | 工单本就是 mock，无网也能走完转人工 |

这不是口头承诺，是写在 catch 分支里的行为，且可测——HTTP API 侧（`POST /api/service/message`）在无 `.env` 时同样降级转人工出工单，完整可用。以用户第二次说「到底怎么办啊」为例，一条消息的完整旅程：

```text
① append 用户消息 → 取会话窗口 20 轮
② 命中追问信号 → unresolvedRounds 变 2
③ supervise → 硬规则：计数 ≥2 命中 → human（不问模型）
④ buildHandoffPack → 打印工单块 → 告知用户 → 回写会话
⑤ 计数清零（已转出去，接手人从新上下文开始）
```

另一条组装纪律：这套核心住在 engine 包而不是某个 app 里，CLI 与 HTTP API 共用同一套 `supervise` / `runWorker` / `buildHandoffPack`，响应形状同源于 `@agent-app/shared` 的契约——**公共核心进包，app 之间禁止互相 import**。

## 五、动手任务（做完才算通关）

1. `pnpm service` 里按第三节的五句话走一遍，对照 trace 说出每句走的哪条路。
2. `pnpm test:service` 后打开 `apps/cli/src/apps/service/__tests__.ts`，找到「双命中」用例（转人工关键词 + 计数 3 同时出现），验证 reason 报的是未解决轮数。
3. **改造**：加第四个工人「物流异常专席」——`WORKER_PROMPTS` / `WORKER_TOOLS` 各加一个键，路由 schema 加一个枚举值。

## 自测题（先凭记忆答，再展开）

1. 三条硬规则的优先级是什么？为什么未解决计数排最前？
2. order 工人为什么不可能建工单？这比提示词约束好在哪？
3. 模型路由彻底不可用时，用户会看到什么？这条链路在哪验证？

<details><summary>答案</summary>

1. 未解决计数 ≥2 > 明确要求转人工 > 高危白名单——最需要兜底的排最前：AI 已在原地打转时，后面说什么都晚了。
2. `WORKER_TOOLS` 按工人裁剪，order 的工具表里只有 `getOrderStatus`——权限从工具表上掐掉，不依赖模型「听话」；提示词约束模型可能无视，缺工具是物理事实。
3. 转人工 + 工单，不是报错页——CLI/API 的 catch 分支把 decision 判为 human 并走 `buildHandoffPack`；`pnpm test:service` 与无 key 环境下的 `POST /api/service/message` 都在验证这条链路。

</details>

---

## 延伸

- [参考库 · 客服产品线深读](/reference/09-service) —— 星型调度逐文件走读 + 上线检查清单
- 产品页：[客服系统](/products/service) —— REPL 话术清单与设计要点
- 归档周教程：[week13 · 产品线组装](/archive/weeks/week13/)
- 下一站：[10 · Web 前端与 SSE](/guide/10-frontend) —— 给这套系统装上事件驱动的脸
