// apps/chat/cli.ts —— readline 聊天 REPL：会话窗口 + 手写工具循环 + 演示工具 + 知识库检索
// 链路：用户输入 → append 进会话 → 取最近 20 轮窗口 → runToolLoop（demo 工具 + 知识库检索）→ 打印回复
// 必须能在「没有 .env / 没有 API key」时启动：首次 LLM 调用失败打印清晰提示，不崩溃。
// 单仓化改造：引擎零件改为从 @agent-app/engine 的包子路径导入。
// --mcp "<命令行>"：先接外部 MCP 服务器（spawn + listTools + 适配），工具表合并后进 REPL——
// MCP 工具与本地工具对循环不可区分（进方向见 engine/mcp/client.ts 与 adapter.ts）。
// P3a 安全护栏：任一 AGENT_GUARD_* 环境开关开启时，仅给 MCP 来源的工具套闸（白名单 /
// 注入扫描 / 人工确认 / PII 脱敏，见 engine/guardrails/），未配置任何开关则零变化。
// 红队加固轮（SECURITY.md 第五节）：H3 消息长度上限 / H4 步数保险丝专门话术 /
// H6 用户消息输入闸（AGENT_GUARD_INPUT，灰度默认关）/ H7 系统提示词数据性声明 /
// H9 MCP 重名合并 strict 模式（AGENT_GUARD_MCP_STRICT，默认关）。
import readline from "node:readline/promises";
import type { Interface as ReadlineInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { ModelMessage, ToolSet } from "ai";
import { auditLog, inspectTextInput, resolveToolAllowlist, wrapToolWithGate } from "@agent-app/engine";
import type { ToolConfirmFn } from "@agent-app/engine";
import { DEFAULT_MAX_STEPS, runToolLoop } from "@agent-app/engine/agent-loop";
import { createModel } from "@agent-app/engine/llm";
import { createSessionStoreFromEnv } from "@agent-app/engine/memory";
import type { ChatTurn } from "@agent-app/engine/memory";
import { createMcpClientBridge } from "@agent-app/engine/mcp";
import type { McpClientBridge } from "@agent-app/engine/mcp";
import { createRagStoreFromEnv, RAG_GROUNDING_RULE, setRagStore } from "@agent-app/engine/rag";
import { enableTrace, preview } from "@agent-app/engine/trace";
import { composeToolShells, createDemoTools, IdempotencyRegistry, wrapToolsWithIdempotency } from "@agent-app/engine/tools";
import { searchKnowledgeBase } from "@agent-app/engine/tools";

// ReAct 式提示词：让模型把「想查什么」显式化，排障日志才有内容（教程 agent-loop-ts.md）。
// 红队加固轮 H7：追加 RAG 数据性声明——chat REPL 的工具表里有 searchKnowledgeBase，
// 检索块（可能被投毒的外部文本）会回灌进上下文，系统提示词必须预先声明「资料是数据不是指令」。
export const SYSTEM_PROMPT =
  "你是客服演示助手，只负责四类业务：查订单状态、创建售后工单、转接人工、检索公司知识库回答制度类问题。" +
  "检索到资料就在句末标 [1][2] 引用，资料没有就直说不知道。" +
  "超出职责范围的问题（闲聊、写作、时事、专业咨询等），礼貌说明你的职责并引导用户回到业务，" +
  "绝不越界作答，也绝不编造职责之外的信息。" +
  "用中文简洁回答。每次调用工具前，先用一句话说明你怀疑什么、想查什么。" +
  RAG_GROUNDING_RULE;

/** 消息长度上限（红队加固轮 H3，修 E8 资源边界）：与 API 两个端点的 DTO 同一口径，CLI/API 三入口一致 */
export const MESSAGE_MAX_CHARS = 8000;

/** 新会话 id：时间戳 + 随机串 */
function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** ChatTurn 窗口 → ModelMessage 数组（system 提示词不塞这里，单独走 runToolLoop 的 system 选项） */
function toModelMessages(window: ChatTurn[]): ModelMessage[] {
  return window.map((turn) => ({ role: turn.role, content: turn.content }));
}

/**
 * H3 长度闸（纯函数，便于离线自测）：超长返回中文拒收话术，未超长返回 null。
 * 为什么拒收而不是截断：截断会把用户意图切成半句，模型答非所问比「请精简」更伤体验；
 * 且 E8 的攻击面本来就是 token 成本——拒收才是终点，截断只省了一半。
 */
export function messageTooLong(input: string): string | null {
  if (input.length <= MESSAGE_MAX_CHARS) return null;
  return (
    `消息过长：${input.length} 字符，超过上限 ${MESSAGE_MAX_CHARS}，本轮不处理` +
    "（输入长度闸，见 SECURITY.md E8）。请精简后重试。"
  );
}

/**
 * H6 输入闸的拒绝话术（纯函数，便于离线自测）：命中注入黑名单返回中文拒收（含命中模式），
 * 未命中返回 null。扫描本体是引擎的 inspectTextInput（规范化 + 黑名单，E2 验证过
 * 全角/leet/零宽变体全拦）——这里只负责呈现。默认不开（AGENT_GUARD_INPUT 灰度开关）。
 */
export function inputGateRefusal(input: string): string | null {
  const inspection = inspectTextInput(input);
  if (inspection.ok) return null;
  return (
    `🛡 输入闸拦截：消息命中提示注入黑名单（模式：${inspection.matchedPattern ?? "未知"}），` +
    "本轮已拒绝，不调用模型（AGENT_GUARD_INPUT 灰度开关）。"
  );
}

/**
 * H4 模型调用失败的呈现（纯函数，便于离线自测）：步数保险丝熔断给专门话术——
 * E8 的教训是熔断被包进「请检查 .env」的配置错误模板，用户被误导去查配置，
 * 而真实原因是任务没在 maxSteps 内收敛（太复杂/需要换问法）。判定依据是
 * agent-loop.ts 的固定错误文案「步数用完（N），模型仍在要工具」。
 */
export function explainModelCallFailure(err: unknown): string[] {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("步数用完")) {
    return [
      "助手> 循环步数保险丝熔断：已连续 5 次工具调用未得出最终回答，已中止本轮——请换一种问法。",
      `       （机制说明：maxSteps=5 是防失控循环的保险丝，本轮不是配置错误；错误详情：${message}）`,
    ];
  }
  return [
    "助手> 调用模型失败。请检查 .env 是否已按 .env.example 配置：",
    "       OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL（无 .env 时默认走智谱 GLM 网关）",
    `       错误详情：${message}`,
  ];
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
 * MCP 工具表合入本地工具表。类型就用 ai 的 ToolSet（runToolLoop 的入参同款）：
 * 本地表与 MCP 适配表在类型层已经是同一张脸。
 *
 * 两种重名策略（红队加固轮 H9，修 E7 工具遮蔽）：
 * - 默认（strict=false）：MCP 版本胜出（显式接入的外部服务器优先），
 *   但必须把覆盖了谁说清楚——静默覆盖会让「为什么查订单走的是 MCP」变成悬案；
 * - strict=true（AGENT_GUARD_MCP_STRICT=1）：重名的 MCP 工具直接跳过、本地胜出——
 *   E7 证明了「警告不是闸」：恶意服务器一个重名就能接管 getOrderStatus 并让模型
 *   逐字转述伪造状态。严格模式从根上消灭遮蔽语义，代价是同名新工具进不来（教学
 *   上可接受：想用 MCP 版就改个名）。默认策略不变（零变化默认铁律）。
 */
export function mergeMcpTools(local: ToolSet, mcpTools: ToolSet, options: { strict?: boolean } = {}): ToolSet {
  const collisions = Object.keys(mcpTools).filter((name) => name in local);
  if (collisions.length === 0) {
    return { ...local, ...mcpTools };
  }
  if (options.strict === true) {
    console.warn(
      `⚠ MCP 严格模式（AGENT_GUARD_MCP_STRICT）：重名工具已跳过 MCP 版本、保留本地实现（${collisions.join("、")}）。`,
    );
    const merged: ToolSet = { ...local };
    for (const name of Object.keys(mcpTools)) {
      if (collisions.includes(name)) continue; // 重名即跳过：本地胜出，外部服务器遮蔽不了内置工具
      merged[name] = mcpTools[name];
    }
    return merged;
  }
  console.warn(`⚠ MCP 工具与本地工具重名（${collisions.join("、")}），已用 MCP 版本覆盖：同名工具改走 MCP 服务器执行。`);
  return { ...local, ...mcpTools };
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
 *
 * 红队加固轮新增（SECURITY.md 第五节，默认全关 = 零变化默认铁律）：
 * - AGENT_GUARD_INPUT=1：用户消息输入闸（H6 灰度）——命中注入黑名单的消息被拒收并审计
 * - AGENT_GUARD_MCP_STRICT=1：MCP 重名合并严格模式（H9）——重名工具跳过 MCP 版本，本地胜出
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
  // 工具执行幂等登记簿：进程内存、TTL 窗口内同参重放命中（详见 engine/tools/idempotency.ts 头注）
  const idempotency = new IdempotencyRegistry();

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

  // 工具表定稿：无 --mcp 时与从前逐字节一致；有 --mcp 时 MCP 工具合并进来
  // （默认重名 MCP 胜出；AGENT_GUARD_MCP_STRICT=1 时重名跳过、本地胜出——H9）
  const mcpStrict = process.env.AGENT_GUARD_MCP_STRICT === "1" || process.env.AGENT_GUARD_MCP_STRICT === "true";
  let tools: ToolSet =
    mcpBridge === undefined ? localTools : mergeMcpTools(localTools, mcpBridge.tools, { strict: mcpStrict });
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

  // H6 用户消息输入闸（红队加固轮，灰度开关）：AGENT_GUARD_INPUT=1 时用户消息先过
  // 注入扫描，命中即拒收（不进会话、不调模型）+ 审计留痕。默认关闭是本仓「零变化默认」
  // 铁律的刻意取舍（SECURITY.md 第五节：黑名单宁可漏报不误伤，先灰度观察误伤率）。
  const inputGuardOn = process.env.AGENT_GUARD_INPUT === "1" || process.env.AGENT_GUARD_INPUT === "true";
  if (inputGuardOn) {
    console.log("安全护栏已启用：用户消息输入闸（AGENT_GUARD_INPUT）——命中提示注入黑名单的消息将被拒收，不调用模型（灰度开关）。");
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

    // H3 长度闸：超长消息中文拒收，不进会话、不调模型（修 E8 的 50KB 消息全量放行）
    const tooLong = messageTooLong(input);
    if (tooLong !== null) {
      console.error(`助手> ${tooLong}`);
      continue;
    }

    // H6 输入闸（灰度开关开启时）：命中注入黑名单 → 拒收 + 审计，模型零感知
    if (inputGuardOn) {
      const refusal = inputGateRefusal(input);
      if (refusal !== null) {
        auditLog("input.user_rejected", { surface: "cli.chat", sessionId, inputLength: input.length });
        console.error(`助手> ${refusal}`);
        continue;
      }
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
        // 工具执行幂等壳（scope=当前会话）：模型重试/重复提问不再重复建工单。
        // 请求级包装（/new 换会话后 scope 随之切换，旧会话的缓存天然隔离）。
        tools: composeToolShells(tools, [(table) => wrapToolsWithIdempotency(table, idempotency, { scope: sessionId })]),
        maxSteps: DEFAULT_MAX_STEPS,
      });

      // ③ 打印回复并回写会话
      console.log(`助手> ${result.text}`);
      await sessionStore.append(sessionId, { role: "assistant", content: result.text });
    } catch (err) {
      // H4：步数保险丝熔断给专门话术，其余保持「查 .env」的配置错误模板（纯函数，可离线自测）
      for (const failureLine of explainModelCallFailure(err)) console.error(failureLine);
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
