// rag/ingest.ts —— 入库核心（CLI 与 HTTP API 共用的无头实现，自 apps/kb/ingest-core.ts 上移）
// 「切块 → 向量化 → 快照落盘」主干：CLI 只管参数与打印，HTTP API（POST /api/kb/ingest）
// 拿上传文件的 buffer/text 走同一条链路。
// 错误礼仪不变：embedding 失败抛带中文配置指引的 Error，由调用方决定怎么呈现。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chunkText } from "./chunker.js";
import { embed } from "./embedder.js";
import { createRagStoreFromEnv } from "./store.factory.js";
import { getRagStore, setRagStore } from "./retrieve.js";
import type { Chunk } from "./types.js";

/** 当前支持的文档类型（教程离线链路：解析 → 切块 → 向量化 → 入库） */
export const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".pdf"]);

/** 入库结果：CLI 打印 / HTTP 响应各取所需 */
export interface IngestResult {
  /** 入库文件名（含扩展名） */
  fileName: string;
  /** 引用块里显示的标题（文件名去扩展名） */
  title: string;
  /** 文档 id：文件名 + 内容哈希前 8 位（同内容重新入库命中同 id，upsert 覆盖） */
  docId: string;
  /** 本次切块数 */
  chunks: number;
  /** 入库后知识库总块数 */
  total: number;
}

/** 抽取纯文本：buffer + 扩展名版（HTTP 上传文件没有磁盘路径，只有 buffer） */
export async function extractTextFromBuffer(buffer: Buffer, ext: string): Promise<string> {
  if (ext === ".pdf") {
    const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
    const parsed = await pdfParse(buffer);
    return parsed.text;
  }
  return buffer.toString("utf8");
}

/** 抽取纯文本：磁盘路径版（CLI 与 ingest-path 接口用） */
export async function extractTextFromFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return extractTextFromBuffer(buffer, extname(filePath).toLowerCase());
}

/**
 * 入库核心：文件名 + 全文 → 切块 → 向量化 → JSON 快照库 upsert。
 * 空文档抛 Error（调用方按自己的错误礼仪呈现）；embedding 失败抛带配置指引的中文 Error。
 */
export async function ingestSource(fileName: string, text: string): Promise<IngestResult> {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error(`文档内容为空，无块可入库：${fileName}`);
  }

  // docId = 文件名 + 内容哈希前 8 位：同一文件原样重新入库命中同一 docId（upsert 覆盖），
  // 内容变了视为新文档；标题取文件名去扩展名，引用块里显示的就是它
  const hash = createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 8);
  const docId = `${fileName}-${hash}`;
  const title = fileName.replace(/\.[^.]+$/, "");

  const pieces = chunkText(trimmed);
  const vectors = await embed(pieces); // 入库与检索必须同一个 embedding 模型，坐标空间才一致

  // 换库的接缝升级为 env 工厂（RAG_STORE=memory|json|pgvector，默认 json）：
  // 不配置时仍是 JSON 快照库（内存检索 + 文件落盘），问答侧读同一份快照——行为与改造前一致；
  // 配 pgvector 时入库直写 PG，问答侧同一开关读到同一个库
  setRagStore(createRagStoreFromEnv());
  const store = getRagStore();

  const chunks: Chunk[] = pieces.map((piece, i) => ({
    id: `${docId}#${i}`,
    docId,
    title,
    text: piece,
    index: i,
    embedding: vectors[i] ?? null,
  }));
  await store.upsert(chunks);

  const total = await store.count();
  return { fileName, title, docId, chunks: chunks.length, total };
}
