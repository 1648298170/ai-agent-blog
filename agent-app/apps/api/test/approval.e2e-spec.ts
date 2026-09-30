// approval.e2e-spec.ts —— 工具审批全链路 e2e（week18 Day 6）：真实 AppModule + 真实 HTTP 栈
// 零网络铁律：与 app.e2e-spec.ts 同款模块级 mock——generateText 一律抛错（网络调用必失败）、
// runToolLoop 换成会「真实执行服务层装配的工具表」的假实现（审批壳被真刀真枪地跑）、
// streamText 换成假流。app.listen(0) 随机端口 + 原生 fetch：
// SSE 流读到 approval 事件 → POST /api/chat/approve 裁决 → 流继续走完，断言全程事件契约。
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunToolLoopOptions } from "@agent-app/engine/agent-loop";
import type { ChatStreamEvent } from "@agent-app/shared";
import { AppModule } from "../src/app.module.js";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("@agent-app/engine/llm", () => ({ createModel: vi.fn(() => ({ fake: "model" })) }));
// runToolLoop 假实现：真实执行 ChatService 装配好的工具表（含审批壳），
// 让 approval 事件 → 挂起 → 裁决回填这条 API 层链路在 e2e 里完整发生
vi.mock("@agent-app/engine/agent-loop", () => ({
  runToolLoop: vi.fn(async (options: RunToolLoopOptions) => {
    const input = { subject: "退款", description: "订单 A-1024 一直未送达" };
    const execute = options.tools.createTicket.execute;
    if (execute === undefined) throw new Error("unreachable：demo 工具必有 execute");
    const output = await execute(input, { toolCallId: "call_e2e_1", messages: [] });
    options.onStep?.({ step: 1, toolCall: { toolName: "createTicket", input }, output });
    return { text: "已处理", messages: [], steps: 1 };
  }),
}));
// ai 包部分 mock：tool 原语用真品；streamText 假流逐 token 出答案；
// generateText 屏蔽——任何意外的真实模型调用当场失败（零网络铁律）
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(() => Promise.reject(new Error("测试环境禁止网络：generateText 已屏蔽"))),
    streamText: streamTextMock,
  };
});

/** 单帧 → 逐行取 data: 前缀 → JSON.parse（与 apps/web/lib/api.ts 的手解析逐行对应） */
function parseFrame(frame: string): ChatStreamEvent[] {
  const events: ChatStreamEvent[] = [];
  for (const line of frame.split("\n")) {
    const normalized = line.replace(/\r$/, "");
    if (!normalized.startsWith("data:")) continue;
    const payload = normalized.slice("data:".length).trim();
    if (payload === "") continue;
    events.push(JSON.parse(payload) as ChatStreamEvent);
  }
  return events;
}

/** SSE 增量读取器：跨 read 复用同一个 TextDecoder（多字节字符不被块边界切断），
 *  事件累计在 events 里；readUntil 停在条件满足或流结束。 */
function createSseReader(res: Response): {
  events: ChatStreamEvent[];
  readUntil(stop: (events: ChatStreamEvent[]) => boolean): Promise<void>;
} {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("响应没有可读流");
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const events: ChatStreamEvent[] = [];
  return {
    events,
    async readUntil(stop) {
      while (!stop(events)) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          for (const event of parseFrame(buffer.slice(0, sep))) events.push(event);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");
        }
      }
    },
  };
}

