// kb.service.spec.ts —— 知识库服务单测：引擎 rag / llm / ai 全 mock（零网络）
// 覆盖：检索命中 → { answer, citations }（引用编号由后端分配）；
// 空命中 → 老实说不知道（不调 LLM）；LLM 失败 → 降级返回检索原文 + hint（kb.md 降级预案）。
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { createModel } from "@agent-app/engine/llm";
import { searchKnowledge } from "@agent-app/engine/rag";
import { ConfigProvider } from "../common/config.provider.js";
import { KbService } from "./kb.service.js";

// vi.mock 工厂引用的 mock 用 vi.hoisted 提升（vi.mock 调用会被提升到文件顶部）
const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

// rag 整包 mock：kb.service 只用到下面这些出口；searchKnowledge 是断言主角
vi.mock("@agent-app/engine/rag", () => ({
  searchKnowledge: vi.fn(),
  createJsonRagStore: vi.fn(() => ({})),
  setRagStore: vi.fn(),
  getRagStore: vi.fn(() => ({
    listDocs: vi.fn(async () => []),
    deleteDoc: vi.fn(async () => undefined),
  })),
  ingestSource: vi.fn(),
  extractTextFromBuffer: vi.fn(),
  extractTextFromFile: vi.fn(),
  SUPPORTED_EXTENSIONS: new Set([".txt", ".md", ".pdf"]),
}));
vi.mock("@agent-app/engine/llm", () => ({ createModel: vi.fn(() => ({ fake: "model" })) }));
// ai 包部分 mock：只接管 generateText（答案生成入口），其余导出用真品
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: generateTextMock };
});

/** RetrievedChunk 测试夹具：两块命中的制度文档 */
const HITS = [
  {
    id: "faq-a1#0",
    docId: "faq-a1",
    title: "company-faq",
    text: "差旅住宿标准为每晚 400 元。",
    index: 0,
    embedding: null,
    score: 0.8312345,
  },
  {
    id: "faq-a1#1",
    docId: "faq-a1",
    title: "company-faq",
    text: "报销需在出差结束后 7 日内提交。",
    index: 1,
    embedding: null,
    score: 0.7123456,
  },
];

describe("KbService.query", () => {
  let service: KbService;

  beforeEach(async () => {
    vi.mocked(searchKnowledge).mockReset();
    generateTextMock.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [KbService, ConfigProvider],
    }).compile();
    service = moduleRef.get(KbService);
  });

  it("检索命中 → { answer, citations }：引用编号后端分配、分数保留 3 位、LLM 拿到带编号资料", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue(HITS);
    generateTextMock.mockResolvedValue({ text: "住宿标准为每晚 400 元 [1]。" });

    const result = await service.query({ question: "出差住宿标准是多少" });

    expect(result.answer).toBe("住宿标准为每晚 400 元 [1]。");
    expect(result.citations).toEqual([
      { no: 1, title: "company-faq", score: 0.831 },
      { no: 2, title: "company-faq", score: 0.712 },
    ]);
    expect(result.degraded).toBe(false);
    // 检索默认 topK=5，问题原样传给引擎
    expect(searchKnowledge).toHaveBeenCalledExactlyOnceWith("出差住宿标准是多少", 5);
    // LLM 的 prompt 里拼进了带 [1][2] 编号的资料与问题
    const llmCall = generateTextMock.mock.calls[0][0];
    expect(llmCall.system).toContain("只依据");
    expect(String(llmCall.messages[0].content)).toContain("[1]（company-faq）");
    expect(String(llmCall.messages[0].content)).toContain("问题：出差住宿标准是多少");
  });

  it("topK 透传：query({ topK: 3 }) → searchKnowledge(_, 3)", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue(HITS.slice(0, 1));
    generateTextMock.mockResolvedValue({ text: "7 日内提交 [1]。" });

    await service.query({ question: "报销时限", topK: 3 });

    expect(searchKnowledge).toHaveBeenCalledExactlyOnceWith("报销时限", 3);
  });

  it("空命中 → 老实说不知道（固定话术、不调 LLM、citations 为空）", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([]);

    const result = await service.query({ question: "CEO 是谁" });

    expect(result.answer).toBe(
      "知识库里没有找到相关内容，这题我不答。请先入库对应文档，或换个问法试试。",
    );
    expect(result.citations).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("LLM 失败 → 降级：answer 是检索原文拼接、degraded=true、hint 给配置指引", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue(HITS);
    generateTextMock.mockRejectedValue(new Error("LLM 网关超时"));

    const result = await service.query({ question: "出差住宿标准是多少" });

    expect(result.degraded).toBe(true);
    expect(result.answer).toContain("[1]（company-faq）差旅住宿标准为每晚 400 元。");
    expect(result.citations).toHaveLength(2);
    // 降级提示一定给到（是否有 key 只影响话术分支，不影响「一定有 hint」）
    expect(typeof result.hint).toBe("string");
    expect(result.hint?.length).toBeGreaterThan(0);
  });
});
