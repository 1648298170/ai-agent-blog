// embedder.ts —— 批量向量化：分批调用 embeddings 接口 + 清晰的中文错误提示
// 教程《RAG TS 全链路》embedBatch 的对照实现：一次几十条是正确姿势，一块一个请求
// 是几百次 HTTP 往返的错误姿势。教程里「按 index 排序再收」那步由 embedMany 保证
//（SDK 返回值与输入同序），跨批按批次顺序拼接，texts[i] 的向量就是返回值第 i 项。
import { embedMany } from "ai";
import { getConfig } from "../config.js";
import { getEmbeddingModel } from "../llm.js";

/** 单批条数：embeddings 接口天生支持批量，几十条一批（教程 BATCH 思想） */
const BATCH_SIZE = 32;

/** 统一的配置错误提示：告诉用户怎么修，而不是甩一串英文堆栈 */
function configError(reason: string): Error {
  return new Error(
    `${reason}。` +
      "请检查密钥配置：在 agent-app 目录下复制 .env.example 为 .env，填入 OPENAI_API_KEY" +
      "（设环境变量亦可）；默认智谱 GLM 网关自带 embeddings（EMBEDDING_MODEL=embedding-3），" +
      "换网关时 EMBEDDING_MODEL 要跟着换（Qwen: text-embedding-v3 / OpenAI: text-embedding-3-small），" +
      "注意 DeepSeek 网关不提供 embeddings 接口。",
  );
}

/**
 * 把一批文本压成语义坐标：texts[i] 的向量就是返回值第 i 项，顺序严格对齐，
 * 上游可以放心拿数组下标当 chunk 与 embedding 的对应关系用。
 * 缺 key 或调用失败时抛出带配置指引的中文错误。
 *
 * 这个"顺序对齐"的保证是整个入库链路的隐形契约：
 * 入库方（rag/ingest.ts）就是拿同一个下标把 chunk.text 和 vectors[i] 配对
 * 写进 Chunk.embedding 的——任何乱序都会让"块 A 配上块 B 的语义"，检索结果全错。
 *
 * 分批的原因：一次请求塞几千条，容易被网关按请求体大小/条数上限拒绝；
 * 一条一个请求又是几百次 HTTP 往返。32 条一批 = 一次入库十几批，各端点都安全。
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (!getConfig().apiKey) {
    // 不带 key 就别发起请求：当场抛清晰错误，省一次注定 401 的网络往返
    throw configError("向量化失败：未配置 API Key（OPENAI_API_KEY 为空）");
  }

  const vectors: number[][] = [];
  // i 以 BATCH_SIZE 为步长推进：texts.length=70 → 批次 [0..32) [32..64) [64..70)，共 3 批
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const { embeddings } = await embedMany({ model: getEmbeddingModel(), values: batch });
      // 防御：SDK 理应同序同长返回，但"多退少补"式的错位一旦发生就是全库语义错乱，
      // 与其静默入库不如当场报错——错误信息带上批号，排障能直接定位到哪一批
      if (embeddings.length !== batch.length) {
        throw new Error(`返回 ${embeddings.length} 条向量，与输入的 ${batch.length} 条不对齐`);
      }
      vectors.push(...embeddings); // 跨批按顺序拼接，保住全局的"下标即对应"契约
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw configError(
        `向量化第 ${Math.floor(i / BATCH_SIZE) + 1} 批（${batch.length} 条）调用失败：${detail}`,
      );
    }
  }
  return vectors;
}
