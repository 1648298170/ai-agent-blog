// service.dto.ts —— 智能客服接口的契约（请求 DTO + 响应形状）
// 路由与转人工契约类型来自 @agent-app/shared（跨端同源）。
// @ApiProperty 供 Swagger（/api/docs）生成 Schema：中文描述与校验规则一一对应。
// 红队加固轮 H3：message 加 8000 字符上限（与 chat DTO 同一口径），修 E8 的消息长度无界。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import type { RouteTarget, ServiceHandoffPack } from "@agent-app/shared";
import { MESSAGE_MAX_CHARS } from "../common/message-limits.js";

/** POST /api/service/message 请求体 */
export class ServiceMessageDto {
  @ApiProperty({
    description: `用户消息（客服主循环的当轮输入，上限 ${MESSAGE_MAX_CHARS} 字符）`,
    example: "订单 A-1024 到哪了",
  })
  @IsString({ message: "message 必须是字符串" })
  @IsNotEmpty({ message: "message 不能为空" })
  @MaxLength(MESSAGE_MAX_CHARS, { message: `message 长度不能超过 ${MESSAGE_MAX_CHARS} 字符（输入长度闸，见 SECURITY.md E8）` })
  message!: string;

  /** 复用会话则传（连续未解决计数按会话维护）；缺省新开并在响应里返回 */
  @ApiPropertyOptional({ description: "复用会话则传（连续未解决计数按会话维护）；缺省新开并在响应里返回" })
  @IsOptional()
  @IsString({ message: "sessionId 必须是字符串" })
  sessionId?: string;
}

/** POST /api/service/message 响应：route=human 时附带 handoff 上下文包 */
export interface ServiceReply {
  sessionId: string;
  /** order / refund / knowledge / human（human 是业务流程的正常一步，不是异常） */
  route: RouteTarget;
  /** 路由判定依据（转人工时进工单，是接手人的第一眼信息） */
  reason: string;
  reply: string;
  /** route=human 时存在：工单号 + 原因 + 用户摘要 + 最近对话（接手人不用用户复述） */
  handoff?: ServiceHandoffPack;
}
