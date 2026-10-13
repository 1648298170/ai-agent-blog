// orchestrator/policies.ts —— 可插拔策略：重试 / 失败分支（Effect 版）。
//
// 为什么是策略不是硬编码：失败处理是「部署形态的属性」——同一编排器，
// 原型环境 retry×1 就够，生产环境要指数退避 + 抖动 + 预算降级。
// 策略接口生产级、默认实现够用，替换 = 换一个对象（依赖注入）。
//
// Effect 化说明：重试的「执行」在编排器的 Effect.gen 循环里——退避走 Effect.sleep
//（虚拟时钟友好），可重试判定按下方口径接入（RetriableError 恒重试 + isRetriable 兜底）。
// 本文件只保留策略的「数据」部分：退避序列计算与失败分支声明。
//
// 可重试判定的口径（与 errors.ts 的分类对齐，编排器 retry 分支按此执行）：
// - RetriableError → 恒定可重试（显式分类优先）；
// - 其余错误 → 交给 isRetriable 判定（默认实现读 message 里的 429/5xx/timeout 特征）；
// - AcceptanceFailedError / BudgetExceededError / IllegalTransitionError → 不可重试（不匹配特征自然落入）。

/** 重试策略：指数退避 + 抖动 + 上限（防重试风暴的经典三件套） */
export interface RetryPolicy {
  /** 最大尝试次数（含首次）——默认 3 */
  readonly maxAttempts: number;
  /** 首次退避基数（毫秒）——默认 500；序列 = base × 2^(attempt-1) + 抖动 */
  readonly baseDelayMs: number;
  /** 单次退避上限（毫秒）——默认 8000，防指数失控 */
  readonly maxDelayMs: number;
  /** 可重试判定：返回 true 才进入退避重试，false 立即上抛 */
  readonly isRetriable: (err: unknown) => boolean;
}

export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  isRetriable: (err) => {
    if (err instanceof Error) {
      const m = err.message;
      // 暂时性失败特征：限流 / 网关 / 服务端 / 超时
      return /429|5\d\d|timeout|ECONNRESET|ETIMEDOUT/i.test(m);
    }
    return false;
  },
};

/** 指数退避 + 全抖动：delay = min(base × 2^attempt, max) × random(0.5~1)
 *  全抖动（而非等比加固定）是 AWS 官方推荐——冲突概率最低。 */
export function backoffDelay(policy: RetryPolicy, failedAttempts: number): number {
  const exp = policy.baseDelayMs * Math.pow(2, Math.min(failedAttempts, 5));
  const capped = Math.min(exp, policy.maxDelayMs);
  return Math.floor(capped * (0.5 + Math.random() * 0.5));
}

/** 子任务失败后的四分支策略 */
export type FailureStrategy = "retry" | "degrade" | "compensate" | "escalate";

export interface FailurePolicy {
  /** 默认分支（子任务可覆写）：retry = 重试耗尽后降级跳过；degrade = 立即降级不重试；
   *  compensate = 先执行补偿再上抛；escalate = 升级人工裁决（上抛） */
  readonly onFail: FailureStrategy;
  /** compensate 分支的补偿钩子：接收已完成子任务的产出，执行回滚（写操作必配） */
  readonly compensate?: (outputs: readonly TaskOutputLike[]) => Promise<void>;
}

/** 补偿钩子的最小形状（避免与 executor 的产出类型循环依赖） */
export interface TaskOutputLike {
  readonly taskId: string;
  readonly text: string;
}
