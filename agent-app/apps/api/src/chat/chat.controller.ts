// chat.controller.ts —— /api/chat：非流式 + SSE 流式两个入口
// SSE 用 @Res() 接管原生响应（week20 Day 2 同款）：三个响应头 + flushHeaders 让浏览器
// 立刻进入接收状态，事件逐帧写出；@Res() 路由绕过拦截器，res.end() 必须亲手收尾。
// 红队加固轮：H3 流式端点消息长度 400（SSE 头之前判——头一旦 flush就只能走 error 事件，
// 给不出 4xx 状态码）；H5 非流式端点的审批不支持错误映射 400（跟随既有 HttpException
// 过滤器放行路径，见 all-exceptions.filter）。
// 生产缺陷修复（D2 断开中止）：两个入口都监听 response 的 'close'—— writableEnded
// 为 false 时说明对端在响应写完之前消失了，立即 abort 生成（signal 传入服务层，
// 引擎循环停止调用模型，token 不再白烧）。'close' 在正常收尾时也会触发，所以必须
// 用 writableEnded 区分「写完了」与「对端消失」。
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Res } from "@nestjs/common";
import { ApiBadRequestResponse, ApiExcludeEndpoint, ApiNotFoundResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { ApproveChatResponse, SessionHistoryResponse, SessionSummary } from "@agent-app/shared";
import { buildConfigHint } from "../common/all-exceptions.filter.js";
import { describeMessageTooLong, MESSAGE_MAX_CHARS } from "../common/message-limits.js";
import { ChatService } from "./chat.service.js";
import { ApprovalUnsupportedError } from "./errors.js";
import { ApproveChatDto, CreateChatDto } from "./dto.js";

@ApiTags("chat")
@Controller("api/chat")
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /** 把「对端消失」接到 AbortController：close 且未写完 → abort 生成 */
  private wireDisconnectAbort(res: Response): AbortController {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    return abort;
  }

  /** 非流式：跑完工具循环一次性返回（passthrough 拿到 res 接断开信号，返回值仍走 Nest 序列化） */
  @Post()
  @ApiBadRequestResponse({ description: "请求体校验失败（缺 message / 类型不符 / 超过 8000 字符上限 / 未知字段被剥）；或该端点不支持工具审批（AGENT_CONFIRM_TOOLS 名单非空）" })
  async chat(
    @Body() dto: CreateChatDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ sessionId: string; reply: string }> {
    const abort = this.wireDisconnectAbort(res);
    try {
      return await this.chatService.chat(
        { message: dto.message, sessionId: dto.sessionId },
        { signal: abort.signal },
      );
    } catch (err) {
      // H5：服务层的「不支持审批」是客户端用法错误（应改用流式端点），映射 400——
      // 跟随既有的 HttpException 过滤器放行路径，其余错误原样上抛走 500 + hint 链路
      if (err instanceof ApprovalUnsupportedError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /** 历史会话列表（会话记录功能）：按最后活跃降序，每项含轮数与更新时间。
   *  会话存储与 service 线共用同一个 SessionStore（sessionId 前缀区分产品线：
   *  聊天 s_ / 客服 cs_），这里按 s_ 前缀过滤——chat 的历史面板只看到聊天会话。 */
  @Get("sessions")
  @ApiOkResponse({
    description:
      "历史会话列表（按最近活跃降序，仅 s_ 前缀的聊天会话）。每项：sessionId / turns（压缩后轮数，含摘要轮）/ updatedAt（最后活跃时间，ISO 8601）。SESSION_STORE=redis 时已过期的会话不出现（索引懒清理）。",
  })
  async listSessions(): Promise<SessionSummary[]> {
    const all = await this.chatService.listSessions();
    return all.filter((summary) => summary.sessionId.startsWith("s_"));
  }

  /** 某个会话的全量历史（会话记录功能）：刷新页面/切换会话时恢复界面用。
   *  会话不存在或已过期时返回空 turns（200，不报 404）——前端据此渲染空对话。 */
  @Get("sessions/:sessionId")
  @ApiOkResponse({
    description:
      "该会话的全量轮次（压缩后含 [会话摘要] system 轮）。会话不存在或已过期（Redis TTL 到期）时 turns 为空数组，仍返回 200。",
  })
  async getSessionHistory(@Param("sessionId") sessionId: string): Promise<SessionHistoryResponse> {
    return this.chatService.getSessionHistory(sessionId);
  }

  /**
   * 工具审批裁决（week18 Day 6）：流式对话里高危工具执行前会发 approval SSE 事件，
   * 前端把事件带回的 sessionId + approvalId 连同用户裁决 POST 回来，唤醒挂起的工具调用。
   * 未知 / 已过期（超时自动拒绝）/ 已裁决过 / sessionId 不匹配 → 404 中文错误。
   */
  @Post("approve")
  @ApiOkResponse({ description: "裁决已送达：允许 → 挂起的工具调用继续执行；拒绝 → 收到结构化拒绝值 { denied: true, reason }" })
  @ApiBadRequestResponse({ description: "请求体校验失败（缺 sessionId / approvalId / approved 类型不符）" })
  @ApiNotFoundResponse({ description: "审批不存在或已过期（超时未裁决会自动拒绝）、sessionId 不匹配" })
  async approve(@Body() dto: ApproveChatDto): Promise<ApproveChatResponse> {
    const delivered = this.chatService.approve({
      sessionId: dto.sessionId,
      approvalId: dto.approvalId,
      approved: dto.approved,
    });
    if (!delivered) {
      throw new NotFoundException("审批请求不存在或已过期（超时未裁决会自动拒绝），本次工具调用已按拒绝处理");
    }
    return { approvalId: dto.approvalId, approved: dto.approved };
  }

  /**
   * SSE 流式：GET /api/chat/stream?message=...&sessionId=...
   * 事件序列：session → step*（Thought/Action/Observation 的工具步）→ token*（最终答案）→ done
   * 任一环节出错：error 事件（中文 message + 配置 hint）后正常收尾，不挂死连接。
   * （@Res() 接管原生响应，Swagger 无法表达 SSE 事件流，故从文档中隐藏——事件契约见 @agent-app/shared）
   */
  @Get("stream")
  @ApiExcludeEndpoint()
  async stream(
    @Query("message") message: string | undefined,
    @Query("sessionId") sessionId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // H3 长度闸（红队加固轮，修 E8）：必须在 SSE 头之前判——头一旦 flush，连接就只能以
    // 200 + error 事件收场，给不出 4xx 状态码。这里手写 JSON 错误体与全局过滤器的
    // { statusCode, message } 形状对齐（@Res() 路由不走过滤器，形状自己负责）。
    if (message !== undefined && message.length > MESSAGE_MAX_CHARS) {
      res.status(400).json({ statusCode: 400, message: describeMessageTooLong(message.length) });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no"); // 告诉反向代理别替我攒
    res.flushHeaders();

    // D2：SSE 的断开检测。'close' 在客户端消失和我们自己 res.end() 时都会触发，
    // 用 writableEnded 区分——只有「对端先走」才 abort，正常收尾不误伤。
    const abort = this.wireDisconnectAbort(res);

    const write = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    try {
      if (message === undefined || message.trim() === "") {
        write({ type: "error", message: "缺少必填查询参数 message（GET /api/chat/stream?message=...）" });
        return;
      }
      await this.chatService.chatStream(
        { message: message.trim(), sessionId: sessionId?.trim() || undefined },
        write,
        { signal: abort.signal },
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
}
