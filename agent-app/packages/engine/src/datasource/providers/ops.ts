// providers/ops.ts —— ops 第三方运营后台数据源插件（第一个第三方接入）。
// 为什么是插件而不是直接写进 chat：业务数据在第三方手里，认证方式、字段口径、
// 错误形态都由对方定义——把它们隔离在 provider 文件里，chat 服务只认
// DataSourceProvider 契约。以后换后台/加后台，这里整个文件替换或新增即可。
//
// 接口契约（2026-09 直连 OpenAPI 导出实测）：全 GET、参数平铺为 query string
// （Spring @ModelAttribute 风格），响应统一包 {code, message, data}，
// code 为 0 或 200 视为成功。六个端点分两组：
//
// 【名册组 /platform/*】名字 → ID 的桥（用户说「广东深圳」时先来这查 ID）：
//   GET /platform/agent/page       分页查代理商（searchDTO.name 模糊）→ agentId
//   GET /platform/tenant/pageTenant 分页查商户（searchReq.tenantName 模糊）→ 商户ID
//   名册行自带订单数/设备数等汇总，简单问题名册一步可答；深挖才需要 ID + 下游端点。
//
// 【经营数据组 /markDashboard/*】按 ID/月份查经营数据：
//   GET /markDashboard/tenantTop      商家流水 Top10
//   GET /markDashboard/agentCompare   代理商经营数据对比（组合工具的全量代理商列表来源）
//   GET /markDashboard/orderStatistics 订单数据统计（单对象）
//   GET /markDashboard/dailyDetails   每日明细（type=1 金额 / 2 订单数）
// 经营数据组四端点各包一个工具之外，还有「组合工具」ops_agent_daily_matrix：
// agentCompare（全量代理商）→ 逐代理商 dailyDetails×2 → 合并成 每代理商×每天 矩阵——
// 因为没有任何单一端点直接返回这个形状（dailyDetails 只给平面日走势，agentCompare
// 只给月度聚合），「每个代理商每天卖了多少」只能由客户端编排两次端点得到。
//
// 认证现实（冒烟实测探明，见 ops-http.ts）：
// - OPS_BASE_URL 指到后台的 API 网关前缀（网关剥掉部署前缀再转给 Spring），
//   本文件的 /markDashboard/* 与 /platform/* 路径不变；
// - 令牌头名 Authorization、裸值无 Bearer 前缀（SPA 拦截器原样发 token）；
// - 未登录走「HTTP 200 + code=401」业务码，不是 HTTP 401。
import { tool } from "ai";
import { z } from "zod";
import { loadEnv } from "../../config.js";
import type { DataSourceProvider } from "../types.js";
import type {
  OpsAgentCompareRow,
  OpsAgentPage,
  OpsDailyDetailRow,
  OpsOrderStatistics,
  OpsTenantPage,
  OpsTenantTopRow,
} from "./ops-contracts.js";
import { callOps } from "./ops-http.js";

// ---------------------------------------------------------------------------
// 组合工具 ops_agent_daily_matrix 的装配类型与零件
// ---------------------------------------------------------------------------

/** 矩阵中单个代理商的行：两个稀疏字典（天 → 数值），只有取到数据的天才有键 */
export interface OpsAgentDailyMatrixRow {
  agentId: number;
  agentName: string;
  /** 每日订单数：{ "09/01": 3 }——缺键 = 该天无数据（不是 0，后端没给就是没卖/没回） */
  orderNum: Record<string, number>;
  /** 每日金额（元）：{ "09/01": 120.5 }——同上，稀疏 */
  amount: Record<string, number>;
}

/** 单代理商拉取失败的重试指引条目（部分结果诚实返回，不让一家失败炸掉整张矩阵） */
export interface OpsAgentDailyMatrixError {
  agentId: number;
  agentName: string;
  /** 中文错误消息（截断到 80 字，防超长 URL/堆栈把矩阵撑爆） */
  message: string;
}

