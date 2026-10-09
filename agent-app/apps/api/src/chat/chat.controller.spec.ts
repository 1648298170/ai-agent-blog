// chat.controller.spec.ts —— /api/chat 控制器单测：校验管道 + 异常过滤器 + 委派
// 覆盖三件事（均不碰网络）：happy path（whitelist 剥未知字段）、缺 message → 400、
// 服务抛错 → 过滤器输出 { statusCode, message, hint } 形状；另带 SSE 缺参的 error 事件契约。
// ChatService 用 useValue 整体替换（控制器只关心它给的返回值/抛出的错误）。
// D2（断开中止）：用真实 socket 制造「客户端消失」——挂起的服务调用中途 destroy
// 连接，断言控制器把 response close 接到了传给服务层的 signal 上（aborted === true）。
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { AllExceptionsFilter } from "../common/all-exceptions.filter.js";
import { MESSAGE_MAX_CHARS } from "../common/message-limits.js";
import { ChatController } from "./chat.controller.js";
import { ApprovalUnsupportedError, NON_STREAM_APPROVAL_UNSUPPORTED } from "./errors.js";
import { ChatService } from "./chat.service.js";


/** ChatService 的最小替身：控制器只调 chat / chatStream / listSessions / getSessionHistory */
const chatServiceMock = {
  chat: vi.fn(),
  chatStream: vi.fn(),
  listSessions: vi.fn(),
  getSessionHistory: vi.fn(),
};

/** 手动把 Nest 的 http server 监听到随机端口（supertest 无法做"中途断开"这种精细控制） */
async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("监听后应返回 AddressInfo");
  return (address as AddressInfo).port;
}

/** 轮询等待条件成立（断开 → abort 是跨事件循环的异步链，轮询比固定 sleep 稳） */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 关掉监听与所有残余连接（被 destroy 的客户端 socket 不清会吊住 server.close） */
async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

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
    // 未知字段被 ValidationPipe(whitelist) 剥掉，服务层只收到白名单内的字段；
    // 第二参是 D2 断开中止的 signal 接缝（AbortSignal，未断开时 aborted=false）
    expect(chatServiceMock.chat).toHaveBeenCalledExactlyOnceWith(
      {
        message: "订单 A-1024 到哪了",
        sessionId: undefined,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
    chatServiceMock.chat.mockRejectedValue(new ApprovalUnsupportedError());

    const res = await request(app.getHttpServer()).post("/api/chat").send({ message: "你好" });

    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.message).toContain("该端点不支持工具审批");
    expect(res.body.message).toContain("/api/chat/stream");
  });

  // ══ D2（生产缺陷修复：断开中止）══════════════════════════════════════

  it("D2 POST /api/chat：客户端中途断开 → 传给 chat() 的 signal 变为 aborted（生成被中止）", async () => {
    let captured: { signal?: AbortSignal } | undefined;
    let release: (() => void) | undefined;
    chatServiceMock.chat.mockImplementation((_input, options) => {
      captured = options; // 模拟"生成还在跑"：挂起直到测试放行
      return new Promise<{ sessionId: string; reply: string }>((resolve) => {
        release = () => resolve({ sessionId: "s_x", reply: "迟到的回复" });
      });
    });

    const server = app.getHttpServer();
    const port = await listen(server);
    try {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/api/chat",
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      // 主动 destroy 会让客户端 socket 报 ECONNRESET——挂上 error 监听吃掉，
      // 否则 Vitest 把它当未处理异常（测试关心的是服务端看到的断开，不是客户端报错）
      req.on("error", () => {});
      req.end(JSON.stringify({ message: "你好" }));

      await waitFor(() => captured !== undefined); // 路由已进服务层
      expect(captured?.signal?.aborted).toBe(false); // 此时连接还在
      req.destroy(); // 对端消失（响应未写完——正是烧 token 的那个窗口）

      await waitFor(() => captured?.signal?.aborted === true); // close → abort 接线生效
      release?.();
    } finally {
      await closeServer(server);
    }
  });

  it("D2 GET /api/chat/stream：SSE 客户端中途断开 → 传给 chatStream() 的 signal 变为 aborted", async () => {
    let captured: { signal?: AbortSignal } | undefined;
    let release: (() => void) | undefined;
    chatServiceMock.chatStream.mockImplementation((_input, _emit, options) => {
      captured = options; // 模拟模型还在生成：SSE 已开流、事件未发完
      return new Promise<void>((resolve) => {
        release = () => resolve();
      });
    });

    const server = app.getHttpServer();
    const port = await listen(server);
    try {
      const req = http.get(
        `http://127.0.0.1:${port}/api/chat/stream?message=${encodeURIComponent("订单到哪了")}`,
      );
      req.on("error", () => {}); // 同 POST 用例：吃掉主动 destroy 引发的客户端 ECONNRESET

      await waitFor(() => captured !== undefined); // SSE 头已 flush、服务层挂起中
      expect(captured?.signal?.aborted).toBe(false);
      req.destroy(); // 浏览器关页面 / 用户点停止——对端消失

      await waitFor(() => captured?.signal?.aborted === true);
      release?.(); // 控制器随后 finally res.end()（已关 socket 上是安全 no-op）
    } finally {
      await closeServer(server);
    }
  });

  it("D2 GET /api/chat/stream：正常收尾（服务先完成）不触发 abort（writableEnded 防误伤）", async () => {
    let captured: { signal?: AbortSignal } | undefined;
    chatServiceMock.chatStream.mockImplementation((_input, emit, options) => {
      captured = options;
      emit({ type: "session", sessionId: "s_ok" });
      emit({ type: "done" });
      return Promise.resolve();
    });

    const res = await request(app.getHttpServer()).get(
      `/api/chat/stream?message=${encodeURIComponent("你好")}`,
    );

    expect(res.status).toBe(200);
    expect(res.text).toContain("session"); // 事件正常写出（宽松断言：JSON 帧包含 session 与 done）
    expect(res.text).toContain("done");
    expect(captured?.signal?.aborted).toBe(false); // 正常路径不能被误 abort
  });
});
