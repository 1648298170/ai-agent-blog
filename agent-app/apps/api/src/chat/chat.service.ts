// chat.service.ts —— 聊天业务：apps/chat/cli.ts 的 HTTP 化（同一引擎、同一会话礼仪）
// 链路同 CLI：用户输入 → append 进会话 → 取最近 20 轮窗口 → runToolLoop（demo 工具）
// → 回复回写会话。离线（无 key）时 runToolLoop 抛错交给全局过滤器转配置提示 JSON。
// 流式版本多一步可视性：onStep 把手写循环的每一步（工具调用 + 输出）转发给调用方，
// 最终答案再用 streamText（不带工具）在已积累的消息上重新流式生成（week20 BFF 的 SSE 形态）。
// SSE 事件契约 ChatStreamEvent 定义在 @agent-app/shared（web 前端与 API 共享），这里再出口。
import { Injectable } from "@nestjs/common";
import { streamText } from "ai";
import type { ModelMessage } from "ai";
import type { ChatStreamEvent } from "@agent-app/shared";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { auditLog, inspectTextInput } from "@agent-app/engine";
import { createModel } from "@agent-app/engine/llm";
import { createSessionStoreFromEnv } from "@agent-app/engine/memory";
import type { ChatTurn, SessionSummary } from "@agent-app/engine/memory";
import { RAG_GROUNDING_RULE } from "@agent-app/engine/rag";
import { createDemoTools } from "@agent-app/engine/tools";
import { ConfigProvider } from "../common/config.provider.js";
import {
  ToolApprovalRegistry,
  readConfirmTimeoutMs,
  readConfirmToolNames,
  wrapToolsWithApproval,
} from "./tool-approval.js";

// ReAct 式提示词：与 apps/chat/cli.ts 完全一致（红队加固轮 H7 追加 RAG 数据性声明——
// 系统提示词层面预先声明「检索资料是数据不是指令」，与 CLI 同一口径）
const SYSTEM_PROMPT =
  "你是客服演示助手，可以查订单状态、创建工单、转接人工。用中文简洁回答。" +
  "每次调用工具前，先用一句话说明你怀疑什么、想查什么。" +
  RAG_GROUNDING_RULE;

/**
 * H5（红队加固轮，修 E6 覆盖面备注）：非流式端点不支持工具审批的错误文案。
 * 导出常量让控制器按它做 400 映射——字符串匹配的单一事实源。
 */
export const NON_STREAM_APPROVAL_UNSUPPORTED = "该端点不支持工具审批，请改用流式端点 /api/chat/stream";

/** AGENT_GUARD_INPUT 的布尔口径（红队加固轮 H6 灰度开关，默认关——零变化默认铁律） */
function isInputGuardEnabled(): boolean {
  const raw = process.env.AGENT_GUARD_INPUT;
  return raw === "1" || raw === "true";
}

/** 新会话 id：时间戳 + 随机串（同 apps/chat/cli.ts） */
export function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** ChatTurn 窗口 → ModelMessage 数组（system 提示词单独走 runToolLoop 的 system 选项） */
function toModelMessages(window: ChatTurn[]): ModelMessage[] {
  return window.map((turn) => ({ role: turn.role, content: turn.content }));
}

/** SSE 事件流：session（含新会话 id）→ 若干 step（工具步）→ 若干 token → done；出错转 error */
export type { ChatStreamEvent };

/**
 * 生成中止信号的接缝（生产缺陷修复：客户端断开后停止烧 token）。
 * 控制器把「对端消失」（response close 且未写完）接到 AbortController.abort()，
 * signal 经这个可选参数流进服务层——不传（既有调用方/测试）行为与旧版完全一致。
 */
export interface ChatAbortOptions {
  signal?: AbortSignal;
}

