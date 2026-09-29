// service.controller.ts —— 智能客服 HTTP 化：apps/cli 的 service REPL 主循环逐行对应
// 链路同 CLI：会话入账 → 维护「连续未解决」计数（按 sessionId，CLI 是单会话变量）
//   → supervise（硬规则纯函数优先，全不命中才 LLM 三分类）
//   → 工人（order/refund/knowledge 各配最小工具表）或转人工（建工单 + HandoffPack）。
// 离线降级同 CLI 上线检查清单第 8 条：模型路由/工人失败直接转人工，用户侧不暴露报错——
// 所以本控制器不向全局过滤器抛模型错误，而是走降级分支返回 human 路由。
// 单仓化改造：supervisor / workers / handoff 产品核心经 @agent-app/engine/service 消费，
// 路由与转人工契约类型来自 @agent-app/shared——app 之间禁止互相 import。
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiBadRequestResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type {
  RouteDecision,
  RouteTarget,
  ServiceHandoffPack,
  SessionHistoryResponse,
  SessionSummary,
} from "@agent-app/shared";
import { createSessionStoreFromEnv } from "@agent-app/engine/memory";
import type { SessionStore } from "@agent-app/engine/memory";
import { setRagStore } from "@agent-app/engine/rag";
import { createRagStoreFromEnv } from "@agent-app/engine/rag/store.factory";
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
  sessionStore: SessionStore,
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
  /** 会话窗口跨请求保留（env 工厂：默认内存版重启即失，同 CLI 进程生命周期；SESSION_STORE=redis 时跨实例共享） */
  private readonly sessionStore = createSessionStoreFromEnv();
  /**
   * 连续未解决计数：CLI 里的单变量，HTTP 侧按 sessionId 各记各的。
   * 已知限制：计数只存在本进程的内存 Map 里，API 重启即清零（会话窗口可经
   * SESSION_STORE=redis 跨重启保留，但计数不随会话迁移）——重启后用户需重新
   * 累积连续追问才会再触发「连续未解决」转人工；不做持久化属已知取舍，无逻辑变更。
   */
  private readonly unresolvedRounds = new Map<string, number>();

  constructor() {
    // knowledge 工人与 kb 问答共用同一份知识库（env 工厂默认 json 快照，与 CLI 一致）
    setRagStore(createRagStoreFromEnv());
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

  /** 历史会话列表（会话记录功能）：按最后活跃降序，每项含轮数与更新时间。
   *  会话存储与 chat 线共用同一个 SessionStore（sessionId 前缀区分产品线：
   *  聊天 s_ / 客服 cs_），这里按 cs_ 前缀过滤——客服历史面板只看到客服会话。 */
  @Get("sessions")
  @ApiOkResponse({
    description:
      "历史会话列表（按最近活跃降序，仅 cs_ 前缀的客服会话）。每项：sessionId / turns（压缩后轮数，含摘要轮）/ updatedAt（最后活跃时间，ISO 8601）。SESSION_STORE=redis 时已过期的会话不出现（索引懒清理）。",
  })
  async listSessions(): Promise<SessionSummary[]> {
    const all = await this.sessionStore.listSessions();
    return all.filter((summary) => summary.sessionId.startsWith("cs_"));
  }

  /** 某个客服会话的全量历史（会话记录功能）：刷新页面/切换会话时恢复界面用。
   *  会话不存在或已过期时返回空 turns（200，不报 404）——前端据此渲染空对话。 */
  @Get("sessions/:sessionId")
  @ApiOkResponse({
    description:
      "该客服会话的全量轮次（压缩后含 [会话摘要] system 轮）。会话不存在或已过期（Redis TTL 到期）时 turns 为空数组，仍返回 200。",
  })
  async getSessionHistory(@Param("sessionId") sessionId: string): Promise<SessionHistoryResponse> {
    const turns = await this.sessionStore.getHistory(sessionId);
    return { sessionId, turns };
  }
}
