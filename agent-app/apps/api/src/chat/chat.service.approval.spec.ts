// chat.service.approval.spec.ts —— ChatService 审批链路单测（引擎模型调用全 mock，零网络）
// 引擎接缝与 chat.service.spec.ts 同款：runToolLoop / createModel / streamText 替换为 vi.fn，
// 会话存储用真品。runToolLoop 的 mock 会真实调用「服务层装配好的工具表」——
// 因此包壳、approval 事件、裁决回填、超时拒绝这些 API 层逻辑被真刀真枪地跑一遍。
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { createModel } from "@agent-app/engine/llm";
import { createDemoTools } from "@agent-app/engine/tools";
import { ConfigProvider } from "../common/config.provider.js";
import type { ChatStreamEvent } from "./chat.service.js";
import { ChatService } from "./chat.service.js";

// vi.mock 会被提升到文件顶部，工厂里引用的 mock 必须用 vi.hoisted 同步提升
const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("@agent-app/engine/agent-loop", () => ({ runToolLoop: vi.fn() }));
vi.mock("@agent-app/engine/llm", () => ({ createModel: vi.fn(() => ({ fake: "model" })) }));
// ai 包部分 mock：tool 等工具原语用真品（demo 工具表要在构造时真实生成），
// 只把 streamText 换成可控假流——最终答案的逐 token 输出来源
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

