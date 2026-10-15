// config-env.spec.ts —— 护栏开关 .env 回填（fillGuardEnvKeys / hydrateGuardEnv）离线单测
// 覆盖三条契约（与 loadEnv() 的合并循环同款）：.env 只补缺、真实环境变量优先、空串视同未设；
// 外加两条边界：清单外的键绝不触碰、hydrateGuardEnv 在 vitest（NODE_ENV=test）下是文档化 no-op
// ——后者是「本机 .env 私有值不渗进测试」的安全前提，锁死防止未来被悄悄改掉。
import { afterEach, describe, expect, it } from "vitest";
import { fillGuardEnvKeys, GUARD_ENV_KEYS, hydrateGuardEnv } from "../src/config.js";

/** 快照：六个护栏键在进程环境里的原始值（undefined 也要记——恢复时区分 delete 与赋值） */
const snapshot = new Map<string, string | undefined>(GUARD_ENV_KEYS.map((key) => [key, process.env[key]]));

describe("护栏开关 .env 回填 fillGuardEnvKeys / hydrateGuardEnv", () => {
  afterEach(() => {
    // 快照恢复（chat.service.spec.ts 同款纪律）：原为 undefined → delete，否则原值写回
    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("GUARD_ENV_KEYS 恰好是文档约定的六个键（锁死公开契约，防手滑增删）", () => {
    expect([...GUARD_ENV_KEYS]).toEqual([
      "AGENT_GUARD_PII",
      "AGENT_GUARD_ALLOWLIST",
      "AGENT_GUARD_CONFIRM",
      "AGENT_GUARD_INPUT",
      "AGENT_GUARD_MCP_STRICT",
      "AGENT_GUARD_LLM_SCAN",
    ]);
  });

  it("未设 + 文件值 → 回填：.env 的默认值补进 process.env（bug 修复的主场景）", () => {
    delete process.env.AGENT_GUARD_PII;
    fillGuardEnvKeys({ AGENT_GUARD_PII: "1" });
    expect(process.env.AGENT_GUARD_PII).toBe("1");
  });

  it("真实环境变量优先：已设非空值不被 .env 覆盖（dotenv 契约）", () => {
    process.env.AGENT_GUARD_PII = "true";
    fillGuardEnvKeys({ AGENT_GUARD_PII: "1" });
    expect(process.env.AGENT_GUARD_PII).toBe("true");
  });

  it("空串真实环境变量视同未设：.env 默认值照常回填（与 loadEnv 合并规则同款）", () => {
    process.env.AGENT_GUARD_PII = "";
    fillGuardEnvKeys({ AGENT_GUARD_PII: "1" });
    expect(process.env.AGENT_GUARD_PII).toBe("1");
  });

  it("空文件值永不写入：.env 里的空串不算有效默认值", () => {
    delete process.env.AGENT_GUARD_PII;
    fillGuardEnvKeys({ AGENT_GUARD_PII: "" });
    expect(process.env.AGENT_GUARD_PII).toBeUndefined();
  });

  it("只碰六个护栏键：清单外的键（如 OPENAI_API_KEY）既不读也不写", () => {
    // OPENAI_API_KEY 不在护栏快照范围内，本用例自带快照-恢复（条件还原同款）
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "keep";
    fillGuardEnvKeys({ OPENAI_API_KEY: "x", AGENT_GUARD_MCP_STRICT: "1" });
    expect(process.env.OPENAI_API_KEY).toBe("keep");
    expect(process.env.AGENT_GUARD_MCP_STRICT).toBe("1");
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  it("hydrateGuardEnv 在 vitest 下是文档化 no-op（NODE_ENV=test 跳过回填）", () => {
    // 前置断言：vitest 设 NODE_ENV=test——这是测试环境跳过回填的安全前提
    expect(process.env.NODE_ENV).toBe("test");
    delete process.env.AGENT_GUARD_CONFIRM;
    expect(() => hydrateGuardEnv()).not.toThrow();
    // 本机 .env 即便写了 AGENT_GUARD_CONFIRM 也不许渗进测试进程
    expect(process.env.AGENT_GUARD_CONFIRM).toBeUndefined();
  });
});