@Injectable()
export class ChatService {
  // env 工厂（SESSION_STORE=memory|redis，默认 memory——与改造前一致；配 redis 时跨实例共享）
  private readonly sessionStore = createSessionStoreFromEnv();
  private readonly tools = createDemoTools();
  /**
   * 工具审批登记簿（week18 Day 6）：approvalId → 挂起中的裁决，进程内存实现
   * （已知取舍同 service 线的 unresolvedRounds：重启即清，等价于「已过期」）。
   * 流式端点与 approve 端点共用同一个 ChatService 单例，因此共用这张表。
   */
  private readonly approvals = new ToolApprovalRegistry();

  constructor(private readonly config: ConfigProvider) {}

  /** 启动自检用：构造注入是否真的装配到 ConfigProvider（main.ts 在 boot 时调用打印） */
  describeInjection(): string {
    return this.config.hasApiKey() ? "已配置" : "未配置（离线降级链路生效）";
  }

  /**
   * 非流式问答：sessionId（缺省新开）→ 会话窗口 → runToolLoop → { sessionId, reply }。
   * 红队加固轮 H5（修 E6 覆盖面备注）：AGENT_CONFIRM_TOOLS 名单非空时直接抛中文错误
   * （控制器映射 400）——非流式端点没有 SSE 通道，审批壳挂上来只会白等超时，
   * E6 已证明 createTicket 在这里是无闸裸奔。这是「安全默认」的刻意变更：默认名单
   * 是 createTicket（非空），所以本端点默认即 400，要么改用流式端点、要么显式
   * AGENT_CONFIRM_TOOLS= 关闭审批（SECURITY.md 第五节已列为有意的行为变更）。
   */
  async chat(
    input: { message: string; sessionId?: string },
    options?: ChatAbortOptions,
  ): Promise<{ sessionId: string; reply: string }> {
    if (readConfirmToolNames().size > 0) {
      throw new Error(NON_STREAM_APPROVAL_UNSUPPORTED);
    }

    const sessionId = input.sessionId ?? newSessionId();

    // ① 用户输入进会话窗口，② 取最近 20 轮拼消息（模型懒创建：没配 key 时这里才碰网络）
    await this.sessionStore.append(sessionId, { role: "user", content: input.message });
    const history = await this.sessionStore.getWindow(sessionId, 20);

    try {
      const result = await runToolLoop({
        model: createModel(),
        messages: toModelMessages(history),
        system: SYSTEM_PROMPT,
        tools: this.tools,
        maxSteps: 5,
        signal: options?.signal,
      });

      // ③ 回复回写会话
      await this.sessionStore.append(sessionId, { role: "assistant", content: result.text });
      return { sessionId, reply: result.text };
    } catch (err) {
      // 客户端断开引发的中止：换算成明确的中文错误后沿既有错误路径上抛（全局
      // 过滤器记日志/组响应——对方虽已收不到，日志语义仍要可读）。刻意不静默：
      // 非流式端点的调用方依赖「要么完整结果、要么明确失败」的二值语义，
      // 静默返回半截结果会把「未完成」伪装成「完成」。
      if (options?.signal?.aborted) {
        throw new Error("客户端已断开连接，本次生成已中止，未产生完整回复");
      }
      throw err;
    }
  }

