// components/DataCards.tsx —— 工具结果数据卡片：把「列表形态」的工具输出渲染成
// 用户可直接阅读的表格，不再只靠模型把数据念成文字。
//
// 为什么放在展示层：SSE 的 step 事件本来就携带 output（工具返回值，BFF 零改动），
// 数据已在消息状态里——缺的只是「看一眼形状、是列表就画表格」的纯渲染逻辑。
//
// 识别哪些 output 算「列表」（与数据源工具的实际返回形状一一对应）：
//   纯数组            → 流水 Top10 / 经营对比 / 每日明细的行集
//   {records: [...]}  → 代理商/商户名册（分页信封）
//   {agents: [...]}   → 组合矩阵（每代理商一行的汇总视图）
// 单对象（订单统计）、错误消息、带「提示」的诚实化空壳 → 不算列表，不画卡片。
"use client";

import { useState } from "react";
import type { StepRecord } from "./MessageBubble";

/** 工具名 → 卡片标题（未映射的工具不画卡片——白名单制，防误伤未来新工具） */
const TOOL_TITLES: Record<string, string> = {
  ops_tenant_top: "商家流水 Top10",
  ops_agent_compare: "代理商经营对比",
  ops_daily_details: "每日明细走势",
  ops_agent_search: "代理商名册",
  ops_tenant_search: "商户名册",
  ops_agent_daily_matrix: "各代理商每日明细矩阵",
};

/** 字段名 → 中文表头（未映射的键原样显示——新字段出现时不至于开天窗） */
const FIELD_HEADERS: Record<string, string> = {
  id: "ID",
  agentId: "代理商ID",
  tenantId: "商户ID",
  name: "名称",
  outletsName: "代理商名称",
  outletsNo: "代理商标识",
  agentName: "所属代理商",
  tenantName: "商户名称",
  agentType: "类型",
  deviceTotal: "设备总数",
  deviceNormal: "正常设备",
  deviceMaintenance: "维护中设备",
  tenantNum: "商户数",
  orderNum: "订单数",
  orderAmountNum: "订单金额",
  orderFlowAmount: "订单流水",
  soldOrderNum: "买断订单数",
  refundOrderNum: "退款订单数",
  refundOrderAmount: "退款金额",
  averageOrderAmount: "平均客单价",
  onlineDeviceNum: "在线设备",
  onlineDeviceRate: "在线率(%)",
  dateTime: "日期",
  data: "数值",
  amount: "每日金额",
  tenantAddress: "商户地址",
  status: "状态",
};

/** 每张表格最多铺多少行——超出折叠（名册 pageSize=10 恰好不折叠） */
const MAX_ROWS = 10;

/** 给模型的指令性字段（提示/说明）不进表格——那是内部话语，不是给用户看的数据 */
const HIDDEN_FIELDS = new Set(["提示", "说明"]);

/** 从 step 提取「行数组」：纯数组 / {records} 名册 / {agents} 矩阵，三种形状统一 */
function extractRows(output: unknown): { rows: Record<string, unknown>[]; kind: "array" | "records" | "matrix" } | null {
  if (Array.isArray(output) && output.length > 0) {
    const rows = output.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
    return rows.length > 0 ? { rows, kind: "array" } : null;
  }
  if (typeof output !== "object" || output === null) return null;
  const obj = output as Record<string, unknown>;
  // 名册信封：records 数组非空才算列表（空壳带「提示」的是诚实化信号，交模型转述）
  if (Array.isArray(obj.records) && obj.records.length > 0) {
    const rows = obj.records.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
    return rows.length > 0 ? { rows, kind: "records" } : null;
  }
  // 组合矩阵：agents 数组，每行含 orderNum/amount 稀疏字典（表格里拍平成紧凑字符串）
  if (Array.isArray(obj.agents) && obj.agents.length > 0) {
    const rows = obj.agents.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
    return rows.length > 0 ? { rows, kind: "matrix" } : null;
  }
  return null;
}

/** 单元格值 → 展示文本：字典（矩阵的 orderNum/amount）拍平成 "09/01:2, 09/02:3"；
 *  布尔/数字直取；对象其余形状 JSON 兜底；空字典显示 — */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "—";
    return entries.map(([k, v]) => `${k}:${String(v)}`).join(", ");
  }
  return String(value);
}

/** 行对象的可见列：取第一条的键序（同形状行键一致），剔除给模型的指令字段，上限 8 列防溢出 */
function columnsOf(rows: Record<string, unknown>[]): string[] {
  const keys = Object.keys(rows[0] ?? {}).filter((key) => !HIDDEN_FIELDS.has(key));
  return keys.slice(0, 8);
}

function DataTable({ rows }: { rows: Record<string, unknown>[] }): React.ReactNode {
  const [expanded, setExpanded] = useState(false);
  const cols = columnsOf(rows);
  const visible = expanded ? rows : rows.slice(0, MAX_ROWS);
  const overflow = rows.length - MAX_ROWS;

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {cols.map((col) => (
                <th
                  key={col}
                  className="whitespace-nowrap border-b border-gray-200 bg-gray-50 px-2.5 py-1.5 text-left font-medium text-gray-500"
                >
                  {FIELD_HEADERS[col] ?? col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, i) => (
              <tr key={i} className={i % 2 === 1 ? "bg-gray-50/60" : ""}>
                {cols.map((col) => (
                  <td key={col} className="max-w-56 truncate whitespace-nowrap border-b border-gray-100 px-2.5 py-1.5 text-gray-700" title={cellText(row[col])}>
                    {cellText(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-xs text-blue-600 hover:text-blue-700 hover:underline"
        >
          {expanded ? "收起" : `还有 ${overflow} 行，展开全部`}
        </button>
      )}
    </div>
  );
}

/** 数据卡片组：过滤出「列表形态」的 step，逐个画卡片；一条回答可能多次调用工具，依次排开 */
export default function DataCards({ steps }: { steps: StepRecord[] }): React.ReactNode {
  const cards = steps
    .map((step) => {
      const title = TOOL_TITLES[step.toolName];
      if (title === undefined) return null; // 白名单外的工具不画
      const extracted = extractRows(step.output);
      if (extracted === null) return null; // 非列表形态（单对象/空壳/错误）不画
      return { key: step.step, title, rows: extracted.rows, total: extracted.kind === "records" && typeof (step.output as { total?: unknown }).total === "number" ? (step.output as { total: number }).total : extracted.rows.length };
    })
    .filter((card): card is NonNullable<typeof card> => card !== null);

  if (cards.length === 0) return null;

  return (
    <div className="mb-2 space-y-2">
      {cards.map((card) => (
        <div key={card.key} className="overflow-hidden rounded-lg border border-gray-200">
          <div className="flex items-center justify-between bg-gray-50 px-3 py-1.5">
            <span className="text-xs font-medium text-gray-600">📊 {card.title}</span>
            <span className="text-[11px] text-gray-400">{card.total} 条</span>
          </div>
          <DataTable rows={card.rows} />
        </div>
      ))}
    </div>
  );
}
