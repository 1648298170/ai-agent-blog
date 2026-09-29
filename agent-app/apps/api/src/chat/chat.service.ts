// chat.service.ts —— 聊天业务：apps/chat/cli.ts 的 HTTP 化（同一引擎、同一会话礼仪）
// 链路同 CLI：用户输入 → append 进会话 → 取最近 20 轮窗口 → runToolLoop（demo 工具）
// → 回复回写会话。离线（无 key）时 runToolLoop 抛错交给全局过滤器转配置提示 JSON。
// 流式版本多一步可视性：onStep 把手写循环的每一步（工具调用 + 输出）转发给调用方，
// 最终答案再用 streamText（不带工具）在已积累的消息上重新流式生成（week20 BFF 的 SSE 形态）。
// SSE 事件契约 ChatStreamEvent 定义在 @agent-app/shared（web 前端与 API 共享），这里再出口。
import { Injectable } from "@nestjs/common";
import { streamText } from "ai";
import type { ModelMessage } from "ai";
import type { ChatStreamEvent } from "@agent-app/shared";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { createModel } from "@agent-app/engine/llm";
import { InMemorySessionStore } from "@agent-app/engine/memory";
import type { ChatTurn } from "@agent-app/engine/memory";
import { createDemoTools } from "@agent-app/engine/tools";
import { ConfigProvider } from "../common/config.provider.js";

// ReAct 式提示词：与 apps/chat/cli.ts 完全一致
const SYSTEM_PROMPT =
  "你是客服演示助手，可以查订单状态、创建工单、转接人工。用中文简洁回答。" +
  "每次调用工具前，先用一句话说明你怀疑什么、想查什么。";

/** 新会话 id：时间戳 + 随机串（同 apps/chat/cli.ts） */
export function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** ChatTurn 窗口 → ModelMessage 数组（system 提示词单独走 runToolLoop 的 system 选项） */
function toModelMessages(window: ChatTurn[]): ModelMessage[] {
  return window.map((turn) => ({ role: turn.role, content: turn.content }));
}

/** SSE 事件流：session（含新会话 id）→ 若干 step（工具步）→ 若干 token → done；出错转 error */
export type { ChatStreamEvent };

@Injectable()
export class ChatService {
  private readonly sessionStore = new InMemorySessionStore();
  private readonly tools = createDemoTools();

  constructor(private readonly config: ConfigProvider) {}

  /** 启动自检用：构造注入是否真的装配到 ConfigProvider（main.ts 在 boot 时调用打印） */
  describeInjection(): string {
    return this.config.hasApiKey() ? "已配置" : "未配置（离线降级链路生效）";
  }

  /** 非流式问答：sessionId（缺省新开）→ 会话窗口 → runToolLoop → { sessionId, reply } */
  async chat(input: { message: string; sessionId?: string }): Promise<{ sessionId: string; reply: string }> {
    const sessionId = input.sessionId ?? newSessionId();

    // ① 用户输入进会话窗口，② 取最近 20 轮拼消息（模型懒创建：没配 key 时这里才碰网络）
    await this.sessionStore.append(sessionId, { role: "user", content: input.message });
    const history = await this.sessionStore.getWindow(sessionId, 20);

    const result = await runToolLoop({
      model: createModel(),
      messages: toModelMessages(history),
      system: SYSTEM_PROMPT,
      tools: this.tools,
      maxSteps: 5,
    });

    // ③ 回复回写会话
    await this.sessionStore.append(sessionId, { role: "assistant", content: result.text });
    return { sessionId, reply: result.text };
  }

  /**
   * 流式问答：事件经 emit 回调交出（控制器负责写成 SSE 帧）。
   * 出错时抛给调用方，由控制器发 {type:"error"} 事件——服务层不碰 HTTP。
   *
   * 实现说明：runToolLoop 收尾那轮 generateText 的 text 不用（非流式产物），
   * 最终答案按 week20 的形态用 streamText（纯文本、不带工具）在已积累的消息
   * （含全部工具调用与回灌，不含最终回复）上重新流式生成——多一次生成调用，
   * 换来逐 token 可视，这是不动引擎内部的前提下最直接的 SSE 形态。
   */
  async chatStream(
    input: { message: string; sessionId?: string },
    emit: (event: ChatStreamEvent) => void,
  ): Promise<void> {
    const sessionId = input.sessionId ?? newSessionId();
    emit({ type: "session", sessionId });

    await this.sessionStore.append(sessionId, { role: "user", content: input.message });
    const history = await this.sessionStore.getWindow(sessionId, 20);

    const result = await runToolLoop({
      model: createModel(),
      messages: toModelMessages(history),
      system: SYSTEM_PROMPT,
      tools: this.tools,
      maxSteps: 5,
      onStep: (event) =>
        emit({ type: "step", step: event.step, toolCall: event.toolCall, output: event.output }),
    });

    // 最终答案流式生成：messages 已含全部工具往来，streamText 只做纯文本收尾
    const { textStream } = streamText({
      model: createModel(),
      system: SYSTEM_PROMPT,
      messages: result.messages,
    });

    let answer = "";
    for await (const delta of textStream) {
      answer += delta;
      emit({ type: "token", text: delta });
    }

    await this.sessionStore.append(sessionId, { role: "assistant", content: answer });
    emit({ type: "done" });
  }
}
