// chat/dto.ts —— POST /api/chat 的请求体契约。DTO 必须是 class：
// interface 编译后会被擦掉，ValidationPipe + class-transformer 在运行时拿不到类型信息（week03 Day 4）。
// @ApiProperty 供 Swagger（/api/docs）生成 Schema：中文描述与校验规则一一对应。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString } from "class-validator";

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
