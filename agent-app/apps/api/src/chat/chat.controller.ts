// chat.controller.ts —— /api/chat：非流式 + SSE 流式两个入口
// SSE 用 @Res() 接管原生响应（week20 Day 2 同款）：三个响应头 + flushHeaders 让浏览器
// 立刻进入接收状态，事件逐帧写出；@Res() 路由绕过拦截器，res.end() 必须亲手收尾。
import { Body, Controller, Get, Post, Query, Res } from "@nestjs/common";
import { ApiBadRequestResponse, ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { buildConfigHint } from "../common/all-exceptions.filter.js";
import { ChatService } from "./chat.service.js";
import { CreateChatDto } from "./dto.js";

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
