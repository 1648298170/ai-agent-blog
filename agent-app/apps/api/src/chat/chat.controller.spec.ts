// chat.controller.spec.ts —— /api/chat 控制器单测：校验管道 + 异常过滤器 + 委派
// 覆盖三件事（均不碰网络）：happy path（whitelist 剥未知字段）、缺 message → 400、
// 服务抛错 → 过滤器输出 { statusCode, message, hint } 形状；另带 SSE 缺参的 error 事件契约。
// ChatService 用 useValue 整体替换（控制器只关心它给的返回值/抛出的错误）。
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "../common/all-exceptions.filter.js";
import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";

/** ChatService 的最小替身：控制器只调 chat / chatStream 两个方法 */
const chatServiceMock = {
  chat: vi.fn(),
  chatStream: vi.fn(),
};

describe("ChatController（/api/chat）", () => {
  let app: INestApplication;

  beforeEach(async () => {
    chatServiceMock.chat.mockReset();
    chatServiceMock.chatStream.mockReset();

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
    chatServiceMock.chat.mockRejectedValue(new Error("LLM 调用失败：401 Unauthorized"));

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
});
