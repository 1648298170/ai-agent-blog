// types.ts —— 引擎层的共享类型：AgentTool 建立在 ai 的 tool() + zod 之上，
// 以及消息类型的统一出口。工具实现见 tools/ 目录，循环调度见 agent-loop.ts。
import type { ModelMessage, Tool, ToolSet } from "ai";
import type { z } from "zod";

/**
 * 项目统一的工具类型：INPUT/OUTPUT 写 zod schema 类型，经 z.output 映射到 ai 的 Tool。
 * ai v5 里 Tool<INPUT, OUTPUT> 的泛型是「解析后的输入输出类型」而非 schema 类型，
 * 所以这里做一层映射：AgentTool<typeof mySchema> ≡ Tool<z.infer<typeof mySchema>>。
 * - inputSchema 用 zod 写（生成与校验同一张图纸）
 * - execute 可缺省：不写 execute，SDK 认为调度方自己执行（手写循环的教程用法）
 * - OUTPUT 默认 any 与 ai 官方 Tool 的默认一致：toModelOutput 对 OUTPUT 逆变，
 *   收窄成 unknown 会让具体工具塞不进注册表
 */
export type AgentTool<INPUT extends z.ZodType = z.ZodType, OUTPUT = any> = Tool<
  z.output<INPUT>,
  OUTPUT
>;

/** 一套工具表：名字 → 工具。直接复用 ai 的 ToolSet（generateText 的 tools 参数同款） */
export type AgentToolSet = ToolSet;

/** 消息类型统一出口：手拼 role: "tool" 消息时，形状拼错 tsc 当场标红 */
export type { ModelMessage };
