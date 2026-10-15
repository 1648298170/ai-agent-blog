// compression-watermark.spec.ts —— 压缩水位线（BACKLOG ①）离线单测：
// token 水位触发 / 贪心保留 / 条数兜底 / 查表解析——estimate 与 summarize 全注入，
// 零网络零不确定性。铁律：未配置水位线时条数阈值行为逐字节不变（离线优先）。
import { describe, expect, it, vi } from "vitest";
import {
  compressIfNeeded,
  modelContextTokensFromEnv,
  SUMMARY_PREFIX,
  type WatermarkPolicy,
} from "../src/memory/compression.js";
import type { ChatTurn } from "../src/memory/types.js";

const turn = (role: ChatTurn["role"], content: string): ChatTurn => ({ role, content });

/** 内容映射估算器：content 即 token 数（'tok100' → 100）——测试精确控制水位 */
const mapEstimate = (text: string): number => {
  const m = /^tok(\d+)$/.exec(text);
  return m ? Number(m[1]) : text.length;
};

const stubSummarize = async (prompt: string): Promise<string> => "（摘要）" + prompt.slice(0, 30);

describe("modelContextTokensFromEnv：优先级 env 直配 > 模型查表 > 未启用", () => {
  it("env 直配优先", () => {
    expect(modelContextTokensFromEnv({ MODEL_CONTEXT_TOKENS: "64000" }, "unknown-model")).toBe(64000);
  });
  it("未配 env → 按模型名查表（glm-4-flash=128K / glm-4.6=200K / moonshot 按型号名）", () => {
    expect(modelContextTokensFromEnv({}, "glm-4-flash")).toBe(128_000);
    expect(modelContextTokensFromEnv({}, "deepseek-chat")).toBe(64_000);
    expect(modelContextTokensFromEnv({}, "glm-4.6")).toBe(200_000);
    expect(modelContextTokensFromEnv({}, "moonshot-v1-128k")).toBe(131_072);
  });
  it("env 非法值且模型不在表 → undefined + warn 告警（不静默：EPISODIC_STORE 同款教训闭环）", () => {
    const warns: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    });
    try {
      expect(modelContextTokensFromEnv({ MODEL_CONTEXT_TOKENS: "abc" }, "some-new-model")).toBeUndefined();
      expect(modelContextTokensFromEnv({}, "some-new-model")).toBeUndefined();
      expect(warns.some((w) => w.includes("some-new-model") && w.includes("MODEL_CONTEXT_TOKENS"))).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });
  it("模型名为空串 → undefined 且不打扰（无模型上下文时不告警）", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(modelContextTokensFromEnv({}, "")).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("compressIfNeeded · 条数兜底（无 watermark = 现状行为）", () => {
  it("≤40 条不压缩；>40 条走旧阈值（保最近 20）", async () => {
    const small = Array.from({ length: 40 }, (_, i) => turn(i % 2 ? "assistant" : "user", `m${i}`));
    expect(await compressIfNeeded("s", small, stubSummarize)).toBe(small); // 同引用 = 零开销

    const big = Array.from({ length: 43 }, (_, i) => turn(i % 2 ? "assistant" : "user", `m${i}`));
    const result = await compressIfNeeded("s", big, stubSummarize);
    expect(result[0]?.content.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(result).toHaveLength(21); // 摘要轮 + 最近 20 条
  });
});

describe("compressIfNeeded · 水位模式（watermark 配置后）", () => {
  const watermark: WatermarkPolicy = {
    contextTokens: 1000,
    bufferRatio: 0.25, // 触发 = 750；压缩目标（targetRatio 0.5）= 保留至 ≤500
    estimate: mapEstimate,
  };

  it("水位未超 → 不压缩（水位模式下条数不再触发：41 条短消息原样返回）", async () => {
    const turns = Array.from({ length: 41 }, (_, i) => turn("user", "tok10"));
    const result = await compressIfNeeded("s", turns, stubSummarize, watermark);
    expect(result).toBe(turns); // 同引用 = 未触发
  });

  it("水位超 → 触发压缩，贪心保留至压缩目标水位（窗口×50%）", async () => {
    // 10 条 × 100 = 1000 > 750 触发；压缩目标 500 → 从尾部贪心保留 5 条（500）
    const turns = Array.from({ length: 10 }, (_, i) => turn("user", "tok100"));
    const result = await compressIfNeeded("s", turns, stubSummarize, watermark);
    expect(result[0]?.content.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(result).toHaveLength(6); // 摘要轮 + 贪心保留 5 条
  });

  it("单条超预算 → 至少保留 1 条（摘要超长消息无意义，交上层护栏）", async () => {
    // 1 条 5000 + 1 条 10：总 5010 > 750 触发；压缩目标 500——最新一条 10 ≤ 500 保住
    const turns = [turn("user", "tok5000"), turn("assistant", "tok10")];
    const result = await compressIfNeeded("s", turns, stubSummarize, watermark);
    expect(result).toHaveLength(2); // 摘要轮 + 保留的最近 1 条
    expect(result[1]?.content).toBe("tok10");
  });

  it("摘要失败 → 降级为窗口截断（水位模式的降级路径与条数模式同构）", async () => {
    const turns = Array.from({ length: 10 }, (_, i) => turn("user", "tok100"));
    const result = await compressIfNeeded("s", turns, async () => "", watermark);
    expect(result[0]?.content.startsWith(SUMMARY_PREFIX)).toBe(false);
    expect(result).toHaveLength(5); // 贪心保留 5 条（压缩目标水位），无摘要轮
  });
});
