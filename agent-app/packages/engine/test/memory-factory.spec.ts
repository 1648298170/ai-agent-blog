// memory-factory.spec.ts —— 三层记忆 env 工厂的离线解析测试（零网络、零基础设施）
// 只测「开关 → 装配哪个实现」的纯解析行为：工厂构造 pgvector/redis 实现时是懒连接
// （构造不碰真实服务），断言落在返回值的类型形状上而不发起任何调用。
// EPISODIC_STORE 是第三个开关，与既有两个开关共用同一套铁律：
// 不配置（或值不认识）一律回内存默认——离线优先。
// （从桶入口 memory/index.js 导入，顺带验证新实现的导出接线。）
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EPISODIC_STORE,
  InMemoryEpisodicStore,
  createEpisodicStoreFromEnv,
} from "../src/memory/index.js";

describe("EPISODIC_STORE 工厂解析（离线，不连接任何服务）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("默认值常量：EPISODIC_STORE 缺省 memory（与文档口径一致）", () => {
    expect(DEFAULT_EPISODIC_STORE).toBe("memory");
  });

  it("未设置 EPISODIC_STORE → 内存实现（离线默认，零警告）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createEpisodicStoreFromEnv({});
    expect(store).toBeInstanceOf(InMemoryEpisodicStore);
    expect(warn).not.toHaveBeenCalled();
  });

  it("显式 EPISODIC_STORE=memory → 仍是内存实现", () => {
    expect(createEpisodicStoreFromEnv({ EPISODIC_STORE: "memory" })).toBeInstanceOf(InMemoryEpisodicStore);
  });

  it("EPISODIC_STORE=pgvector → pgvector 实现（形状断言：契约两方法齐备且不再是内存类；构造不开连接）", () => {
    const store = createEpisodicStoreFromEnv({ EPISODIC_STORE: "pgvector" });
    expect(store).not.toBeInstanceOf(InMemoryEpisodicStore);
    expect(typeof store.remember).toBe("function");
    expect(typeof store.recall).toBe("function");
  });

  it("大小写与空白宽容：「 PGVECTOR 」仍切 pgvector（与 SESSION/PREFERENCE 工厂同口径）", () => {
    const store = createEpisodicStoreFromEnv({ EPISODIC_STORE: " PGVECTOR " });
    expect(store).not.toBeInstanceOf(InMemoryEpisodicStore);
  });

  it("不认识的值 → 警告一次并回退内存（离线优先铁律，警告里带上原值与可选值）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createEpisodicStoreFromEnv({ EPISODIC_STORE: "sqlite" });
    expect(store).toBeInstanceOf(InMemoryEpisodicStore);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("EPISODIC_STORE");
    expect(warn.mock.calls[0]?.[0]).toContain("sqlite");
    expect(warn.mock.calls[0]?.[0]).toContain("memory | pgvector");
  });
});
