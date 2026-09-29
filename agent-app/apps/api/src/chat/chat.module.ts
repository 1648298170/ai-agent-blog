// chat.module.ts —— 聊天特性模块：controller + service + 配置薄封装
import { Module } from "@nestjs/common";
import { ConfigProvider } from "../common/config.provider.js";
import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";

@Module({
  controllers: [ChatController],
  providers: [ChatService, ConfigProvider],
})
export class ChatModule {}
