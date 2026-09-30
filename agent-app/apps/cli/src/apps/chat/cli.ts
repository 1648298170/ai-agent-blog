// apps/chat/cli.ts —— readline 聊天 REPL：会话窗口 + 手写工具循环 + 演示工具 + 知识库检索
// 链路：用户输入 → append 进会话 → 取最近 20 轮窗口 → runToolLoop（demo 工具 + 知识库检索）→ 打印回复
// 必须能在「没有 .env / 没有 API key」时启动：首次 LLM 调用失败打印清晰提示，不崩溃。
// 单仓化改造：引擎零件改为从 @agent-app/engine 的包子路径导入。
// --mcp "<命令行>"：先接外部 MCP 服务器（spawn + listTools + 适配），工具表合并后进 REPL——
// MCP 工具与本地工具对循环不可区分（进方向见 engine/mcp/client.ts 与 adapter.ts）。
// P3a 安全护栏：任一 AGENT_GUARD_* 环境开关开启时，仅给 MCP 来源的工具套闸（白名单 /
// 注入扫描 / 人工确认 / PII 脱敏，见 engine/guardrails/），未配置任何开关则零变化。
import readline from "node:readline/promises";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { ModelMessage, ToolSet } from "ai";
import { resolveToolAllowlist, wrapToolWithGate } from "@agent-app/engine";
import type { ToolConfirmFn } from "@agent-app/engine";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { createModel } from "@agent-app/engine/llm";
import { createSessionStoreFromEnv } from "@agent-app/engine/memory";
import type { ChatTurn } from "@agent-app/engine/memory";
import { createMcpClientBridge } from "@agent-app/engine/mcp";
import type { McpClientBridge } from "@agent-app/engine/mcp";
import { createRagStoreFromEnv, setRagStore } from "@agent-app/engine/rag";
import { enableTrace, preview } from "@agent-app/engine/trace";
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

// ══ P3a 安全护栏（engine/guardrails 的 CLI 装配层）════════════════════════
// 设计边界：护栏只作用于 MCP 来源的工具——外部服务器是我们控制不了的面，
// 本地演示工具是自己写的代码，不进闸。三个环境开关全关时整段不生效，
// 与引入护栏之前逐字节一致（零变化默认）。

/** 护栏开关快照：三个环境变量在启动期读一次，全未配置（或全解析为空）→ null */
interface GuardSwitches {
  /** AGENT_GUARD_PII=1：MCP 工具输出先做 PII 脱敏再回灌模型 */
  maskOutput: boolean;
  /** AGENT_GUARD_ALLOWLIST="a,b"：只放行名单内的 MCP 工具（null = 不限制） */
  allowlist: string[] | null;
  /** AGENT_GUARD_CONFIRM="c,d"：名单内工具执行前需终端 y 确认（null = 无需确认） */
  confirmNames: string[] | null;
}

/** 读护栏环境开关：空串/全空条目一律折算成 null（视同未配置），不产生幽灵限制 */
function readGuardSwitches(): GuardSwitches | null {
  const piiRaw = process.env.AGENT_GUARD_PII;
  const maskOutput = piiRaw === "1" || piiRaw === "true"; // 与 AGENT_TRACE 同款布尔口径
  const allowlist = resolveToolAllowlist(process.env.AGENT_GUARD_ALLOWLIST);
  const confirmNames = resolveToolAllowlist(process.env.AGENT_GUARD_CONFIRM);
  if (!maskOutput && allowlist === null && confirmNames === null) return null;
  return { maskOutput, allowlist, confirmNames };
}

/** 启动期把生效的护栏列成中文一行：让使用者知道工具行为被什么改变了 */
function describeActiveGuards(guard: GuardSwitches): string {
  const parts: string[] = [];
  if (guard.maskOutput) {
    parts.push("输出 PII 脱敏（AGENT_GUARD_PII：手机号/身份证/银行卡打码后再回给模型）");
  }
  if (guard.allowlist !== null) {
    parts.push(`工具白名单（AGENT_GUARD_ALLOWLIST：仅放行 ${guard.allowlist.join("、")}）`);
  }
  if (guard.confirmNames !== null) {
    parts.push(`执行确认（AGENT_GUARD_CONFIRM：${guard.confirmNames.join("、")} 调用前需按 y 同意）`);
  }
  return `安全护栏已启用（仅作用于 MCP 工具）：${parts.join("；")}`;
}