/** 组合工具的返回形状：LLM 上下文感知的紧凑编码 */
export interface OpsAgentDailyMatrix {
  month: string;
  agentCount: number;
  /** 天序并集（升序）：后端给 "MM/dd"，同一月内字典序 = 时间序 */
  days: string[];
  agents: OpsAgentDailyMatrixRow[];
  errors: OpsAgentDailyMatrixError[];
  /** 空月诚实化标记：整月无任何数据时附带，提示模型如实转述（可选字段） */
  提示?: string;
}

/**
 * 手写 worker pool：固定条车道（limit 条）各自循环取下一个任务执行，
 * 任意车道完成立刻补位——比「整批等齐再下一批」吞吐高（不空转），
 * 且保证同时在飞的 HTTP 请求 ≤ limit。不引 p-limit 等新依赖，15 行以内解决。
 */
async function runPool<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  return results;
}

/** 中文错误消息截断：超过 maxLen 硬截（含 URL 的网络错误很容易过百字） */
function truncateChinese(msg: string, maxLen: number): string {
  return msg.length <= maxLen ? msg : `${msg.slice(0, maxLen)}…`;
}

/** 一次 dailyDetails 拉取的结局：成功拿行数组，或失败拿中文消息（不在这里抛） */
type DailyFetchOutcome =
  | { ok: true; rows: OpsDailyDetailRow[] }
  | { ok: false; message: string };

/**
 * 组合编排：为什么存在——用户要「某月所有代理商×每天×订单数+金额」的矩阵，
 * 没有任何单一端点返回这个形状，只能 agentCompare 拿全量代理商列表，再逐家
 * dailyDetails(type=1 金额 + type=2 订单数) 拼装。
 *
 * 三个关键取舍：
 * - 稀疏字典而非 31 槽数组：多数代理商一个月只有十来天有单，`{"09/01":3}` 比
 *   `[3,null,null,...]` 省 3~5 倍 token——每代理商 ~30-40 token，50 家 ≈ 2K，
 *   glm-4-flash 128K 窗口下安全；
 * - 并发上限 5：50 家代理商 = 101 个请求，不限流会把对方网关打挂；同一代理商的
 *   金额/订单数两个请求是独立任务，天然并行；
 * - 单代理失败不炸整矩阵：某家拉挂了就进 errors 带中文原因，其余家照常返回——
 *   部分真相好过没有真相，模型可以告诉用户「12 家里 11 家如下、1 家查询失败」。
 * agentCompare 本身失败（拿不到代理商名单）则整个工具抛中文错误，与兄弟工具同礼遇。
 */
async function buildAgentDailyMatrix(dateTime: string, token: string | undefined): Promise<OpsAgentDailyMatrix> {
  // 第一步：全量代理商列表（agentCompare 是唯一可靠的「这个月有哪些代理商」来源）
  const agents = await callOps<OpsAgentCompareRow[]>("/markDashboard/agentCompare", { dateTime }, token);

  // 第二步：压平成 代理商×{type=1,type=2} 的请求任务，交给 5 车道 pool
  const tasks = agents.flatMap((agent) =>
    ([1, 2] as const).map((type) => ({ agent, type })),
  );
  const outcomes = await runPool(tasks, 5, async ({ agent, type }) => {
    try {
      const rows = await callOps<OpsDailyDetailRow[]>(
        "/markDashboard/dailyDetails",
        { type, agentId: agent.agentId, dateTime },
        token,
      );
      return { ok: true, rows } satisfies DailyFetchOutcome;
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) } satisfies DailyFetchOutcome;
    }
  });

  // 第三步：合并矩阵。天序取所有成功序列的并集；失败的任务贡献空字典 + errors 条目
  const daySet = new Set<string>();
  const toSparse = (outcome: DailyFetchOutcome): Record<string, number> => {
    if (!outcome.ok) return {};
    for (const row of outcome.rows) daySet.add(row.dateTime);
    return Object.fromEntries(outcome.rows.map((row) => [row.dateTime, row.data]));
  };

  const rows: OpsAgentDailyMatrixRow[] = [];
  const errors: OpsAgentDailyMatrixError[] = [];
  agents.forEach((agent, i) => {
    // tasks 按 [type1, type2] 顺序压平，outcomes 与之同序：第 i 家对应 2i / 2i+1
    const amountOut = outcomes[i * 2]!;
    const orderOut = outcomes[i * 2 + 1]!;
    const failures: string[] = [];
    if (!amountOut.ok) failures.push(amountOut.message);
    if (!orderOut.ok) failures.push(orderOut.message);
    rows.push({
      agentId: agent.agentId,
      agentName: agent.agentName,
      orderNum: toSparse(orderOut),
      amount: toSparse(amountOut),
    });
    if (failures.length > 0) {
      errors.push({
        agentId: agent.agentId,
        agentName: agent.agentName,
        message: truncateChinese(failures.join("；"), 80),
      });
    }
  });

  const matrix = { month: dateTime, agentCount: agents.length, days: [...daySet].sort(), agents: rows, errors };
  // 空天诚实化（同 withEmptyNote）：整月无数据时明确告知模型，防「每天均为 0」的伪数据陈述
  return matrix.days.length === 0
    ? { ...matrix, 提示: "该月份所有代理商都没有数据记录——请如实告知用户该时间段无数据，不要以 0 填充每一天。" }
    : matrix;
}

