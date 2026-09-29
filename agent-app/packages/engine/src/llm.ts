// llm.ts —— 模型工厂：@ai-sdk/openai 的 createOpenAI 挂自定义 baseURL，
// 连 OpenAI 兼容网关（DeepSeek / Qwen / GLM），写法同教程《记忆 TS 版》：
//   const llmProvider = createOpenAI({ baseURL, apiKey });
//   const llm = llmProvider.chat(model);
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModelV2, LanguageModelV2 } from "@ai-sdk/provider";
import { getConfig } from "./config.js";

/**
 * 创建一个新的 chat 模型实例。缺 apiKey 不会在这里抛错——
 * provider 校验发生在真正发起请求时，chat REPL 才能实现「无 key 也能启动」。
 * 可传 modelId 覆盖默认模型（比如路由场景里大小模型分工）。
 */
export function createModel(modelId?: string): LanguageModelV2 {
  const { apiKey, baseURL, model } = getConfig();
  const openai = createOpenAI({ apiKey, baseURL });
  return openai.chat(modelId ?? model);
}

let cachedModel: ReturnType<typeof createModel> | undefined;
let cachedEmbeddingModel: ReturnType<typeof createEmbeddingModel> | undefined;

/** 拿默认 chat 模型（进程内单例，环境变量一次读定） */
export function getModel(): LanguageModelV2 {
  cachedModel ??= createModel();
  return cachedModel;
}

/** 创建 embedding 模型实例：入库与检索必须同一个，混用则坐标空间不同 */
function createEmbeddingModel(): EmbeddingModelV2<string> {
  const { apiKey, baseURL, embeddingModel } = getConfig();
  const openai = createOpenAI({ apiKey, baseURL });
  return openai.embedding(embeddingModel);
}

/** 拿 embedding 模型（进程内单例） */
export function getEmbeddingModel(): EmbeddingModelV2<string> {
  cachedEmbeddingModel ??= createEmbeddingModel();
  return cachedEmbeddingModel;
}
