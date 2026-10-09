// tool-assembly.ts —— 对话工具表的组装车间：把「基础工具表 + 哪些壳」装配成
// 一张可直接交给 runToolLoop 的表。
//
// 为什么单独一个文件：壳的叠加顺序（审批在外、幂等在内）是安全语义，
// 散落在每个端点的手工嵌套里迟早被改坏——集中在这里，顺序即配置。
// chat.service 只剩编排，不再关心壳怎么包。
//
// 洋葱模型：shells 数组书写顺序 = 拦截顺序，shells[0] 最靠外。
// 审批壳在最外（拒绝的调用到不了幂等层，不污染缓存）；幂等壳贴着原工具。
import type { ToolSet } from "ai";
import type { ChatStreamEvent } from "@agent-app/shared";
import {
  composeToolShells,
  IdempotencyRegistry,
  wrapToolsWithIdempotency,
} from "@agent-app/engine/tools";
import { wrapToolsWithApproval } from "./tool-approval.js";

export interface ChatToolAssemblyOptions {
  /** 基础工具表（demo 工具等，未包壳） */
  baseTools: ToolSet;
  /** 会话 id：幂等键的 scope（同会话去重，跨会话互不影响） */
  sessionId: string;
  /** 幂等登记簿（service 持有的单例） */
  idempotency: IdempotencyRegistry;
  /**
   * 审批壳参数（仅流式端点传入）：confirmTools 为空 = 不装审批壳（零变化默认）。
   * 非流式端点没有 SSE 通道，审批壳挂上来只会白等超时——由调用方决定不传。
   */
  approval?: {
    confirmTools: ReadonlySet<string>;
    registry: import("./tool-approval.js").ToolApprovalRegistry;
    emit: (event: ChatStreamEvent) => void;
    timeoutMs: number;
  };
}

/** 组装对话工具表：[审批壳（可选，最外）] → 幂等壳（最内，贴着原工具） */
export function assembleChatTools(options: ChatToolAssemblyOptions): ToolSet {
  const { baseTools, sessionId, idempotency, approval } = options;

  const shells: ((table: ToolSet) => ToolSet)[] = [];
  if (approval !== undefined && approval.confirmTools.size > 0) {
    shells.push((table) =>
      wrapToolsWithApproval(table, approval.confirmTools, {
        sessionId,
        registry: approval.registry,
        emit: approval.emit,
        timeoutMs: approval.timeoutMs,
      }),
    );
  }
  shells.push((table) => wrapToolsWithIdempotency(table, idempotency, { scope: sessionId }));

  return composeToolShells(baseTools, shells);
}
