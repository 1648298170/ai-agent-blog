// service.stream.spec.ts —— GET /api/service/stream 流式端点单测（引擎模型调用全 mock，零网络）
// 接缝复刻 chat.service.spec：runToolLoop（工人循环，经真实 runWorkerStreaming 走到）、
// createModel/getModel（模型工厂）、streamText（最终答案流）替换为 vi.fn；
// supervisor 的 LLM 三分类走 generateText mock 返回硬约定 JSON——硬规则（转人工）是
// 纯函数路径，离线真实跑通；HandoffPack 的用户摘要让 generateText 抛错，触发降级拼接
// （buildHandoffPack 自带 catch），工单本身是 mock 工具，转人工全程无网可用。
// 断言口径：ServiceStreamEvent 事件序列（@agent-app/shared 契约）+ 会话回写（历史端点验证）。
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { createModel, getModel } from "@agent-app/engine/llm";
import type { ServiceStreamEvent } from "@agent-app/shared";
import { ServiceController } from "./service.controller.js";

// vi.mock 会被提升到文件顶部，工厂里引用的 mock 必须用 vi.hoisted 同步提升
const { streamTextMock, generateTextMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
  generateTextMock: vi.fn(),
}));

vi.mock("@agent-app/engine/agent-loop", () => ({ DEFAULT_MAX_STEPS: 5, runToolLoop: vi.fn() }));
vi.mock("@agent-app/engine/llm", () => ({
  createModel: vi.fn(() => ({ fake: "model" })),
  getModel: vi.fn(() => ({ fake: "model" })),
}));
// ai 包部分 mock：tool 等工具原语用真品（demo 工具表 / createTicket 工单要真实生成），
// 只换 streamText（最终答案流）与 generateText（LLM 三分类 / 摘要）
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock, generateText: generateTextMock };
});

/** supertest 拿到的是整段 SSE 文本：按空行切帧、取 data: 行 JSON（与前端解析同规则） */
function parseSse(raw: string): ServiceStreamEvent[] {
  const events: ServiceStreamEvent[] = [];
  for (const frame of raw.split("\n\n")) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (payload !== "") events.push(JSON.parse(payload) as ServiceStreamEvent);
    }
  }
  return events;
}

