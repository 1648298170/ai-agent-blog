// json-utils.ts —— 网关无关的 JSON 提取：generateText + 严格指令 + 宽松解析
// 为什么不直接用 generateObject：它依赖网关的 response_format 结构化输出，
// glm-4-flash 等轻薄模型/网关会静默无视（模型照常闲聊回复），JSON 解析直接炸。
// 教程手写精神的同款取舍：约定输出格式 → 拿到文本 → 自己解析校验，
// 换任何 OpenAI 兼容网关（GLM / Qwen / DeepSeek）行为一致。

/**
 * 从模型回复里抠出第一个 JSON 对象。
 * 容忍 ```json 围栏与前后废话：取第一个 { 到最后一个 } 之间的内容再解析；
 * 解析失败抛带原文摘录的中文错误（上层决定重试还是降级）。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`模型未按 JSON 约定回复，无法解析。原文摘录：${trimmed.slice(0, 120)}`);
  }
}
