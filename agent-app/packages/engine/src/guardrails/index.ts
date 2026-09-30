// guardrails/index.ts —— 安全护栏子域 barrel：输入闸（校验）+ 输出闸（脱敏）+ 工具闸门（组装）+ 审计日志。
// 导出面刻意保持最小：不新增 package.json 的子路径出口，统一从包根出口走。
//
//   pii-mask.ts   输出闸：手机号/身份证/银行卡打码（边界锁死，长串不误拆）
//   validate.ts   输入闸：规范化 + 注入黑名单扫描；白名单解析与判定
//   gate.ts       工具闸门：白名单 → 输入闸 → 确认 → 原执行 → 输出闸 的编排
//   audit.ts      审计日志：安全事件 JSONL 追加落盘（红队加固轮 H10）
export * from "./pii-mask.js";
export * from "./validate.js";
export * from "./gate.js";
export * from "./audit.js";
