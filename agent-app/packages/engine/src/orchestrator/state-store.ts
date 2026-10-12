// orchestrator/state-store.ts —— 编排状态持久化接口 + 内存默认实现。
//
// 为什么是接缝：断点续跑（进程崩溃后任务从上次状态恢复）的前提是「状态是真的」——
// 内存 Map 意味着重启即失忆（Demo/单实例档）；生产档挂 redis/pg 适配器
//（实现同一接口，orchestrator 零改动）。接口与实现的分离 = 依赖倒置。
import type { TaskState } from "./types.js";
import { TASK_TRANSITIONS } from "./types.js";
import { IllegalTransitionError } from "./errors.js";

/** 一次编排作业的持久化快照（状态 + 已完成产出 + 汇总） */
export interface OrchestrationSnapshot {
  readonly id: string;
  readonly goal: string;
  state: TaskState;
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
    throw new IllegalTransitionError(snapshot.state, to);
  }
  return { ...snapshot, state: to, updatedAt: Date.now() };
}
