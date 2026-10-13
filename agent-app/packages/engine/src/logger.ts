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
//
// ── 结构化日志（AGENT_LOG_FORMAT=json）───────────────────────────────────
// 生产采集（Loki / ELK / CloudWatch）吃的是 JSON 行，不是给人看的 console 直出。
// 开了 json 之后「默认实现」从 consoleLogger 切为 pino 适配器（level 读
// AGENT_LOG_LEVEL，默认 info；JSON 行写 stdout）。三条优先级铁律：
//   1. 显式 setEngineLogger 注入的自定义实现永远最高——env 开关抢不走调用方的发言权；
//   2. 默认态（从未 setEngineLogger，或 set 回 consoleLogger）才由 env 决定：
//      json → pino，其余（未设置 / text）→ consoleLogger，与引入本开关之前逐字节一致；
//      想从注入态回到「env 决定」，setEngineLogger(consoleLogger) 即可（consoleLogger
//      语义上是「默认实现」而不是「强制 console」）。
//   3. pino 用法保持最小：pino({ level })，不引 pino-pretty、不接传输流。
//      pino 静态 import 是刻意的——EngineLogger 是同步接口，动态 import（async）
//      会传染所有调用点；几十毫秒的一次性模块成本换同步装配，值得。
import pino from "pino";
import { loadEnv } from "./config.js";

/** engine 库日志的最小接口：只留两个用得到的级别，刻意保持小 */
export interface EngineLogger {
  /** 常规信息（当前库内部暂未使用，为消费方预留） */
  info(message: string): void;
  /** 警告：配置写错但已安全降级、数据脏行被跳过这类「不该无声吞掉」的事 */
  warn(message: string): void;
}

/** 默认实现（text 模式）：console 直出（零配置即可用的兜底行为） */
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
  // 注入的自定义实现一字不问 env 直接用；只有默认态才看 AGENT_LOG_FORMAT
  if (current !== consoleLogger) return current;
  return isJsonLogFormat() ? getPinoLogger() : consoleLogger;
}

/**
 * 日志形态开关：AGENT_LOG_FORMAT=json → true（其余一切值，含未设置 → false）。
 * logger 与 trace（结构化轨迹）共用这同一个开关口径——「日志形态」是进程级决策，
 * 两处各自实现一份判断迟早漂移，所以唯一一份长在这里、trace.ts 来借。
 */
export function isJsonLogFormat(env: Record<string, string> = loadEnv()): boolean {
  return (env.AGENT_LOG_FORMAT ?? "").trim().toLowerCase() === "json";
}

/** pino 认识的 level 全集（含 silent）：白名单外一律回退 info——配置错误不炸日志链 */
const PINO_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

/** pino 适配器缓存（按 level 键）：实例创建是重活，level 没变就复用 */
let pinoCache: { level: string; impl: EngineLogger } | null = null;

/** 拿 pino 适配的 EngineLogger：JSON 行写 stdout，level 在创建时读一次 env */
function getPinoLogger(): EngineLogger {
  const raw = (loadEnv().AGENT_LOG_LEVEL ?? "").trim().toLowerCase();
  const level = PINO_LEVELS.has(raw) ? raw : "info";
  if (pinoCache && pinoCache.level === level) return pinoCache.impl;

  const p = pino({ level });
  const impl: EngineLogger = {
    info: (message) => {
      p.info(message);
    },
    warn: (message) => {
      p.warn(message);
    },
  };
  pinoCache = { level, impl };
  return impl;
}
