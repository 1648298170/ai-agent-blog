// infra.episodic-pgvector.spec.ts —— pgvector EpisodicStore 集成测试（真实 PostgreSQL，扩展路线最后一行落地）
// 门控与风格同 infra.pgvector.spec.ts：RUN_INFRA_TESTS=1 才连（pnpm test:infra 自动设置）；
// 服务不可达 → describe.skip 并打印原因，绝不炸普通 pnpm test / CI。
//
// 与 kb_chunks 套件的两个刻意不同：
// 1. 用**真实 embedding**（rag/embedder.embed，默认 GLM embedding-3）——EpisodicStore 契约里
//    向量由调用方算好传入（remember/recall 都收 embedding），测试恰好能端到端验证「真实语义
//    向量在 <=> 余弦下按相似度排序」；全部文本一次 embed()（≤32 条单批单请求），API 调用最少。
// 2. 断言前的清理是整表清空而非前缀清理：episodic_memories 是本次新增的表，尚无任何产品链路
//    写入（工厂默认 memory，remember 的调用方都不会碰到 pgvector 版）；而 recall() 契约没有
//    docId 式过滤，无法像 kb_chunks 那样圈定断言——整表清空换取确定性。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getConfig } from "../src/config.js";
import { embed } from "../src/rag/embedder.js";
import { embeddingDimFromEnv } from "../src/rag/store.pgvector.js";
import { createPgVectorEpisodicStore } from "../src/memory/episodic.pgvector.js";
import type { EpisodicRecord } from "../src/memory/types.js";

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

// 真实 embedding 还需要 API Key：本套件的断言建立在真实语义向量上，没 key 就跳过
const hasKey = Boolean(getConfig().apiKey);
const describeEpi = gated && reachable && hasKey ? describe : describe.skip;
if (gated && !reachable) {
  console.warn(
    `[infra.episodic-pgvector] PostgreSQL 不可达（${CONNECTION}）：${probeError}\n` +
      "  跳过情景记忆 pgvector 集成测试。请先在 agent-app 目录运行 pnpm infra:up 等 postgres healthy，再跑 pnpm test:infra。",
  );
}
if (gated && reachable && !hasKey) {
  console.warn(
    "[infra.episodic-pgvector] 未配置 OPENAI_API_KEY，跳过（本套件用真实 embedding 验证语义排序，" +
      "在 agent-app 目录复制 .env.example 为 .env 并填入 key 后重跑）。",
  );
}
if (!gated) {
  console.warn("[infra.episodic-pgvector] 未设置 RUN_INFRA_TESTS=1，跳过（普通 pnpm test 不碰真实基础设施）。");
}

const RUN = Date.now().toString(36);
const SESSION_A = `spec-episodic-a-${RUN}`;
const SESSION_B = `spec-episodic-b-${RUN}`;
const SESSION_C = `spec-episodic-c-${RUN}`;

// 语义上明显分主题的摘要与查询：top1 归属靠真实语义相似度稳定断言
const SUMMARY_A = "用户咨询了订单 A-1024 的物流进度，助手查询物流系统后告知已发货、预计明日送达";
const SUMMARY_B = "用户询问公司差旅报销的标准与流程，助手依据制度文档说明了住宿上限和票据要求";
const SUMMARY_C = "用户想改账户绑定的手机号，助手引导其通过设置页完成验证与更换";
const SUMMARY_D = "用户咨询了会议室预订的注意事项，助手说明了预订时段与设备申请方式";
const QUERY_A = "我上次问的那个订单发货了没有"; // 语义最近 A
const QUERY_B = "报销制度是怎么规定的"; // 语义最近 B

/** 造一条归档记录（embedding 由调用方算好传入——契约如此，与内存版口径一致） */
function record(sessionId: string, summary: string, embedding: number[]): EpisodicRecord {
  return { sessionId, summary, embedding, createdAt: new Date().toISOString() };
}

