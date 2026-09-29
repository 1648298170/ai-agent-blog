// apps/kb/cli.ts —— 知识库问答 REPL：pnpm kb
// 链路（教程《RAG TS 全链路》第五步 + products/kb.md 在线链路）：
//   问题 → searchKnowledge top5
//   → 空结果老实说不知道（边界探测类场景的信任分水岭，不硬编）
//   → 命中块编号拼进 prompt → LLM 只依据资料作答并标 [1][2] → formatCitations 打印引用块
// 降级（kb.md 降级预案）：LLM 挂了返回检索原文 + 出处，链路上哪段活着就交哪段的产出；
// 离线优先：embedding / LLM 失败打印清晰中文配置提示，REPL 不崩（错误礼仪同 apps/chat/cli.ts）。
// 会话记忆：SessionStore 存问答对，追问时带上最近窗口，模型才知道「它」指的是哪条。
// 单仓化改造：RAG 零件与记忆改为从 @agent-app/engine 的包子路径导入。
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { createModel } from "@agent-app/engine/llm";
import { createSessionStoreFromEnv } from "@agent-app/engine/memory";
import type { ChatTurn } from "@agent-app/engine/memory";
import { createRagStoreFromEnv, formatCitations, searchKnowledge, setRagStore } from "@agent-app/engine/rag";
import type { RetrievedChunk } from "@agent-app/engine/rag";
import { enableTrace } from "@agent-app/engine/trace";

const SYSTEM_PROMPT =
  "你是知识库问答助手，只依据用户消息里「资料」一节给出的内容回答，" +
  "引用哪段就在句末标注编号，如 [1][2]。" +
  "资料里没有答案就直说不知道，禁止编造。回答用中文，简洁准确。";

/** 新会话 id：时间戳 + 随机串（同 chat REPL） */
function newSessionId(): string {
  return `kb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** ChatTurn 窗口 → ModelMessage（本轮问题单独拼资料，不在这步转换） */
function toModelMessages(window: ChatTurn[]): ModelMessage[] {
  return window.map((turn) => ({ role: turn.role, content: turn.content }));
}

/** 命中块 → 编号资料：引用编号由后端分配、模型只负责标号（溯源思想，模型编不了出处） */
function buildGroundedPrompt(question: string, hits: RetrievedChunk[]): string {
  const material = hits.map((chunk, i) => `[${i + 1}]（${chunk.title}）\n${chunk.text}`).join("\n\n");
  return `资料：\n${material}\n\n问题：${question}`;
}

/** LLM 不可用时的降级输出：检索原文 + 出处（kb.md：宁可给没润色的资料，不给报错页） */
function printDegradedAnswer(err: unknown, hits: RetrievedChunk[]): void {
  console.log("答> [降级] LLM 暂不可用，以下是知识库检索原文与出处（未经润色）：");
  hits.forEach((chunk, i) => {
    console.log(`--- [${i + 1}]（${chunk.title}，相似度 ${chunk.score.toFixed(3)}）`);
    console.log(chunk.text);
  });
  console.error("（生成失败，请检查 .env：OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL）");
  console.error(`  错误详情：${err instanceof Error ? err.message : String(err)}`);
}

/**
 * 知识库问答入口。args 预留给后续参数（如 --top），当前直接进 REPL。
 */
export async function main(args: string[] = []): Promise<void> {
  if (args.includes("--trace")) enableTrace(); // 每一步执行轨迹：--trace 或环境变量 AGENT_TRACE=1
  // 换库接缝升级为 env 工厂：RAG_STORE=pgvector 时读 PG，默认 json 读 .data/kb-store.json 快照
  setRagStore(createRagStoreFromEnv());
  // 会话存储同步升级（SESSION_STORE=memory|redis，默认 memory——与改造前一致）
  const sessionStore = createSessionStoreFromEnv();
  let sessionId = newSessionId();

  console.log("=== 知识库问答（kb） ===");
  console.log("命令：/exit 退出  /new 开新会话    当前会话：" + sessionId);
  console.log("先入库再提问：pnpm kb:ingest <文件>（支持 .txt/.md/.pdf），答案带 [1][2] 引用。");

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

    await sessionStore.append(sessionId, { role: "user", content: input });

    // ① 检索 top5（embedding 调用发生在 searchKnowledge 内部，离线时抛错走配置提示）
    let hits: RetrievedChunk[];
    try {
      hits = await searchKnowledge(input, 5);
    } catch (err) {
      console.error("答> 检索失败：调用 embedding 接口出错。请检查 .env 是否已按 .env.example 配置：");
      console.error("     OPENAI_API_KEY / OPENAI_BASE_URL / EMBEDDING_MODEL");
      console.error("     默认智谱 GLM 网关自带 embeddings（embedding-3）；换网关时 EMBEDDING_MODEL 要跟着换，DeepSeek 网关没有 embeddings");
      console.error(`     错误详情：${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // ② 空结果 / 空库：老实说不知道（kb.md 边界探测场景，敢说不知道才敢信它说的知道）
    if (hits.length === 0) {
      const reply = "知识库里没有找到相关内容，这题我不答。请先入库对应文档，或换个问法试试。";
      console.log(`答> ${reply}`);
      await sessionStore.append(sessionId, { role: "assistant", content: reply });
      continue;
    }

    // ③ 历史窗口（去掉刚 append 的本轮问题）+ 本轮「资料 + 问题」，模型只依据资料作答
    try {
      const history = await sessionStore.getWindow(sessionId, 20);
      const messages = toModelMessages(history.slice(0, -1));
      messages.push({ role: "user", content: buildGroundedPrompt(input, hits) });

      const { text } = await generateText({ model: createModel(), system: SYSTEM_PROMPT, messages });

      console.log(`答> ${text}`);
      console.log("\n引用来源：");
      console.log(formatCitations(hits));
      await sessionStore.append(sessionId, { role: "assistant", content: text });
    } catch (err) {
      // ④ 降级：LLM 挂了，检索链路还活着——原文和出处照样交出去
      printDegradedAnswer(err, hits);
      const degraded = hits.map((chunk, i) => `[${i + 1}]（${chunk.title}）${chunk.text}`).join("\n");
      await sessionStore.append(sessionId, { role: "assistant", content: degraded });
    }
  }

  console.log("再见！");
  rl.close();
}

// 直接运行（pnpm kb）时自动执行；被 index.ts 路由导入时由调用方调 main(rest)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
