# 10 · 编排器：多 Agent 的生产级骨架

> **这一模块解决「多 Agent 从概念到落地」**：任务拆分、编排模式、失败策略、预算控制、状态机——每个生产级关注点都有显式接口与可配策略。它是 [09 站客服系统](/reference/09-service)的 Supervisor 模式的**泛化**：不再绑死「三工人」，而是「N 个可插拔角色 + 显式状态机 + 可配失败策略」。

**前置**：[02 · 工具循环](/guide/02-agent-loop)（executor 的底层引擎）· [09 · 产品线](/guide/09-product)（星型编排的单机版实战）
**代码位置**：`packages/engine/src/orchestrator/`（8 文件 ~980 行，Effect 范式）
**测试**：`test/orchestrator.spec.ts`（26 用例：状态机守护 / 验收闭环 / 失败四分支 / 预算超支 / 失败终态落盘 / 断点续跑 / DAG 顺序 / 事件断言 / TestClock 虚拟时钟）

---

## 一、它解决什么问题：多 Agent 的三个「新问题」

单 Agent 够用时不要拆（[02 站岔路 3](/guide/02-agent-loop)）。当出现以下信号时，编排器让拆分变成可管理的工程而不是灾难：

| 新问题 | 编排器的回应 |
|---|---|
| **分工**（谁干、干几步、依赖关系） | `TaskSpec` 显式规格（id / goal / dependsOn / acceptance）+ `Planner` 接口（LLM 动态拆 or 静态任务单） |
| **共享状态**（互相知道什么、崩了怎么办） | `StateStore` 接口（save/load 快照）——断点续跑建立在「状态是真的」之上 |
| **质量闭环**（谁验收、不达标怎么办） | `Acceptance` 显式标准 + `Critic` 接口 + 失败四分支策略（retry/degrade/compensate/escalate） |

---

## 二、核心框架：拆 · 派 · 跑

编排的全生命周期就是三个字。每个字对应模块内的一组文件，也是面试的一条主线。

### 拆（Split）—— 大任务怎么变成小任务

**什么时候拆**——四个「超过」信号（全部满足才拆，任何一个不满足就留在单 Agent）：

| 信号 | 症状 |
|---|---|
| 工具表超载 | 单 Agent 塞 20+ 工具，选错率飙升 |
| 上下文需要隔离 | 不同子任务的 system prompt 互相打架 |
| 职责冲突 | 同一 prompt 同时要求「严谨查询」和「灵活创作」，行为不稳定 |
| 并行机会 | 子任务互不依赖，拆开能并行提速 |

**怎么拆**——三种切法，按优先级：

| 切法 | 依据 | 例子 |
|---|---|---|
| **按业务域** | 订单/售后/知识是天然边界 | 客服三工人（09 站） |
| **按认知角色** | 规划/执行/批判是不同的思考方式 | planner→executor→critic 流水线 |
| **按数据/权限** | 不同 Agent 持不同密钥、访问不同数据 | 爆炸半径隔离（生产最硬的理由） |

**何时不拆**——**能 Workflow 别 Agent，能单 Agent 别多 Agent**。拆分是代价高昂的重构（跨 Agent 传状态、失败传播、调试复杂度全部翻倍），四个信号全满足才动手。

产物 = `TaskSpec[]`（id / goal / dependsOn / acceptance），即下一站「派」的输入。

### 派（Dispatch）—— 小任务分配给谁执行

依赖序分派 + 最小权限工具表。`Planner` 接口负责「谁来拆」（LLM 动态拆或静态任务单），拆出的 `TaskSpec` 按依赖图分波：入度 0 的任务**同波并行**（`Effect.all`），完成后解锁下游进入下一波。

### 跑（Run）—— 多个执行者协作不打架

状态机（显式迁移表守护）+ 失败策略（四分支）+ 预算（控制信号）+ 事件流（可观测）。

---