describeEpi("pgvector EpisodicStore（真实 PostgreSQL + 真实 embedding）", () => {
  const store = createPgVectorEpisodicStore({ connectionString: CONNECTION });
  const admin = postgres(CONNECTION, { connect_timeout: 3, max: 1 });

  // 全套件共用的一批真实向量：beforeAll 里一次 embed（单批 ≤32 → 单次 HTTP）赋值
  let vecA: number[] = [];
  let vecB: number[] = [];
  let vecC: number[] = [];
  let vecD: number[] = [];
  let vecQa: number[] = [];
  let vecQb: number[] = [];

  beforeAll(async () => {
    // 先触发懒 ensureSchema（建表建索引幂等），再做管理清理——admin 直连不管建表
    await store.recall([], 0);
    await admin`DELETE FROM episodic_memories`;

    // 六条文本一次 embed：真实语义向量 + 顺序对齐（embed 的「下标即对应」契约）
    const vectors = await embed([SUMMARY_A, SUMMARY_B, SUMMARY_C, SUMMARY_D, QUERY_A, QUERY_B]);
    [vecA, vecB, vecC, vecD, vecQa, vecQb] = vectors;

    // 维度对齐检查：真实模型维度必须与建表维度（EMBEDDING_DIM）一致，否则给出可读报错
    const dim = embeddingDimFromEnv();
    if (vecA.length !== dim) {
      throw new Error(
        `真实 embedding 维度（${vecA.length}）与建表维度 EMBEDDING_DIM（${dim}）不一致：` +
          "换维度模型须 DROP TABLE episodic_memories 并同步调整 EMBEDDING_DIM。",
      );
    }
  });

  afterAll(async () => {
    await admin`DELETE FROM episodic_memories`;
    await admin.end();
  });

  it("冷表召回：空表 recall 返回 []（不炸、不返回脏形状）", async () => {
    expect(await store.recall(vecQa, 3)).toEqual([]);
  });

  it("remember→recall 真实语义往返：查询向量按相似度排到对应会话（降序 + top1 归属）", async () => {
    await store.remember(record(SESSION_A, SUMMARY_A, vecA));
    await store.remember(record(SESSION_B, SUMMARY_B, vecB));
    await store.remember(record(SESSION_C, SUMMARY_C, vecC));

    // 问「订单发货没有」→ 最像的是物流咨询那段会话
    const hitsA = await store.recall(vecQa, 2);
    expect(hitsA).toHaveLength(2);
    expect(hitsA[0].sessionId).toBe(SESSION_A);
    expect(hitsA[0].summary).toBe(SUMMARY_A);
    expect(hitsA[0].score).toBeGreaterThan(0);
    expect(hitsA[0].score).toBeLessThanOrEqual(1);
    expect(hitsA[0].score).toBeGreaterThanOrEqual(hitsA[1].score); // 相似度降序

    // 问「报销制度」→ top1 换成报销那段（不同查询唤醒不同情景）
    const hitsB = await store.recall(vecQb, 2);
    expect(hitsB[0].sessionId).toBe(SESSION_B);

    // 不传 k 走默认 3：库里此刻恰好 3 条，全部召回且降序
    const all = await store.recall(vecA);
    expect(all).toHaveLength(3);
    // 自己问自己：同向量余弦距离为 0 → score 精确等于 1，且必然排第一
    expect(all[0].sessionId).toBe(SESSION_A);
    expect(Math.abs(all[0].score - 1)).toBeLessThan(1e-6);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].score).toBeGreaterThanOrEqual(all[i].score);
    }
    // 返回形状恰好三字段（契约口径：sessionId / summary / score，不带内部字段）
    expect(Object.keys(all[0]).sort()).toEqual(["score", "sessionId", "summary"]);
  });

  it("同分稳定排序：同一向量归档两条，recall 按入库先后返回（对齐内存版语义）", async () => {
    const sessionX = `spec-episodic-x-${RUN}`;
    const sessionY = `spec-episodic-y-${RUN}`;
    await store.remember(record(sessionX, "同向量情景一", vecD));
    await store.remember(record(sessionY, "同向量情景二", vecD));
    // vecD 只属于这两条记录：完全相同的向量 → 余弦距离完全相同 → 前后由 seq（入库顺序）决定
    const hits = await store.recall(vecD, 2);
    expect(hits).toHaveLength(2);
    expect(hits[0].score).toBe(hits[1].score);
    expect(hits[0].sessionId).toBe(sessionX);
    expect(hits[1].sessionId).toBe(sessionY);
  });

  it("k=0 返回空（k 夹到 ≥0，同内存版语义）", async () => {
    expect(await store.recall(vecQa, 0)).toEqual([]);
  });

  it("createdAt 脏数据防御：非法日期串不炸表，正常入库可召回（对齐内存版 toIsoDate 兜底）", async () => {
    await store.remember({ sessionId: SESSION_A, summary: "脏日期情景", embedding: vecA, createdAt: "不是日期" });
    const hits = await store.recall(vecA, 10);
    expect(hits.some((h) => h.summary === "脏日期情景")).toBe(true);
  });
});
