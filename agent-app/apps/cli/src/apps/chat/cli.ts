// apps/chat/cli.ts —— readline 聊天 REPL：会话窗口 + 手写工具循环 + 演示工具 + 知识库检索
// 链路：用户输入 → append 进会话 → 取最近 20 轮窗口 → runToolLoop（demo 工具 + 知识库检索）→ 打印回复
// 必须能在「没有 .env / 没有 API key」时启动：首次 LLM 调用失败打印清晰提示，不崩溃。
// 单仓化改造：引擎零件改为从 @agent-app/engine 的包子路径导入。
// --mcp "<命令行>"：先接外部 MCP 服务器（spawn + listTools + 适配），工具表合并后进 REPL——
// MCP 工具与本地工具对循环不可区分（进方向见 engine/mcp/client.ts 与 adapter.ts）。
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { ModelMessage, ToolSet } from "ai";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { createModel } from "@agent-app/engine/llm";
import { createSessionStoreFromEnv } from "@agent-app/engine/memory";
import type { ChatTurn } from "@agent-app/engine/memory";
import { createMcpClientBridge } from "@agent-app/engine/mcp";
import type { McpClientBridge } from "@agent-app/engine/mcp";
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
 * 取 --mcp 的值（--mcp "<完整命令行>"）。约定与限制：
 * - 首个 token 当命令、其余当参数（空白切分）；带空格的参数（路径里带空格等）
 *   目前不支持——引号不会被 shell 二次解析，聊天场景够用，复杂命令请写脚本。
 * - 缺值（--mcp 是最后一个参数或下一个又是 flag）当场报错，不静默忽略。
 */
function parseMcpOption(args: string[]): string {
  const index = args.indexOf("--mcp");
  if (index === -1) return "";
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error('--mcp 需要跟一个完整命令行，例如：pnpm chat --mcp "cmd /c pnpm mcp:server"');
  }
  return value;
}

/** 命令行字符串 → spawn 参数（首 token = 命令，其余 = 参数，纯空白切分） */
function splitCommandLine(commandLine: string): { command: string; args: string[] } {
  const tokens = commandLine.trim().split(/\s+/).filter((token) => token.length > 0);
  const [command, ...rest] = tokens;
  if (command === undefined || command === "") {
    throw new Error(`--mcp 命令行为空：${commandLine}（示例：--mcp "cmd /c pnpm mcp:server"）`);
  }
  return { command, args: rest };
}

/**
 * MCP 工具表合入本地工具表：重名时 MCP 版本胜出（显式接入的外部服务器优先），
 * 但必须把覆盖了谁说清楚——静默覆盖会让「为什么查订单走的是 MCP」变成悬案。
 * 类型就用 ai 的 ToolSet（runToolLoop 的入参同款）：本地表与 MCP 适配表在类型层已经是同一张脸。
 */
function mergeMcpTools(local: ToolSet, bridge: McpClientBridge): ToolSet {
  const collisions = Object.keys(bridge.tools).filter((name) => name in local);
  if (collisions.length > 0) {
    console.warn(`⚠ MCP 工具与本地工具重名（${collisions.join("、")}），已用 MCP 版本覆盖：同名工具改走 MCP 服务器执行。`);
  }
  return { ...local, ...bridge.tools };
}

/**
 * 聊天入口。args 支持：
 * - --selftest：跑无网络自检后直接返回
 * - --trace：开启执行轨迹（▶⚙✓ 打到 stderr）
 * - --mcp "<完整命令行>"：先接外部 MCP 服务器再进 REPL（连接失败打印修复指引并以退出码 1 结束）
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
  const localTools = { ...createDemoTools(), searchKnowledgeBase };

  // --mcp：spawn 子进程 + initialize + listTools + 适配，全部就绪后才进 REPL——
  // 连接失败（命令写错、服务器起不来）在启动期暴露并给出修复指引，不带着半残的工具表聊天。
  let mcpBridge: McpClientBridge | undefined;
  let mcpCommand: string;
  try {
    mcpCommand = parseMcpOption(args);
  } catch (err) {
    console.error(`参数错误：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (mcpCommand !== "") {
    try {
      const { command, args: commandArgs } = splitCommandLine(mcpCommand);
      mcpBridge = await createMcpClientBridge({ command, args: commandArgs });
    } catch (err) {
      console.error(`接入 MCP 服务器失败：${err instanceof Error ? err.message : String(err)}`);
      console.error('请检查 --mcp 的命令行能否在终端直接跑通；Windows 下 pnpm/npx 等 .cmd 命令需要包一层 cmd /c，例如：--mcp "cmd /c pnpm mcp:server"');
      process.exitCode = 1;
      return;
    }
  }

  // 工具表定稿：无 --mcp 时与从前逐字节一致；有 --mcp 时 MCP 工具合并进来（重名 MCP 胜出）
  const tools: ToolSet = mcpBridge === undefined ? localTools : mergeMcpTools(localTools, mcpBridge);
  let sessionId = newSessionId();

  console.log("=== 客服演示助手（手写工具循环版） ===");
  console.log("命令：/exit 退出  /new 开新会话    当前会话：" + sessionId);
  console.log("试试：「订单 A-1024 到哪了？」「出差住宿标准是多少？」");
  if (mcpBridge !== undefined) {
    const names = Object.keys(mcpBridge.tools);
    console.log(`已接入 MCP 服务（${names.length} 个工具：${names.join(", ")}）`);
  }

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
  // /exit 与 EOF 两条退出路径都汇到这里：桥先关（SDK 序列收子进程），
  // 再让 main 返回——避免带着活的 MCP 子进程退出留下孤儿。
  await mcpBridge?.close();
}

// 直接运行（pnpm chat）时自动进入 REPL；被 index.ts 路由导入时由调用方调 main(rest)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