## 三、核心概念：三层契约 + 一个调度器

### 层 1 · 类型（`types.ts`）

```ts
// src/orchestrator/types.ts —— 验收标准显式化是生产级的分水岭
type Acceptance =
  | { type: "llm-judge"; rubric: string }   // LLM 对照 rubric 二元判定
  | { type: "contains"; anyOf: string[] }   // 产出包含任一关键词
  | { type: "manual" }                      // 必须人工验收 → 走 escalate
  | { type: "none" };                       // 无验收

// 状态机（显式枚举 + 合法迁移表守护）
type TaskState =
  | "pending" | "planning" | "executing" | "reviewing"
  | "done" | "failed" | "escalated" | "compensated";
```

**三条生产级分水岭**（每条都是玩具没有的）：

1. **验收标准进 TaskSpec**——critic 对照结构化标准判定，不靠感觉。`manual` 类型表示必须人工验收（→ 走 escalate 路径）；
2. **状态机显式**——`TASK_TRANSITIONS` 表守护每一条迁移（非法迁移抛 `IllegalTransitionError`，编程错误直接暴露不被策略吞掉）；`done → executing` 合法（断点续跑：追加新子任务后继续）；
3. **预算是控制信号**——`Budget` 池跨子任务共享扣减，超支抛 `BudgetExceededError` 终态 failed（不是监控指标，是「停下来」的命令）。

### 层 2 · 三角色契约（`roles.ts`）

依赖倒置的实战——编排器只认接口，实现按环境注入：

| 角色 | 接口 | 默认实现 | 测试替代 |
|---|---|---|---|
| **Planner** | `plan(goal, ctx) → TaskSpec[]` | `LlmPlanner`（LLM 拆任务单） | 静态任务单（跳过规划） |
| **Executor** | `execute(task, ctx) → TaskOutput` | `LoopExecutor`（runToolLoop 封装） | 确定性纯函数 |
| **Critic** | `review(task, acceptance, output)` | `AcceptanceCritic`（LLM rubric 判定） | 布尔函数（确定性通过/拒绝） |

### 层 3 · 失败策略（`policies.ts`）

四分支，**部署形态决定选哪支**：

| 分支 | 语义 | 典型场景 |
|---|---|---|
| `retry` | 退避重试（指数 + 全抖动），耗尽后标记 failed | 暂时性故障（429/5xx/超时） |
| `degrade` | 降级跳过，占位产出让后续子任务知道上游缺失 | 单个子任务挂了不影响主线 |
| `compensate` | 先执行补偿钩子（回滚已完成子任务副作用）再标记 compensated | 写操作类子任务失败 |
| `escalate` | 升级人工裁决（终态，外部系统接手） | 信心不足 / 策略要求人拍板 |

---

## 三、代码走读（`orchestrator.ts`，Effect 范式）

### 组装：全部构造期注入

```ts
// src/orchestrator/orchestrator.ts —— 只依赖接口，实现全部注入
export class Orchestrator {
  constructor(options: OrchestratorOptions = {}) {
    this.stateStore = options.stateStore ?? new MemoryStateStore();
    this.planner    = options.planner    ?? new LlmPlanner();
    this.executor   = options.executor   ?? new LoopExecutor({
      tools: options.defaultTools ?? {},
      systemPrompt: options.defaultSystemPrompt ?? "…",
      maxSteps: DEFAULT_MAX_STEPS,
    });
    this.critic = options.critic ?? new AcceptanceCritic();
    this.retryPolicy = options.retryPolicy ?? defaultRetryPolicy;
    this.failurePolicy = options.failurePolicy ?? { onFail: "retry" };
    this.onEvent = options.onEvent;
  }
```

### 主流程：Effect.gen 流水线（状态机 + 验收 + 波次派发）

