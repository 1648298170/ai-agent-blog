// logger.ts —— engine 的可注入日志出口：库内部不硬编码 console，消费方可以
// 换成自己的日志系统（写文件、接监控、测试时静音），默认行为保持 console。
//
// 为什么存在（库卫生）：engine 是被 api / cli / 测试多方消费的库，库代码里散落
// `console.warn` 意味着「调用方对输出没有发言权」——测试想静音、生产想接结构化
// 日志，都改不了库内部的硬编码。一个最小接口 + 可替换单例，就是把发言权还给调用方。
//
// 边界（刻意不覆盖的范围）：
// - trace.ts 不走这里：轨迹是独立的可观测通道（stderr + AGENT_TRACE 开关），
//   有自己的开关与图标体系，与「库的警告日志」是两回事；
// - evals 的报告输出（report.ts 的 console.log）不走这里：那是 CLI 跑评测时的
//   产品输出（给人看的成绩单），不是库日志。
//
// 使用方式：
//   import { getEngineLogger } from "../logger.js";
//   getEngineLogger().warn("[memory] 未认识的 STORE=…");
// 替换默认实现（应用启动早期、任何工厂调用之前）：
//   setEngineLogger({ info: myLog, warn: myWarn });

/** engine 库日志的最小接口：只留两个用得到的级别，刻意保持小 */
export interface EngineLogger {
  /** 常规信息（当前库内部暂未使用，为消费方预留） */
  info(message: string): void;
  /** 警告：配置写错但已安全降级、数据脏行被跳过这类「不该无声吞掉」的事 */
  warn(message: string): void;
}

/** 默认实现：console 直出（零配置即可用的兜底行为） */
export const consoleLogger: EngineLogger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

/** 模块级单例：setEngineLogger 一次性替换，之后所有库内警告都走新实现 */
let current: EngineLogger = consoleLogger;

/** 换掉库日志实现（应用装配期调用一次即可；测试里可传空实现静音警告） */
export function setEngineLogger(logger: EngineLogger): void {
  current = logger;
}

/** 库内部统一从这里取当前日志实现（不直接用 console） */
export function getEngineLogger(): EngineLogger {
  return current;
}
