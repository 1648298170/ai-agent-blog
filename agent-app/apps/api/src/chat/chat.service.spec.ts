// chat.service.spec.ts —— 聊天服务单测：引擎模块全部 mock（零网络）
// 引擎接缝：runToolLoop（@agent-app/engine/agent-loop）与 createModel
// （@agent-app/engine/llm）、streamText（ai）替换为 vi.fn；会话存储用真品
// （纯内存、无副作用），顺便验证「同 sessionId 跨调用保留上下文」的会话礼仪。
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { createModel } from "@agent-app/engine/llm";
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

describe("ChatService", () => {
  let service: ChatService;

  beforeEach(async () => {
    vi.mocked(runToolLoop).mockReset();
    vi.mocked(createModel).mockClear();
    streamTextMock.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [ChatService, ConfigProvider],
    }).compile();
    service = moduleRef.get(ChatService);
  });

  it("chat：happy path → { sessionId, reply }，reply 来自 runToolLoop 的 text", async () => {
    vi.mocked(runToolLoop).mockResolvedValue({
      text: "订单 A-1024 已发货，预计明天送达",
      messages: [],
      steps: 1,
    });

    const result = await service.chat({ message: "订单 A-1024 到哪了" });

    expect(result.reply).toBe("订单 A-1024 已发货，预计明天送达");
    expect(result.sessionId).toMatch(/^s_/); // 缺省新开会话
    expect(runToolLoop).toHaveBeenCalledOnce();
    // 模型来自引擎工厂、系统提示词与最大步数与 CLI 同款
    const options = vi.mocked(runToolLoop).mock.calls[0][0];
    expect(options.model).toEqual({ fake: "model" });
    expect(options.system).toContain("客服演示助手");
    expect(options.maxSteps).toBe(5);
    // 首轮消息就是这条用户输入
    expect(options.messages).toEqual([{ role: "user", content: "订单 A-1024 到哪了" }]);
  });

  it("chat：同一 sessionId 复用会话窗口（第二轮能看到第一轮的用户/助手消息）", async () => {
    vi.mocked(runToolLoop).mockImplementation(async (options) => {
      const text = `第 ${options.messages.length} 条消息`;
      return { text, messages: [...options.messages, { role: "assistant", content: text }], steps: 1 };
    });

    const first = await service.chat({ message: "第一句", sessionId: "s_keep" });
    const second = await service.chat({ message: "第二句", sessionId: "s_keep" });

    expect(first.sessionId).toBe("s_keep");
    expect(second.sessionId).toBe("s_keep");
    // 真实 InMemorySessionStore 生效：第二轮窗口 = [user1, assistant1, user2]
    expect(second.reply).toBe("第 3 条消息");
  });

  it("chat：runToolLoop 抛错（如离线无 key）→ 原样向上抛，交给全局过滤器转配置提示", async () => {
    vi.mocked(runToolLoop).mockRejectedValue(new Error("API key 未配置，无法调用模型"));

    await expect(service.chat({ message: "你好" })).rejects.toThrow("API key 未配置");
  });

  it("chatStream：事件序列 session → step → token* → done，最终答案来自 streamText", async () => {
    vi.mocked(runToolLoop).mockImplementation(async (options) => {
      options.onStep?.({
        step: 1,
        toolCall: { toolName: "getOrderStatus", input: { orderId: "A-1024" } },
        output: "已发货",
      });
      return { text: "最终回答（被忽略，改走 streamText）", messages: [], steps: 1 };
    });
    streamTextMock.mockReturnValue({
      textStream: (async function* () {
        yield "已";
        yield "发货";
      })(),
    });

    const events: ChatStreamEvent[] = [];
    await service.chatStream({ message: "订单到哪了" }, (event) => events.push(event));

    // 事件契约（@agent-app/shared 的 ChatStreamEvent）：session → step → token×2 → done
    expect(events.map((e) => e.type)).toEqual(["session", "step", "token", "token", "done"]);
    const session = events[0];
    if (session.type !== "session") throw new Error("unreachable：首事件必须是 session");
    expect(session.sessionId).toMatch(/^s_/);
    const step = events[1];
    if (step.type !== "step") throw new Error("unreachable：第二事件必须是 step");
    expect(step.toolCall.toolName).toBe("getOrderStatus");
    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.map((t) => (t.type === "token" ? t.text : ""))).toEqual(["已", "发货"]);
    // streamText 拿到的是 runToolLoop 返回的 messages + 同款系统提示词
    expect(streamTextMock).toHaveBeenCalledOnce();
  });

  it("chatStream：runToolLoop 抛错 → 事件流中断并向上抛（控制器负责转 error 事件）", async () => {
    vi.mocked(runToolLoop).mockRejectedValue(new Error("模型网关不可达"));

    const events: ChatStreamEvent[] = [];
    await expect(
      service.chatStream({ message: "你好" }, (event) => events.push(event)),
    ).rejects.toThrow("模型网关不可达");
    // 中断前只发出了 session 开场事件
    expect(events.map((e) => e.type)).toEqual(["session"]);
  });
});
