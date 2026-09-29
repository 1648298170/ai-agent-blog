// service.controller.spec.ts —— /api/service 控制器单测：会话记录两个新端点。
// 「转人工」是硬规则纯函数路径（零模型调用），离线即可在控制器自带的内存会话存储里
// 真实攒出 cs_ 会话，再验证列表的 cs_ 前缀过滤与历史端点的轮次恢复。
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServiceController } from "./service.controller.js";

describe("ServiceController（/api/service）会话记录端点", () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ServiceController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /api/service/sessions 只列 cs_ 前缀的客服会话（不含其他前缀）", async () => {
    // 硬规则「转人工」离线可用：真实写一条 cs_ 会话进控制器自带的会话存储
    const msg = await request(app.getHttpServer())
      .post("/api/service/message")
      .send({ message: "转人工" });
    expect(msg.status).toBe(201);
    expect(msg.body.sessionId).toMatch(/^cs_/);

    const res = await request(app.getHttpServer()).get("/api/service/sessions");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // 过滤契约：每个会话都是 cs_ 前缀，且刚发的会话在列（按最后活跃降序排第一）
    for (const summary of res.body as Array<{ sessionId: string; turns: number }>) {
      expect(summary.sessionId.startsWith("cs_")).toBe(true);
    }
    expect(res.body[0].sessionId).toBe(msg.body.sessionId);
    expect(res.body[0].turns).toBeGreaterThanOrEqual(2);
  });

  it("GET /api/service/sessions/:sessionId → { sessionId, turns }，user/assistant 轮俱在", async () => {
    const msg = await request(app.getHttpServer())
      .post("/api/service/message")
      .send({ message: "转人工" });
    expect(msg.status).toBe(201);

    const res = await request(app.getHttpServer()).get(
      `/api/service/sessions/${msg.body.sessionId}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(msg.body.sessionId);
    const roles = (res.body.turns as Array<{ role: string }>).map((turn) => turn.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
  });

  it("GET /api/service/sessions/:sessionId 未知会话 → 200 + 空 turns（不报 404）", async () => {
    const res = await request(app.getHttpServer()).get("/api/service/sessions/cs_notexist");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: "cs_notexist", turns: [] });
  });
});
