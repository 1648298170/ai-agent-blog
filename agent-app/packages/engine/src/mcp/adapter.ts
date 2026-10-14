// mcp/adapter.ts —— MCP 工具描述符 → 引擎 AgentTool 的单向适配器
//
// ── 为什么要有这一层（先说为什么，再说怎么做）──────────────────────────────
// server.ts 解决的是「把引擎工具递出去」；本文件解决的是「把外部 MCP 服务器的
// 工具接进来」。接进来的工具要能直接塞进 runToolLoop 的 ToolSet——循环只认
// { description, inputSchema, execute }，不问工具出身：MCP 工具与本地工具
// 对循环不可区分，这就是接入侧的全部设计目标。
//
// ── schema 的照单全收原则 ────────────────────────────────────────────────
// 生态里 MCP 服务器的工具 schema 是 JSON Schema（我们不认识、也不可能预知），
// 适配器不复制也不改写它：ai 的 jsonSchema() 把原始 JSON Schema 包装成 SDK
// 认识的 Schema 对象，原样透传给模型（参数图纸由服务器说了算），校验责任
// 也在服务器侧（MCP SDK 按 inputSchema 校验后才回调 execute）。所以本文件
// 刻意不 import zod——一旦引了 zod 就等于替服务器"翻译"schema，翻译即失真。
//
// ── 依赖倒置：适配器不认识 SDK 的 Client 类 ──────────────────────────────
// 适配器只依赖一个最小结构接口 McpToolCaller（能 callTool 即是"客户端"）：
// 真实链路里传入 SDK Client 实例（结构兼容，零包装）；单元测试里传一个
// 手写的桩对象就能测 isError / 内容映射，不需要任何传输层。
//
// ── 调用超时（BACKLOG：外部服务器挂起防线）──────────────────────────────
// callTool 挂起（外部服务器无响应）时 execute 会永远等下去，循环卡死。
// execute 内对 callTool 做超时包装：超时抛中文错误、循环的 errorOutput 通道
// 接住它。注意 Promise.race 不会取消底层请求——SDK 的挂起请求仍在（内存中
// 等待响应到来后被丢弃），但调用方已经解脱，循环可以继续。
// 超时默认 60s（AGENT_MCP_TOOL_TIMEOUT_MS 可配，0 = 关闭超时回到现状）。
import { jsonSchema, tool } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { AgentTool } from "../types.js";
import { loadEnv } from "../config.js";

/**
 * 适配器愿意打交道的最小客户端面（依赖倒置的接缝）：
 * 只要能 callTool 就是"客户端"——SDK 的 Client 结构兼容此接口，
 * 测试桩只需要实现这一个方法。
 */
export interface McpToolCaller {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpToolCallResult>;
}

/**
 * callTool 结果里适配器消费的字段（SDK 真实返回形状的最小投影）：
 * - content：内容块数组（text / image / audio / resource…），适配器只读 text 块
 * - structuredContent：程序可读的结构化结果（server.ts 双通道输出的另一条）
 * - isError：服务器侧执行失败的标记（协议约定：错误也走正常返回，不抛异常）
 * - toolResult：旧版（2024-11-05 协议）兼容形状的兜底字段
 * 索引签名保持宽进：SDK 的联合返回类型（新形状 | 兼容形状）都能装进来。
 */
export interface McpToolCallResult {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  toolResult?: unknown;
  [key: string]: unknown;
}

/** MCP 工具描述符：listTools 返回条目的最小投影（name + 描述 + JSON Schema 参数图纸） */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: JSONSchema7;
}

/** 适配选项：callTool 的超时毫秒数（缺省读 AGENT_MCP_TOOL_TIMEOUT_MS，再缺省 60000；0 = 关闭超时） */
export interface McpAdapterOptions {
  timeoutMs?: number;
}

/** 解析 callTool 超时：注入 > env > 默认 60s（0 显式关闭，回到「无限等」的现状行为） */
export function resolveMcpCallTimeoutMs(
  env: Record<string, string> = loadEnv(),
  options?: McpAdapterOptions,
): number {
  if (options?.timeoutMs !== undefined) return options.timeoutMs;
  const raw = Number.parseInt(env.AGENT_MCP_TOOL_TIMEOUT_MS ?? "", 10);
  if (Number.isInteger(raw) && raw >= 0) return raw;
  return 60_000;
}

/** 运行时收窄：非 null 的普通对象（structuredContent 通道只认它） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 从内容块数组里拼接文本：只认 { type: "text", text } 块，按序拼接（多块用换行分隔）。
 * 一块文本都没有时返回 undefined——调用方据此区分「纯文本工具」与「不含可读文本」。
 */
function joinTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (isPlainObject(block) && block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** 错误场景下尽力拼出服务器想说的话（isError 时正文就是错误说明） */
function describeResult(result: McpToolCallResult): string {
  const text = joinTextContent(result.content);
  if (text !== undefined) return text;
  return `内容块类型：${Array.isArray(result.content) ? result.content.map((b) => (isPlainObject(b) ? String(b.type) : typeof b)).join("、") : String(result.content)}`;
}

/** callTool 超时包装：race 不取消底层请求，但调用方解脱、循环可继续 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  if (timeoutMs <= 0) return promise; // 0 = 显式关闭超时（无限等，现状行为）
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `MCP 工具 ${toolName} 调用超时（${timeoutMs}ms 无响应）。` +
            "外部服务器可能已挂起：请检查服务器进程，或调整 AGENT_MCP_TOOL_TIMEOUT_MS（设 0 关闭超时）。",
        ),
      );
    }, timeoutMs);
    timer.unref(); // 不挡进程退出
  });
  return Promise.race([promise, timeout]);
}

/**
 * 把一个 MCP 工具描述符适配成引擎 AgentTool。
 *
 * - inputSchema：jsonSchema() 包装服务器声明的原始 JSON Schema（类型不兼容时
 *   的备选方案是宽松 z.record + 在 execute 里手工校验——本版本 ai 5.0.267
 *   的 FlexibleSchema 直接接受 Schema 对象，实测通过，备选方案未启用）
 * - execute：callTool 往返（超时包装）+ 结果映射（structuredContent 优先，
 *   文本块拼接兜底，isError / 传输层失败抛带修复指引的中文错误）
 */
export function mcpToolToAgentTool(
  caller: McpToolCaller,
  descriptor: McpToolDescriptor,
  options?: McpAdapterOptions,
): AgentTool {
  // 超时在装配期解析一次（env 一次读定，调用期零开销）
  const timeoutMs = resolveMcpCallTimeoutMs(undefined, options);
  return tool({
    description: descriptor.description ?? descriptor.name,
    inputSchema: jsonSchema<unknown>(descriptor.inputSchema),
    execute: async (input) => {
      // 入参收窄：静态类型是 unknown（照单全收），运行时只放行「对象或缺省」——
      // 模型若给出数组/字符串，MCP 侧的 arguments 也装不下，先在这里说清楚。
      let args: Record<string, unknown> | undefined;
      if (input === undefined) {
        args = undefined; // 无参工具：模型可以完全不给参数
      } else if (isPlainObject(input)) {
        args = input;
      } else {
        throw new Error(
          `MCP 工具 ${descriptor.name} 的入参必须是对象，模型传来了 ${Array.isArray(input) ? "数组" : typeof input}。` +
            "请检查服务器声明的 inputSchema 是否为 object 类型，或修正模型的调用参数。",
        );
      }

      let result: McpToolCallResult;
      try {
        result = await withTimeout(
          caller.callTool({ name: descriptor.name, arguments: args }),
          timeoutMs,
          descriptor.name,
        );
      } catch (err) {
        // 超时错误已带中文指引（withTimeout 抛出），只透传不重复包装；
        // 其余按连接/传输层失败处理：原样透传会是一串英文协议栈，
        // 换成中文并保留原始信息，让使用者知道下一步查什么。
        if (err instanceof Error && err.message.startsWith(`MCP 工具 ${descriptor.name} 调用超时`)) throw err;
        throw new Error(
          `MCP 工具 ${descriptor.name} 调用失败（连接或传输层）：${err instanceof Error ? err.message : String(err)}。` +
            "请检查 MCP 服务器进程是否存活、--mcp 命令行是否正确（Windows 下 pnpm/npx 等 .cmd 命令需要 cmd /c 前缀）。",
        );
      }

      // 协议约定：服务器侧执行失败也走正常返回，靠 isError 标记——翻译成异常，
      // 引擎循环的 errorOutput 通道（✗ 观察）才能接住它。
      if (result.isError === true) {
        throw new Error(
          `MCP 工具 ${descriptor.name} 返回错误：${describeResult(result)}。` +
            "请修正调用参数后重试；若持续失败，请查看 MCP 服务器日志定位原因。",
        );
      }

      // ① structuredContent 通道：程序读的结构化结果，原样上抛（server.ts 双通道的正主）
      if (isPlainObject(result.structuredContent)) {
        return result.structuredContent;
      }
      // ② text 内容块拼接：纯文本工具（无 structuredContent）的常规形态
      const text = joinTextContent(result.content);
      if (text !== undefined) {
        return text;
      }
      // ③ 旧协议兼容形状兜底：没有 content/structuredContent 但有 toolResult
      if (result.content === undefined && result.toolResult !== undefined) {
        return result.toolResult;
      }
      // ④ 真的没东西可映射（纯图片/音频工具、空返回）：宁可报错也不静默吞掉
      throw new Error(
        `MCP 工具 ${descriptor.name} 返回了无法映射的内容（${describeResult(result)}）。` +
          "当前适配器只支持 structuredContent 与 text 内容块；图片/音频类工具结果暂未适配。",
      );
    },
  });
}