describe("ChatService 工具审批（week18 Day 6）", () => {
  let service: ChatService;

  beforeEach(async () => {
    // 显式控制审批开关（进程环境变量优先于 .env，测试不受 .env 内容影响）
    process.env.AGENT_CONFIRM_TOOLS = "createTicket";
    process.env.AGENT_CONFIRM_TIMEOUT_MS = "5000"; // 兜底大窗口：裁决由各用例自己驱动
    vi.mocked(runToolLoop).mockReset();
    vi.mocked(createModel).mockClear();
    streamTextMock.mockReset();
    streamTextMock.mockReturnValue({
      textStream: (async function* () {
        yield "好";
      })(),
    });

    const moduleRef = await Test.createTestingModule({
      providers: [ChatService, ConfigProvider],
    }).compile();
    service = moduleRef.get(ChatService);
  });

  afterEach(() => {
    delete process.env.AGENT_CONFIRM_TOOLS;
    delete process.env.AGENT_CONFIRM_TIMEOUT_MS;
  });

  /** 从工具表拿必带 execute 的工具（demo 工具全都有；拿不到说明装配坏了） */
  function mustExecute(tools: ToolSet, name: string) {
    const execute = tools[name]?.execute;
    if (execute === undefined) throw new Error(`unreachable：工具 ${name} 必有 execute`);
    return execute;
  }

  /** runToolLoop mock：真实执行工具表里的 createTicket（含审批壳），并把结果转成 step 事件 */
  function mockLoopExecutingCreateTicket(): void {
    vi.mocked(runToolLoop).mockImplementation(async (options) => {
      const input = { subject: "退款", description: "订单 A-1024 未送达" };
      const output = await mustExecute(options.tools, "createTicket")(input, {
        toolCallId: "call_test_1",
        messages: [],
      });
      options.onStep?.({ step: 1, toolCall: { toolName: "createTicket", input }, output });
      return { text: "已处理", messages: [], steps: 1 };
    });
  }

  it("chatStream 允许：session → approval → step → token → done，工具真实执行拿到工单号", async () => {
    mockLoopExecutingCreateTicket();

    const events: ChatStreamEvent[] = [];
    await service.chatStream({ message: "帮我建退款工单" }, (event) => {
      events.push(event);
      if (event.type === "approval") {
        // 模拟用户点「允许」：真实世界由 POST /api/chat/approve 触发，同一时刻流仍挂着
        service.approve({ sessionId: event.sessionId, approvalId: event.approvalId, approved: true });
      }
    });

    expect(events.map((e) => e.type)).toEqual(["session", "approval", "step", "token", "done"]);
    const approval = events[1];
    if (approval.type !== "approval") throw new Error("unreachable：第二事件必须是 approval");
    expect(approval.toolName).toBe("createTicket");
    expect(approval.sessionId).toMatch(/^s_/);
    expect(approval.input).toEqual({ subject: "退款", description: "订单 A-1024 未送达" });
    // 允许 → 原工具透传：step 的 output 是真实建单结果
    const step = events[2];
    if (step.type !== "step") throw new Error("unreachable：第三事件必须是 step");
    expect(step.output).toMatchObject({ subject: "退款", status: "已创建" });
  });

  it("chatStream 拒绝：step 的 output 是结构化拒绝值（模型可见可礼貌收尾）", async () => {
    mockLoopExecutingCreateTicket();

    const events: ChatStreamEvent[] = [];
    await service.chatStream({ message: "帮我建退款工单" }, (event) => {
      events.push(event);
      if (event.type === "approval") {
        service.approve({ sessionId: event.sessionId, approvalId: event.approvalId, approved: false });
      }
    });

    expect(events.map((e) => e.type)).toEqual(["session", "approval", "step", "token", "done"]);
    const step = events[2];
    if (step.type !== "step") throw new Error("unreachable");
    expect(step.output).toEqual({ denied: true, reason: "用户拒绝执行该工具" });
  });

  it("chatStream 超时自动拒绝（AGENT_CONFIRM_TIMEOUT_MS=50）：不裁决 → 拒绝值落定，事后裁决返回 false", async () => {
    process.env.AGENT_CONFIRM_TIMEOUT_MS = "50"; // 覆盖 beforeEach 的大窗口
    mockLoopExecutingCreateTicket();

    const events: ChatStreamEvent[] = [];
    await service.chatStream({ message: "帮我建退款工单" }, (event) => events.push(event));
    // 不回填裁决：50ms 超时自动拒绝，流继续走完（不会挂死连接）

    expect(events.map((e) => e.type)).toEqual(["session", "approval", "step", "token", "done"]);
    const step = events[2];
    if (step.type !== "step") throw new Error("unreachable");
    expect(step.output).toEqual({ denied: true, reason: "用户拒绝执行该工具" });

    // pending 条目已随超时清理：迟到的裁决按未知处理（控制器转 404）
    const approval = events[1];
    if (approval.type !== "approval") throw new Error("unreachable");
    expect(
      service.approve({ sessionId: approval.sessionId, approvalId: approval.approvalId, approved: true }),
    ).toBe(false);
  });

  it("AGENT_CONFIRM_TOOLS 置空 → 不包壳：runToolLoop 收到的就是原工具表（toBe 同一引用），事件流无 approval", async () => {
    process.env.AGENT_CONFIRM_TOOLS = "";
    const demoTools = createDemoTools();
    vi.mocked(runToolLoop).mockImplementation(async (options) => {
      options.onStep?.({
        step: 1,
        toolCall: { toolName: "getOrderStatus", input: { orderId: "A-1024" } },
        output: { orderId: "A-1024", status: "已发货", eta: "明天 18 点前送达" },
      });
      return { text: "已发货", messages: [], steps: 1 };
    });

    const events: ChatStreamEvent[] = [];
    await service.chatStream({ message: "订单到哪了" }, (event) => events.push(event));

    // 工具表原对象直传：与 demo 工具表逐工具同一引用（零包壳 = 与改造前完全一致）
    const options = vi.mocked(runToolLoop).mock.calls[0][0];
    expect(options.tools.createTicket).toBe(demoTools.createTicket);
    expect(options.tools.getOrderStatus).toBe(demoTools.getOrderStatus);
    expect(options.tools.escalateToHuman).toBe(demoTools.escalateToHuman);
    // 事件序列与改造前逐字节一致：没有 approval
    expect(events.map((e) => e.type)).toEqual(["session", "step", "token", "done"]);
  });

  it("名单外的工具不包壳（默认 createTicket 名单）：getOrderStatus 直传 + 立即执行无 approval 事件", async () => {
    const demoTools = createDemoTools();
    vi.mocked(runToolLoop).mockImplementation(async (options) => {
      const output = await mustExecute(options.tools, "getOrderStatus")({ orderId: "A-1024" }, {
        toolCallId: "call_test_2",
        messages: [],
      });
      options.onStep?.({
        step: 1,
        toolCall: { toolName: "getOrderStatus", input: { orderId: "A-1024" } },
        output,
      });
      return { text: "已发货", messages: [], steps: 1 };
    });

    const events: ChatStreamEvent[] = [];
    await service.chatStream({ message: "订单到哪了" }, (event) => events.push(event));

    const options = vi.mocked(runToolLoop).mock.calls[0][0];
    // 名单外：原对象直传（绝不包壳）
    expect(options.tools.getOrderStatus).toBe(demoTools.getOrderStatus);
    // 名单内：包了壳（不同引用），但对模型可见的描述不变
    expect(options.tools.createTicket).not.toBe(demoTools.createTicket);
    expect(options.tools.createTicket.description).toBe(demoTools.createTicket.description);
    // 查订单不在名单：执行不经审批，事件流无 approval
    expect(events.map((e) => e.type)).toEqual(["session", "step", "token", "done"]);
    const step = events[1];
    if (step.type !== "step") throw new Error("unreachable");
    expect(step.output).toEqual({ orderId: "A-1024", status: "已发货", eta: "明天 18 点前送达" });
  });

  it("AGENT_CONFIRM_TOOLS 未配置 → 默认名单 createTicket 生效（开箱即用）", async () => {
    delete process.env.AGENT_CONFIRM_TOOLS; // 撤掉 beforeEach 的显式值，测默认路径
    const demoTools = createDemoTools();
    vi.mocked(runToolLoop).mockImplementation(async (options) => {
      options.onStep?.({
        step: 1,
        toolCall: { toolName: "getOrderStatus", input: { orderId: "A-1024" } },
        output: "ok",
      });
      return { text: "ok", messages: [], steps: 1 };
    });

    await service.chatStream({ message: "查订单" }, () => {});

    const options = vi.mocked(runToolLoop).mock.calls[0][0];
    expect(options.tools.createTicket).not.toBe(demoTools.createTicket); // 默认名单把它包了
    expect(options.tools.getOrderStatus).toBe(demoTools.getOrderStatus);
  });

  it("H5（红队加固轮）：非流式 chat() 在审批名单非空时直接拒收（E6 备注的「无闸裸奔」收口）", async () => {
    vi.mocked(runToolLoop).mockResolvedValue({ text: "ok", messages: [], steps: 1 });

    await expect(service.chat({ message: "帮我建工单" })).rejects.toThrow("该端点不支持工具审批");
    expect(runToolLoop).not.toHaveBeenCalled(); // 不再是「不包壳地裸奔执行」，而是明确拒收
  });

  it("非流式 chat() 名单置空 → 不包壳：runToolLoop 收到的就是原工具表（toBe 同一引用）", async () => {
    process.env.AGENT_CONFIRM_TOOLS = "";
    const demoTools = createDemoTools();
    vi.mocked(runToolLoop).mockResolvedValue({ text: "ok", messages: [], steps: 1 });

    await service.chat({ message: "帮我建工单" });

    const options = vi.mocked(runToolLoop).mock.calls[0][0];
    expect(options.tools.createTicket).toBe(demoTools.createTicket);
  });

  it("approve：sessionId 不匹配 → false（跨会话裁决不误唤醒）", async () => {
    mockLoopExecutingCreateTicket();

    const events: ChatStreamEvent[] = [];
    const streamDone = service.chatStream({ message: "帮我建退款工单" }, (event) => {
      events.push(event);
      if (event.type === "approval") {
        // 先拿错会话试一次（应失败），再用正确会话允许（应成功）
        const wrongSession = service.approve({
          sessionId: "s_别的会话",
          approvalId: event.approvalId,
          approved: true,
        });
        if (!wrongSession) {
          service.approve({ sessionId: event.sessionId, approvalId: event.approvalId, approved: true });
        }
      }
    });
    await streamDone;

    const step = events[2];
    if (step.type !== "step") throw new Error("unreachable");
    expect(step.output).toMatchObject({ status: "已创建" }); // 错会话被拒后，正确裁决仍生效
  });
});
