// demo-tools.ts —— 三个 zod-schema 演示工具：查订单 / 建工单 / 转人工
// 数据全是 mock：本阶段验证的是「工具循环 + 调度」这条路，不是业务本身。
// 转人工返回 HandoffPack（上下文包）：让接手人拿到完整背景，是体验的分水岭
// （见教程 products/service.md《客服系统》的 HandoffPack 设计）。
import { tool } from "ai";
import { z } from "zod";

/** 转人工上下文包：工单号 + 原因 + 会话记录 + 时间，接手人的第一眼信息 */
export interface HandoffPack {
  ticketId: string;
  reason: string;
  transcript: string;
  createdAt: string;
}

// 演示用工单号生成器：日期 + 递增序号，进程内保证不重复
let ticketSeq = 0;
function nextTicketId(): string {
  ticketSeq += 1;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `TK-${date}-${String(ticketSeq).padStart(4, "0")}`;
}

// mock 订单表：固定几条演示数据（教程 agent-loop-ts.md 里 getOrderByNo 的同款题材）
const ORDERS: Record<string, { status: string; eta: string }> = {
  "A-1024": { status: "已发货", eta: "明天 18 点前送达" },
  "A-2048": { status: "仓库打包中", eta: "后天发出" },
  "B-0001": { status: "已签收", eta: "无" },
};

/** 按订单号查询订单状态与预计送达时间 */
export const getOrderStatus = tool({
  description: "按订单号查询订单状态与预计送达时间",
  inputSchema: z.object({
    orderId: z.string().describe("订单号，如 A-1024"),
  }),
  execute: async ({ orderId }) => {
    const order = ORDERS[orderId];
    if (order) {
      return { orderId, status: order.status, eta: order.eta };
    }
    return { orderId, status: "未找到", eta: "请确认订单号是否正确" };
  },
});

/** 为用户创建客服工单，返回工单号 */
export const createTicket = tool({
  description: "为用户创建客服工单，返回工单号",
  inputSchema: z.object({
    subject: z.string().describe("工单主题，一句话概括问题"),
    description: z.string().describe("问题的详细描述"),
  }),
  execute: async ({ subject, description }) => {
    return { ticketId: nextTicketId(), subject, description, status: "已创建" };
  },
});

/** 转接人工客服：AI 判断接不住或用户明确要求时调用，携带完整上下文 */
export const escalateToHuman = tool({
  description: "转接人工客服：AI 判断接不住或用户明确要求时调用，携带完整上下文",
  inputSchema: z.object({
    reason: z.string().describe("转人工原因，一句话"),
    transcript: z.string().describe("当前会话的关键对话记录，让接手人不用重新问"),
  }),
  execute: async ({ reason, transcript }): Promise<HandoffPack> => {
    return {
      ticketId: nextTicketId(),
      reason,
      transcript,
      createdAt: new Date().toISOString(),
    };
  },
});

/** 打包成 { 工具名: 工具 } 对象，chat REPL 直接喂给 runToolLoop */
export function createDemoTools() {
  return { getOrderStatus, createTicket, escalateToHuman };
}
