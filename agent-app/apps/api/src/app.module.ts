// app.module.ts —— 根模块：三个特性模块 + /api/health + 全局限流（生产安全壳）
// 教程 week20 Day 2 的 BFF 形态：每个业务域一个模块（chat / kb / service），
// 路由前缀统一写在各 @Controller("api/...") 里，与教程的路径约定一致。
import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule, seconds } from "@nestjs/throttler";
import { ChatModule } from "./chat/chat.module.js";
import { KbModule } from "./kb/kb.module.js";
import { ServiceModule } from "./service/service.module.js";

/** 限流阈值默认值：100 次/分钟，对正常用户（含现有 e2e 测试）不可见，只拦滥用 */
const THROTTLE_LIMIT_DEFAULT = 100;

// 为什么直接读 process.env 而不走 engine 的 loadEnv：限流是 HTTP 壳（BFF）的关注点，
// 与引擎的 .env 密钥加载是两层——不把「请求防滥用」耦合进「模型配置」，删引擎也不影响语义。
// THROTTLE_DISABLED 主要给测试用：置 1 时整个限流（模块 + 全局守卫）都不装配，
// 行为与引入限流之前完全一致（新能力 env 可关的项目哲学）。
const throttleDisabled = process.env.THROTTLE_DISABLED === "1";
const envLimit = Number(process.env.AGENT_THROTTLE_LIMIT);
// 非法值（未设置 / 非数字 / ≤0）一律回落默认，宁可限流宽松也不让配置笔误打死服务
const throttleLimit =
  Number.isFinite(envLimit) && envLimit > 0 ? Math.floor(envLimit) : THROTTLE_LIMIT_DEFAULT;

/** 健康检查：探活专用，不碰模型不碰存储 */
@Controller("api")
class HealthController {
  @Get("health")
  health(): { status: string } {
    return { status: "ok" };
  }
}

@Module({
  // 条件装配：THROTTLE_DISABLED=1 时连 ThrottlerModule 都不进 imports，
  // 全局限流零开销（而不是装配了再放行）
  imports: [
    ...(throttleDisabled
      ? []
      : [
          // 对象形式：errorMessage 让 429 的 message 走中文（默认是英文
          // "ThrottlerException: Too Many Requests"，与项目中文错误礼仪不一致）；
          // ThrottlerException 继承 HttpException，AllExceptionsFilter 会原样放行成
          // { statusCode: 429, message } 的 JSON 错误体
          ThrottlerModule.forRoot({
            errorMessage: "请求过于频繁，请稍后再试（已触发限流保护）",
            throttlers: [{ ttl: seconds(60), limit: throttleLimit }],
          }),
        ]),
    ChatModule,
    KbModule,
    ServiceModule,
  ],
  controllers: [HealthController],
  providers: [
    // APP_GUARD 把 ThrottlerGuard 注册成全局守卫：所有路由（含未来新增的）默认被限流，
    // 按 IP（req.ip）计数的桶在内存里（默认 storage），单实例部署开箱即用
    ...(throttleDisabled ? [] : [{ provide: APP_GUARD, useClass: ThrottlerGuard }]),
  ],
})
export class AppModule {}