describe("工具审批 e2e（POST /api/chat/approve + SSE approval 事件）", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    // 显式控制审批开关（进程环境变量优先于 .env）：名单固定 createTicket，超时留足余量
    process.env.AGENT_CONFIRM_TOOLS = "createTicket";
    process.env.AGENT_CONFIRM_TIMEOUT_MS = "10000";
    streamTextMock.mockReturnValue({
      textStream: (async function* () {
        yield "已";
        yield "处理";
      })(),
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    // 与 main.ts 完全一致的全局管道/过滤器：e2e 测的就是线上装配
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0); // 随机端口：SSE + 裁决 POST 走真实 HTTP 栈
    const address = app.getHttpServer().address();
    if (address === null || typeof address === "string") {
      throw new Error("unreachable：listen(0) 应返回 AddressInfo");
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    delete process.env.AGENT_CONFIRM_TOOLS;
    delete process.env.AGENT_CONFIRM_TIMEOUT_MS;
    await app.close();
  });

  async function postApprove(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${base}/api/chat/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("拒绝全链路：SSE approval 事件 → POST approve(false) → step 收到结构化拒绝值", async () => {
    const res = await fetch(`${base}/api/chat/stream?message=${encodeURIComponent("帮我建退款工单")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = createSseReader(res);
    await reader.readUntil((events) => events.some((e) => e.type === "approval"));
    const approval = reader.events.find((e) => e.type === "approval");
    if (approval === undefined || approval.type !== "approval") {
      throw new Error("unreachable：应先读到 approval 事件");
    }
    expect(approval.toolName).toBe("createTicket");
    expect(approval.sessionId).toMatch(/^s_/);
    expect(approval.input).toEqual({ subject: "退款", description: "订单 A-1024 一直未送达" });

    // 用户点「拒绝」：裁决 POST 走真实 HTTP，服务端唤醒挂起的工具调用
    const approveRes = await postApprove({
      sessionId: approval.sessionId,
      approvalId: approval.approvalId,
      approved: false,
    });
    expect(approveRes.status).toBe(201);
    expect(await approveRes.json()).toEqual({ approvalId: approval.approvalId, approved: false });

    // 流继续走完：session → approval → step（拒绝值）→ token → done
    await reader.readUntil((events) => events.some((e) => e.type === "done"));
    expect(reader.events.map((e) => e.type)).toEqual([
      "session",
      "approval",
      "step",
      "token",
      "token",
      "done",
    ]);
    const step = reader.events.find((e) => e.type === "step");
    if (step === undefined || step.type !== "step") throw new Error("unreachable：应有 step 事件");
    expect(step.output).toEqual({ denied: true, reason: "用户拒绝执行该工具" });
  });

  it("允许全链路：POST approve(true) → 工具真实执行，step 的 output 是建单结果", async () => {
    const res = await fetch(`${base}/api/chat/stream?message=${encodeURIComponent("帮我建退款工单")}`);
    const reader = createSseReader(res);
    await reader.readUntil((events) => events.some((e) => e.type === "approval"));
    const approval = reader.events.find((e) => e.type === "approval");
    if (approval === undefined || approval.type !== "approval") {
      throw new Error("unreachable：应先读到 approval 事件");
    }

    const approveRes = await postApprove({
      sessionId: approval.sessionId,
      approvalId: approval.approvalId,
      approved: true,
    });
    expect(approveRes.status).toBe(201);
    expect(await approveRes.json()).toEqual({ approvalId: approval.approvalId, approved: true });

    await reader.readUntil((events) => events.some((e) => e.type === "done"));
    const step = reader.events.find((e) => e.type === "step");
    if (step === undefined || step.type !== "step") throw new Error("unreachable：应有 step 事件");
    expect(step.output).toMatchObject({ subject: "退款", status: "已创建" });
  });

  it("未知 approvalId → 404 + 中文错误体（全链路真实装配：DTO 校验 + 过滤器放行 HttpException）", async () => {
    const res = await postApprove({
      sessionId: "s_nope",
      approvalId: "00000000-0000-4000-8000-000000000000",
      approved: true,
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { statusCode: number; message: string };
    expect(body.statusCode).toBe(404);
    expect(body.message).toContain("不存在或已过期");
  });

  it("缺 approved → 400（ValidationPipe 拦截，未触达审批登记簿）", async () => {
    const res = await postApprove({ sessionId: "s_x", approvalId: "ap-x" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { statusCode: number; message: unknown };
    expect(body.statusCode).toBe(400);
    expect(JSON.stringify(body.message)).toContain("approved");
  });
});
