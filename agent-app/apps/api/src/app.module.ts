// app.module.ts —— 根模块：三个特性模块 + /api/health
// 教程 week20 Day 2 的 BFF 形态：每个业务域一个模块（chat / kb / service），
// 路由前缀统一写在各 @Controller("api/...") 里，与教程的路径约定一致。
import { Controller, Get, Module } from "@nestjs/common";
import { ChatModule } from "./chat/chat.module.js";
import { KbModule } from "./kb/kb.module.js";
import { ServiceModule } from "./service/service.module.js";

/** 健康检查：探活专用，不碰模型不碰存储 */
@Controller("api")
class HealthController {
  @Get("health")
  health(): { status: string } {
    return { status: "ok" };
  }
}

@Module({
  imports: [ChatModule, KbModule, ServiceModule],
  controllers: [HealthController],
})
export class AppModule {}
