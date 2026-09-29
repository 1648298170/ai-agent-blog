// kb.module.ts —— 知识库特性模块
import { Module } from "@nestjs/common";
import { ConfigProvider } from "../common/config.provider.js";
import { KbController } from "./kb.controller.js";
import { KbService } from "./kb.service.js";

@Module({
  controllers: [KbController],
  providers: [KbService, ConfigProvider],
})
export class KbModule {}
