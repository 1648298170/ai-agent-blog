// app.e2e-spec.ts —— 全链路 e2e：Test.createTestingModule(AppModule) + supertest
// 零网络铁律：模块级 vi.mock 掉 "ai"（generateText/streamText 一律抛错）与
// @agent-app/engine/agent-loop（runToolLoop 抛错），任何模型调用在测试里都会失败——
// 这正好逼出两条离线链路：service 降级转人工、handoff 摘要降级原文拼接。
// 引擎的纯函数零件（硬规则路由、mock 工单工具、会话存储）用真品，测真实装配。
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { AppModule } from "../src/app.module.js";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter.js";

// 部分 mock：tool / embedMany 等工具原语用真品（转人工要真实建 mock 工单），
// 只屏蔽两个会发起网络请求的模型入口——任何 LLM/embedding 调用在测试里必失败，
// 这正好逼出两条离线链路：service 降级转人工、handoff 摘要降级原文拼接。
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(() => Promise.reject(new Error("测试环境禁止网络：generateText 已屏蔽"))),
    streamText: vi.fn(() => {
      throw new Error("测试环境禁止网络：streamText 已屏蔽");
    }),
  };
});
vi.mock("@agent-app/engine/agent-loop", () => ({
  DEFAULT_MAX_STEPS: 5,
  runToolLoop: vi.fn(() => Promise.reject(new Error("测试环境禁止网络：runToolLoop 已屏蔽"))),
}));

describe("AppModule e2e（/api/*）", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // 与 main.ts 完全一致的全局管道/过滤器：e2e 测的就是线上装配
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/health → 200 { status: 'ok' }", async () => {
    const res = await request(app.getHttpServer()).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("POST /api/kb/query 缺 question → 400（ValidationPipe 拦截，未触达检索）", async () => {
    const res = await request(app.getHttpServer()).post("/api/kb/query").send({ topK: 5 });

    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
  });

  it("GET /api/nonexistent → 404（过滤器对 HttpException 原样放行）", async () => {
    const res = await request(app.getHttpServer()).get("/api/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.statusCode).toBe(404);
  });

  it("POST /api/service/message「转人工」→ 硬规则命中 route=human，附完整 handoff 包（全程零模型）", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/service/message")
      .send({ message: "转人工" });

    // Nest 对 @Post 的默认成功状态码是 201（保持框架默认，不改端点行为）
    expect(res.status).toBe(201);
    expect(res.body.route).toBe("human");
    expect(res.body.reason).toContain("转人工");
    // handoff 上下文包：mock 工单工具离线可建，摘要走降级原文拼接
    expect(res.body.handoff).toBeDefined();
    expect(res.body.handoff.ticketId).toMatch(/^TK-/);
    expect(res.body.handoff.userSummary).toContain("用户最近的问题");
    expect(res.body.reply).toContain(res.body.handoff.ticketId);
    expect(res.body.sessionId).toMatch(/^cs_/);
  });

  it("POST /api/service/message 模糊消息 + 模型路由被屏蔽 → 降级转人工 route=human", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/service/message")
      .send({ message: "今天天气怎么样呢" }); // 不命中任何硬规则 → 必须问模型 → 被屏蔽 → 降级

    expect(res.status).toBe(201); // 同上：@Post 默认 201
    expect(res.body.route).toBe("human");
    expect(res.body.reason).toContain("降级");
    expect(res.body.handoff).toBeDefined();
    // 降级链路的证据：LLM 分类确实被调用过（且按 mock 约定失败了）
    expect(vi.mocked(runToolLoop)).not.toHaveBeenCalled(); // 工人未上岗，直接转人工
  });
});
