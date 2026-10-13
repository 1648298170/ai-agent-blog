// token-estimate.spec.ts —— token 估算层测试：两种估算器的量级断言与开关切换。
// 估算器开关走 loadEnv() → process.env 优先于 .env 文件，所以直接设进程环境变量
// 即可注入（与 hardening.spec.ts 的 AGENT_AUDIT_LOG 同款 save/restore 惯例）。
// tiktoken 的断言只锁「量级区间」不锁精确值：BPE 计数随词表版本可能微漂，
// 区间断言（100 汉字 ≈ 80~150）足以证明「真的在分词计数」而不是字符系数。
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens } from "../src/memory/token-estimate.js";

/** 恰好 100 个常用汉字（20 字句 × 5）：cl100k_base 实测 ≈115 tokens，落在 80~150 区间 */
const ZH100 = "智能体技术正在快速改变世界产业格局与未来".repeat(5);
/** 72 个 ASCII 字符的英文句：cl100k_base 实测 16 tokens；chars 口径 ceil(72×0.25)=18 */
const EN72 = "The quick brown fox jumps over the lazy dog near the river bank at dawn.";

const ORIGINAL = process.env.AGENT_TOKEN_ESTIMATOR;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AGENT_TOKEN_ESTIMATOR;
  else process.env.AGENT_TOKEN_ESTIMATOR = ORIGINAL;
});

describe("estimateTokens · tiktoken 口径（默认）", () => {
  it("未设置 AGENT_TOKEN_ESTIMATOR → tiktoken：100 汉字落在 80~150 tokens 区间", () => {
    delete process.env.AGENT_TOKEN_ESTIMATOR;
    const tokens = estimateTokens(ZH100);
    expect([...ZH100].length).toBe(100); // 夹具自检：样本确实 100 字
    expect(tokens).toBeGreaterThanOrEqual(80);
    expect(tokens).toBeLessThanOrEqual(150);
  });

  it("显式 tiktoken：英文样本落在 10~25 tokens 区间（≈0.22 token/字符）", () => {
    process.env.AGENT_TOKEN_ESTIMATOR = "tiktoken";
    const tokens = estimateTokens(EN72);
    expect(tokens).toBeGreaterThanOrEqual(10);
    expect(tokens).toBeLessThanOrEqual(25);
  });

  it("空串 = 0（不必触发编码器构建）", () => {
    process.env.AGENT_TOKEN_ESTIMATOR = "tiktoken";
    expect(estimateTokens("")).toBe(0);
  });

  it("非法值（AGENT_TOKEN_ESTIMATOR=bogus）静默回退 tiktoken：中文量级与默认一致", () => {
    process.env.AGENT_TOKEN_ESTIMATOR = "bogus";
    const tokens = estimateTokens(ZH100);
    expect(tokens).toBeGreaterThanOrEqual(80);
    expect(tokens).toBeLessThanOrEqual(150);
  });
});

describe("estimateTokens · chars 口径（系数兜底）", () => {
  it("AGENT_TOKEN_ESTIMATOR=chars：100 汉字 = 恰好 100（1 token/字）", () => {
    process.env.AGENT_TOKEN_ESTIMATOR = "chars";
    expect(estimateTokens(ZH100)).toBe(100);
  });

  it("chars：纯英文 72 字符 = ceil(72×0.25) = 18（恰好整除不进位）", () => {
    process.env.AGENT_TOKEN_ESTIMATOR = "chars";
    expect(estimateTokens(EN72)).toBe(18);
  });

  it("chars：中英混排分别计数再加权和（2 汉字×1 + 4 字母×0.25 = 3）", () => {
    process.env.AGENT_TOKEN_ESTIMATOR = "chars";
    expect(estimateTokens("你好abcd")).toBe(3);
  });

  it("chars：小数向上取整（3 个非中文字符 ×0.25 = 0.75 → 1）", () => {
    process.env.AGENT_TOKEN_ESTIMATOR = "chars";
    expect(estimateTokens("abc")).toBe(1);
  });

  it("chars：空串 = 0", () => {
    process.env.AGENT_TOKEN_ESTIMATOR = "chars";
    expect(estimateTokens("")).toBe(0);
  });

  it("大小写与空白宽容：「 CHARS 」仍切 chars 口径（与存储工厂同口径）", () => {
    process.env.AGENT_TOKEN_ESTIMATOR = " CHARS ";
    expect(estimateTokens(EN72)).toBe(18);
  });
});

describe("estimateTokens · 两种口径的量级一致性", () => {
  it("同一份中文样本，tiktoken 与 chars 的结果都落在 0.5x~2x 的同量级带内", () => {
    const byChars = (() => {
      process.env.AGENT_TOKEN_ESTIMATOR = "chars";
      return estimateTokens(ZH100);
    })();
    const byTiktoken = (() => {
      process.env.AGENT_TOKEN_ESTIMATOR = "tiktoken";
      return estimateTokens(ZH100);
    })();
    expect(byTiktoken / byChars).toBeGreaterThanOrEqual(0.5);
    expect(byTiktoken / byChars).toBeLessThanOrEqual(2);
  });
});
