// errors.ts —— chat 模块的领域错误：错误携带建议的 HTTP 状态码，
// 控制器按 instanceof 映射响应，而不是按文案字符串匹配。
//
// 为什么存在（坏味道修复）：此前「非流式端点不支持审批」的错误靠
// controller 比对 `err.message === NON_STREAM_APPROVAL_UNSUPPORTED` 映射 400——
// 文案改一个字，映射就静默失效，编译器帮不上忙。领域错误类让映射
// 挂在类型上：文案随便改，statusCode 跟着错误走。
//
// 命名惯例：新错误继承 AppError 并给出 statusCode，文案常量就近导出
//（单一事实源），service 抛、controller 接，spec 直接断言文案。

/** chat 模块错误基类：子类声明自己的建议 HTTP 状态码 */
export abstract class AppError extends Error {
  abstract readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = new.target.name; // 错误名 = 具体子类名（日志可读性）
  }
}

/** 非流式端点不支持工具审批的统一文案（单一事实源：spec 与 Swagger 描述都引用它） */
export const NON_STREAM_APPROVAL_UNSUPPORTED = "该端点不支持工具审批，请改用流式端点 /api/chat/stream";

/** H5（红队加固轮）：非流式 chat() 在审批名单非空时直接拒收 → controller 映射 400 */
export class ApprovalUnsupportedError extends AppError {
  readonly statusCode = 400 as const;

  constructor(message: string = NON_STREAM_APPROVAL_UNSUPPORTED) {
    super(message);
  }
}
