// orchestrator/state-store.ts —— 编排状态持久化接口 + 内存默认实现。
//
// 为什么是接缝：断点续跑（进程崩溃后任务从上次状态恢复）的前提是「状态是真的」——
// 内存 Map 意味着重启即失忆（Demo/单实例档）；生产档挂 redis/pg 适配器
//（实现同一接口，orchestrator 零改动）。接口与实现的分离 = 依赖倒置。
//
// Effect 化说明：StateStore 接口保持 Promise（持久化适配器生态是 Promise 的），
// 编排器内部经 Effect.tryPromise 桥接——接缝层换范式，实现层不强迫迁移。
import type { TaskSpec, TaskState } from "./types.js";
import { TASK_TRANSITIONS } from "./types.js";
import { IllegalTransitionError } from "./errors.js";

/** 一次编排作业的持久化快照（状态 + 任务单 + 已完成产出 + 汇总） */
export interface OrchestrationSnapshot {
  readonly id: string;
  readonly goal: string;
  state: TaskState;
  /** 任务单快照：动态规划（planner 拆单）后持久化——断点续跑重入时跳过重新规划，
   *  保证 taskId 稳定（否则重入重新拆单，已完成产出对不上新任务单）。
   *  存入前须剥掉 TaskSpec.tools（ToolSet 含函数，structuredClone 不支持）。 */
  tasks?: readonly Omit<TaskSpec, "tools">[];
  /** 已完成子任务的产出（id → 产出摘要），按完成顺序追加 */
  readonly outputs: { taskId: string; text: string }[];
  /** 汇总产出（全部子任务完成后由编排器写入） */
  summary?: string;
  readonly createdAt: number;
  updatedAt: number;
}

/** 状态持久化接口：实现方必须保证「save 原子」（写一半崩了不能留脏状态） */
export interface StateStore {
  save(snapshot: OrchestrationSnapshot): Promise<void>;
  load(id: string): Promise<OrchestrationSnapshot | undefined>;
}

/** 内存默认实现：Demo/单实例档（重启即失忆——生产档换 redis/pg 适配器） */
export class MemoryStateStore implements StateStore {
  private readonly store = new Map<string, OrchestrationSnapshot>();

  async save(snapshot: OrchestrationSnapshot): Promise<void> {
    // 深拷贝写入：调用方继续改内存对象不影响已保存快照
    this.store.set(snapshot.id, structuredClone(snapshot));
  }

  async load(id: string): Promise<OrchestrationSnapshot | undefined> {
    const hit = this.store.get(id);
    return hit ? structuredClone(hit) : undefined;
  }
}

/** 状态机守护：校验迁移合法性、盖时间戳、返回新快照——编排器只经由这里改状态。
 *  非法迁移抛 IllegalTransitionError（编程错误直接暴露，不被策略吞掉）。 */
export function transition(
  snapshot: OrchestrationSnapshot,
  to: TaskState,
): OrchestrationSnapshot {
  const allowed = TASK_TRANSITIONS[snapshot.state];
  if (!allowed.includes(to)) {
    throw new IllegalTransitionError({
      message: `状态机非法迁移：${snapshot.state} → ${to}（请对照 TASK_TRANSITIONS 检查调用顺序）`,
      from: snapshot.state,
      to,
    });
  }
  return { ...snapshot, state: to, updatedAt: Date.now() };
}
