// datasource.e2e-spec.ts —— 外部数据源工具合并的 API 层 e2e（provider plugin 的消费端）：
// 真实 AppModule + 真实 HTTP 栈，@agent-app/engine/datasource 桶路径整体 vi.mock——
// resolveDataSourceTools 回放一个假 ops 工具，runToolLoop 换成「真实执行服务层
// 装配的工具表」的假实现（与 approval.e2e-spec 同款 mock 接缝），断言：
// 带 X-Ops-Token 头 → 工具表含 ops_*（step 事件可见其真实执行）；
// 不带头 → 解析函数压根没被调用（零行为变化）。
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "ai";
import type { RunToolLoopOptions } from "@agent-app/engine/agent-loop";
import type { ChatStreamEvent } from "@agent-app/shared";
import { AppModule } from "../src/app.module.js";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter.js";

const { resolveToolsMock, registerBuiltInMock, streamTextMock, runToolLoopMock } = vi.hoisted(() => ({
  resolveToolsMock: vi.fn(),
  registerBuiltInMock: vi.fn(),
  streamTextMock: vi.fn(),
  runToolLoopMock: vi.fn(),
}));

// 数据源桶整体 mock：服务层只认识 registerBuiltInDataSources / resolveDataSourceTools
// 两个函数，mock 之后「OPS_BASE_URL 是否配置」的分支被折算成 resolveToolsMock 的回放值
vi.mock("@agent-app/engine/datasource", () => ({
  registerBuiltInDataSources: registerBuiltInMock,
  resolveDataSourceTools: resolveToolsMock,
}));
vi.mock("@agent-app/engine/llm", () => ({ createModel: vi.fn(() => ({ fake: "model" })) }));
// runToolLoop 假实现：真实执行 ChatService 装配好的工具表（含外部合并进来的 ops 工具），
// 并把本轮拿到的工具表快照存起来供断言
vi.mock("@agent-app/engine/agent-loop", () => ({
  runToolLoop: runToolLoopMock,
}));
// ai 包部分 mock：tool 原语用真品（假 ops 工具要用）；streamText 假流逐 token 出答案；
// generateText 屏蔽——任何意外的真实模型调用当场失败（零网络铁律）
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(() => Promise.reject(new Error("测试环境禁止网络：generateText 已屏蔽"))),
    streamText: streamTextMock,
  };
});

/** 假 ops 工具（名字与线上一致，execute 返回固定形状——断言对象）。
 *  inputSchema 用 ai 的 jsonSchema 原语（api 包不直接依赖 zod，与 mcp/adapter 同款做法） */
function fakeOpsTools() {
  return [
    {
      name: "ops_tenant_top",
      tool: tool({
        description: "查询商家流水 Top10 排行（假）",
        inputSchema: jsonSchema<{ }>({ type: "object", properties: {}, additionalProperties: false }),
        execute: async () => ({ rows: 10, source: "fake-ops" }),
      }),
    },
  ];
}

/** SSE 单帧 → data: 行 JSON（与 web 端手解析逐行对应） */
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

describe("外部数据源工具合并 e2e（X-Ops-Token → ops_* 进工具表）", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    // 非流式端点用例需要审批名单显式置空（默认 createTicket 非空会让 POST /api/chat 直接 400）
    process.env.AGENT_CONFIRM_TOOLS = "";
    resolveToolsMock.mockImplementation(fakeOpsTools);
    runToolLoopMock.mockImplementation(async (options: RunToolLoopOptions) => {
      const execute = options.tools.ops_tenant_top?.execute;
      if (execute !== undefined) {
        // 真实执行合并进来的外部工具，让 step 事件携带其输出（证明不只是「在表里」）
        const output = await execute({}, { toolCallId: "call_ds_1", messages: [] });
        options.onStep?.({ step: 1, toolCall: { toolName: "ops_tenant_top", input: {} }, output });
      }
      return { text: "已处理", messages: [], steps: 1 };
    });
    streamTextMock.mockReturnValue({
      textStream: (async function* () {
        yield "已";
        yield "处理";
      })(),
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (address === null || typeof address === "string") {
      throw new Error("unreachable：listen(0) 应返回 AddressInfo");
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    delete process.env.AGENT_CONFIRM_TOOLS;
    await app.close();
  });

  it("流式端点带头：runToolLoop 的工具表含本地工具 + ops_tenant_top，step 事件带外部工具输出", async () => {
    registerBuiltInMock.mockClear();
    resolveToolsMock.mockClear();
    runToolLoopMock.mockClear();

    const res = await fetch(`${base}/api/chat/stream?message=${encodeURIComponent("查一下商家流水 Top10")}`, {
      headers: { "X-Ops-Token": "tok-e2e" },
    });
    expect(res.status).toBe(200);

    const body = await res.text();
    const events = body.split("\n\n").flatMap(parseFrame);
    expect(events.map((e) => e.type)).toEqual(["session", "step", "token", "token", "done"]);

    const step = events.find((e) => e.type === "step");
    if (step === undefined || step.type !== "step") throw new Error("unreachable：应有 step 事件");
    expect(step.toolCall.toolName).toBe("ops_tenant_top");
    expect(step.output).toEqual({ rows: 10, source: "fake-ops" });

    // 消费端接缝：登记函数被调、解析函数收到的 token 正是请求头里的值
    expect(registerBuiltInMock).toHaveBeenCalledTimes(1);
    expect(resolveToolsMock).toHaveBeenCalledWith({ token: "tok-e2e" });

    // 工具表快照：本地 demo 工具与外部工具并存（合并而非替换）
    const toolsTable = runToolLoopMock.mock.calls[0][0].tools as Record<string, unknown>;
    expect(Object.keys(toolsTable)).toEqual(
      expect.arrayContaining(["getOrderStatus", "createTicket", "escalateToHuman", "ops_tenant_top"]),
    );
  });

  it("流式端点不带头：resolveDataSourceTools 根本不被调用（零行为变化）", async () => {
    registerBuiltInMock.mockClear();
    resolveToolsMock.mockClear();

    const res = await fetch(`${base}/api/chat/stream?message=${encodeURIComponent("订单A-1024到哪了")}`);
    expect(res.status).toBe(200);
    await res.text();

    expect(resolveToolsMock).not.toHaveBeenCalled();
    expect(registerBuiltInMock).not.toHaveBeenCalled();
  });

  it("非流式端点带头：合并同样生效（POST /api/chat 的工具表含 ops_tenant_top）", async () => {
    runToolLoopMock.mockClear();

    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ops-Token": "tok-e2e-post" },
      body: JSON.stringify({ message: "查一下商家流水 Top10" }),
    });
    expect(res.status).toBe(201);

    const toolsTable = runToolLoopMock.mock.calls[0][0].tools as Record<string, unknown>;
    expect("ops_tenant_top" in toolsTable).toBe(true);
    expect("getOrderStatus" in toolsTable).toBe(true);
  });
});
