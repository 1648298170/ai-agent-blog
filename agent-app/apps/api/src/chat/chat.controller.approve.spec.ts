// chat.controller.approve.spec.ts —— POST /api/chat/approve 控制器单测（零网络）
// 覆盖：happy path（允许/拒绝回显 + whitelist 剥未知字段）、服务层返回 false → 404 中文错误、
// 缺字段 / approved 类型不符 → 400。ChatService 用 useValue 整体替换（控制器只关心
// 它给的返回值），校验管道 + 异常过滤器与 main.ts 同款——测的才是线上真实形状。
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AllExceptionsFilter } from "../common/all-exceptions.filter.js";
import { ChatController } from "./chat.controller.js";
import { ChatService } from "./chat.service.js";

/** ChatService 的最小替身：控制器只调 approve（其余方法补全形状） */
const chatServiceMock = {
  chat: vi.fn(),
  chatStream: vi.fn(),
  listSessions: vi.fn(),
  getSessionHistory: vi.fn(),
  approve: vi.fn(),
};

describe("ChatController POST /api/chat/approve（工具审批裁决）", () => {
  let app: INestApplication;

  beforeEach(async () => {
    chatServiceMock.approve.mockReset();

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

  it("允许：服务返回 true → 201 回显 { approvalId, approved: true }，whitelist 剥掉未知字段", async () => {
    chatServiceMock.approve.mockReturnValue(true);

    const res = await request(app.getHttpServer())
      .post("/api/chat/approve")
      .send({ sessionId: "s_x", approvalId: "ap-1", approved: true, hack: "<script>" });

    // Nest 对 @Post 的默认成功状态码是 201（与兄弟端点一致，保持框架默认）
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ approvalId: "ap-1", approved: true });
    expect(chatServiceMock.approve).toHaveBeenCalledExactlyOnceWith({
      sessionId: "s_x",
      approvalId: "ap-1",
      approved: true,
    });
  });

  it("拒绝：服务返回 true → 201 回显 { approvalId, approved: false }（决定权在用户，两端点行为对称）", async () => {
    chatServiceMock.approve.mockReturnValue(true);

    const res = await request(app.getHttpServer())
      .post("/api/chat/approve")
      .send({ sessionId: "s_x", approvalId: "ap-2", approved: false });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ approvalId: "ap-2", approved: false });
  });

  it("服务返回 false（未知/过期/已裁决/会话不符）→ 404 + 中文错误体（HttpException 原样放行）", async () => {
    chatServiceMock.approve.mockReturnValue(false);

    const res = await request(app.getHttpServer())
      .post("/api/chat/approve")
      .send({ sessionId: "s_x", approvalId: "ap-gone", approved: true });

    expect(res.status).toBe(404);
    expect(res.body.statusCode).toBe(404);
    expect(res.body.message).toContain("不存在或已过期");
  });

  it("缺 approved → 400，字段错误信息含「approved」；未触达服务", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/chat/approve")
      .send({ sessionId: "s_x", approvalId: "ap-3" });

    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain("approved");
    expect(chatServiceMock.approve).not.toHaveBeenCalled();
  });

  it("approved 不是布尔值 → 400（拒绝字符串/数字伪装）", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/chat/approve")
      .send({ sessionId: "s_x", approvalId: "ap-4", approved: "yes" });

    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(chatServiceMock.approve).not.toHaveBeenCalled();
  });
});
