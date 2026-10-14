// json-utils.ts —— 网关无关的 JSON 提取：generateText + 严格指令 + 宽松解析
// 为什么不直接用 generateObject：它依赖网关的 response_format 结构化输出，
// glm-4-flash 等轻薄模型/网关会静默无视（模型照常闲聊回复），JSON 解析直接炸。
// 教程手写精神的同款取舍：约定输出格式 → 拿到文本 → 自己解析校验，
// 换任何 OpenAI 兼容网关（GLM / Qwen / DeepSeek）行为一致。

/**
 * 从模型回复里抠出第一个 JSON 值（对象或数组）。
 * 容忍 ```json 围栏与前后废话。
 *
 * 解析策略：括号配对扫描——收集文本里所有 { / [ 开括号，按位置顺序对每个做
 * 字符串感知的配对扫描（引号内的括号不计深度），取第一个「语法完整」的候选
 * 尝试解析；解析失败换下一个开括号。返回 = 文本中第一个可解析的完整 JSON 结构。
 *
 * 为什么不用「首 { 到末 }」或「对象优先两层尝试」：
 * - 首花括号截取对数组任务单必挂（```json [...] ``` 截出首对象 { 到末对象 } 的
 *   非法片段——team CLI 真实冒烟抓到）；
 * - 「对象优先/数组优先」的固定次序在混排文本里必有一边误吸（数组内元素被
 *   对象候选截走，或反之）。
 * 配对扫描返回的永远是完整平衡结构，对所有消费方语义一致：
 * supervisor/judge（对象）拿到文本中第一个完整对象，planner（数组）拿到第一个
 * 完整数组——「第一个 JSON 值」的字面语义。
 * 解析全失败抛带原文摘录的中文错误（上层决定重试还是降级）。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  for (let i = 0; i < trimmed.length; i++) {
    const open = trimmed[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < trimmed.length; j++) {
      const c = trimmed[j]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0 && c === close) {
          const candidate = trimmed.slice(i, j + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break; // 此开括号的结构不合法（模型瞎写）→ 换下一个开括号
          }
        }
      }
    }
  }
  throw new Error(`模型未按 JSON 约定回复，无法解析。原文摘录：${trimmed.slice(0, 120)}`);
}
