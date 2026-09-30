// message-limits.ts —— 消息长度上限的单一事实源（红队加固轮 H3，修 E8 资源边界）
// E8 实测：50KB 消息在 REPL/API/引擎/网关全链路无任何长度检查、全量放行（12s 往返），
// 是 token 成本攻击面 + 会话存储膨胀的入口。上限取 8000 字符（约数千 token，
// 覆盖正常业务咨询的同时把滥用成本钳在可控范围），CLI 与 API 两个入口共用同一口径
// （CLI 侧的 MESSAGE_MAX_CHARS 在 apps/cli/src/apps/chat/cli.ts，两处数值刻意对齐，
// 都指向 SECURITY.md 第五节——改上限时两处一起动）。
export const MESSAGE_MAX_CHARS = 8000;

/** 超长消息的中文拒收话术（CLI 与 SSE error 事件共用同一措辞口径） */
export function describeMessageTooLong(length: number): string {
  return `消息过长：${length} 字符，超过上限 ${MESSAGE_MAX_CHARS}（输入长度闸，见 SECURITY.md E8）。请精简后重试。`;
}
