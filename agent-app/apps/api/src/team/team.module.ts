// team.module.ts —— 多 Agent 编排的特性模块：只挂 SSE 端点（编排器在 engine，
// api 层只做 SSE 帧与断连——编排状态持久化 / 事件流都在 engine 侧）。
import { Module } from "@nestjs/common";
import { TeamController } from "./team.controller.js";

@Module({
  controllers: [TeamController],
})
export class TeamModule {}
