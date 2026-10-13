// llm-policy.spec.ts —— LLM 调用统一策略（maxRetries + 超时）离线单测：
// 销 BACKLOG #3「LLM 调用无显式超时/退避」的配套测试——AI SDK 内置能力经
// llmCallPolicy() 统一注入，本文件钉住配置读取与 signal 合并语义。
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLlmPolicy } from "../src/config.js";
import { llmCallPolicy } from "../src/llm.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getLlmPolicy：env 读取与非法值回退", () => {
  it("不配置 → 默认 maxRetries=2、timeoutMs=60000", () => {
    const p = getLlmPolicy();
    expect(p.maxRetries).toBe(2);
    expect(p.timeoutMs).toBe(60_000);
  });

  it("env 覆盖生效", () => {
    vi.stubEnv("AGENT_LLM_MAX_RETRIES", "5");
    vi.stubEnv("AGENT_LLM_TIMEOUT_MS", "120000");
    const p = getLlmPolicy();
    expect(p.maxRetries).toBe(5);
    expect(p.timeoutMs).toBe(120_000);
  });

  it("非法值（负数/非数字/零超时）→ 回退默认（配置错误不炸调用链）", () => {
    vi.stubEnv("AGENT_LLM_MAX_RETRIES", "-1");
    vi.stubEnv("AGENT_LLM_TIMEOUT_MS", "abc");
    const p = getLlmPolicy();
    expect(p.maxRetries).toBe(2);
    expect(p.timeoutMs).toBe(60_000);
  });
});

describe("llmCallPolicy：统一参数与 signal 合并", () => {
  it("无外部 signal → 返回超时信号（未中止）+ 默认重试次数", () => {
    const policy = llmCallPolicy();
    expect(policy.maxRetries).toBe(2);
    expect(policy.abortSignal.aborted).toBe(false);
  });

  it("外部 signal 合并：超时未触发时外部中止 → 合并信号联动中止", () => {
    const controller = new AbortController();
    const policy = llmCallPolicy(controller.signal);
    expect(policy.abortSignal).not.toBe(controller.signal); // 不是原引用（any 合并）
    expect(policy.abortSignal.aborted).toBe(false);
    controller.abort();
    expect(policy.abortSignal.aborted).toBe(true); // 联动成立 = SSE 断连中止语义保留
  });

  it("env 覆盖重试次数：maxRetries 透传为配置值", () => {
    vi.stubEnv("AGENT_LLM_MAX_RETRIES", "0"); // 0 = 显式关闭传输层重试（合法配置）
    const policy = llmCallPolicy();
    expect(policy.maxRetries).toBe(0);
  });
});