```ts
// 双出口：run() 返回 Effect（结构化并发 / 虚拟时钟），runAsync() 是 Promise 桥接
run(spec: OrchestrationSpec, signal?): Effect.Effect<OrchestrationResult, unknown> {
  return Effect.gen(function* () {
    // 断点续跑：恢复快照；动态规划的任务单也存进快照（重入跳过重新规划）
    let snapshot = (yield* load(spec.id)) ?? { state: "pending", … };

    // 规划：静态任务单优先 → 快照任务单 → planner 动态拆（进 planning 态）
    let tasks = spec.tasks.length > 0 ? spec.tasks
      : (snapshot.tasks?.length ?? 0) > 0 ? snapshot.tasks!     // 断点续跑复用
      : yield* planDynamically();                                // 真正的动态拆单

    // 所有状态迁移走 moveTo：迁移合法性 + 时间戳 + state-changed 事件三合一
    snapshot = self.moveTo(snapshot, "executing");

    // DAG 波次派发：入度 0 并行跑（Effect.all），完成后解锁下游
    const dispatched = yield* Effect.result(dispatch);
    if (dispatched._tag === "Failure") {
      // 失败终态落盘：EscalatedError → escalated，其余 → failed
      //（落盘后重入合法：failed → executing 在迁移表内）
      const terminal = dispatched.failure instanceof EscalatedError ? "escalated" : "failed";
      snapshot = yield* self.persistTerminal(snapshot, terminal);
      return yield* Effect.fail(dispatched.failure);
    }

    // 编排级终审：汇总产出过 critic（spec.acceptance，缺省 none 瞬间过站）
    // → reviewing 态 → done。终审不达标：manual → escalated，其余 → failed
    snapshot = self.moveTo(snapshot, "done");
  });
}
```

### 单子任务执行（`executeWithStrategy`：Effect.result 分支 + 虚拟时钟退避）

```ts
// 完整管线：executor 调用 → 产出校验 → 验收 → 失败按策略分支
const outcome = yield* Effect.result(guardedAttempt);   // 不用 try/catch——result 把错误搬进成功通道

// ① per-task 预算：maxDurationMs → Effect.timeout（虚拟时钟友好）；maxTokens 事后校验
// ② 验收接线：产出先过 critic——
//    manual → 直接 EscalatedError（升级人工，不重试不降级）；
//    contains/llm-judge 不达标 → 打回重做（进失败策略）
// ③ 失败四分支（Effect.fail 替代 throw）：
if (err instanceof BudgetExceededError) return yield* Effect.fail(err);      // 预算穿透
if (onFail === "escalate")  return yield* Effect.fail(new EscalatedError(…)); // 升级人工
if (onFail === "compensate") { yield* compensate(…); return yield* Effect.fail(err); }
if (onFail === "retry" && attempts < maxAttempts) {
  const retriable = err.name === "RetriableError" || retryPolicy.isRetriable(err);
  if (retriable) {
    yield* Effect.sleep(Duration.millis(backoffDelay(…)));  // 虚拟时钟：TestClock 下零等待
    continue;                                                 // 确定性失败不浪费重试
  }
}
// degrade / retry 耗尽 → 降级跳过（占位产出，调用方据此判断哪些子任务被降级）
return { taskId: task.id, text: "（降级跳过）", … };
```

> **为什么是 Effect**：① `Effect.result` 取代 try/catch——错误进类型通道，`EscalatedError`/`BudgetExceededError` 按 `_tag` 精确分支（漏接 = 编译错误）；② `Effect.sleep` 驱动退避——`TestClock.adjust` 虚拟推进，重试测试零真实等待；③ `Effect.all` 并行波次——fiber scope 托管子任务生命周期，无孤儿 Promise。

---

## 四、跑起来（先体感）

```powershell
cd agent-app
pnpm --filter @agent-app/engine exec vitest run test/orchestrator.spec.ts
# 26 用例：状态机守护 / 验收闭环 / 失败四分支 / 预算超支 / 失败终态落盘 /
# 断点续跑（含动态规划任务单复用）/ DAG 顺序 / 事件断言 / TestClock 虚拟时钟——全部离线零网络
```

