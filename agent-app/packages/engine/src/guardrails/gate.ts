// guardrails/gate.ts —— 工具闸门：把「白名单 → 输入闸 → 人工确认 → 原执行 → 输出闸」
// 套在任意 AgentTool 外面，产出仍是一个 AgentTool（对循环透明）。
//
// ── 拦截时为什么「返回结构化拒绝」而不是抛异常 ──────────────────────────────
// 引擎的 runToolLoop 虽然会用 try/catch 把 execute 的异常折成 errorOutput（
// `{error:"工具 X 执行失败：…"}`），循环不至于崩——但把护栏拒绝伪装成执行失败
// 有三个问题：
//   ① 语义错位：拒绝是「策略结果」不是「工具坏了」，模型看到失败会倾向重试或
//      换参数再试，看到 denied 才会放弃并向用户解释——这正是想要的循环行为；
//   ② 结构丢失：errorOutput 把 reason 揉进一句中文散文，调用方（HTTP API /
//      审计日志）无法稳定地区分「被拦」与「挂了」；
//   ③ 不可移植：闸门按「可用于任何循环」设计——SDK 版 generateText 直接调度
//      execute 时异常路径未必有逐调用兜底，拒绝一旦变成 throw 就可能真的炸掉
//      整个运行。拒绝即数据（denial-as-data）是唯一在所有宿主里都安全的形状。
// 所以被拦时 execute 正常 resolve，返回 `{ denied: true, reason }`——模型看得见、
// 循环活得下来、调用方分得清。
//
// ── 检查顺序 ───────────────────────────────────────────────────────────────
// 白名单（O(1) 集合判定，最便宜的先走）→ 输入闸（纯函数正则）→ 人工确认（可能
// 需要终端交互，最贵且只有前面的静态闸都放行才值得问人）→ 原执行 → 输出闸。
// 前置闸任一命中就直接短路返回拒绝，绝不触碰原 execute。
//
// ── 与 MCP 的关系：零耦合 ──────────────────────────────────────────────────
// 闸门只认 AgentTool（引擎自己的类型），不知道工具来自 MCP 适配器还是本地注册表
// ——依赖倒置的确认回调（ToolConfirmFn）同理：CLI 传 readline 问答，HTTP API
// 传 SSE+HTTP 审批，闸门两边都不认识。
import { trace } from "../trace.js";
import type { AgentTool } from "../types.js";
import { auditLog } from "./audit.js";
import { maskPii } from "./pii-mask.js";
import { inspectTextInput, isToolAllowed } from "./validate.js";

/**
 * 人工确认回调（依赖倒置的接缝）：返回 true 放行本次执行，false 拒绝。
 * CLI 用 readline y/n 问答实现，HTTP API 用 SSE 推问 + 审批端点实现——
 * 闸门只依赖这个函数形状，不依赖任何 I/O 设施。
 */
export type ToolConfirmFn = (info: { toolName: string; input: unknown }) => Promise<boolean>;

/** 闸门配置：name 必填（白名单匹配、拒绝话术、确认信息都用它），其余可选项全关 = 仅保留输入闸 */
export interface ToolGateOptions {
  /** 工具名（ToolSet 里的键）：白名单比对与拒绝话术的标识 */
  name: string;
  /** 工具白名单（null/缺省 = 不限制） */
  allowlist?: string[] | null;
  /** 人工确认回调（缺省 = 不需要确认） */
  confirm?: ToolConfirmFn;
  /** 是否对输出做 PII 脱敏（缺省 = 不脱敏） */
  maskOutput?: boolean;
}

/** 结构化拒绝：被拦工具的正常返回值（不是异常）。调用方用 denied === true 识别 */
export interface ToolGateDenial {
  denied: true;
  reason: string;
}

/**
 * 输出闸的脱敏实现：序列化 → maskPii → 尽量解析回原结构。
 * 解析失败（裸数字字段被脱成 `138****5678` 后不再是合法 JSON）时退回脱敏后的
 * JSON 字符串——结构降级好过把未脱敏的原文放出去（fail-closed）。
 * 序列化本身失败（循环引用等，MCP 工具输出经 JSON-RPC 往返实际不会出现）时
 * 原样返回：此时没有可操作的文本面，且丢结果比漏脱敏对用户更不可接受——
 * 该场景已在注释里标明为理论边界。
 */
function maskToolOutput(output: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(output);
  } catch {
    return output;
  }
  if (json === undefined) return output; // undefined/函数等序列化产物缺失：无文本可脱
  const masked = maskPii(json);
  try {
    return JSON.parse(masked);
  } catch {
    return masked;
  }
}

/** 拒绝结果的构造与轨迹：三种拒绝共用（🛡 图标与轨迹系统的 ✗ 执行失败区分开） */
function deny(name: string, reason: string): ToolGateDenial {
  trace("🛡", `护栏拦截 → ${name} 不执行：${reason}`);
  // 审计（红队加固轮 H10）：闸门拒绝即安全事件，落 JSONL 留痕——fire-and-forget，不影响拒绝路径
  auditLog("gate.denied", { tool: name, reason });
  return { denied: true, reason: `工具 ${name} 被护栏拦截：${reason}` };
}

/**
 * 给工具套上护栏闸门，返回的新工具对循环完全透明：
 * description / inputSchema 原样透传（模型看到的工具面不变），execute 换成
 * 「四道前置检查 + 原执行 + 可选输出脱敏」的编排。
 *
 * 无 execute 的 schema-only 工具原样返回——循环本来就报「工具无实现」，
 * 没有可拦截的执行面。
 */
export function wrapToolWithGate(tool: AgentTool, options: ToolGateOptions): AgentTool {
  const { name, allowlist = null, confirm, maskOutput = false } = options;

  const execute = tool.execute;
  if (execute === undefined) {
    return tool;
  }

  return {
    ...tool,
    execute: async (input, executeOptions) => {
      // ① 白名单闸：不在名单 → 拒绝（未配置名单 = null = 放行）
      if (!isToolAllowed(name, allowlist)) {
        return deny(name, "该工具不在允许清单中，禁止执行。");
      }

      // ② 输入闸：对入参的 JSON 序列化做注入扫描（字符串字段的内容会原样进入
      // 序列化文本，扫描面因此覆盖所有字段；无参工具扫 "{}" 恒通过）
      const inspection = inspectTextInput(JSON.stringify(input ?? {}));
      if (!inspection.ok) {
        return deny(name, `输入命中提示注入黑名单（模式：${inspection.matchedPattern ?? "未知"}）。`);
      }

      // ③ 确认闸：回调返回 false / 抛异常都视为未确认（fail-closed）
      if (confirm !== undefined) {
        let approved: boolean;
        try {
          approved = await confirm({ toolName: name, input });
        } catch {
          approved = false;
        }
        // 审计（红队加固轮 H10）：人工裁决结果无论同意/拒绝都留痕——与后续可能的
        // gate.denied 是两个维度（谁裁决了 vs 最终发生了什么），并存不算重复记账
        auditLog("gate.confirm", { tool: name, approved });
        if (approved !== true) {
          return deny(name, "人工确认未通过（未应答或明确拒绝均视为不同意）。");
        }
      }

      // ④ 原执行：与 runToolLoop 同款取值方式（await），正常结果与异常都原样上抛
      const output = await execute(input, executeOptions);

      // ⑤ 输出闸：脱敏开启时对结果做 PII 打码，否则原样返回
      return maskOutput ? maskToolOutput(output) : output;
    },
  };
}
