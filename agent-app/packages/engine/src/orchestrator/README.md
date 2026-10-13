# orchestrator · 多 Agent 编排器（Effect 版）

> 「多 Agent 从概念到落地」：任务拆分、DAG 并行派发、验收闭环、失败策略、预算控制、状态机——每个生产级关注点都有显式接口与可配策略。是 `service/`（Supervisor 客服）的**泛化**：不绑死「三工人」，而是「N 个可插拔角色 + 显式状态机 + 可配失败策略」。

📖 **完整深讲**：[参考库 · 编排器](../../../../../docs/reference/10-orchestrator.md)（拆·派·跑三字框架 + 代码走读 + 设计取舍 + 自测题）

## 三字框架

| 字 | 语义 | 模块内对应 |
|---|---|---|
| **拆**（Split） | 大任务变小任务：四个「超过」信号全满足才拆；产物 = `TaskSpec[]` | `types.ts` + `roles.ts`（Planner） |
| **派**（Dispatch） | 小任务分配执行：依赖图分波，入度 0 同波并行（`Effect.all`），完成后解锁下游 | `orchestrator.ts`（dispatch 循环） |
| **跑**（Run） | 协作不打架：状态机 + 验收闭环 + 失败四分支 + 预算 + 事件流 | `orchestrator.ts` + `policies.ts` + `state-store.ts` |

## 文件地图

| 文件 | 职责 |
|---|---|
| `types.ts` | 类型图纸：TaskSpec / 状态机迁移表 / Acceptance / Budget（纯数据，零 Effect 依赖） |
| `errors.ts` | 编排域错误：全部 `Data.TaggedError`（`catchTag` 精确分支，漏接 = 编译错误） |
| `policies.ts` | 策略数据：RetryPolicy（指数退避 + 全抖动）/ 失败四分支声明 |
| `state-store.ts` | 状态持久化接缝：StateStore 接口 + 内存默认实现 + transition 守护 |
| `roles.ts` | 三角色契约：Planner / Executor / Critic（Promise 接口，编排器内抬进 Effect） |
| `defaults.ts` | 默认实现：LlmPlanner / LoopExecutor（runToolLoop 封装）/ AcceptanceCritic |
| `orchestrator.ts` | 主体：Effect.gen 流水线 + DAG 波次派发 + 验收闭环 + 终态落盘 |
| `index.ts` | 桶文件出口 |

## 关键语义（生产级分水岭）

- **验收闭环**：子任务产出先过 critic——`manual` 直接升级人工（`escalated` 终态）；contains/llm-judge 不达标打回重做（走失败策略）。编排级终审走 `spec.acceptance`（`reviewing` 态）。
- **失败终态落盘**：escalate → `escalated`、其余失败 → `failed`——落盘后同 id 重入合法（`failed → executing` 表内迁移，断点续跑闭环）；`escalated` 是终态，人工裁决后换新 id 重开。
- **断点续跑**：状态 + 动态规划的任务单都进快照（重入跳过重新规划，taskId 稳定）。
- **预算是控制信号**：全局池波次间判（超支 → `failed`）；per-task `maxDurationMs`（`Effect.timeout` 硬约束）/ `maxTokens`（事后校验走策略）。
- **双出口**：`run()` 返回 Effect（结构化并发 / TestClock 虚拟时钟）；`runAsync()` Promise 桥接（现有调用方零迁移）。

## 跑测试

```powershell
pnpm --filter @agent-app/engine exec vitest run test/orchestrator.spec.ts
# 30 用例，全部离线零网络（角色注入确定性桩 + MemoryStateStore 真品）
```