编排器默认不参与产品线（客服 / kb 均为单 Agent）——它是一个**可用的基建件**，消费方（api/cli）按需组装。

---

## 五、设计取舍（面试级追问）

| 追问 | 回答 |
|---|---|
| 为什么编排器不用框架（LangGraph 等）？ | 手写 = 每个接缝可插拔 + 循环本体零改动（同 02 站逻辑）。学过手写再看 LangGraph 的 checkpointer/interrupt/edges——就是你手写的 StateStore/escalate/dependsOn |
| 重试为什么用指数退避 + 全抖动？ | 固定间隔在并发场景造成重试风暴；全抖动（而非等比）是 AWS 官方推荐——冲突概率最低 |
| 为什么失败策略是配置不是代码？ | 部署形态的属性：原型 retry×1，生产 retry×3 + 退避 + 补偿。策略接口不变，换一个对象 |
| 为什么用接口注入而非继承？ | 依赖倒置 = 编排器只认契约，实现按环境装配（测试注入确定性桩 / 生产注入 LLM 版） |
| DAG 并行怎么做的？ | 入度计数 + 就绪波次：入度 0 的任务 `Effect.all` 并行（fiber scope 托管），完成解锁下游进下一波；有环在派发前直接拒绝 |
| 失败后同 id 重入为什么不再炸？ | 失败终态落盘：escalate → escalated、其余 → failed（都是 executing/reviewing 的表内迁移）——`failed → executing` 合法，断点续跑闭环；escalated 是终态，人工裁决后换新 id 重开 |
| 为什么整个编排器是 Effect 范式？ | ① 错误进类型通道（TaggedError + catchTag，漏接 = 编译错）② Effect.sleep 退避走虚拟时钟（TestClock 零等待测重试）③ Effect.all 并行 + fiber scope 托管生命周期。Promise 调用方走 `runAsync()` 桥接零迁移 |
| 断点续跑的存储？ | `StateStore` 接口——内存默认（Demo），redis/pg 适配器实现同接口即升级（orchestrator 零改动）；动态规划的任务单也进快照（重入跳过重新规划，taskId 稳定） |

---

## 六、自测题（先凭记忆答，再展开）

1. 验收标准为什么放进 TaskSpec 而不是 critic 的构造参数？
2. `IllegalTransitionError` 为什么「直接暴露不被策略吞掉」？
3. 断点续跑的前提是什么？如果 StateStore 是内存版，重启后发生了什么？

<details><summary>答案</summary>

1. 验收标准是**任务的属性**（每个任务有不同的「完成的定义」），不是编排器的属性（编排器服务所有任务）——放进 TaskSpec 让每个子任务独立声明自己的验收口径。
2. 非法迁移是**编程错误**（调用顺序写错了），不是运行时故障——错误处理策略（重试/降级）是为后者设计的。吞掉编程错误只会让它以更隐蔽的方式延迟爆发。
3. 前提 = 状态经 StateStore 持久化。内存版重启即清空 → 编排器当作全新任务跑（`load` 返回 undefined → 从头开始）；redis/pg 版重启后 `load` 返回快照 → 已完成子任务自动跳过。

</details>

---

## 延伸

- `packages/engine/src/orchestrator/` —— 源码目录（8 文件，Effect 范式）
- `packages/engine/test/orchestrator.spec.ts` —— 26 用例离线测试
- [09 · 产品线组装](/reference/09-service) —— Supervisor 星型的单机版实战（编排器的特化前身）
- [05 · 工具层加固](/guide/05-tools-hardening) —— 幂等壳与审批壳（编排器的两个"壳"）
- [MATURITY 矩阵](/how-to/MATURITY) —— 编排器的当前档位与生产前置项
