// apps/chat/cli.ts —— readline 聊天 REPL：会话窗口 + 手写工具循环 + 演示工具 + 知识库检索
// 链路：用户输入 → append 进会话 → 取最近 20 轮窗口 → runToolLoop（demo 工具 + 知识库检索）→ 打印回复
// 必须能在「没有 .env / 没有 API key」时启动：首次 LLM 调用失败打印清晰提示，不崩溃。
// 单仓化改造：引擎零件改为从 @agent-app/engine 的包子路径导入。
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { ModelMessage } from "ai";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { createModel } from "@agent-app/engine/llm";
import { createSessionStoreFromEnv } from "@agent-app/engine/memory";
import type { ChatTurn } from "@agent-app/engine/memory";
import { createRagStoreFromEnv, setRagStore } from "@agent-app/engine/rag";
import { enableTrace } from "@agent-app/engine/trace";
import { createDemoTools } from "@agent-app/engine/tools";
import { searchKnowledgeBase } from "@agent-app/engine/tools";

// ReAct 式提示词：让模型把「想查什么」显式化，排障日志才有内容（教程 agent-loop-ts.md）
const SYSTEM_PROMPT =
  "你是客服演示助手，可以查订单状态、创建工单、转接人工，" +
  "也能检索公司知识库回答制度类问题（检索到资料就在句末标 [1][2] 引用，资料没有就直说不知道）。" +
  "用中文简洁回答。每次调用工具前，先用一句话说明你怀疑什么、想查什么。";

/** 新会话 id：时间戳 + 随机串 */
function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** ChatTurn 窗口 → ModelMessage 数组（system 提示词不塞这里，单独走 runToolLoop 的 system 选项） */
function toModelMessages(window: ChatTurn[]): ModelMessage[] {
  return window.map((turn) => ({ role: turn.role, content: turn.content }));
}

/**
 * 聊天入口。args 支持 --selftest：跑无网络自检后直接返回。
 */
export async function main(args: string[] = []): Promise<void> {
  if (args.includes("--trace")) enableTrace(); // 每一步执行轨迹：--trace 或环境变量 AGENT_TRACE=1
  if (args.includes("--selftest")) {
    const { runSelfTest } = await import("../../selftest.js");
    await runSelfTest();
    return;
  }

  // 会话存储升级为 env 工厂（SESSION_STORE=memory|redis，默认 memory——与改造前一致）
  const sessionStore = createSessionStoreFromEnv();
  // 挂载知识库（env 工厂：RAG_STORE=memory|json|pgvector，默认 json 读 .data/kb-store.json 快照，
  // 与 kb 问答 / 客服 knowledge 工人共享同一份）
  setRagStore(createRagStoreFromEnv());
  // 工具表：三个演示工具 + 知识库检索（模型按问题自主决定调不调——Agentic RAG 的最小形态）
  const tools = { ...createDemoTools(), searchKnowledgeBase };
  let sessionId = newSessionId();

  console.log("=== 客服演示助手（手写工具循环版） ===");
  console.log("命令：/exit 退出  /new 开新会话    当前会话：" + sessionId);
  console.log("试试：「订单 A-1024 到哪了？」「出差住宿标准是多少？」");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  for await (const line of rl) {
    const input = line.trim();
    if (input === "") continue;
    if (input === "/exit") break;
    if (input === "/new") {
      sessionId = newSessionId();
      console.log(`已开启新会话：${sessionId}（旧会话历史不再带入）`);
      continue;
    }

    // ① 用户输入进会话窗口
    await sessionStore.append(sessionId, { role: "user", content: input });

    try {
      // ② 取最近 20 轮窗口拼消息（模型懒创建：没配 key 时这里才会碰网络）
      const history = await sessionStore.getWindow(sessionId, 20);
      const result = await runToolLoop({
        model: createModel(),
        messages: toModelMessages(history),
        system: SYSTEM_PROMPT,
        tools,
        maxSteps: 5,
      });

      // ③ 打印回复并回写会话
      console.log(`助手> ${result.text}`);
      await sessionStore.append(sessionId, { role: "assistant", content: result.text });
    } catch (err) {
      console.error("助手> 调用模型失败。请检查 .env 是否已按 .env.example 配置：");
      console.error("       OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL（无 .env 时默认走智谱 GLM 网关）");
      console.error(`       错误详情：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("再见！");
  rl.close();
}

// 直接运行（pnpm chat）时自动进入 REPL；被 index.ts 路由导入时由调用方调 main(rest)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
