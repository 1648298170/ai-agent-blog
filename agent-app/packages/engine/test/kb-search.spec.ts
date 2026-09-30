// kb-search.spec.ts —— 知识库检索工具的加固面单测（红队加固轮 H7/H8，离线零网络）
// H7：工具输出（知识库内容回灌模型的主通道）带围栏与数据性声明——E3 证明这条
//     通道零防线时模型 3/3 把检索块里的注入指令当指令执行；
// H8：AGENT_GUARD_PII=1 时本地工具输出同样过 PII 脱敏——E5 的「本地工具永不脱敏」补口。
// searchKnowledge 整体 mock（返回固定命中）：检索内部（embed/store）已有各自的测试，
// 这里只关心工具输出面的形状。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RAG_GROUNDING_RULE, searchKnowledge } from "../src/rag/retrieve.js";
import { searchKnowledgeBase } from "../src/tools/kb-search.js";
import type { RetrievedChunk } from "../src/rag/types.js";

vi.mock("../src/rag/retrieve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/rag/retrieve.js")>();
  return { ...actual, searchKnowledge: vi.fn() };
});

/** 造一块命中（带 PII 原文，供脱敏断言用） */
function fakeHit(text: string): RetrievedChunk {
  return {
    id: "pii-note.md#0",
    docId: "pii-note.md-00000000",
    title: "联系人卡片",
    text,
    index: 0,
    embedding: [1, 0],
    score: 0.88,
  };
}

/** 与 runToolLoop 同款方式调工具 execute（缺 execute 当场报错，测试先守住前提） */
async function runQuery(query: string): Promise<Record<string, unknown>> {
  const execute = searchKnowledgeBase.execute;
  if (execute === undefined) throw new Error("searchKnowledgeBase 必须有 execute");
  return (await execute({ query }, { toolCallId: "call-1", messages: [] })) as Record<string, unknown>;
}

describe("searchKnowledgeBase 工具输出 · 加固面", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agent-app-kbsearch-"));
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.AGENT_GUARD_PII;
    vi.mocked(searchKnowledge).mockReset();
  });

  it("H7：每块原文包 <<<资料[n]开始/结束>>> 围栏，notice 携带数据性声明", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([fakeHit("客户甲，电话 13812345678")]);
    const output = await runQuery("查联系人");

    interface Hit {
      no: number;
      title: string;
      text: string;
      score: number;
    }
    const hits = output.hits as Hit[];
    expect(hits.length).toBe(1);
    expect(hits[0].text.startsWith("<<<资料[1]开始>>>")).toBe(true);
    expect(hits[0].text.endsWith("<<<资料[1]结束>>>")).toBe(true);
    expect(hits[0].text).toContain("（联系人卡片）");
    expect(output.notice).toBe(RAG_GROUNDING_RULE);
  });

  it("H8：AGENT_GUARD_PII=1 → 块原文先脱敏再进围栏（完整号码不出工具边界）", async () => {
    process.env.AGENT_GUARD_PII = "1";
    vi.mocked(searchKnowledge).mockResolvedValue([
      fakeHit("联系电话 13812345678，证件号 130102199001011234"),
    ]);
    const output = await runQuery("查联系人");

    interface Hit {
      text: string;
    }
    const text = (output.hits as Hit[])[0].text;
    expect(text).toContain("138****5678");
    expect(text).toContain("1301************34");
    expect(text).not.toContain("13812345678");
    expect(text).not.toContain("130102199001011234");
    // 围栏结构不受脱敏影响（H7 与 H8 正交叠加）
    expect(text.startsWith("<<<资料[1]开始>>>")).toBe(true);
    expect(text.endsWith("<<<资料[1]结束>>>")).toBe(true);
  });

  it("H8：默认（未设 env）输出原文不脱敏——零变化默认保持", async () => {
    vi.mocked(searchKnowledge).mockResolvedValue([fakeHit("联系电话 13812345678")]);
    const output = await runQuery("查联系人");

    interface Hit {
      text: string;
    }
    expect((output.hits as Hit[])[0].text).toContain("13812345678");
  });

  it("H8：AGENT_GUARD_PII=true 与 =1 同口径生效", async () => {
    process.env.AGENT_GUARD_PII = "true";
    vi.mocked(searchKnowledge).mockResolvedValue([fakeHit("联系电话 13812345678")]);
    const output = await runQuery("查联系人");

    interface Hit {
      text: string;
    }
    expect((output.hits as Hit[])[0].text).not.toContain("13812345678");
  });
});
