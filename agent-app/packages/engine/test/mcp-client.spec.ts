// mcp-client.spec.ts —— MCP 客户端桥 + 适配器的行为测试（离线、零网络、零基础设施门控）
//
// 覆盖四个面（与 mcp-server.spec.ts 同款 InMemoryTransport 往返，方向反过来——
// P1 测「我们的服务器说得对不对」，这里测「我们把外部服务器接得对不对」）：
//   1. 桥装配：我方服务器三工具全部适配成 AgentTool（描述 / schema / execute 三件套在场）
//   2. 适配执行：适配后的 getOrderStatus 直接调用 → 结构化结果（structuredContent 通道端到端）
//   3. 循环不可区分（头号断言）：剧本模型对 MCP 适配工具发起调用，runToolLoop 零改造地
//      调度回灌——循环感知不到这个工具来自 MCP，这正是 P2 的设计承诺
//   4. 错误映射：isError → 中文异常（注入手写客户端桩，不需要任何传输层）
//
// 存储说明：本套件只碰 demo 工具（getOrderStatus / createTicket），不触发
// searchKnowledge 执行与资源读取，因此无需种子库——server.ts 的惰性装配不会启动。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runToolLoop } from "../src/agent-loop.js";
import type { ToolLoopStepEvent } from "../src/agent-loop.js";
import { createScriptedModel } from "../src/evals/fixtures.js";
import { createInMemoryMcpClientBridge } from "../src/mcp/client.js";
import type { McpClientBridge } from "../src/mcp/client.js";
import { mcpToolToAgentTool } from "../src/mcp/adapter.js";
import type { McpToolCaller } from "../src/mcp/adapter.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** unknown → Record 的运行时收窄（同 mcp-server.spec.ts 的 isRecord 约定，不用 as 断言） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let server: McpServer;
let bridge: McpClientBridge;

beforeAll(async () => {
  // 协议对：server 先 connect（P1 实证），client 后 connect——createInMemoryMcpClientBridge
  // 内部已按此顺序装配，这里只负责起一套桥供全部用例复用
  server = createMcpServer();
  bridge = await createInMemoryMcpClientBridge(server);
});

afterAll(async () => {
  // 桥的 close 收两端（client + server），见 client.ts 文件头说明
  await bridge.close();
});

describe("桥装配 createInMemoryMcpClientBridge", () => {
  it("三个引擎工具全部适配成 AgentTool（描述非空、inputSchema 在场、execute 可调用）", () => {
    const names = Object.keys(bridge.tools);
    expect(names).toHaveLength(3);
    expect(names).toContain("getOrderStatus");
    expect(names).toContain("createTicket");
    expect(names).toContain("searchKnowledge");
    for (const name of names) {
      const adapted = bridge.tools[name];
      if (adapted === undefined) throw new Error(`工具 ${name} 缺席`);
      expect(adapted.description, `工具 ${name} 的 description 不应为空`).toBeTruthy();
      expect(adapted.inputSchema, `工具 ${name} 的 inputSchema 应在场`).toBeDefined();
      expect(typeof adapted.execute, `工具 ${name} 的 execute 应可调用`).toBe("function");
    }
  });

  it("适配不挑食：inputSchema 携带服务器声明的 JSON Schema 原样透传（照单全收，不引 zod 重写）", () => {
    const adapted = bridge.tools.getOrderStatus;
    if (adapted === undefined) throw new Error("getOrderStatus 缺席");
    // jsonSchema() 的包装对象带 jsonSchema 字段——里面就是服务器声明的参数图纸
    if (!isRecord(adapted.inputSchema)) throw new Error("inputSchema 应是 jsonSchema 包装对象");
    const declared: unknown = adapted.inputSchema.jsonSchema;
    if (!isRecord(declared)) throw new Error("包装内应携带服务器声明的 JSON Schema");
    expect(declared.type).toBe("object");
  });

  it("close 幂等：连关两次不炸（REPL 退出路径与异常路径可能各关一次）", async () => {
    const extraServer = createMcpServer();
    const extraBridge = await createInMemoryMcpClientBridge(extraServer);
    expect(Object.keys(extraBridge.tools)).toContain("getOrderStatus");
    await extraBridge.close();
    await extraBridge.close();
  });
});