/**
 * 确认回调（ToolConfirmFn）的 CLI 实现：问题写 stderr（stdout 保持干净，与轨迹同款
 * 纪律；用户敲的答案回显走 rl 自身的 output=stdout，属终端回显不属于程序输出），
 * 答案复用主 REPL 的 readline 接口读取。可行性依据（Node 22 实测验证过）：
 * - rl.question 的行路由优先于 'line' 事件（readline 内部的 kQuestionCallback 机制），
 *   答案行只进确认回调，不会混进聊天输入流；后续行照常回到 REPL 迭代器；
 * - stdin EOF 时 question 的 Promise 永远不落定——与 close 事件竞速，落空按拒绝处理；
 * - 默认拒绝（fail-closed）：空输入 / EOF / 非 y、yes 的一律不同意，宁可少执行；
 * - 已知边界：管道批量输入（一次性灌多行）时答案行可能已被 REPL 迭代器缓冲——
 *   确认闸面向交互式终端设计，自动化/脚本场景请勿开启 AGENT_GUARD_CONFIRM。
 */
function askToolConfirm(rl: ReadlineInterface): ToolConfirmFn {
  return async (info) => {
    process.stderr.write(`🛡 MCP 工具 ${info.toolName} 请求执行，入参：${preview(info.input, 120)}。允许吗？[y/N] `);
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return; // question 与 close 竞速：只认先到的一方
        settled = true;
        rl.removeListener("close", onClose);
        resolve(value);
      };
      const onClose = () => finish(false); // EOF → 默认拒绝（同时兜住 question 永挂起）
      rl.once("close", onClose);
      void rl.question("").then(
        (answer) => {
          const normalized = answer.trim().toLowerCase();
          finish(normalized === "y" || normalized === "yes");
        },
        () => finish(false), // question 异常（理论不可达）：按拒绝处理
      );
    });
  };
}

/** 给合并后的工具表里 MCP 来源的工具逐个套闸（重名被 MCP 覆盖的键也在其中） */
function applyGuardsToMcpTools(tools: ToolSet, bridge: McpClientBridge, guard: GuardSwitches, confirm: ToolConfirmFn): void {
  for (const name of Object.keys(bridge.tools)) {
    const original = tools[name];
    if (original === undefined) continue; // 理论不可达：合并后 MCP 工具必在表内
    tools[name] = wrapToolWithGate(original, {
      name,
      allowlist: guard.allowlist,
      confirm: guard.confirmNames !== null && guard.confirmNames.includes(name) ? confirm : undefined,
      maskOutput: guard.maskOutput,
    });
  }
}

/**
 * 聊天入口。args 支持：
 * - --selftest：跑无网络自检后直接返回
 * - --trace：开启执行轨迹（▶⚙✓ 打到 stderr）
 * - --mcp "<完整命令行>"：先接外部 MCP 服务器再进 REPL（连接失败打印修复指引并以退出码 1 结束）
 *
 * 环境开关（P3a 安全护栏，只作用于 MCP 工具，见 engine/guardrails/）：
 * - AGENT_GUARD_PII=1：MCP 工具输出先做 PII 脱敏（手机号/身份证/银行卡）再回灌模型
 * - AGENT_GUARD_ALLOWLIST="t1,t2"：MCP 工具白名单，不在名单内的调用被结构化拒绝
 * - AGENT_GUARD_CONFIRM="t3,t4"：名单内工具执行前在终端 y/n 确认（默认拒绝）
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
  let tools: ToolSet = mcpBridge === undefined ? localTools : mergeMcpTools(localTools, mcpBridge);
  let sessionId = newSessionId();

  console.log("=== 客服演示助手（手写工具循环版） ===");
  console.log("命令：/exit 退出  /new 开新会话    当前会话：" + sessionId);
  console.log("试试：「订单 A-1024 到哪了？」「出差住宿标准是多少？」");
  if (mcpBridge !== undefined) {
    const names = Object.keys(mcpBridge.tools);
    console.log(`已接入 MCP 服务（${names.length} 个工具：${names.join(", ")}）`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // P3a 安全护栏装配：任一开关开启时给 MCP 工具套闸（闸门需要 rl 读确认答案，
  // 所以装配点放在 rl 创建之后、REPL 循环之前）。未配置任何开关 → 整段跳过，
  // 行为与引入护栏之前逐字节一致。
  const guard = readGuardSwitches();
  if (guard !== null) {
    if (mcpBridge !== undefined) {
      applyGuardsToMcpTools(tools, mcpBridge, guard, askToolConfirm(rl));
      console.log(describeActiveGuards(guard));
    } else {
      console.log("已配置安全护栏开关，但未通过 --mcp 接入外部工具，护栏本次未生效（护栏只作用于 MCP 工具）。");
    }
  }

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
