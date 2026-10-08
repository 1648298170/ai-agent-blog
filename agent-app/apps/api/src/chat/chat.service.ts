// chat.service.ts —— 聊天业务：apps/chat/cli.ts 的 HTTP 化（同一引擎、同一会话礼仪）
// 链路同 CLI：用户输入 → append 进会话 → 取最近 20 轮窗口 → runToolLoop（demo 工具）
// → 回复回写会话。离线（无 key）时 runToolLoop 抛错交给全局过滤器转配置提示 JSON。
// 流式版本多一步可视性：onStep 把手写循环的每一步（工具调用 + 输出）转发给调用方，
// 最终答案再用 streamText（不带工具）在已积累的消息上重新流式生成（week20 BFF 的 SSE 形态）。
// SSE 事件契约 ChatStreamEvent 定义在 @agent-app/shared（web 前端与 API 共享），这里再出口。
// 外部数据源（2026-09）：请求带 X-Ops-Token 头时，把已配置数据源的 ops_* 工具
// 合并进本轮工具表（provider plugin pattern，见 @agent-app/engine/datasource）——
// 不带头或数据源未配置 = 与改造前逐字节一致。
import { Injectable } from "@nestjs/common";
import { streamText } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import type { ChatStreamEvent } from "@agent-app/shared";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { auditLog, inspectTextInput } from "@agent-app/engine";
import { registerBuiltInDataSources, resolveDataSourceTools } from "@agent-app/engine/datasource";
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
const SYSTEM_PROMPT = (() => {
  // 当前日期锚点：LLM 不知道今天几号——不注入就会把「8月份」幻觉成任意年份
  // （week19 实测：模型把「8月份」编成 2021-08 / 2022-08）。模块加载时取一次即可。
  const today = new Date().toLocaleDateString("sv-SE"); // yyyy-MM-dd
  return (
    `你是运营数据助手，负责两类业务：` +
    `① 查询运营后台数据——订单统计、每日明细走势、代理商经营对比、商家流水排行、各代理商每天明细（用 ops_* 工具）；` +
    `② 演示业务——查订单状态、创建售后工单、转接人工。` +
    `用户按名字提到某代理商或商家时，先用 ops_agent_search / ops_tenant_search 按名字查出 ID` +
    `（名册行自带订单总数等汇总，简单问题可直接回答；要月度流水/每日走势再用 ID 调 ops_order_statistics / ops_daily_details）；` +
    `名册里没有该名字就如实告知，绝不编造 ID。` +
    `用户追问某个指标的细分数字（如「买断订单数是多少」「退款金额呢」）而没重复代理商/商家名字时，` +
    `承接上文：本会话前面查过某代理商/商户的，就带上同一个 agentId 调工具继续查（ID 见下方已知对象清单或名册结果）；` +
    `上文同时聊过多个对象或确实无法确定是谁时，先向用户确认，不要默认查全部。` +
    `需要数据就必须真的调用工具拿到结果再回答——严禁只说「请稍等」「正在查询」却不调用工具就结束，` +
    `严禁虚构「模拟查询过程」，严禁在未查到结果时报具体数字。` +
    `今天是 ${today}——用户提到相对时间（如「8月份」「上个月」）时，按今天推算具体年份与月份。` +
    `超出职责范围的问题（闲聊、写作、时事、专业咨询等），礼貌说明你的职责并引导用户回到业务，` +
    `绝不越界作答，也绝不编造职责之外的信息。` +
    `工具查询返回空数据或全零时，如实告知用户「该时间段没有数据记录」，绝不编造数字。` +
    `用户请求缺少关键信息（如年份、统计范围）或含义不明时，先向用户确认，不要自行假设。` +
    `用中文简洁回答。每次调用工具前，先用一句话说明你怀疑什么、想查什么。` +
    RAG_GROUNDING_RULE
  );
})();

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

