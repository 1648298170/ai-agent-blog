// infra.mcp-readdoc.spec.ts —— pgvector readDoc 集成测试（真实 PostgreSQL，最小集）
// 门控与 infra.pgvector.spec.ts 逐字同款：RUN_INFRA_TESTS=1 才尝试连接（pnpm test:infra
// 自动设置）；服务不可达 → describe.skip 并打印原因，绝不炸普通 pnpm test / CI。
// 只覆盖 readDoc 一个面：seeded 行的全文往返（按 idx 排序拼接）+ 不存在的中文错误。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createPgVectorRagStore } from "../src/rag/store.pgvector.js";
import type { Chunk } from "../src/rag/types.js";

const CONNECTION =
  process.env.PG_CONNECTION_STRING ?? "postgres://agent:agent@localhost:5433/agent";

// —— 门控与可达性探测（top-level await：跑测试前先弄清 PG 在不在）——
const gated = process.env.RUN_INFRA_TESTS === "1";
let reachable = false;
let probeError = "";
if (gated) {
  try {
    const probe = postgres(CONNECTION, { connect_timeout: 3, max: 1 });
    await probe`SELECT 1`;
    await probe.end();
    reachable = true;
  } catch (err) {
    reachable = false;
    probeError = err instanceof Error ? err.message : String(err);
  }
}

const describePg = gated && reachable ? describe : describe.skip;
if (gated && !reachable) {
  console.warn(
    `[infra.mcp-readdoc] PostgreSQL 不可达（${CONNECTION}）：${probeError}\n` +
      "  跳过 readDoc 集成测试。请先在 agent-app 目录运行 pnpm infra:up 等 postgres healthy，再跑 pnpm test:infra。",
  );
}
if (!gated) {
  console.warn("[infra.mcp-readdoc] 未设置 RUN_INFRA_TESTS=1，跳过（普通 pnpm test 不碰真实基础设施）。");
}

// 本轮测试专用 docId 前缀：用完清掉，不污染真实入库数据（kb_chunks 可能已有 e2e 数据）
const RUN = Date.now().toString(36);
const DOC = `spec-mcp-readdoc-${RUN}`;

/** 造测试块：embedding 为 null（readDoc 不需要向量，也未向量化块照样要能读回） */
function makeChunk(id: string, index: number, text: string): Chunk {
  return { id, docId: DOC, title: "readDoc 往返", text, index, embedding: null };
}

describePg("pgvector readDoc（真实 PostgreSQL）", () => {
  const store = createPgVectorRagStore({ connectionString: CONNECTION });
  const admin = postgres(CONNECTION, { connect_timeout: 3, max: 1 });

  beforeAll(async () => {
    // 先触发懒 ensureSchema（建表建索引幂等），再做管理清理——admin 直连不管建表
    await store.count();
    await admin`DELETE FROM kb_chunks WHERE doc_id LIKE 'spec-mcp-readdoc-%'`;
  });

  afterAll(async () => {
    await admin`DELETE FROM kb_chunks WHERE doc_id LIKE 'spec-mcp-readdoc-%'`;
    await admin.end();
  });

  it("readDoc：seeded 行按 idx 升序、空行分隔拼回全文；不存在的 docId 抛中文错误", async () => {
    // 故意乱序 upsert：ORDER BY idx 必须还原阅读顺序，而不是物理插入顺序
    await store.upsert([
      makeChunk(`${DOC}#2`, 2, "第三行（idx 2）"),
      makeChunk(`${DOC}#0`, 0, "第一行（idx 0）"),
      makeChunk(`${DOC}#1`, 1, "第二行（idx 1）"),
    ]);

    const doc = await store.readDoc(DOC);
    expect(doc).toEqual({
      docId: DOC,
      title: "readDoc 往返",
      chunks: 3,
      text: "第一行（idx 0）\n\n第二行（idx 1）\n\n第三行（idx 2）",
    });

    await expect(store.readDoc(`spec-mcp-readdoc-不存在-${RUN}`)).rejects.toThrow(
      /文档不存在：spec-mcp-readdoc-不存在-/,
    );
  });
});
