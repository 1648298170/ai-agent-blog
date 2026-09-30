// service.controller.ts —— 智能客服 HTTP 化：apps/cli 的 service REPL 主循环逐行对应
// 链路同 CLI：会话入账 → 维护「连续未解决」计数（按 sessionId，CLI 是单会话变量）
//   → supervise（硬规则纯函数优先，全不命中才 LLM 三分类）
//   → 工人（order/refund/knowledge 各配最小工具表）或转人工（建工单 + HandoffPack）。
// 离线降级同 CLI 上线检查清单第 8 条：模型路由/工人失败直接转人工，用户侧不暴露报错——
// 所以本控制器不向全局过滤器抛模型错误，而是走降级分支返回 human 路由。
// 流式端点 GET /api/service/stream（chat 线 /api/chat/stream 的骨架同款）：
//   session → route（判定先行，回复生成前就到）→ step*（工人工具步）→ token* → done；
//   转人工路径多发 handoff 工单包，告知文本按定宽切片成 token 事件。
// 单仓化改造：supervisor / workers / handoff 产品核心经 @agent-app/engine/service 消费，
// 路由与转人工契约类型来自 @agent-app/shared——app 之间禁止互相 import。
import { Body, Controller, Get, Param, Post, Query, Res } from "@nestjs/common";
import { ApiBadRequestResponse, ApiExcludeEndpoint, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { streamText } from "ai";
import type {
  RouteDecision,
  RouteTarget,
  ServiceHandoffPack,
  ServiceStreamEvent,
  SessionHistoryResponse,
  SessionSummary,
} from "@agent-app/shared";
import { createSessionStoreFromEnv } from "@agent-app/engine/memory";
import type { SessionStore } from "@agent-app/engine/memory";
import { setRagStore } from "@agent-app/engine/rag";
import { createRagStoreFromEnv } from "@agent-app/engine/rag/store.factory";
import { createModel } from "@agent-app/engine/llm";
import {
  buildHandoffPack,
  handoffReply,
  isUnresolvedSignal,
  runWorker,
  runWorkerStreaming,
  supervise,
  workerSystemPrompt,
} from "@agent-app/engine/service";
import type { ChatTurn } from "@agent-app/engine/memory";
import { buildConfigHint } from "../common/all-exceptions.filter.js";
import { describeMessageTooLong, MESSAGE_MAX_CHARS } from "../common/message-limits.js";
import type { ServiceReply } from "./service.dto.js";
import { ServiceMessageDto } from "./service.dto.js";

/** 新会话 id：时间戳 + 随机串（同 service REPL 的 cs_ 前缀） */
function newSessionId(): string {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 转人工：建工单 + HandoffPack，回写会话（CLI 的 doHandoff 对应物，返回值代替打印） */
async function doHandoff(
  sessionStore: SessionStore,
  sessionId: string,
  reason: string,
  history: ChatTurn[],
): Promise<{ reply: string; handoff: ServiceHandoffPack }> {
  const pack = await buildHandoffPack({ reason, turns: history });
  const reply = handoffReply(pack);
  await sessionStore.append(sessionId, { role: "assistant", content: reply });
  return { reply, handoff: pack };
}

/**
 * 固定告知文本按定宽切片为 token 事件：转人工路径的回执不是模型产物、没有天然分片边界，
 * 切片纯粹为了前端逐段渲染的流式体感（宽度过大失去渐进感、过小事件数爆炸，16 取中）。
 */
function chunkText(text: string, size = 16): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

@ApiTags("service")
@Controller("api/service")
export class ServiceController {
  /** 会话窗口跨请求保留（env 工厂：默认内存版重启即失，同 CLI 进程生命周期；SESSION_STORE=redis 时跨实例共享） */
  private readonly sessionStore = createSessionStoreFromEnv();
  /**
   * 连续未解决计数：CLI 里的单变量，HTTP 侧按 sessionId 各记各的。
   * 已知限制：计数只存在本进程的内存 Map 里，API 重启即清零（会话窗口可经
   * SESSION_STORE=redis 跨重启保留，但计数不随会话迁移）——重启后用户需重新
   * 累积连续追问才会再触发「连续未解决」转人工；不做持久化属已知取舍，无逻辑变更。
   */
  private readonly unresolvedRounds = new Map<string, number>();

  constructor() {
    // knowledge 工人与 kb 问答共用同一份知识库（env 工厂默认 json 快照，与 CLI 一致）
    setRagStore(createRagStoreFromEnv());
  }

  /** 把「对端消失」接到 AbortController：close 且未写完 → abort 生成
   *  （chat.controller 同款：'close' 在正常收尾时也触发，必须用 writableEnded 区分） */
  private wireDisconnectAbort(res: Response): AbortController {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    return abort;
  }

  @Post("message")
  @ApiBadRequestResponse({ description: "请求体校验失败（缺 message / 类型不符）" })
  async message(@Body() dto: ServiceMessageDto): Promise<ServiceReply> {
    const sessionId = dto.sessionId ?? newSessionId();

    await this.sessionStore.append(sessionId, { role: "user", content: dto.message });
    const history = await this.sessionStore.getWindow(sessionId, 20);

    // 追问信号维护「连续未解决」计数：命中 +1，正常提问清零（计数归代码管，不归模型管）
    const prev = this.unresolvedRounds.get(sessionId) ?? 0;
    const unresolvedRounds = isUnresolvedSignal(dto.message) ? prev + 1 : 0;
    this.unresolvedRounds.set(sessionId, unresolvedRounds);

    // ① 路由：硬规则在 supervise 内部优先执行，全不命中才发起 LLM 分类。
    // 模型不可用 → 降级转人工（用户侧表现为 human 路由而非报错页）
    let decision: RouteDecision;
    try {
      decision = await supervise({ lastUserMessage: dto.message, unresolvedRounds }, history);
    } catch {
      decision = {
        target: "human",
        reason: "模型路由不可用，按降级预案直接转人工（用户侧不暴露报错）",
      };
    }

    // ② 转人工是业务流程的正常一步：建工单 + 上下文包，计数清零
    if (decision.target === "human") {
      const { reply, handoff } = await doHandoff(this.sessionStore, sessionId, decision.reason, history);
      this.unresolvedRounds.set(sessionId, 0);
      return { sessionId, route: decision.target, reason: decision.reason, reply, handoff };
    }

    // ③ 业务工人处理；工人失败同样降级转人工
    try {
      const reply = await runWorker(decision.target, { history, message: dto.message });
      await this.sessionStore.append(sessionId, { role: "assistant", content: reply });
      return { sessionId, route: decision.target, reason: decision.reason, reply };
    } catch {
      const reason = `工人 ${decision.target} 处理失败（模型不可用），按降级预案转人工`;
      const { reply, handoff } = await doHandoff(this.sessionStore, sessionId, reason, history);
      this.unresolvedRounds.set(sessionId, 0);
      const route: RouteTarget = "human";
      return { sessionId, route, reason, reply, handoff };
    }
  }

  /**
   * SSE 流式：GET /api/service/stream?message=...&sessionId=...
   * 事件序列（契约 ServiceStreamEvent 在 @agent-app/shared）：
   *   LLM 路由 session → route → step* → token* → done；
   *   硬规则转人工 session → route(human) → handoff → token*（告知文本定宽切片）→ done；
   *   降级转人工 route 事件连发两次（业务路由 → human 降级），前端以最后一次为准。
   * 任一环节出错：error 事件（中文 message + 配置 hint）后正常收尾，不挂死连接。
   * 会话入账与 POST /message 逐行同款（user 轮 + assistant 回写），历史两端连续。
   * （@Res() 接管原生响应，Swagger 无法表达 SSE 事件流，故从文档中隐藏）
   */
  @Get("stream")
  @ApiExcludeEndpoint()
  async stream(
    @Query("message") message: string | undefined,
    @Query("sessionId") sessionId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // 长度闸必须在 SSE 头之前判（chat.stream 同款，H3 修 E8）：头一旦 flush，连接就
    // 只能以 200 + error 事件收场，给不出 4xx 状态码；错误体形状与全局过滤器对齐。
    if (message !== undefined && message.length > MESSAGE_MAX_CHARS) {
      res.status(400).json({ statusCode: 400, message: describeMessageTooLong(message.length) });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no"); // 告诉反向代理别替我攒
    res.flushHeaders();

    // SSE 断开检测：只有「对端先走」（close 且未写完）才 abort，正常收尾不误伤
    const abort = this.wireDisconnectAbort(res);

    const write = (payload: ServiceStreamEvent): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      if (message === undefined || message.trim() === "") {
        write({ type: "error", message: "缺少必填查询参数 message（GET /api/service/stream?message=...）" });
        return;
      }
      await this.streamRound(
        { message: message.trim(), sessionId: sessionId?.trim() || undefined },
        write,
        abort.signal,
      );
    } catch (err) {
      if (abort.signal.aborted) return; // 客户端已断：error 事件写给谁？直接收尾
      const detail = err instanceof Error ? err.message : String(err);
      const hint = buildConfigHint(err);
      write(hint === undefined ? { type: "error", message: detail } : { type: "error", message: detail, hint });
    } finally {
      res.end(); // 无论如何都收尾，不留悬空连接
    }
  }

  /**
   * 流式主循环：POST /message 的逐行流式版（会话入账 → 计数 → 路由 → 工人/转人工），
   * 与非流式端点共用同一个 sessionStore 与 unresolvedRounds 计数表（跨端点历史连续）。
   * route 事件在工人开跑之前发出——路由判定先行是流式版独有的可视性增量。
   */
  private async streamRound(
    input: { message: string; sessionId?: string },
    write: (event: ServiceStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const sessionId = input.sessionId ?? newSessionId();
    write({ type: "session", sessionId });

    await this.sessionStore.append(sessionId, { role: "user", content: input.message });
    const history = await this.sessionStore.getWindow(sessionId, 20);

    // 追问信号维护「连续未解决」计数（与 POST /message 同一逻辑、同一张表）
    const prev = this.unresolvedRounds.get(sessionId) ?? 0;
    const unresolvedRounds = isUnresolvedSignal(input.message) ? prev + 1 : 0;
    this.unresolvedRounds.set(sessionId, unresolvedRounds);

    // ① 路由：硬规则优先；模型不可用 → 降级转人工（不暴露报错，与非流式同口径）
    let decision: RouteDecision;
    try {
      decision = await supervise({ lastUserMessage: input.message, unresolvedRounds }, history);
    } catch {
      decision = {
        target: "human",
        reason: "模型路由不可用，按降级预案直接转人工（用户侧不暴露报错）",
      };
    }
    write({ type: "route", route: decision.target, reason: decision.reason });

    // ② 转人工：工单包 + 告知文本切片（route 已发过 human，这里不重复发）
    if (decision.target === "human") {
      await this.streamHandoff(sessionId, decision.reason, history, write);
      return;
    }

    // ③ 业务工人：工具步实时外发，最终答案用工人的提示词 streamText 逐 token 收尾
    try {
      const { messages } = await runWorkerStreaming(
        decision.target,
        { history, message: input.message },
        {
          onStep: (event) =>
            write({
              type: "step",
              step: event.step,
              toolCall: event.toolCall,
              output: event.output,
              text: event.text, // 模型步间推理文本（常为 undefined——诚实透传，不造模板话）
            }),
          signal,
        },
      );

      const { textStream } = streamText({
        model: createModel(),
        system: workerSystemPrompt(decision.target),
        messages,
        abortSignal: signal,
      });

      let answer = "";
      for await (const delta of textStream) {
        if (signal.aborted) break; // 断开后不再 emit（写已关的 socket 没有意义）
        answer += delta;
        write({ type: "token", text: delta });
      }

      if (signal.aborted) {
        // 断开收场（chat 线同口径）：不回写半截答案、不发 done——会话里保留提问即可
        return;
      }
      await this.sessionStore.append(sessionId, { role: "assistant", content: answer });
      write({ type: "done" });
    } catch (err) {
      if (signal.aborted) return; // abort 引发的拒绝（AbortError 等）：安静收场
      // 工人失败同样降级转人工：补发 route(human) 让前端徽标切到真实出口，再走工单流
      const reason = `工人 ${decision.target} 处理失败（模型不可用），按降级预案转人工`;
      write({ type: "route", route: "human", reason });
      await this.streamHandoff(sessionId, reason, history, write);
    }
  }

  /** 转人工的流式出口：工单包事件 → 告知文本切片成 token → done，回写会话 + 计数清零 */
  private async streamHandoff(
    sessionId: string,
    reason: string,
    history: ChatTurn[],
    write: (event: ServiceStreamEvent) => void,
  ): Promise<void> {
    const { reply, handoff } = await doHandoff(this.sessionStore, sessionId, reason, history);
    this.unresolvedRounds.set(sessionId, 0);
    write({ type: "handoff", handoff });
    for (const chunk of chunkText(reply)) write({ type: "token", text: chunk });
    write({ type: "done" });
  }

  /** 历史会话列表（会话记录功能）：按最后活跃降序，每项含轮数与更新时间。
   *  会话存储与 chat 线共用同一个 SessionStore（sessionId 前缀区分产品线：
   *  聊天 s_ / 客服 cs_），这里按 cs_ 前缀过滤——客服历史面板只看到客服会话。 */
  @Get("sessions")
  @ApiOkResponse({
    description:
      "历史会话列表（按最近活跃降序，仅 cs_ 前缀的客服会话）。每项：sessionId / turns（压缩后轮数，含摘要轮）/ updatedAt（最后活跃时间，ISO 8601）。SESSION_STORE=redis 时已过期的会话不出现（索引懒清理）。",
  })
  async listSessions(): Promise<SessionSummary[]> {
    const all = await this.sessionStore.listSessions();
    return all.filter((summary) => summary.sessionId.startsWith("cs_"));
  }

  /** 某个客服会话的全量历史（会话记录功能）：刷新页面/切换会话时恢复界面用。
   *  会话不存在或已过期时返回空 turns（200，不报 404）——前端据此渲染空对话。 */
  @Get("sessions/:sessionId")
  @ApiOkResponse({
    description:
      "该客服会话的全量轮次（压缩后含 [会话摘要] system 轮）。会话不存在或已过期（Redis TTL 到期）时 turns 为空数组，仍返回 200。",
  })
  async getSessionHistory(@Param("sessionId") sessionId: string): Promise<SessionHistoryResponse> {
    const turns = await this.sessionStore.getHistory(sessionId);
    return { sessionId, turns };
  }
}
