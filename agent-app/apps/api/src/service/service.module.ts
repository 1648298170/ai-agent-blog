// service.module.ts —— 智能客服特性模块（逻辑在控制器内，同 CLI 单循环的形状）
import { Module } from "@nestjs/common";
import { ServiceController } from "./service.controller.js";

@Module({
  controllers: [ServiceController],
})
export class ServiceModule {}
