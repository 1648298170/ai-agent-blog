// apps/service/cli.ts —— 智能客服 REPL：pnpm service
// 链路（教程 products/service.md）：用户输入 → 维护「连续未解决」计数
//   → supervise（硬规则纯函数优先，全不命中才问模型做 JSON 三分类）
//   → 工人（order / refund / knowledge，各配最小工具表 + runToolLoop）
//     或转人工（建工单 + HandoffPack 上下文包，接手人不用用户复述）
// 离线优先：无 key 时 REPL 照常启动；模型路由失败直接降级转人工而不是报错
// （service.md 上线检查清单第 8 条：降级链路——用户侧表现为转人工而非报错页）。
// 单仓化改造：supervisor / workers / handoff 产品核心上移 @agent-app/engine/service
// （HTTP API 复用同一套逻辑），本文件经包子路径导入。
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { createSessionStoreFromEnv } from "@agent-app/engine/memory";
import type { SessionStore } from "@agent-app/engine/memory";
import { createRagStoreFromEnv, setRagStore } from "@agent-app/engine/rag";
import { buildHandoffPack, formatHandoffPack, handoffReply, runWorker, supervise, isUnresolvedSignal } from "@agent-app/engine/service";
import type { RouteDecision } from "@agent-app/engine/service";
import { enableTrace } from "@agent-app/engine/trace";

/** 新会话 id：时间戳 + 随机串（同 chat REPL） */
function newSessionId(): string {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 调用模型失败的统一配置提示（错误礼仪同 apps/chat/cli.ts） */
function printConfigHint(detail: string): void {
  console.error("客服> 调用模型失败。请检查 .env 是否已按 .env.example 配置：");
  console.error("       OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL（无 .env 时默认走智谱 GLM 网关）");
  console.error(`       错误详情：${detail}`);
}

/** 转人工：建工单 + HandoffPack，打印工单块与用户告知，回写会话 */
async function doHandoff(
  sessionStore: SessionStore,
  sessionId: string,
  reason: string,
): Promise<void> {
  const history = await sessionStore.getWindow(sessionId, 20);
  const pack = await buildHandoffPack({ reason, turns: history });
  console.log(formatHandoffPack(pack));
  const reply = handoffReply(pack);
  console.log(`客服> ${reply}`);
  await sessionStore.append(sessionId, { role: "assistant", content: reply });
}

/**
 * 客服入口。args 预留给后续参数，当前直接进 REPL。
 */
export async function main(args: string[] = []): Promise<void> {
  if (args.includes("--trace")) enableTrace(); // 每一步执行轨迹：--trace 或环境变量 AGENT_TRACE=1
  // 换库接缝升级为 env 工厂：knowledge 工人与 kb 问答共用同一个知识库（默认 json 快照）
  setRagStore(createRagStoreFromEnv());
  // 会话存储同步升级（SESSION_STORE=memory|redis，默认 memory——与改造前一致）
  const sessionStore = createSessionStoreFromEnv();
  let sessionId = newSessionId();
  let unresolvedRounds = 0; // 连续未解决计数（service.md 硬规则 3：第三轮再转，耐心就见底了）

  console.log("=== 智能客服（service） ===");
  console.log("命令：/exit 退出  /new 开新会话    当前会话：" + sessionId);
  console.log("试试：「订单 A-1024 到哪了」「退款怎么申请」「出差住宿标准多少」「转人工」");
  console.log("硬规则优先：转人工/投诉关键词、连续 2 轮未解决 → 直接人工，不问模型。");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for await (const line of rl) {
    const input = line.trim();
    if (input === "") continue;
    if (input === "/exit") break;
    if (input === "/new") {
      sessionId = newSessionId();
      unresolvedRounds = 0;
      console.log(`已开启新会话：${sessionId}（旧会话历史与未解决计数不再带入）`);
      continue;
    }

    await sessionStore.append(sessionId, { role: "user", content: input });
    const history = await sessionStore.getWindow(sessionId, 20);

    // 追问信号维护「连续未解决」计数：命中 +1，正常提问清零（计数归代码管，不归模型管）
    unresolvedRounds = isUnresolvedSignal(input) ? unresolvedRounds + 1 : 0;

    // ① 路由：硬规则在 supervise 内部优先执行，全不命中才发起 LLM 分类
    let decision: RouteDecision;
    try {
      decision = await supervise({ lastUserMessage: input, unresolvedRounds }, history);
    } catch (err) {
      printConfigHint(err instanceof Error ? err.message : String(err));
      decision = {
        target: "human",
        reason: "模型路由不可用，按降级预案直接转人工（用户侧不暴露报错）",
      };
    }

    // ② 转人工是业务流程的正常一步：建工单 + 上下文包，走完继续接客
    if (decision.target === "human") {
      await doHandoff(sessionStore, sessionId, decision.reason);
      unresolvedRounds = 0; // 已转出去，接手人从新上下文开始
      continue;
    }

    // ③ 业务工人处理
    try {
      const reply = await runWorker(decision.target, { history, message: input });
      console.log(`客服> ${reply}`);
      await sessionStore.append(sessionId, { role: "assistant", content: reply });
    } catch (err) {
      printConfigHint(err instanceof Error ? err.message : String(err));
      await doHandoff(
        sessionStore,
        sessionId,
        `工人 ${decision.target} 处理失败（模型不可用），按降级预案转人工`,
      );
    }
  }

  console.log("再见！");
  rl.close();
}

// 直接运行（pnpm service）时自动执行；被 index.ts 路由导入时由调用方调 main(rest)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
