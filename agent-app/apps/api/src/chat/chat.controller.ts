// chat.controller.ts —— /api/chat：非流式 + SSE 流式两个入口
// SSE 用 @Res() 接管原生响应（week20 Day 2 同款）：三个响应头 + flushHeaders 让浏览器
// 立刻进入接收状态，事件逐帧写出；@Res() 路由绕过拦截器，res.end() 必须亲手收尾。
import { Body, Controller, Get, NotFoundException, Param, Post, Query, Res } from "@nestjs/common";
import { ApiBadRequestResponse, ApiExcludeEndpoint, ApiNotFoundResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { ApproveChatResponse, SessionHistoryResponse, SessionSummary } from "@agent-app/shared";
import { buildConfigHint } from "../common/all-exceptions.filter.js";
import { ChatService } from "./chat.service.js";
import { ApproveChatDto, CreateChatDto } from "./dto.js";

@ApiTags("chat")
@Controller("api/chat")
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /** 非流式：跑完工具循环一次性返回 */
  @Post()
  @ApiBadRequestResponse({ description: "请求体校验失败（缺 message / 类型不符 / 未知字段被剥）" })
  async chat(@Body() dto: CreateChatDto): Promise<{ sessionId: string; reply: string }> {
    return this.chatService.chat({ message: dto.message, sessionId: dto.sessionId });
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
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no"); // 告诉反向代理别替我攒
    res.flushHeaders();

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
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const hint = buildConfigHint(err);
      write(hint === undefined ? { type: "error", message: detail } : { type: "error", message: detail, hint });
    } finally {
      res.end(); // 无论如何都收尾，不留悬空连接
    }
  }
}