/** 内置数据源的懒登记旗子：registerBuiltInDataSources 本身幂等（Map 覆盖式登记），
 *  这面旗子让「进程生命周期内只调一次」成为字面事实——首个带 token 的请求触发。 */
let builtInDataSourcesRegistered = false;

/** 会话实体缓存上限：单会话最多记 20 条（FIFO 淘汰）、进程最多记 200 个会话（防泄漏） */
const MAX_ENTITIES_PER_SESSION = 20;
const MAX_SESSIONS_IN_CACHE = 200;

/**
 * 从工具输出里递归扫描「实体」（同时含数字 id 与以 Name 结尾字符串字段的对象，
 * 如名册行 {id: 42, outletsName: "广东深圳"}）——通用纯 JSON 规则，不耦合任何
 * provider 的具体形状。扫描产物喂给 system prompt 的动态段，让模型在追问
 * （「买断订单数是多少」）时直接拿到 ID，不用重查名册。
 * 真机实测踩中（2026-10）：工具消息不入会话历史，模型追问时手里没有 ID，
 * 只能反问用户或查全量——这是「会话记忆颗粒度」的最小修复。
 */
export function extractEntityLines(output: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || output === null || typeof output !== "object") return out;
  if (Array.isArray(output)) {
    for (const item of output) extractEntityLines(item, depth + 1, out);
    return out;
  }
  const obj = output as Record<string, unknown>;
  const id = obj.id;
  if (typeof id === "number" && Number.isInteger(id)) {
    for (const [key, value] of Object.entries(obj)) {
      if (key.toLowerCase().endsWith("name") && typeof value === "string" && value.trim() !== "") {
        const line = `${value.trim()}（ID ${id}）`;
        if (!out.includes(line)) out.push(line); // 同名同 ID 去重
        break; // 一个对象取第一个名字字段即可
      }
    }
  }
  for (const value of Object.values(obj)) extractEntityLines(value, depth + 1, out);
  return out;
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
 * 单次请求的可选项（原「中止信号接缝」的扩展）：
 * - signal：客户端断开后停止烧 token（生产缺陷修复，见下方 chatStream）；
 * - opsToken：请求级外部数据源凭据（X-Ops-Token 头）。非空时服务层会把
 *   已配置数据源（OPS_BASE_URL 非空）的 ops_* 工具合并进本轮工具表——
 *   token 是用户自己的钥匙，只跟着请求走，不进进程状态。
 */
export interface ChatRequestOptions {
  signal?: AbortSignal;
  opsToken?: string;
}