describe("适配执行（InMemory 协议往返，零网络）", () => {
  it("适配后的 getOrderStatus 直接 execute → structuredContent 通道的结构化订单状态", async () => {
    const adapted = bridge.tools.getOrderStatus;
    if (adapted?.execute === undefined) throw new Error("getOrderStatus 必须带 execute");
    const output = await adapted.execute({ orderId: "A-1024" }, { toolCallId: "spec-exec-1", messages: [] });
    if (!isRecord(output)) throw new Error("适配 execute 应返回 structuredContent 对象");
    expect(output.orderId).toBe("A-1024");
    expect(output.status).toBe("已发货");
    expect(output.eta).toBeTruthy();
  });
});

describe("循环不可区分（头号断言）：runToolLoop 对 MCP 适配工具零改造", () => {
  it("剧本模型调 getOrderStatus → 循环照常调度回灌，onStep 采集到结构化输出，2 步收口", async () => {
    const steps: ToolLoopStepEvent[] = [];
    // 剧本：第 1 轮模型要调 getOrderStatus（工具表里是 MCP 适配版），第 2 轮给最终回答
    const model = createScriptedModel([
      { kind: "tool-calls", calls: [{ toolName: "getOrderStatus", input: { orderId: "A-1024" } }] },
      { kind: "text", text: "订单 A-1024 已发货，预计明天 18 点前送达。" },
    ]);

    const result = await runToolLoop({
      model,
      messages: [{ role: "user", content: "查一下订单 A-1024" }],
      tools: bridge.tools, // MCP 适配表整表直喂——与本地工具表同一类型（ToolSet），无任何包装
      onStep: (event) => steps.push(event),
    });

    // 循环出口正常：2 步（1 次工具轮 + 1 次文本轮），最终回答是剧本文本
    expect(result.steps).toBe(2);
    expect(result.text).toContain("已发货");

    // 观测链路采到的是「结构化输出」——MCP structuredContent 通道经适配器原样上抛，
    // 与本地 zod 工具的输出形状无差别。这就是「循环分不清工具出身」的本体断言。
    expect(steps).toHaveLength(1);
    expect(steps[0]?.toolCall.toolName).toBe("getOrderStatus");
    const output = steps[0]?.output;
    if (!isRecord(output)) throw new Error("onStep 应采集到结构化输出");
    expect(output.orderId).toBe("A-1024");
    expect(output.status).toBe("已发货");
  });
});

describe("错误映射（注入手写客户端桩，零传输层）", () => {
  /** 最小客户端桩：callTool 返回 isError + 文本错误内容（协议约定的失败形态） */
  const failingCaller: McpToolCaller = {
    callTool: async () => ({
      isError: true,
      content: [{ type: "text", text: "boom" }],
    }),
  };

  it("isError → execute 抛中文错误，携带服务器错误文本 boom、工具名与修复指引", async () => {
    const adapted = mcpToolToAgentTool(failingCaller, {
      name: "alwaysFails",
      description: "永远失败的工具",
      inputSchema: { type: "object", properties: {} },
    });
    if (adapted.execute === undefined) throw new Error("适配后的工具必须带 execute");
    await expect(
      adapted.execute({}, { toolCallId: "spec-err-1", messages: [] }),
    ).rejects.toThrow(/MCP 工具 alwaysFails 返回错误：.*boom.*请修正调用参数后重试/);
  });

  it("传输层异常（callTool 直接 throw）→ 包装成中文连接错误，保留原始信息", async () => {
    const deadCaller: McpToolCaller = {
      callTool: async () => {
        throw new Error("Connection closed");
      },
    };
    const adapted = mcpToolToAgentTool(deadCaller, {
      name: "ghostTool",
      description: "服务器已死",
      inputSchema: { type: "object" },
    });
    if (adapted.execute === undefined) throw new Error("适配后的工具必须带 execute");
    await expect(
      adapted.execute({}, { toolCallId: "spec-err-3", messages: [] }),
    ).rejects.toThrow(/MCP 工具 ghostTool 调用失败（连接或传输层）：Connection closed/);
  });

  it("无 structuredContent 的纯文本工具 → text 内容块拼接成字符串返回", async () => {
    const textOnlyCaller: McpToolCaller = {
      callTool: async () => ({
        content: [
          { type: "text", text: "第一行" },
          { type: "text", text: "第二行" },
        ],
      }),
    };
    const adapted = mcpToolToAgentTool(textOnlyCaller, {
      name: "textOnly",
      description: "只回文本的工具",
      inputSchema: { type: "object" },
    });
    if (adapted.execute === undefined) throw new Error("适配后的工具必须带 execute");
    const output = await adapted.execute({}, { toolCallId: "spec-err-4", messages: [] });
    expect(output).toBe("第一行\n第二行");
  });
});
