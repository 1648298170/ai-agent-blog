// service.controller.ts —— 智能客服 HTTP 化：apps/cli 的 service REPL 主循环逐行对应
// 链路同 CLI：会话入账 → 维护「连续未解决」计数（按 sessionId，CLI 是单会话变量）
//   → supervise（硬规则纯函数优先，全不命中才 LLM 三分类）
//   → 工人（order/refund/knowledge 各配最小工具表）或转人工（建工单 + HandoffPack）。
// 离线降级同 CLI 上线检查清单第 8 条：模型路由/工人失败直接转人工，用户侧不暴露报错——
// 所以本控制器不向全局过滤器抛模型错误，而是走降级分支返回 human 路由。
// 单仓化改造：supervisor / workers / handoff 产品核心经 @agent-app/engine/service 消费，
// 路由与转人工契约类型来自 @agent-app/shared——app 之间禁止互相 import。
import { Body, Controller, Post } from "@nestjs/common";
import { ApiBadRequestResponse, ApiTags } from "@nestjs/swagger";
import type { RouteDecision, RouteTarget, ServiceHandoffPack } from "@agent-app/shared";
import { InMemorySessionStore } from "@agent-app/engine/memory";
import { createJsonRagStore, setRagStore } from "@agent-app/engine/rag";
import { buildHandoffPack, handoffReply, isUnresolvedSignal, runWorker, supervise } from "@agent-app/engine/service";
import type { ChatTurn } from "@agent-app/engine/memory";
import type { ServiceReply } from "./service.dto.js";
import { ServiceMessageDto } from "./service.dto.js";

/** 新会话 id：时间戳 + 随机串（同 service REPL 的 cs_ 前缀） */
function newSessionId(): string {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 转人工：建工单 + HandoffPack，回写会话（CLI 的 doHandoff 对应物，返回值代替打印） */
async function doHandoff(
  sessionStore: InMemorySessionStore,
  sessionId: string,
  reason: string,
  history: ChatTurn[],
): Promise<{ reply: string; handoff: ServiceHandoffPack }> {
  const pack = await buildHandoffPack({ reason, turns: history });
  const reply = handoffReply(pack);
  await sessionStore.append(sessionId, { role: "assistant", content: reply });
  return { reply, handoff: pack };
}

@ApiTags("service")
@Controller("api/service")
export class ServiceController {
  /** 会话窗口跨请求保留（内存版：重启即失，同 CLI 进程生命周期） */
  private readonly sessionStore = new InMemorySessionStore();
  /** 连续未解决计数：CLI 里的单变量，HTTP 侧按 sessionId 各记各的 */
  private readonly unresolvedRounds = new Map<string, number>();

  constructor() {
    setRagStore(createJsonRagStore()); // knowledge 工人与 kb 问答共用同一份知识库快照
  }

  @Post("message")
  @ApiBadRequestResponse({ description: "请求体校验失败（缺 message / 类型不符）" })
  async message(@Body() dto: ServiceMessageDto): Promise<ServiceReply> {
    const sessionId = dto.sessionId ?? newSessionId();

    await this.sessionStore.append(sessionId, { role: "user", content: dto.message });
    const history = await this.sessionStore.getWindow(sessionId, 20);

    // 追问信号维护「连续未解决」计数：命中 +1，正常提问清零（计数归代码管，不归模型管）
    const prev = this.unresolvedRounds.get(sessionId) ?? 0;
    const unresolvedRounds = isUnresolvedSignal(dto.message) ? prev + 1 : 0;
    this.unresolvedRounds.set(sessionId, unresolvedRounds);

    // ① 路由：硬规则在 supervise 内部优先执行，全不命中才发起 LLM 分类。
    // 模型不可用 → 降级转人工（用户侧表现为 human 路由而非报错页）
    let decision: RouteDecision;
    try {
      decision = await supervise({ lastUserMessage: dto.message, unresolvedRounds }, history);
    } catch {
      decision = {
        target: "human",
        reason: "模型路由不可用，按降级预案直接转人工（用户侧不暴露报错）",
      };
    }

    // ② 转人工是业务流程的正常一步：建工单 + 上下文包，计数清零
    if (decision.target === "human") {
      const { reply, handoff } = await doHandoff(this.sessionStore, sessionId, decision.reason, history);
      this.unresolvedRounds.set(sessionId, 0);
      return { sessionId, route: decision.target, reason: decision.reason, reply, handoff };
    }

    // ③ 业务工人处理；工人失败同样降级转人工
    try {
      const reply = await runWorker(decision.target, { history, message: dto.message });
      await this.sessionStore.append(sessionId, { role: "assistant", content: reply });
      return { sessionId, route: decision.target, reason: decision.reason, reply };
    } catch {
      const reason = `工人 ${decision.target} 处理失败（模型不可用），按降级预案转人工`;
      const { reply, handoff } = await doHandoff(this.sessionStore, sessionId, reason, history);
      this.unresolvedRounds.set(sessionId, 0);
      const route: RouteTarget = "human";
      return { sessionId, route, reason, reply, handoff };
    }
  }
}
