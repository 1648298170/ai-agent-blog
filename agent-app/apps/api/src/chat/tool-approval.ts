// tool-approval.ts —— 工具审批（human-in-the-loop）的 API 层实现（week18 Day 6）
// 架构边界：引擎的 runToolLoop 一行不改（packages/engine 冻结），审批完全做在 API 层——
// 交给引擎的工具表先「包壳」：命中高危名单的工具，execute 前先发 approval SSE 事件并挂起，
// 等用户 POST /api/chat/approve 裁决（允许 → 放行原 execute；拒绝 → 返回结构化拒绝值，
// 模型看得见、能礼貌收尾）。超时未裁决自动拒绝。
// （引擎侧可复用的审批闸门是另一个工作流，这里刻意不依赖、不 import。）
// 红队加固轮 H10：裁决结果（允许/拒绝/超时）落审计日志——此前只在 SSE 与 stderr 里飘过，
// 事后无法回答「什么时候批了什么」。auditLog 从 @agent-app/engine 根桶走（fire-and-forget）。
import { randomUUID } from "node:crypto";
import type { ChatStreamEvent } from "@agent-app/shared";
import { auditLog } from "@agent-app/engine";
import { loadEnv } from "@agent-app/engine/config";
import type { ToolCallOptions, ToolSet } from "ai";

/** 高危工具默认名单：建工单（写操作，改了外部状态所以拦一道） */
const DEFAULT_CONFIRM_TOOLS = "createTicket";

/** 审批等待上限默认 60s：超时自动拒绝（resolve false 并清理 pending 条目） */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 60000;

/**
 * AGENT_CONFIRM_TOOLS：逗号分隔的高危工具名单。
 * - 未配置 → 默认 createTicket（教程演示开箱即用）
 * - 显式置空（AGENT_CONFIRM_TOOLS=）→ 名单为空，不包壳、不发新事件，行为与改造前完全一致
 * 读取优先级：进程环境变量 > .env 文件（同 main.ts 读 PORT 的惯例）。
 */
export function readConfirmToolNames(): ReadonlySet<string> {
  const raw =
    process.env.AGENT_CONFIRM_TOOLS ?? loadEnv().AGENT_CONFIRM_TOOLS ?? DEFAULT_CONFIRM_TOOLS;
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

/** AGENT_CONFIRM_TIMEOUT_MS：审批等待毫秒数（默认 60000）；缺省/非法/非正值回退默认 */
export function readConfirmTimeoutMs(): number {
  const raw = process.env.AGENT_CONFIRM_TIMEOUT_MS ?? loadEnv().AGENT_CONFIRM_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONFIRM_TIMEOUT_MS;
}

/** 内存 pending 表的一行：裁决 resolver + 归属会话 + 工具名 + 超时句柄 */
interface PendingApproval {
  resolve: (approved: boolean) => void;
  sessionId: string;
  toolName: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 审批登记簿：approvalId → 挂起中的审批。
 * 多流并发安全：每条审批有独立 UUID，任意多个 SSE 流可同时挂起各自的审批；
 * 裁决按 approvalId 精确唤醒，且要求 sessionId 匹配（跨会话的裁决请求按未知处理）。
 * 已知取舍（同 service 线的 unresolvedRounds）：表在进程内存里，API 重启即清——
 * 重启后旧的 approvalId 全部变 404，等价于「已过期」。
 */
export class ToolApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();

  /**
   * 等待用户裁决：登记 pending → 同步发出 approval 事件 → 挂起等待。
   * 超时（timeoutMs）自动拒绝：resolve(false) 并清理条目——之后迟到的裁决 POST 按 404 处理。
   */
  confirm(
    info: { sessionId: string; toolName: string; input: unknown },
    emit: (event: ChatStreamEvent) => void,
    timeoutMs: number,
  ): Promise<boolean> {
    const approvalId = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId); // 过期条目清理：迟到的裁决不再命中
        // H10 审计：超时自动拒绝也是裁决结果的一种（fail-closed 的证据链）
        auditLog("approval.timeout", { approvalId, sessionId: info.sessionId, toolName: info.toolName });
        resolve(false); // 自动拒绝
      }, timeoutMs);
      this.pending.set(approvalId, {
        resolve,
        sessionId: info.sessionId,
        toolName: info.toolName,
        timer,
      });
      // 事件在挂起之前发出：前端看到卡片时，BFF 侧已可接受裁决
      emit({
        type: "approval",
        approvalId,
        sessionId: info.sessionId,
        toolName: info.toolName,
        input: info.input,
      });
    });
  }

  /**
   * 用户裁决回填（POST /api/chat/approve 的服务端入口）。
   * 命中（且 sessionId 匹配）→ resolve 挂起的工具调用并清理条目，返回 true；
   * 未知 / 已过期 / 已裁决过 / 会话不符 → 返回 false（控制器转 404）。
   */
  resolveApproval(decision: { sessionId: string; approvalId: string; approved: boolean }): boolean {
    const entry = this.pending.get(decision.approvalId);
    if (entry === undefined || entry.sessionId !== decision.sessionId) return false;
    this.pending.delete(decision.approvalId);
    clearTimeout(entry.timer);
    // H10 审计：用户裁决结果落痕（允许/拒绝是两条不同的事件名，检索时直接 grep）
    auditLog(decision.approved ? "approval.granted" : "approval.denied", {
      approvalId: decision.approvalId,
      sessionId: decision.sessionId,
      toolName: entry.toolName,
    });
    entry.resolve(decision.approved);
    return true;
  }
}

/**
 * 工具表包壳：命中名单的工具换成审批版 execute（description / inputSchema 原样保留，
 * 模型看到的工具面不变），其余工具原对象直传（不进名单的工具零改动）。
 * 拒绝时的返回值是结构化对象 { denied, reason }——经引擎 jsonOutput 回灌后模型可见，
 * 能据此向用户解释而没有半途而废的假成功。
 */
export function wrapToolsWithApproval(
  tools: ToolSet,
  gatedNames: ReadonlySet<string>,
  context: {
    sessionId: string;
    registry: ToolApprovalRegistry;
    emit: (event: ChatStreamEvent) => void;
    timeoutMs: number;
  },
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const original = tool.execute;
    if (!gatedNames.has(name) || original === undefined) {
      wrapped[name] = tool; // 非高危 / 纯 schema 工具：原样透传，绝不包壳
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, options: ToolCallOptions) => {
        const approved = await context.registry.confirm(
          { sessionId: context.sessionId, toolName: name, input },
          context.emit,
          context.timeoutMs,
        );
        if (!approved) return { denied: true, reason: "用户拒绝执行该工具" };
        return original(input, options);
      },
    };
  }
  return wrapped;
}
