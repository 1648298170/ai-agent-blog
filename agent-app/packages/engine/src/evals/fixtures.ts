// fixtures.ts —— 评测专用夹具：三个确定性演示工具 + 把脚本变成假模型的工厂
//
// ── 为什么不用真的 tools/registry（demo-tools）而要另造一套 ───────────────
// 轨迹评测评的是「模型选了哪个工具、循环按什么顺序执行」，不是业务本身：
//   1. 真 registry 里的 kb-search 会触发 embedding 网络调用——离线铁律被破；
//   2. 工具名即断言对象（search_orders / query_logistics / create_ticket），
//      评测要的是电商客服语义的稳定词表，跟演示工具的命名解耦，两边任一方
//      改名都不会误伤对方；
//   3. execute 全部返回固定 JSON：观察（工具输出）不影响判定（工具序列），
//      打分 100% 可复现。
//
// ── 为什么用 MockLanguageModelV2 而不是自己 mock generateText ────────────
// 评测要穿透 REAL 的 runToolLoop（generateText → 入账 → 调度 → 回灌全走真代码），
// 只把最外端的「模型」换成脚本——夹具换的是环境，不是被测系统。
// ai/test 的 MockLanguageModelV2 是官方提供的这个接缝，类型与真实模型
// 完全同构（LanguageModelV2），编译期就能发现协议形状漂移。
import { tool } from "ai";
import type { LanguageModel, ToolSet } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { z } from "zod";
import type { ScriptedModelTurn } from "./types.js";

/**
 * 评测专用工具表：三个工具 + 固定假数据。
 * execute 刻意做成最平凡的同步返回（无随机、无时间戳、无网络）——
 * 工具输出不参与打分，稳定性是它唯一的职责。
 */
export function createEvalTools(): ToolSet {
  return {
    search_orders: tool({
      description: "按手机尾号或姓名搜索用户名下的订单号列表",
      inputSchema: z.object({
        keyword: z.string().describe("手机尾号四位或收货人姓名"),
      }),
      execute: async ({ keyword }) => ({
        keyword,
        orders: [
          { orderId: "A-1024", status: "已发货", createdAt: "2026-09-25" },
          { orderId: "A-2048", status: "仓库打包中", createdAt: "2026-09-27" },
        ],
      }),
    }),
    query_logistics: tool({
      description: "按订单号查询物流状态、承运公司与运单号",
      inputSchema: z.object({
        orderId: z.string().describe("订单号，如 A-1024"),
      }),
      execute: async ({ orderId }) => ({
        orderId,
        status: "已发货",
        carrier: "顺丰速运",
        trackingNo: "SF1234567890",
        eta: "明天 18 点前送达",
      }),
    }),
    create_ticket: tool({
      description: "为用户创建客服工单（投诉 / 退货 / 催单等需要跟进的事项）",
      inputSchema: z.object({
        subject: z.string().describe("工单主题，一句话概括"),
        description: z.string().describe("问题的详细描述"),
      }),
      execute: async ({ subject, description }) => ({
        // 固定工单号：真实 demo-tools 用时间戳+序号，评测里那是不确定性来源
        ticketId: "TK-EVAL-0001",
        subject,
        description,
        status: "已创建",
      }),
    }),
  };
}

/** 假模型的用量上报：全 0（形状要合规，数值没人消费） */
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** doGenerate 的返回形状（从协议类型反推，避免手写长类型漂移） */
type ScriptedResponse = Awaited<ReturnType<LanguageModelV2["doGenerate"]>>;

/**
 * 把脚本编排变成一个假模型：每次被调用按序吐出 script 里的一轮。
 * - text 轮 → content 只有一条 text part，finishReason "stop"（循环出口）；
 * - tool-calls 轮 → content 是 tool-call part（input 必须是字符串化 JSON，
 *   与 LanguageModelV2ToolCall 的协议一致），finishReason "tool-calls"。
 *
 * 脚本用尽时抛中文错误：这一定是 dataset 编排漏了 text 收尾轮，
 * 错误信息直接告诉维护者去哪修（错误礼仪同 embedder.ts 的 configError）。
 */
export function createScriptedModel(script: ScriptedModelTurn[]): LanguageModel {
  let cursor = 0;
  return new MockLanguageModelV2({
    doGenerate: async (): Promise<ScriptedResponse> => {
      const index = cursor;
      cursor += 1;
      const turn = script[index];
      if (turn === undefined) {
        throw new Error(
          `评测脚本用尽：模型第 ${index + 1} 次被调用，但脚本只编排了 ${script.length} 轮。` +
            "请检查 dataset 中该用例的 script——工具轮之后必须编排一个 text 轮作最终回答，工具循环才有出口。",
        );
      }
      if (turn.kind === "text") {
        return {
          content: [{ type: "text", text: turn.text }],
          finishReason: "stop",
          usage: ZERO_USAGE,
          warnings: [], // 脚本化模型永远不产生告警（协议必填字段，空数组即「无告警」）
        };
      }
      return {
        content: turn.calls.map((call, i) => ({
          type: "tool-call" as const,
          toolCallId: `eval-call-${index}-${i}`, // 同一轮内唯一即可，SDK 用它对账
          toolName: call.toolName,
          input: JSON.stringify(call.input),
        })),
        finishReason: "tool-calls",
        usage: ZERO_USAGE,
        warnings: [],
      };
    },
  });
}
