// orchestrator/errors.ts —— 编排域错误：Effect Data.TaggedError（类型化分支，禁文案匹配）。
//
// 为什么换 TaggedError：手写 EngineError 子类只能靠 instanceof 分支（漏接无告警）；
// TaggedError 自带 _tag 判别字段——Effect.catchTag("BudgetExceededError", ...) 精确
// 分支，类型系统保证每个 tag 都被处理（漏接 = 编译错误）。
// TaggedError 仍是 Error 子类——旧代码的 instanceof 判断、rejects.toThrow 全部兼容。
//
// 错误与策略的分工：错误本身不带「怎么办」的决策——决策由 FailureStrategy 做；
// 错误只携带「分类依据」（retriable 标记），让策略能区分「可重试的暂时性失败」
//（429 / 5xx / 超时）与「不可重试的确定性失败」（4xx / 校验失败 / 预算超支）。
import { Data } from "effect";

/** 可重试的错误：策略层据此决定是否进入退避重试 */
export class RetriableError extends Data.TaggedError("RetriableError")<{
  readonly message: string;
  /** 建议的退避基数（毫秒）：429 常带 Retry-After，可显式传入 */
  readonly retryAfterMs?: number;
}> {}

/** 不可重试的错误：确定性失败（参数/权限/预算类），重试只会重复失败 */
export class PermanentError extends Data.TaggedError("PermanentError")<{
  readonly message: string;
}> {}

/** 预算超支：token 池耗尽或墙钟超时——策略可降级（degrade）或升级人工（escalate） */
export class BudgetExceededError extends Data.TaggedError("BudgetExceededError")<{
  readonly message: string;
}> {}

/** 状态机非法迁移：编程错误（不是运行时故障），直接暴露不该被策略吞掉 */
export class IllegalTransitionError extends Data.TaggedError("IllegalTransitionError")<{
  readonly message: string;
  readonly from: string;
  readonly to: string;
}> {}

/** 验收不通过：critic 判定产出未达标——交由失败策略决定打回/降级/升级 */
export class AcceptanceFailedError extends Data.TaggedError("AcceptanceFailedError")<{
  readonly message: string;
  /** critic 的判定依据（转述给人工升级时的关键信息） */
  readonly detail: string;
}> {}
