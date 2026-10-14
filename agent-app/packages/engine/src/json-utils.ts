// json-utils.ts —— 网关无关的 JSON 提取：generateText + 严格指令 + 宽松解析
// 为什么不直接用 generateObject：它依赖网关的 response_format 结构化输出，
// glm-4-flash 等轻薄模型/网关会静默无视（模型照常闲聊回复），JSON 解析直接炸。
// 教程手写精神的同款取舍：约定输出格式 → 拿到文本 → 自己解析校验，
// 换任何 OpenAI 兼容网关（GLM / Qwen / DeepSeek）行为一致。

/**
 * 从模型回复里抠出第一个 JSON 值（对象或数组）。
 * 容忍 ```json 围栏与前后废话：取第一个 { 或 [ 到最后一个 } 或 ] 之间的内容再解析；
 * 解析失败抛带原文摘录的中文错误（上层决定重试还是降级）。
 *
 * 为什么数组也要支持：LlmPlanner 的任务单就是 JSON 数组——此前只找 {..}，
 * 模型回 ```json [...] ``` 时会截出「首对象的 { 到末对象的 }」的非法片段
 * （两个对象用逗号连着），JSON.parse 必挂（team CLI 真实冒烟抓到）。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const open = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((i) => i >= 0);
  const close = [trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]")].filter((i) => i >= 0);
  let candidate = trimmed;
  if (open.length > 0 && close.length > 0) {
    const start = Math.min(...open);
    const end = Math.max(...close);
    if (end > start) candidate = trimmed.slice(start, end + 1);
  }
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`模型未按 JSON 约定回复，无法解析。原文摘录：${trimmed.slice(0, 120)}`);
  }
}
