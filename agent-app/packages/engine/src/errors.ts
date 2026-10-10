// errors.ts —— engine 的领域错误基类：调用方按类型分支，而不是按中文文案做字符串比对。
//
// 为什么存在（坏味道修复，同 apps/api/src/chat/errors.ts 的思路）：此前循环中止
// 通过导出常量 TOOL_LOOP_ABORTED 让调用方比对 `err.message === TOOL_LOOP_ABORTED`——
// 文案改一个字，分支就静默失效。类型化后：文案随便改，分支挂在 instanceof 上。
//
// 设计边界（刻意不做的事）：
// - 不搞错误码表（数字/字符串码表是生产系统设施，教学模板用不上）；
// - 不改变「错误消息是中文」的设计——engine 的错误消息经常会被回灌给模型
//   （error-json）或转述给用户，**中文可读性是 feature**：类型给程序，文本给模型。
//
// 命名惯例：新错误继承 EngineError；message 保持中文 + 修复指引（同仓库错误礼仪）。

/** engine 领域错误基类：所有「调用方需要按类型分支」的错误都继承它 */
export abstract class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name; // 错误名 = 具体子类名（日志可读性）
  }
}