// ---------------------------------------------------------------------------
// 名册搜索词清洗：用户话术「广东深圳这个代理商」常把类型词（代理商/商户/商家…）
// 一起带进名字参数——上游按名字模糊匹配，带类型词就不命中（2026-10 真机实测踩中）。
// 双层防御：schema describe 引导模型只传名字本身（提示层）+ execute 空结果时
// 自动剥类型词重查一次（结构层，不赌模型自觉——同 dateTimeField 的 refine 思路）。
// ---------------------------------------------------------------------------
const TYPE_SUFFIXES = ["代理商", "运营商", "商户", "商家", "公司", "门店", "代理"] as const;

/** 剥掉名字末尾的类型词（可叠多轮：「XX代理商公司」→「XX」）；纯类型词不剥（防剥成空串） */
function stripTypeSuffix(name: string): string {
  let out = name.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of TYPE_SUFFIXES) {
      if (out.length > suffix.length && out.endsWith(suffix)) {
        out = out.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return out;
}

/**
 * 名册搜索的公共编排：原词查 → 空则剥类型词重查一次 → 仍空才返回带重试指引的诚实空壳。
 * 重试命中时附「说明」字段（中性陈述，非指令）：告诉模型这次结果是剥词后的关键词命中的，
 * 方便它向用户转述「按『广东深圳』查到的」——不吞掉这次自动纠正的痕迹。
 */
async function searchRosterPage<T extends { records: unknown[] }>(
  path: string,
  keywordField: string,
  rawName: string,
  extraParams: Record<string, string | number | undefined>,
  token: string | undefined,
): Promise<unknown> {
  const search = (keyword: string) =>
    callOps<T>(path, { [keywordField]: keyword, ...extraParams, pageNum: 1, pageSize: 10 }, token);

  let page = await search(rawName);
  const stripped = stripTypeSuffix(rawName);
  if (page.records.length === 0 && stripped !== rawName.trim()) {
    page = await search(stripped);
    // 剥词重查命中：数据可信（同一端点），但向模型说明关键词曾被自动修正
    if (page.records.length > 0) {
      return { ...page, 说明: `按「${rawName}」没有直接找到，已自动去掉名称末尾的类型词、改按「${stripped}」查到以下结果。` };
    }
  }
  if (page.records.length === 0) {
    return {
      records: [],
      total: 0,
      提示: `没有找到名称匹配「${rawName}」的记录（含去掉类型词后按「${stripped}」重查）——请如实告知用户名单里没有这个名字，不要编造 ID。可以换更短的关键词（只保留名字中最有辨识度的部分）再试一次。`,
    };
  }
  return page;
}

/**
 * 空结果诚实化：上游返回空数组时附加模型可读的「无数据」声明——
 * week19 实测踩中：模型把空结果包装成「每天均为 0」的伪数据陈述，比查不到更误导。
 * 中文提示写在工具输出里，是给模型的指令（它会读工具结果），不是给用户的文案。
 */
function withEmptyNote<T>(rows: T[], dateTime: string): unknown {
  return rows.length === 0
    ? {
        data: [],
        提示: `${dateTime} 在上游系统没有任何数据记录——请如实告知用户该时间段无数据，不要编造数字，也不要以 0 填充每一天。`,
      }
    : rows;
}

/**
 * 单对象版空结果诚实化（orderStatistics 专用）：单对象端点的「查不出来」有三层——
 * ① 整个对象为 null（上游无该月数据，2026-10 真机实测踩中：null 裸透传，模型只能
 *    含糊猜「可能没数据/尚未更新」）；
 * ② 字段级 null（对象在、但个别指标上游没算出来，如 refundOrderNum: null）——
 *    弱模型会把 null 念给用户或当成 0，week19 伪零教训的字段级版本，故剔除出对象
 *    并列进提示；0 不剔除（它是合法业务值：「当月就是没有退款」≠「查不出来」）；
 * ③ 全零对象（后端有该月记录但数值全 0）。
 * 三层给模型三种明确信号，转述不再靠猜。
 */
function withEmptyObjectNote(value: OpsOrderStatistics | null, dateTime: string): unknown {
  // ① 整体缺失：上游连对象都没给
  if (value === null || value === undefined) {
    return {
      dateTime,
      提示: `上游系统对 ${dateTime} 没有返回任何统计数据（data 为空）——请如实告知用户该时间段没有数据记录，不要编造数字，也不要猜测原因。`,
    };
  }

  // ② 字段级清洗：null/undefined 指标剔除 + 列入提示（0 是合法业务值，保留）
  const entries = Object.entries(value);
  const missing = entries.filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  const present = Object.fromEntries(entries.filter(([, v]) => v !== null && v !== undefined));

  // ③ 全零判定只看幸存字段（null 字段不参与，避免「全 null」被误判成「全 0」）
  const numeric = Object.values(present).filter((v) => typeof v === "number");
  const allZero = numeric.length > 0 && numeric.every((v) => v === 0);

  if (missing.length > 0) {
    const zeroNote = allZero && numeric.length > 0 ? "；其余字段上游明确返回全 0（不是查询失败）" : "";
    return {
      ...present,
      提示: `字段 ${missing.join("、")} 上游未返回（该指标暂无数据）——请如实告知用户这些指标暂无数据，不要当成 0${zeroNote}。`,
    };
  }
  return allZero
    ? {
        ...value,
        提示: `${dateTime} 的统计数据上游明确返回全 0（不是查询失败）——如与用户预期不符，请如实说明「上游返回的数据就是 0」，不要包装成有效数据，也不要猜测原因。`,
      }
    : value;
}

// ---------------------------------------------------------------------------
// 月份字段工厂：格式 + 时间窗口双层校验（全部工具共用，DRY）
// 为什么有窗口：用户说「9月份」而未说年份时，glm-4-flash 实测幻觉出 2022-09
// （训练先验年份）——格式校验拦不住（格式合法）。refine 窗口让越界年份在 SDK 层
// 直接校验失败，错误回灌给模型强制按当前年份重试——结构性修复，不赌模型自觉。
// 窗口以今天为锚：最早 24 个月前，最晚下个月（覆盖未来排期查询）。
// ---------------------------------------------------------------------------
const MONTH_WINDOW_MIN_MONTHS_AGO = 24;
const MONTH_WINDOW_MAX_MONTHS_AHEAD = 1;

function inMonthWindow(dateTime: string): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(dateTime);
  if (m === null) return false;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  const now = new Date();
  const min = new Date(now.getFullYear(), now.getMonth() - MONTH_WINDOW_MIN_MONTHS_AGO, 1);
  const max = new Date(now.getFullYear(), now.getMonth() + MONTH_WINDOW_MAX_MONTHS_AHEAD, 1);
  return t >= min && t <= max;
}