/** 兼容旧名（既有调用方/测试若引用）：改名只是让语义覆盖「请求级选项」而不仅是中止 */
export type ChatAbortOptions = ChatRequestOptions;

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

  /**
   * 会话实体缓存：sessionId → 「名称（ID n）」行列表（进程内存，重启即清——
   * 丢失后模型没有注入段会重新查名册，自然降级，不会编 ID）。
   * 每轮工具结果经 extractEntityLines 扫描入账，下一轮拼进 system 动态段。
   */
  private readonly sessionEntities = new Map<string, string[]>();

  constructor(private readonly config: ConfigProvider) {}

  /** 记录本轮工具结果扫出的实体（FIFO 上限；会话数超限时淘汰最早一个会话） */
  private rememberEntities(sessionId: string, output: unknown): void {
    const lines = extractEntityLines(output);
    if (lines.length === 0) return;
    const existing = this.sessionEntities.get(sessionId) ?? [];
    for (const line of lines) {
      if (existing.includes(line)) continue;
      existing.push(line);
      if (existing.length > MAX_ENTITIES_PER_SESSION) existing.shift();
    }
    if (this.sessionEntities.size >= MAX_SESSIONS_IN_CACHE && !this.sessionEntities.has(sessionId)) {
      const oldest = this.sessionEntities.keys().next().value;
      if (oldest !== undefined) this.sessionEntities.delete(oldest);
    }
    this.sessionEntities.set(sessionId, existing);
  }

  /** system 提示词 + 实体动态段：本会话查到过对象时，追问拿已知 ID 直接触发工具调用 */
  private buildSystemPrompt(sessionId: string): string {
    const lines = this.sessionEntities.get(sessionId);
    if (lines === undefined || lines.length === 0) return SYSTEM_PROMPT;
    return (
      SYSTEM_PROMPT +
      `\n\n[本会话已查到的对象——用户追问细分指标时，用对应的 ID 调 ops_order_statistics / ops_daily_details 等工具查询，不要重新查名册]\n` +
      lines.map((line) => `- ${line}`).join("\n")
    );
  }

  /** 启动自检用：构造注入是否真的装配到 ConfigProvider（main.ts 在 boot 时调用打印） */
  describeInjection(): string {
    return this.config.hasApiKey() ? "已配置" : "未配置（离线降级链路生效）";
  }

  /**
   * 请求级外部数据源工具合并（provider plugin pattern 的消费端）：
   * X-Ops-Token 头非空时，把「已配置数据源」（OPS_BASE_URL 非空，由
   * resolveDataSourceTools 内部过滤）的 ops_* 工具并进本地工具表。
   * 三条铁律：
   * - 没带头 / 数据源未配置 → 原表直返，行为与改造前逐字节一致（零变化默认）；
   * - 重名时外部版本胜出 + 中文警告——与 CLI --mcp 合并（apps/cli chat cli.ts 的
   *   mergeMcpTools）同一策略：静默覆盖会让「为什么查商家流水走的是外部」变成悬案；
   * - token 只进 resolveDataSourceTools 的参数，不进任何日志。
   */
  private mergeExternalDataTools(base: ToolSet, opsToken: string | undefined): ToolSet {
    const token = opsToken?.trim() ?? "";
    if (token === "") return base; // 用户没填钥匙：本轮不给外部工具，模型也不会点名
    if (!builtInDataSourcesRegistered) {
      registerBuiltInDataSources(); // 幂等：首次带 token 的请求登记一次
      builtInDataSourcesRegistered = true;
    }
    const external = resolveDataSourceTools({ token });
    if (external.length === 0) return base; // 数据源没配 env：零变化
    const merged: ToolSet = { ...base };
    for (const { name, tool } of external) {
      if (name in merged) {
        console.warn(`⚠ 外部数据源工具与本地工具重名（${name}），已用外部版本覆盖：同名工具改走外部数据源执行。`);
      }
      merged[name] = tool;
    }
    return merged;
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
        system: this.buildSystemPrompt(sessionId),
        tools: this.mergeExternalDataTools(this.tools, options?.opsToken),
        maxSteps: 5,
        signal: options?.signal,
        onStep: (event) => this.rememberEntities(sessionId, event.output), // 实体入账（非流式无 SSE，只需记账）
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
    // 外部数据源工具在包壳之前合并（先并表、再统一上闸——外部工具若进审批名单同样受闸）。
    const confirmTools = readConfirmToolNames();
    const baseTools = this.mergeExternalDataTools(this.tools, options?.opsToken);
    const tools =
      confirmTools.size === 0
        ? baseTools
        : wrapToolsWithApproval(baseTools, confirmTools, {
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
        system: this.buildSystemPrompt(sessionId),
        tools,
        maxSteps: 5,
        signal,
        onStep: (event) => {
          this.rememberEntities(sessionId, event.output); // 实体入账 → 下一轮 system 动态段
          emit({
            type: "step",
            step: event.step,
            toolCall: event.toolCall,
            output: event.output,
            text: event.text, // 模型步间推理文本（常为 undefined——诚实透传，不造模板话）
          });
        },
      });

      // 最终答案流式生成：messages 已含全部工具往来，streamText 只做纯文本收尾。
      // abortSignal 同样接上：断开后底层流被取消，不再向网关要新 token。
      const { textStream } = streamText({
        model: createModel(),
        system: this.buildSystemPrompt(sessionId),
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
