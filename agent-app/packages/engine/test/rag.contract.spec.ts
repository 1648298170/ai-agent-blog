// rag.contract.spec.ts —— RagStore 契约测试：同一套行为断言跑所有实现（最小集）。
//
// 与 memory.contract.spec 同一思路：RagStore 有 memory / json / pgvector 多份实现，
// 「换存储开关，检索行为不变」的承诺由契约背书。最小契约只覆盖检索核心四件事：
// upsert 入库、search 相关度排序、deleteDoc 删除、listDocs/count 清单——
// 引用编号、分页、维度建表等属于各实现的专项测试（infra.pgvector.spec 等）。
//
// 断言口径（与 infra.pgvector.spec 同一纪律）：**相对计数 + docId 前缀圈定**——
// 共享存储（pg/redis）里可能有真实数据，契约不假设空库、不清理别人的数据，
// 只断言「自己前缀的数据」的增删与排序。
//
// 运行矩阵：
// - memory 实现：always 跑（零依赖，独立实例天然干净）；
// - pgvector 实现：RUN_INFRA_TESTS=1 且 PG 可达时跑（沿用 infra spec 的门控与探测）。
import { afterAll, describe, expect, it } from "vitest";
import { createInMemoryRagStore } from "../src/rag/store.memory.js";
import type { Chunk, RagStore } from "../src/rag/types.js";

/** 契约套件：对任意 RagStore 实现断言检索核心语义。
 *  dim：向量维度（pgvector 跟随 EMBEDDING_DIM 建表口径，memory 随意）；
 *  docIdPrefix：本次契约写入的数据前缀（共享存储用它圈定「自己的数据」）。 */
export function runRagStoreContract(
  suite: string,
  makeStore: () => RagStore,
  dim: number,
  docIdPrefix = "",
): void {
  const axisVec = (axis: number): number[] => {
    const v = new Array<number>(dim).fill(0);
    v[axis % dim] = 1;
    return v;
  };
  const chunk = (id: string, docId: string, axis: number): Chunk => ({
    id: `${docIdPrefix}${docId}#${id}`,
    docId: `${docIdPrefix}${docId}`,
    title: `${docId}#${id}`,
    text: `${docId} 的正文`,
    index: 0,
    embedding: axisVec(axis),
  });

  describe(`RagStore 契约 · ${suite}`, () => {
    it("upsert → count：入库计数相对增量如实", async () => {
      const store = makeStore();
      const before = await store.count();
      await store.upsert([chunk("c1", "A", 0), chunk("c2", "A", 1)]);
      expect(await store.count()).toBe(before + 2);
    });

    it("search：与查询向量同向的块排最前（相关度排序，前缀圈定自己的数据）", async () => {
      const store = makeStore();
      await store.upsert([chunk("c1", "A", 0), chunk("c2", "B", 1)]);
      const all = await store.search(axisVec(0), 50);
      const mine = all.filter((hit) => hit.docId.startsWith(docIdPrefix));
      expect(mine[0]?.docId).toBe(`${docIdPrefix}A`); // 与查询同向的块必须第一
      if (mine.length > 1) {
        expect(mine[0]?.score).toBeGreaterThanOrEqual(mine[1]?.score ?? 0);
      }
    });

    it("deleteDoc：按文档删除后，检索与清单同步消失", async () => {
      const store = makeStore();
      await store.upsert([chunk("c1", "A", 0), chunk("c2", "B", 1)]);
      await store.deleteDoc(`${docIdPrefix}A`);

      const all = await store.search(axisVec(0), 50);
      expect(all.some((hit) => hit.docId === `${docIdPrefix}A`)).toBe(false);
      const docs = await store.listDocs();
      expect(docs.some((doc) => doc.docId === `${docIdPrefix}A`)).toBe(false);
    });
  });
}

// —— memory 实现：always 跑（零依赖，独立实例天然干净；4 维向量足够手算）——
runRagStoreContract("memory 实现", () => createInMemoryRagStore(), 4);

// —— pgvector 实现：沿用 infra spec 的门控（RUN_INFRA_TESTS=1 且可达才跑）——
const gated = process.env.RUN_INFRA_TESTS === "1";
if (gated) {
  const postgresMod = await import("postgres");
  const postgres = postgresMod.default;
  const { createPgVectorRagStore, embeddingDimFromEnv } = await import("../src/rag/store.pgvector.js");
  const CONNECTION = process.env.PG_CONNECTION_STRING ?? "postgres://agent:agent@localhost:5433/agent";
  const DIM = embeddingDimFromEnv();

  let reachable = false;
  try {
    const probe = postgres(CONNECTION, { connect_timeout: 3, max: 1 });
    await probe`SELECT 1`;
    probe.end();
    reachable = true;
  } catch {
    reachable = false;
  }

  if (reachable) {
    const store = createPgVectorRagStore({ connectionString: CONNECTION });
    runRagStoreContract("pgvector 实现", () => store, DIM, "spec-contract-");
    const cleaner = postgres(CONNECTION, { max: 1 });
    afterAll(async () => {
      await cleaner`DELETE FROM kb_chunks WHERE doc_id LIKE 'spec-contract-%'`;
      await cleaner.end();
    });
  }
}
