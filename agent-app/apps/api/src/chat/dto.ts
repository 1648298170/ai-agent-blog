// chat/dto.ts —— POST /api/chat 与 POST /api/chat/approve 的请求体契约。DTO 必须是 class：
// interface 编译后会被擦掉，ValidationPipe + class-transformer 在运行时拿不到类型信息（week03 Day 4）。
// @ApiProperty 供 Swagger（/api/docs）生成 Schema：中文描述与校验规则一一对应。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class CreateChatDto {
  @ApiProperty({ description: "用户消息（非流式对话的完整输入）", example: "订单 A-1024 到哪了" })
  @IsString({ message: "message 必须是字符串" })
  @IsNotEmpty({ message: "message 不能为空" })
  message!: string;

  /** 复用会话则传；缺省服务端新开一个 sessionId 并在响应里返回 */
  @ApiPropertyOptional({ description: "复用会话则传；缺省服务端新开一个 sessionId 并在响应里返回" })
  @IsOptional()
  @IsString({ message: "sessionId 必须是字符串" })
  sessionId?: string;
}

/** POST /api/chat/approve 请求体（week18 Day 6 工具审批）：approval SSE 事件带回的
 *  sessionId + approvalId 连同用户裁决一起回传。线上纯类型（ApproveChatRequest）在 @agent-app/shared。 */
export class ApproveChatDto {
  @ApiProperty({ description: "发起审批的会话 id（approval 事件的 sessionId 字段）", example: "s_m3x2k1_ab12cd" })
  @IsString({ message: "sessionId 必须是字符串" })
  @IsNotEmpty({ message: "sessionId 不能为空" })
  sessionId!: string;

  @ApiProperty({
    description: "待审批的工具调用 id（approval 事件的 approvalId 字段，UUID）",
    example: "3f1c8d20-7c2a-4b1e-9f3d-2a6b8e4c1d5f",
  })
  @IsString({ message: "approvalId 必须是字符串" })
  @IsNotEmpty({ message: "approvalId 不能为空" })
  approvalId!: string;

  @ApiProperty({ description: "用户裁决：true=允许执行该工具调用，false=拒绝执行", example: true })
  @IsBoolean({ message: "approved 必须是布尔值" })
  approved!: boolean;
}