describe("ServiceController GET /api/service/stream（SSE 流式客服）", () => {
  let app: INestApplication;
  /** LLM 三分类的行为开关：默认返回 order 的硬约定 JSON，个别用例改为抛错（降级路径） */
  let classifyBehavior: () => { text: string };
  /** 分类调用计数：硬规则路径必须零调用（判定归代码管，不归模型管） */
  let classifyCalls: number;

  beforeEach(async () => {
    vi.mocked(runToolLoop).mockReset();
    vi.mocked(createModel).mockClear();
    vi.mocked(getModel).mockClear();
    streamTextMock.mockReset();
    generateTextMock.mockReset();
    classifyCalls = 0;
    classifyBehavior = () => ({ text: '{"route":"order","reason":"用户在查询订单物流状态"}' });

    // generateText 双职责按 system 提示词分派：路由员 → 三分类 JSON；
    // 摘要员 → 抛错触发 fallbackSummary 降级（工单照出、摘要变原文拼接）
    generateTextMock.mockImplementation(async (options: { system?: string }) => {
      const system = options.system ?? "";
      if (system.includes("路由员")) {
        classifyCalls += 1;
        return classifyBehavior();
      }
      if (system.includes("摘要员")) {
        throw new Error("模型不可用（单测模拟：触发摘要降级）");
      }
      return { text: "" };
    });

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

  it("LLM 路由：session → route(order) → step → token* → done，答案来自 streamText，assistant 回写会话", async () => {
    // 工人循环（真实 runWorkerStreaming 内部调 runToolLoop）：先外发一个工具步，再交回消息历史
    vi.mocked(runToolLoop).mockImplementation(async (options) => {
      options.onStep?.({
        step: 1,
        toolCall: { toolName: "getOrderStatus", input: { orderId: "A-1024" } },
        output: { status: "已发货" },
        text: "我先查一下订单状态。",
      });
      return {
        text: "最终回答（被忽略，改走 streamText）",
        messages: [...options.messages, { role: "assistant", content: "（工具往返）" }],
        steps: 1,
      };
    });
    streamTextMock.mockReturnValue({
      textStream: (async function* () {
        yield "已";
        yield "发货";
        yield "。";
      })(),
    });

    const res = await request(app.getHttpServer())
      .get("/api/service/stream")
      .query({ message: "订单 A-1024 到哪了" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    // 事件契约：session → route → step → token×3 → done
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "route",
      "step",
      "token",
      "token",
      "token",
      "done",
    ]);

    const session = events[0];
    if (session.type !== "session") throw new Error("unreachable：首事件必须是 session");
    expect(session.sessionId).toMatch(/^cs_/); // 客服线会话前缀

    const route = events[1];
    if (route.type !== "route") throw new Error("unreachable：第二事件必须是 route");
    expect(route.route).toBe("order");
    expect(route.reason).toBe("用户在查询订单物流状态");

    const step = events[2];
    if (step.type !== "step") throw new Error("unreachable：第三事件必须是 step");
    expect(step.toolCall.toolName).toBe("getOrderStatus");
    expect(step.toolCall.input).toEqual({ orderId: "A-1024" });
    expect(step.text).toBe("我先查一下订单状态。"); // Thought 管道：步间文本透传到 SSE

    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.map((t) => (t.type === "token" ? t.text : ""))).toEqual(["已", "发货", "。"]);

    // 工人循环拿到的是 order 职责提示词（真实 runWorkerStreaming → WORKER_PROMPTS.order）
    expect(runToolLoop).toHaveBeenCalledOnce();
    const loopOptions = vi.mocked(runToolLoop).mock.calls[0][0];
    expect(loopOptions.system).toContain("订单客服");
    expect(loopOptions.onStep).toBeTypeOf("function");
    // 最终答案：工人提示词 + 循环后的消息历史（与 chat 线 streamText 收尾同形态）
    expect(streamTextMock).toHaveBeenCalledOnce();
    const streamOptions = streamTextMock.mock.calls[0][0];
    expect(streamOptions.system).toContain("订单客服");
    expect(streamOptions.messages).toEqual([
      { role: "user", content: "订单 A-1024 到哪了" },
      { role: "assistant", content: "（工具往返）" },
    ]);

    // 会话回写镜像 POST /message：user 轮 + assistant 轮（token 拼接的最终答案）
    const history = await request(app.getHttpServer()).get(
      `/api/service/sessions/${session.sessionId}`,
    );
    const turns = history.body.turns as Array<{ role: string; content: string }>;
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1].content).toBe("已发货。");
  });

  it("硬规则转人工：session → route(human) → handoff → token* → done，零 LLM 分类调用", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/service/stream")
      .query({ message: "转人工" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const types = events.map((e) => e.type);
    // 硬规则命中：没有 step（不跑工人）、没有第二次 route（route 只发一次）
    expect(types[0]).toBe("session");
    expect(types.filter((t) => t === "route")).toEqual(["route"]);
    expect(types.indexOf("handoff")).toBe(2); // session → route → handoff → token* → done
    expect(types[types.length - 1]).toBe("done");

    const route = events[1];
    if (route.type !== "route") throw new Error("unreachable：第二事件必须是 route");
    expect(route.route).toBe("human");
    expect(route.reason).toContain("用户明确要求转人工");

    const handoff = events.find((e) => e.type === "handoff");
    if (handoff === undefined || handoff.type !== "handoff") throw new Error("unreachable：必须有 handoff 事件");
    expect(handoff.handoff.ticketId).not.toBe(""); // mock 工单真实产出
    expect(handoff.handoff.reason).toContain("用户明确要求转人工");
    expect(handoff.handoff.recentTranscript).toContain("转人工"); // 文稿里有本轮用户消息

    // 告知文本按定宽切片成 token，拼回去是完整的转人工回执
    const tokens = events.filter((e) => e.type === "token");
    const reply = tokens.map((t) => (t.type === "token" ? t.text : "")).join("");
    expect(reply).toContain("已为您转接人工客服");
    expect(reply).toContain(handoff.handoff.ticketId);

    // 硬规则优先的宪法：分类零调用（判定归代码管），工人循环零调用
    expect(classifyCalls).toBe(0);
    expect(runToolLoop).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it("工人失败降级：session → route(order) → route(human) → handoff → token* → done（徽标以最后一次为准）", async () => {
    vi.mocked(runToolLoop).mockRejectedValue(new Error("模型网关不可达"));

    const res = await request(app.getHttpServer())
      .get("/api/service/stream")
      .query({ message: "订单 B-2048 到哪了" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const routes = events.filter((e) => e.type === "route");
    // 降级路径 route 连发两次：先业务路由、再 human 降级——前端以最后一次为准
    expect(routes).toHaveLength(2);
    if (routes[0].type !== "route" || routes[1].type !== "route") throw new Error("unreachable");
    expect(routes[0].route).toBe("order");
    expect(routes[1].route).toBe("human");
    expect(routes[1].reason).toContain("处理失败");
    // 完整序列：session → route → route → handoff → token* → done
    expect(events[0].type).toBe("session");
    expect(events[3].type).toBe("handoff");
    expect(events[events.length - 1].type).toBe("done");
    // 降级后用户拿到的仍是业务动作（工单回执），不是报错
    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.map((t) => (t.type === "token" ? t.text : "")).join("")).toContain("已为您转接人工客服");
  });

  it("模型路由不可用降级：session → route(human) → handoff → token* → done（用户侧不暴露报错）", async () => {
    classifyBehavior = () => {
      throw new Error("模型网关不可达");
    };

    const res = await request(app.getHttpServer())
      .get("/api/service/stream")
      .query({ message: "退款怎么申请" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const routes = events.filter((e) => e.type === "route");
    expect(routes).toHaveLength(1);
    if (routes[0].type !== "route") throw new Error("unreachable");
    expect(routes[0].route).toBe("human");
    expect(routes[0].reason).toContain("模型路由不可用");
    expect(events.some((e) => e.type === "handoff")).toBe(true);
    expect(events[events.length - 1].type).toBe("done");
    expect(events.some((e) => e.type === "error")).toBe(false); // 降级不是错误事件
  });

  it("超长 message → 400 中文错误（长度闸在 SSE 头之前，还能给 4xx）", async () => {
    // 用 ASCII 超长而不是中文：中文 GET 查询参数 URL 编码后每字 9 字节，8001 字会先撞
    // Node 的 HTTP 头上限（约 16KB）直接断连；路由内的 400 只对「超过 8000 但 URL 还
    // 装得下」的区间可达（chat.controller.spec H3 同款注记）
    const long = encodeURIComponent("a".repeat(8001));
    const res = await request(app.getHttpServer()).get(`/api/service/stream?message=${long}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("消息过长");
    expect(res.body.message).toContain("8000");
  });

  it("缺 message → SSE error 事件（头已 flush，只能 200 + error 收场）", async () => {
    const res = await request(app.getHttpServer()).get("/api/service/stream");

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    if (events[0].type !== "error") throw new Error("unreachable");
    expect(events[0].message).toContain("缺少必填查询参数 message");
  });
});
