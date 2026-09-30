// chat.controller.spec.ts —— /api/chat 控制器单测：校验管道 + 异常过滤器 + 委派
// 覆盖三件事（均不碰网络）：happy path（whitelist 剥未知字段）、缺 message → 400、
// 服务抛错 → 过滤器输出 { statusCode, message, hint } 形状；另带 SSE 缺参的 error 事件契约。
// ChatService 用 useValue 整体替换（控制器只关心它给的返回值/抛出的错误）。
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "../common/all-exceptions.filter.js";
import { MESSAGE_MAX_CHARS } from "../common/message-limits.js";
import { ChatController } from "./chat.controller.js";
import { NON_STREAM_APPROVAL_UNSUPPORTED, ChatService } from "./chat.service.js";

/** ChatService 的最小替身：控制器只调 chat / chatStream / listSessions / getSessionHistory */
const chatServiceMock = {
  chat: vi.fn(),
  chatStream: vi.fn(),
  listSessions: vi.fn(),
  getSessionHistory: vi.fn(),
};

describe("ChatController（/api/chat）", () => {
  let app: INestApplication;

  beforeEach(async () => {
    chatServiceMock.chat.mockReset();
    chatServiceMock.chatStream.mockReset();
    chatServiceMock.listSessions.mockReset();
    chatServiceMock.getSessionHistory.mockReset();

    const moduleRef = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: chatServiceMock }],
    }).compile();

    app = moduleRef.createNestApplication();
    // 与 main.ts 同款全局管道/过滤器：这里测的才是线上真实形状
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("POST /api/chat happy path：返回 { sessionId, reply }，whitelist 剥掉未知字段", async () => {
    chatServiceMock.chat.mockResolvedValue({ sessionId: "s_fixed", reply: "已为你查到订单 A-1024" });

    const res = await request(app.getHttpServer())
      .post("/api/chat")
      .send({ message: "订单 A-1024 到哪了", hack: "<script>" });

    // Nest 对 @Post 的默认成功状态码是 201（保持框架默认，不改端点行为）
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ sessionId: "s_fixed", reply: "已为你查到订单 A-1024" });
    // 未知字段被 ValidationPipe(whitelist) 剥掉，服务层只收到白名单内的字段
    expect(chatServiceMock.chat).toHaveBeenCalledExactlyOnceWith({
      message: "订单 A-1024 到哪了",
      sessionId: undefined,
    });
  });

  it("POST /api/chat 缺 message → 400，message 字段报「不能为空」", async () => {
    const res = await request(app.getHttpServer()).post("/api/chat").send({});

    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.message).toContain("message 不能为空");
    // 校验失败不应触达业务服务
    expect(chatServiceMock.chat).not.toHaveBeenCalled();
  });

  it("POST /api/chat 服务层抛 LLM 错误 → 500 + { statusCode, message, hint } 形状", async () => {
    chatServiceMock.chat.mockRejectedValue(new Error("【模拟】LLM 调用失败：401 Unauthorized"));

    const res = await request(app.getHttpServer()).post("/api/chat").send({ message: "你好" });

    expect(res.status).toBe(500);
    expect(res.body.statusCode).toBe(500);
    expect(res.body.message).toContain("LLM 调用失败");
    // 过滤器识别出鉴权类错误，给出 .env 配置指引（hint 一定存在且指向 .env.example）
    expect(res.body.hint).toContain(".env.example");
  });

  it("GET /api/chat/stream 缺 message → SSE error 事件（中文提示），不调服务", async () => {
    const res = await request(app.getHttpServer()).get("/api/chat/stream");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.text).toContain("缺少必填查询参数 message");
    expect(chatServiceMock.chatStream).not.toHaveBeenCalled();
  });

  it("GET /api/chat/sessions 按 s_ 前缀过滤：共享存储里的 cs_ 客服会话不出现", async () => {
    // 会话存储与 service 线共用（Redis 模式同库）：混入的 cs_ 会话应被过滤掉
    chatServiceMock.listSessions.mockResolvedValue([
      { sessionId: "s_aaa", turns: 2, updatedAt: "2026-01-01T00:00:00.000Z" },
      { sessionId: "cs_bbb", turns: 4, updatedAt: "2026-01-02T00:00:00.000Z" },
      { sessionId: "s_ccc", turns: 6, updatedAt: "2026-01-03T00:00:00.000Z" },
    ]);

    const res = await request(app.getHttpServer()).get("/api/chat/sessions");

    expect(res.status).toBe(200);
    expect(res.body.map((s: { sessionId: string }) => s.sessionId)).toEqual(["s_aaa", "s_ccc"]);
  });

  it("GET /api/chat/sessions/:sessionId → 服务层返回的 { sessionId, turns } 原样透传", async () => {
    chatServiceMock.getSessionHistory.mockResolvedValue({
      sessionId: "s_aaa",
      turns: [{ role: "user", content: "你好" }],
    });

    const res = await request(app.getHttpServer()).get("/api/chat/sessions/s_aaa");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: "s_aaa",
      turns: [{ role: "user", content: "你好" }],
    });
    expect(chatServiceMock.getSessionHistory).toHaveBeenCalledExactlyOnceWith("s_aaa");
  });

  // ══ 红队加固轮（H3 长度闸 / H5 非流式审批映射）════════════════════════════

  it("H3：POST /api/chat 消息超过 8000 字符 → 400 + 中文超长提示（DTO MaxLength 拦截）", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/chat")
      .send({ message: "啊".repeat(MESSAGE_MAX_CHARS + 1) });

    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain(String(MESSAGE_MAX_CHARS));
    // 校验失败不应触达业务服务
    expect(chatServiceMock.chat).not.toHaveBeenCalled();
  });

  it("H3：GET /api/chat/stream 消息超过 8000 字符 → 400 JSON（SSE 头之前拦截，非 error 事件）", async () => {
    // 用 ASCII 超长而不是中文：GET 查询参数过大会先撞 Node 的 HTTP 头上限（约 16KB，
    // 一个中文字 URL 编码后 9 字节）——连接层直接断（ECONNRESET，事实上也 fail-closed），
    // 路由内的 400 只对「超过 8000 但 URL 还装得下」的区间可达。ASCII 8001 字节稳落在该区间。
    const long = encodeURIComponent("a".repeat(MESSAGE_MAX_CHARS + 1));
    const res = await request(app.getHttpServer()).get(`/api/chat/stream?message=${long}`);

    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.message).toContain("消息过长");
    expect(chatServiceMock.chatStream).not.toHaveBeenCalled();
  });

  it("H5：服务层抛「该端点不支持工具审批」→ 控制器映射 400（中文 message，走 HttpException 放行路径）", async () => {
    chatServiceMock.chat.mockRejectedValue(new Error(NON_STREAM_APPROVAL_UNSUPPORTED));

    const res = await request(app.getHttpServer()).post("/api/chat").send({ message: "你好" });

    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.message).toContain("该端点不支持工具审批");
    expect(res.body.message).toContain("/api/chat/stream");
  });
});
