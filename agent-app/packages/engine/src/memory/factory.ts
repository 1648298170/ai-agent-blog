// factory.ts —— 三层记忆的 env 驱动工厂：SESSION_STORE / PREFERENCE_STORE 一行换实现（week17 实战）
// 消费方（cli chat/kb/service 启动、api chat.service / service.controller）统一改成
//   const sessionStore = createSessionStoreFromEnv()
// 之后底层实现由环境变量决定，业务代码零改动：
//
//   SESSION_STORE=memory     → 内存 Map（默认，与改造前完全一致）
//   SESSION_STORE=redis      → Redis list（agent:sess:{sessionId}，TTL 24h 续期，多实例共享）
//   PREFERENCE_STORE=memory  → 内存 Map（默认）
//   PREFERENCE_STORE=pg      → PostgreSQL user_preferences 长表（行级 upsert，重启不丢）
//
// 铁律：不配置（或值不认识）一律回内存默认——离线优先原则，
// 没起 Docker 的机器上行为与改造前逐字节一致。
// （EpisodicStore 暂无工厂：pgvector 版不在本次范围，见 memory/README.md 扩展路线表。）
import { loadEnv } from "../config.js";
import { InMemorySessionStore } from "./session.memory.js";
import { createRedisSessionStore } from "./session.redis.js";
import { InMemoryPreferenceStore } from "./preference.memory.js";
import { createPgPreferenceStore } from "./preference.pg.js";
import type { PreferenceStore, SessionStore } from "./types.js";

/** SESSION_STORE 合法取值（默认 memory） */
export type SessionStoreKind = "memory" | "redis";
/** PREFERENCE_STORE 合法取值（默认 memory） */
export type PreferenceStoreKind = "memory" | "pg";

/** 默认值常量：文档与工厂共用同一口径 */
export const DEFAULT_SESSION_STORE: SessionStoreKind = "memory";
export const DEFAULT_PREFERENCE_STORE: PreferenceStoreKind = "memory";

/** 按 env 装配会话存储（默认 memory）。summarize 可注入假实现（自检/测试离线覆盖压缩路径） */
export function createSessionStoreFromEnv(
  env: Record<string, string> = loadEnv(),
): SessionStore {
  const value = (env.SESSION_STORE ?? DEFAULT_SESSION_STORE).trim().toLowerCase();
  if (value === "redis") return createRedisSessionStore();
  if (value !== DEFAULT_SESSION_STORE) {
    console.warn(`[memory] 未认识的 SESSION_STORE=「${env.SESSION_STORE}」（可选 memory | redis），按默认 ${DEFAULT_SESSION_STORE} 处理`);
  }
  return new InMemorySessionStore();
}

/** 按 env 装配偏好存储（默认 memory） */
export function createPreferenceStoreFromEnv(
  env: Record<string, string> = loadEnv(),
): PreferenceStore {
  const value = (env.PREFERENCE_STORE ?? DEFAULT_PREFERENCE_STORE).trim().toLowerCase();
  if (value === "pg") return createPgPreferenceStore();
  if (value !== DEFAULT_PREFERENCE_STORE) {
    console.warn(`[memory] 未认识的 PREFERENCE_STORE=「${env.PREFERENCE_STORE}」（可选 memory | pg），按默认 ${DEFAULT_PREFERENCE_STORE} 处理`);
  }
  return new InMemoryPreferenceStore();
}
