// orchestrator/errors.ts —— 编排域错误：全部继承 EngineError（类型化分支，禁文案匹配）。
//
// 错误与策略的分工：错误本身不带「怎么办」的决策——决策由 FailureStrategy 做；
// 错误只携带「分类依据」（retriable 标记），让策略能区分「可重试的暂时性失败」
//（429 / 5xx / 超时）与「不可重试的确定性失败」（4xx / 校验失败 / 预算超支）。
import { EngineError } from "../errors.js";

/** 可重试的错误：策略层据此决定是否进入退避重试 */
export class RetriableError extends EngineError {
  constructor(
    message: string,
    /** 建议的退避基数（毫秒）：429 常带 Retry-After，可显式传入 */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** 不可重试的错误：确定性失败（参数/权限/预算类），重试只会重复失败 */
export class PermanentError extends EngineError {}

/** 预算超支：token 池耗尽或墙钟超时——策略可降级（degrade）或升级人工（escalate） */
export class BudgetExceededError extends EngineError {
  constructor(message = "编排预算超支：任务未在 token/时间预算内完成") {
    super(message);
  }
}

/** 状态机非法迁移：编程错误（不是运行时故障），直接暴露不该被策略吞掉 */
export class IllegalTransitionError extends EngineError {
  constructor(from: string, to: string) {
    super(`状态机非法迁移：${from} → ${to}（请对照 TASK_TRANSITIONS 检查调用顺序）`);
  }
}

/** 验收不通过：critic 判定产出未达标——交由失败策略决定打回/降级/升级 */
export class AcceptanceFailedError extends EngineError {
  constructor(
    message: string,
    /** critic 的判定依据（转述给人工升级时的关键信息） */
    readonly detail: string,
  ) {
    super(message);
  }
}