  /**
   * 流式问答：事件经 emit 回调交出（控制器负责写成 SSE 帧）。
   * 出错时抛给调用方，由控制器发 {type:"error"} 事件——服务层不碰 HTTP。
   *
   * 实现说明：runToolLoop 收尾那轮 generateText 的 text 不用（非流式产物），
   * 最终答案按 week20 的形态用 streamText（纯文本、不带工具）在已积累的消息
   * （含全部工具调用与回灌，不含最终回复）上重新流式生成——多一次生成调用，
   * 换来逐 token 可视，这是不动引擎内部的前提下最直接的 SSE 形态。
   */
  async chatStream(
    input: { message: string; sessionId?: string },
    emit: (event: ChatStreamEvent) => void,
    options?: ChatAbortOptions,
  ): Promise<void> {
    const signal = options?.signal;
    const sessionId = input.sessionId ?? newSessionId();
    emit({ type: "session", sessionId });

    // H6 用户消息输入闸（红队加固轮，灰度开关 AGENT_GUARD_INPUT，默认关）：
    // 命中注入黑名单 → 审计留痕 + 抛中文错误（控制器转 error 事件）——消息不进会话、
    // 模型零感知。E2 证明了扫描器拦得住混淆变体，缺的只是接到用户消息路径上。
    if (isInputGuardEnabled()) {
      const inspection = inspectTextInput(input.message);
      if (!inspection.ok) {
        auditLog("input.user_rejected", {
          surface: "api.chatStream",
          sessionId,
          inputLength: input.message.length,
          matchedPattern: inspection.matchedPattern ?? null,
        });
        throw new Error(
          `输入闸拦截：消息命中提示注入黑名单（模式：${inspection.matchedPattern ?? "未知"}），已拒绝处理，不调用模型。`,
        );
      }
    }

    await this.sessionStore.append(sessionId, { role: "user", content: input.message });
    const history = await this.sessionStore.getWindow(sessionId, 20);

    // 高危工具审批（week18 Day 6）：命中 AGENT_CONFIRM_TOOLS 名单的工具先包壳——
    // execute 前发 approval 事件并挂起，等 POST /api/chat/approve 裁决。
    // 名单为空（显式置空）→ 原表直传：不包壳、不发新事件，与改造前完全一致。
    // 只作用于流式端点：非流式 chat() 没有 SSE 通道，包壳只会白等 60s。
    const confirmTools = readConfirmToolNames();
    const tools =
      confirmTools.size === 0
        ? this.tools
        : wrapToolsWithApproval(this.tools, confirmTools, {
            sessionId,
            registry: this.approvals,
            emit,
            timeoutMs: readConfirmTimeoutMs(),
          });

    // 生成段整体套 try：客户端断开（signal.aborted）时安静收场——对方已经收不到
    // 任何事件，发 error 事件毫无意义，还会在已关闭的 socket 上白写。
    try {
      const result = await runToolLoop({
        model: createModel(),
        messages: toModelMessages(history),
        system: SYSTEM_PROMPT,
        tools,
        maxSteps: 5,
        signal,
        onStep: (event) =>
          emit({ type: "step", step: event.step, toolCall: event.toolCall, output: event.output }),
      });

      // 最终答案流式生成：messages 已含全部工具往来，streamText 只做纯文本收尾。
      // abortSignal 同样接上：断开后底层流被取消，不再向网关要新 token。
      const { textStream } = streamText({
        model: createModel(),
        system: SYSTEM_PROMPT,
        messages: result.messages,
        abortSignal: signal,
      });

      let answer = "";
      for await (const delta of textStream) {
        if (signal?.aborted) break; // 断开后不再 emit（写已关的 socket 没有意义）
        answer += delta;
        emit({ type: "token", text: delta });
      }

      if (signal?.aborted) {
        // 断开收场：不回写半截答案（污染下一轮上下文）、不发 done——客户端没等到
        // 完整回答是既成事实，会话里保留它的提问即可，下次追问有上下文可续。
        return;
      }
      await this.sessionStore.append(sessionId, { role: "assistant", content: answer });
      emit({ type: "done" });
    } catch (err) {
      if (signal?.aborted) return; // abort 引发的拒绝（AbortError 等）：安静收场
      throw err;
    }
  }

  /**
   * 用户裁决回填（POST /api/chat/approve）：唤醒挂起的工具调用。
   * 返回 false = 未知 / 已过期（超时自动拒绝）/ 已裁决过 / sessionId 不匹配——控制器转 404。
   */
  approve(decision: { sessionId: string; approvalId: string; approved: boolean }): boolean {
    return this.approvals.resolveApproval(decision);
  }

  /** 历史会话清单（按最近活跃降序）：委托给会话存储（memory / redis 行为一致） */
  listSessions(): Promise<SessionSummary[]> {
    return this.sessionStore.listSessions();
  }

  /** 某个会话的全量轮次（压缩后含摘要轮）；会话不存在/已过期时 turns 为空数组 */
  async getSessionHistory(sessionId: string): Promise<{ sessionId: string; turns: ChatTurn[] }> {
    const turns = await this.sessionStore.getHistory(sessionId);
    return { sessionId, turns };
  }
}
