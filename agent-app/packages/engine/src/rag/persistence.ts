// persistence.ts —— JSON 文件版 RAG 存储：内存库的装饰器 + 快照持久化
// 定位（教程 products/kb.md）：内存库负责检索（余弦相似度，毫秒级），
// 本文件负责把 chunks 以 JSON 快照落盘到 .data/kb-store.json——
// 入库 CLI 与问答 CLI 是两个进程，快照让知识库跨进程存活。
// 接口与 RagStore 完全一致：retrieve.ts 一行 setRagStore 就能换上，检索代码零改动。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getEngineLogger } from "../logger.js";
import { createInMemoryRagStore } from "./store.memory.js";
import type { Chunk, DocumentContent, DocumentSummary, RagFilter, RagStore, RetrievedChunk } from "./types.js";

/** 默认快照位置：agent-app/.data/kb-store.json（.data/ 已进 .gitignore） */
const DEFAULT_STORE_PATH = join(process.cwd(), ".data", "kb-store.json");

/**
 * 创建带 JSON 快照的 RAG 存储：
 * - 首次访问时懒加载快照（load on init）
 * - upsert / deleteDoc 后同步写盘（save on change）
 * - 检索全权委托内存库；本文件只多管一份「快照镜像」当持久化的真源
 *
 * ── 设计模式：装饰器（组合，不是继承）────────────────────────────────────
 * 内部持有一个真正的内存库 memory，本类的四个方法里：
 *   search / count → 原样委托 memory（内存 Map 的毫秒级余弦检索，一分不差）
 *   upsert / deleteDoc → 委托 memory + 额外维护 snapshot 镜像 + 写盘
 * 对外暴露的仍是标准 RagStore 接口——调用方（retrieve.ts）完全无感知。
 *
 * ── 为什么要一份 snapshot 镜像（内存库不是已经有全部数据了吗）──────────
 * 内存库的 Map 是私有的，RagStore 接口没有"列出全部"的方法。落盘要写全量，
 * 所以本文件自己维护一份镜像当"该写什么进文件"的真源。检索永远走内存库，
 * 镜像只服务于持久化——两份数据靠"每次变更都同步双写"保持一致。
 *
 * ── 懒加载 ready ??= load() 的门道 ──────────────────────────────────────
 * 快照读取放在首次调用时而非工厂函数里，因为工厂返回对象的瞬间还没法 await；
 * `ready ??= load()` 保证并发下也只读一次盘：十个方法同时首次调用，
 * 它们等的是同一个 Promise，不会把快照重复灌三遍进内存库。
 */
export function createJsonRagStore(filePath: string = DEFAULT_STORE_PATH): RagStore {
  const memory = createInMemoryRagStore();
  const snapshot = new Map<string, Chunk>(); // 快照镜像：id → chunk，落盘内容的真源
  let ready: Promise<void> | undefined;

  /** 读快照：文件不存在按空库启动；解析失败不炸检索，告警后按空库重来 */
  async function load(): Promise<void> {
    if (!existsSync(filePath)) return;

    let list: Chunk[];
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { chunks?: Chunk[] };
      list = Array.isArray(parsed.chunks) ? parsed.chunks : [];
    } catch (err) {
      getEngineLogger().warn(`[kb-store] 快照文件解析失败，按空库启动（可删除该文件重建）：${filePath}`);
      getEngineLogger().warn(`[kb-store] 原因：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const chunk of list) snapshot.set(chunk.id, chunk);
    await memory.upsert(list);
  }

  /** 懒加载只跑一次：后续所有读写都先等它落定，快照才不会覆盖旧数据 */
  function ensureLoaded(): Promise<void> {
    ready ??= load();
    return ready;
  }

  /** 快照镜像 → JSON 文件（同步写：CLI 场景量小，原子性要求不高，简单可靠优先） */
  function save(): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ chunks: [...snapshot.values()] }, null, 2), "utf8");
  }

  return {
    // 写路径的三步舞：等快照加载完 → 双写（内存库 + 镜像）→ 落盘。
    // 顺序不能颠倒：先改内存再写盘，哪怕写盘失败内存里也是新的（重启才需要快照兜底）。
    async upsert(list: Chunk[]): Promise<void> {
      await ensureLoaded();
      await memory.upsert(list);
      for (const chunk of list) snapshot.set(chunk.id, { ...chunk });
      save();
    },

    async deleteDoc(docId: string): Promise<void> {
      await ensureLoaded();
      await memory.deleteDoc(docId);
      // 删除链路要清干净：镜像里同一文档的所有切块一并移除，不留新旧两版同时在库的隐患
      for (const [id, chunk] of snapshot) {
        if (chunk.docId === docId) snapshot.delete(id);
      }
      save();
    },

    // 读路径只等加载、全权委托内存库——检索性能与纯内存版完全一致，快照零开销
    async listDocs(): Promise<DocumentSummary[]> {
      await ensureLoaded();
      return memory.listDocs();
    },

    // 读整篇文档同样只等加载、全权委托内存库（转发模式与 listDocs 一致）
    async readDoc(docId: string): Promise<DocumentContent> {
      await ensureLoaded();
      return memory.readDoc(docId);
    },

    async search(
      queryEmbedding: number[],
      k: number,
      filter?: RagFilter,
    ): Promise<RetrievedChunk[]> {
      await ensureLoaded();
      return memory.search(queryEmbedding, k, filter);
    },

    async count(): Promise<number> {
      await ensureLoaded();
      return memory.count();
    },
  };
}
