// idempotency.factory.ts —— 幂等层存储的 env 驱动工厂：IDEMPOTENCY_STORE 一行换实现
// 消费方（api 的 chat.service、cli 的 chat）改用
//   const idempotency = createIdempotencyRegistryFromEnv()
// 之后底层实现由环境变量决定，业务代码零改动：
//
//   IDEMPOTENCY_STORE=memory  → 进程内存 Map（默认，与改造前完全一致）
//   IDEMPOTENCY_STORE=redis   → Redis SET NX PX 抢锁（多实例 / 重启共享幂等窗口）
//
// 铁律：不配置（或值不认识）一律回内存默认——离线优先原则，
// 没起 Docker 的机器上行为与改造前逐字节一致，绝不因新功能破坏老默认。
// （模式同 rag/store.factory.ts 与 memory/factory.ts，三处工厂一个模子。）
import type { AgentToolSet } from "../types.js";
import { loadEnv } from "../config.js";
import { getEngineLogger } from "../logger.js";
import { IdempotencyRegistry, wrapToolsWithIdempotency } from "./idempotency.js";
import { RedisIdempotencyRegistry, wrapToolsWithRedisIdempotency } from "./idempotency.redis.js";

/** IDEMPOTENCY_STORE 合法取值（默认 memory） */
export type IdempotencyStoreKind = "memory" | "redis";

/** 默认值常量：文档与工厂共用同一口径 */
export const DEFAULT_IDEMPOTENCY_STORE: IdempotencyStoreKind = "memory";

/** 幂等登记簿的联合类型：消费方持有与包装一律用它（实现由 env 决定，类型不写死） */
export type AnyIdempotencyRegistry = IdempotencyRegistry | RedisIdempotencyRegistry;

/**
 * 按环境变量装配幂等登记簿（默认 memory = 改造前的行为）。
 * env 参数缺省读 loadEnv()（.env 文件 + 进程环境变量合并），测试可注入。
 * Redis 版懒连接：选了 redis 也只是构造对象，第一条命令才真起连接——
 * 离线机器上误配 redis 不会在启动瞬间炸（首次工具调用才报连接错误并给指引）。
 */
export function createIdempotencyRegistryFromEnv(
  env: Record<string, string> = loadEnv(),
): AnyIdempotencyRegistry {
  const value = (env.IDEMPOTENCY_STORE ?? DEFAULT_IDEMPOTENCY_STORE).trim().toLowerCase();
  if (value === "redis") return new RedisIdempotencyRegistry();
  if (value !== DEFAULT_IDEMPOTENCY_STORE) {
    getEngineLogger().warn(
      `[idempotency] 未认识的 IDEMPOTENCY_STORE=「${env.IDEMPOTENCY_STORE}」（可选 memory | redis），按默认 ${DEFAULT_IDEMPOTENCY_STORE} 处理`,
    );
  }
  return new IdempotencyRegistry();
}

/**
 * 幂等壳的统一包装入口：按 registry 的实际实现分发到对应的 wrap。
 * 为什么要它：两个 run 的返回类型本就不同（Redis 版多降级分支），内存版
 * wrapToolsWithIdempotency 的签名收的是具体类——消费方拿联合类型时
 * 直接过不了编译。收口在这里做一次 instanceof 分发，消费方零分支。
 */
export function wrapToolsWithIdempotencyAuto(
  tools: AgentToolSet,
  registry: AnyIdempotencyRegistry,
  options: { scope: string },
): AgentToolSet {
  if (registry instanceof RedisIdempotencyRegistry) {
    return wrapToolsWithRedisIdempotency(tools, registry, options);
  }
  return wrapToolsWithIdempotency(tools, registry, options);
}
