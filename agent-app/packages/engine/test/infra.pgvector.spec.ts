// infra.pgvector.spec.ts —— pgvector RagStore 集成测试（真实 PostgreSQL，week14 实战）
// 门控：环境变量 RUN_INFRA_TESTS=1 才尝试连接（pnpm test:infra 自动设置）；
// 服务不可达 → describe.skip 并打印原因，绝不炸普通 pnpm test / CI。
// 断言全部用「相对计数 + docId 圈定」：表里可能已有真实入库数据（e2e 先跑过），
// 测试不假设空表、不清理别人的数据（只清自己的 spec-pgvector-* 前缀）。
// 向量维度跟随建表口径（EMBEDDING_DIM，默认 2048）：单轴单位向量做余弦题，
// 答案可以手算（正交 = 0、同向 = 1），不依赖真实 embedding 模型。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createPgVectorRagStore, embeddingDimFromEnv } from "../src/rag/store.pgvector.js";
import type { Chunk } from "../src/rag/types.js";

const CONNECTION =
  process.env.PG_CONNECTION_STRING ?? "postgres://agent:agent@localhost:5433/agent";

/** 本次运行的维度：与建表同一口径（EMBEDDING_DIM 默认 2048），测试向量必须同维 */
const DIM = embeddingDimFromEnv();

/** 造一个 dim 维、只在 axis 轴为 1 的单位向量（手算余弦的标准答案） */
function axisVec(axis: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[axis] = 1;
  return v;
}

/** 造测试块：embedding 为 null 时模拟「未向量化的块」 */
function makeChunk(id: string, docId: string, title: string, embedding: number[] | null): Chunk {
  return { id, docId, title, text: `${title} 的正文`, index: 0, embedding };
}

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
    `[infra.pgvector] PostgreSQL 不可达（${CONNECTION}）：${probeError}\n` +
      "  跳过 pgvector 集成测试。请先在 agent-app 目录运行 pnpm infra:up 等 postgres healthy，再跑 pnpm test:infra。",
  );
}
if (!gated) {
  console.warn("[infra.pgvector] 未设置 RUN_INFRA_TESTS=1，跳过（普通 pnpm test 不碰真实基础设施）。");
}

// 本轮测试专用 docId 前缀：用完清掉，不污染真实入库数据（kb_chunks 可能已有 e2e 数据）
const RUN = Date.now().toString(36);
const DOC_A = `spec-pgvector-a-${RUN}`;
const DOC_B = `spec-pgvector-b-${RUN}`;

describePg("pgvector RagStore（真实 PostgreSQL）", () => {
  const store = createPgVectorRagStore({ connectionString: CONNECTION });
  const admin = postgres(CONNECTION, { connect_timeout: 3, max: 1 });

  beforeAll(async () => {
    // 先触发懒 ensureSchema（建表建索引幂等），再做管理清理——admin 直连不管建表
    await store.count();
    await admin`DELETE FROM kb_chunks WHERE doc_id LIKE 'spec-pgvector-%'`;
  });

  afterAll(async () => {
    await admin`DELETE FROM kb_chunks WHERE doc_id LIKE 'spec-pgvector-%'`;
    await admin.end();
  });

  it("upsert：批量入库 + 同 id 再 upsert 覆盖不翻倍（相对计数，不假设空表）", async () => {
    const before = await store.count(); // 表里可能已有真实入库数据
    await store.upsert([
      makeChunk(`${DOC_A}#0`, DOC_A, "住宿标准", axisVec(0)), // 方向：x 轴
      makeChunk(`${DOC_A}#1`, DOC_A, "物流时效", axisVec(1)), // 方向：y 轴（与查询正交）
      makeChunk(`${DOC_A}#2`, DOC_A, "未向量化的块", null), // NULL embedding 不参与检索
    ]);
    await store.upsert([makeChunk(`${DOC_B}#0`, DOC_B, "同向倍长", axisVec(0).map((x) => x * 3))]);
    expect(await store.count()).toBe(before + 4);

    // 同 id 重新 upsert：ON CONFLICT 覆盖（同文档重新入库不翻倍）
    await store.upsert([makeChunk(`${DOC_B}#0`, DOC_B, "同向倍长-新版", axisVec(0))]);
    expect(await store.count()).toBe(before + 4);
  });

  it("search：score = 1 - 余弦距离，按相似度降序；未向量化的块不参与（docId 圈定断言）", async () => {
    // 只在 DOC_A 里搜：3 块中 1 块 NULL embedding → 2 块候选，不受表里真实数据干扰
    const hits = await store.search(axisVec(0), 10, { docId: DOC_A });
    expect(hits.length).toBe(2);

    // 手算答案：x 轴查询 → 同向块 score = 1、正交块 score = 0；降序排列
    expect(Math.abs(hits[0].score - 1)).toBeLessThan(1e-6);
    expect(hits[0].id).toBe(`${DOC_A}#0`);
    expect(Math.abs(hits[1].score - 0)).toBeLessThan(1e-6);
    expect(hits[1].id).toBe(`${DOC_A}#1`);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    // RetrievedChunk 形状：向量回来了且维度正确（pgvector '[..]' 文本已解析成 number[]）
    expect(hits[0].embedding).toBeInstanceOf(Array);
    expect(hits[0].embedding?.length).toBe(DIM);
  });

  it("search：全局搜索里 docId 过滤硬圈候选（DOC_B 同向块必在、正交块必不在）", async () => {
    const onlyB = await store.search(axisVec(0), 10, { docId: DOC_B });
    expect(onlyB.length).toBe(1);
    expect(onlyB[0].docId).toBe(DOC_B);
    // 同向倍长（×3 模长）score 仍 = 1：余弦只比方向不比模长
    expect(Math.abs(onlyB[0].score - 1)).toBeLessThan(1e-6);
  });

  it("search：k=0 返回空（k 夹到 ≥0，同内存版语义）", async () => {
    expect(await store.search(axisVec(0), 0)).toEqual([]);
  });

  it("deleteDoc：整篇文档的切块一并清掉，查不到残留（相对计数）", async () => {
    const before = await store.count();
    await store.deleteDoc(DOC_A);
    expect(await store.count()).toBe(before - 3);
    const residue = await store.search(axisVec(0), 10, { docId: DOC_A });
    expect(residue).toEqual([]);
    const left = await store.search(axisVec(0), 10, { docId: DOC_B });
    expect(left.map((h) => h.docId)).toEqual([DOC_B]);
  });
});
