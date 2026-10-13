// security.e2e-spec.ts —— 生产安全壳 e2e（BACKLOG #5）：helmet 安全头 + Throttler 全局限流
// 只打 /api/health（不碰模型），故无需像另两个 e2e 那样 mock "ai" / agent-loop（零网络铁律天然满足）。
// 装配与 main.ts 对齐：helmet 是 main.ts 的中间件（这里手动挂同一份），
// 限流是 AppModule 内置的全局守卫（import 即生效）——测的就是线上装配。
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import helmet from "helmet";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";

// 限流阈值必须在 AppModule 求值（import 时）之前就位：静态 import 会被提升，
// 普通语句来不及；vi.hoisted 由 vitest 提升到所有 import 之前执行，刚好卡进这个缝隙。
// 压到 3 次/分钟 → 第 4 个请求必 429，不用真打 100 次。
vi.hoisted(() => {
  process.env.AGENT_THROTTLE_LIMIT = "3";
});

describe("生产安全壳 e2e（helmet 安全头 + 全局限流）", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // 与 main.ts 同款 helmet 配置（含 Swagger 让步），安全头断言才有代表性
    app.use(helmet({ contentSecurityPolicy: false }));
    await app.init();
  });

  afterAll(async () => {
    // 压低的阈值只属于本文件：删干净，避免同 worker 里后续测试文件的 AppModule
    // 在模块求值时读到被污染的 env（隔离只保证模块注册表，不保证 process.env）
    delete process.env.AGENT_THROTTLE_LIMIT;
    await app.close();
  });

  it("GET /api/health → helmet 安全头存在（X-Content-Type-Options / X-Frame-Options 等）", async () => {
    const res = await request(app.getHttpServer()).get("/api/health");

    expect(res.status).toBe(200);
    // MIME 嗅探防御（helmet 头里最有共识的一个，任务点名要求）
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // 点击劫持防御：同源才许内嵌 iframe
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    // referrer 泄露防御（helmet 默认策略 no-referrer）
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("限流开启时 → 响应带 X-RateLimit-* 头，且 limit 反映 env 覆盖（AGENT_THROTTLE_LIMIT=3）", async () => {
    const res = await request(app.getHttpServer()).get("/api/health");

    expect(res.status).toBe(200);
    // 默认（未命名）throttler 的头不带后缀：X-RateLimit-Limit / -Remaining / -Reset
    expect(res.headers["x-ratelimit-limit"]).toBe("3");
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("超过阈值（3 次/分钟）→ 第 4 个请求 429 + 中文 JSON 错误体 + Retry-After", async () => {
    // 本用例前的 2 个请求 + 这里第 3 个：额度用满，仍应 200
    const third = await request(app.getHttpServer()).get("/api/health");
    expect(third.status).toBe(200);

    // 第 4 个：同 IP 计数 4 > 3 → 拦下，429 走 AllExceptionsFilter 的 HttpException 放行链路
    const fourth = await request(app.getHttpServer()).get("/api/health");
    expect(fourth.status).toBe(429);
    expect(fourth.body.statusCode).toBe(429);
    expect(fourth.body.message).toContain("请求过于频繁");
    // 被拦的请求附带 Retry-After（秒数），告诉调用方何时重试
    expect(fourth.headers["retry-after"]).toBeDefined();
  });
});