/** 全工具共用的月份字段：格式（yyyy-MM）+ 时间窗口（refine），模型越界年份会被 SDK 层拒绝并重试 */
function dateTimeField() {
  return z
    .string()
    .regex(/^\d{4}-\d{2}$/, "月份格式必须是 yyyy-MM（如 2026-09）")
    .refine(inMonthWindow, {
      message: `月份超出合理范围（最早 ${MONTH_WINDOW_MIN_MONTHS_AGO} 个月前、最晚下个月）——用户只说月份未说年份时，按当前年份重试`,
    })
    .describe("统计月份，格式 yyyy-MM（必填）。用户未说明年份时按当前年份理解。");
}

/**
 * ops 提供商。isConfigured 只认 OPS_BASE_URL 非空：base 地址是「接哪家
 * 后台」的开关，token 是「这次请求」的凭据——前者 env、后者请求头，职责分离。
 */
export const opsProvider: DataSourceProvider = {
  name: "ops",
  description:
    "ops 第三方运营后台：代理商/商户名册（按名字查 ID）+ 商家流水 Top10、代理商经营对比、订单统计、每日明细、代理商每日经营明细矩阵五类经营数据。",
  isConfigured() {
    const base = loadEnv().OPS_BASE_URL;
    return base !== undefined && base.trim() !== "";
  },
  createTools({ token }) {
    // 前四个工具各包一个端点，第五个是跨端点组合；token 闭包捕获（请求级），
    // execute 时才校验缺失——「没填 token」不是装配错误，不该在 createTools 时
    // 炸掉整张工具表，而是让模型在真正调用时收到结构化的中文指引。
    // 顺序取舍（2026-09 实测）：组合工具刻意排最前——glm-4-flash 这类弱模型对
    // 靠前工具与描述开头权重更高，而「各代理商每天」型问题恰是最容易被轻工具
    // （每日明细的关键词太像）误吸走的重问题，排序是零成本的一道防误选闸。
    return [
      {
        // 组合工具（第 5 个）：跨 agentCompare + dailyDetails 两个端点的编排。
        // description 刻意写清「适合什么 / 不适合什么」——它比单端点工具贵
        // （1 + 2N 个请求），让模型把轻问题留给轻工具，重组合留给矩阵问题。
        name: "ops_agent_daily_matrix",
        tool: tool({
          description:
            "查询某月所有代理商每天的订单数与金额明细矩阵：先取全量代理商列表，再逐代理商拉取每日金额与订单数，合并为每代理商×每天的数据矩阵。适合「每个代理商每天卖了多少」这类跨天对比问题；单代理商或单日问题请用更轻的工具。",
          inputSchema: z.object({
            dateTime: dateTimeField(),
          }),
          execute: async ({ dateTime }) => buildAgentDailyMatrix(dateTime, token),
        }),
      },
      {
        // 名册工具（第 6、7 个）：名字 → ID 的桥。用户说「广东深圳这个代理商」时
        // 模型手里只有名字，markDashboard 系列全要 agentId——没有名册，模型只能拒绝
        // （2026-10 实测踩中）。名册行自带订单数/设备数汇总：简单问题一步可答，
        // 深挖（月度流水/每日走势）才需要拿 ID 调下游端点。
        // 分页写死 1/10：找 ID 场景 10 条足够，分页参数暴露给弱模型只增加犯错面。
        name: "ops_agent_search",
        tool: tool({
          description:
            "按名字查找代理商（模糊匹配，返回前 10 条）：每条含代理商ID（agentId）、名称、设备数、商户数与订单总数。用户按名字提到某代理商时，先用本工具把名字换成 agentId；行内自带订单总数可直接回答简单问题，要月度流水/客单价/每日走势再用该 agentId 调 ops_order_statistics / ops_daily_details。返回 records 为空说明名单里没有该名字，请如实告知，不要编造 ID。",
          inputSchema: z.object({
            name: z
              .string()
              .min(1)
              .describe("代理商名称关键词（模糊匹配）。只传名字本身——用户说「广东深圳这个代理商」时传「广东深圳」，去掉「代理商」等类型词"),
          }),
          execute: async ({ name }) =>
            searchRosterPage<OpsAgentPage>("/platform/agent/page", "name", name, {}, token),
        }),
      },
      {
        name: "ops_tenant_search",
        tool: tool({
          description:
            "按名字查找商户/商家（模糊匹配，返回前 10 条）：每条含商户ID、名称、所属代理商、订单数与订单金额。用户按名字提到某商户/商家时，先用本工具查到它的 ID 与归属代理商，行内订单数据可直接回答简单问题。返回 records 为空说明名单里没有该名字，请如实告知，不要编造 ID。",
          inputSchema: z.object({
            tenantName: z
              .string()
              .min(1)
              .describe("商户名称关键词（模糊匹配）。只传名字本身——用户说「XX这个商户」时传「XX」，去掉「商户/商家」等类型词"),
            agentId: z
              .number()
              .int()
              .optional()
              .describe("可选：只查某代理商名下的商户（agentId 来自 ops_agent_search）"),
          }),
          execute: async ({ tenantName, agentId }) =>
            // 上游搜索字段是 outletsId（代理商ID），入参名不同——转换在 provider 内完成
            searchRosterPage<OpsTenantPage>("/platform/tenant/pageTenant", "tenantName", tenantName, { outletsId: agentId }, token),
        }),
      },
      {
        name: "ops_tenant_top",
        tool: tool({
          description:
            "查询商家流水 Top10 排行（第三方运营后台）：可按代理商与月份过滤，返回商家ID、名称与流水金额。",
          inputSchema: z.object({
            agentId: z.number().int().optional().describe("代理商ID（int64），不传则查全部"),
            dateTime: dateTimeField(),
          }),
          execute: async ({ agentId, dateTime }) =>
            withEmptyNote(await callOps<OpsTenantTopRow[]>("/markDashboard/tenantTop", { agentId, dateTime }, token), dateTime),
        }),
      },
      {
        name: "ops_agent_compare",
        tool: tool({
          description:
            "查询代理商经营数据对比（第三方运营后台）：各代理商的流水、订单数、客单价、在线设备数与在线率，用于代理商横向比较（月度聚合，无每日明细）。要「各代理商每天」的分日明细矩阵请改用 ops_agent_daily_matrix；要按名字找某代理商的 ID 请用 ops_agent_search 名册工具。",
          inputSchema: z.object({
            dateTime: dateTimeField(),
          }),
          execute: async ({ dateTime }) =>
            withEmptyNote(
              await callOps<OpsAgentCompareRow[]>("/markDashboard/agentCompare", { dateTime }, token),
              dateTime,
            ),
        }),
      },
      {
        name: "ops_order_statistics",
        tool: tool({
          description:
            "查询订单数据统计（第三方运营后台，单对象）：订单流水、订单数、卖断/退款订单数与金额、平均客单价、在线设备，可按代理商与月份过滤。用户问退款/卖断/客单价这类订单细分指标时用本工具——退款相关字段是 refundOrderNum（退款订单数）与 refundOrderAmount（退款金额）。",
          inputSchema: z.object({
            agentId: z
              .number()
              .int()
              .optional()
              .describe(
                "代理商ID（int64）。不传 = 查全部代理商合计。用户追问细分指标（如「买断订单数」「退款金额」）且上文查过某代理商时，必须带上同一个 agentId（从前面的名册/查询结果里取）；只有明确问「全部/所有代理商」时才省略",
              ),
            dateTime: dateTimeField(),
          }),
          execute: async ({ agentId, dateTime }) =>
            withEmptyObjectNote(
              await callOps<OpsOrderStatistics | null>("/markDashboard/orderStatistics", { agentId, dateTime }, token),
              dateTime,
            ),
        }),
      },
      {
        name: "ops_daily_details",
        tool: tool({
          description:
            "查询每日明细走势（type=1 金额、2 订单数量，可按代理商过滤；不区分代理商维度——不传 agentId 是全部代理商合计，传了是单家走势）。用户问「各代理商/每个代理商每天」这类分代理商对比时，必须改用 ops_agent_daily_matrix，本工具给不出分代理商数据。",
          inputSchema: z.object({
            type: z
              .union([z.literal(1), z.literal(2)])
              .optional()
              .describe("明细类型：1=金额（默认），2=订单数量"),
            agentId: z.number().int().optional().describe("代理商ID（int64），不传则查全部"),
            dateTime: dateTimeField(),
          }),
          execute: async ({ type, agentId, dateTime }) =>
            withEmptyNote(await callOps<OpsDailyDetailRow[]>("/markDashboard/dailyDetails", { type, agentId, dateTime }, token), dateTime),
        }),
      },
    ];
  },
};
