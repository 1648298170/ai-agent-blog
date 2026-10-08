// ops-contracts.ts —— ops 运营后台四个端点的返回数据形状（OpenAPI 导出的 TS 投影）。
// 为什么单独一个文件：字段口径是第三方定的（在线率是百分数值 3.33=33.33%、
// 日期是 "MM/dd" 短格式），把这些「他家的怪癖」集中注释在一个纯类型文件里，
// provider 主文件只剩业务组装，排查字段含义时只有一个地方要翻。

/** 商家流水 Top10 行（GET /markDashboard/tenantTop） */
export interface OpsTenantTopRow {
  /** 商家ID */
  tenantId: number | string;
  /** 商家名称 */
  name: string;
  /** 流水金额（数值，单位元） */
  data: number;
}

/** 代理商经营对比行（GET /markDashboard/agentCompare） */
export interface OpsAgentCompareRow {
  /** 代理商ID */
  agentId: number;
  /** 代理商名称 */
  agentName: string;
  /** 流水金额（数值，单位元） */
  orderFlowAmount: number;
  /** 订单数 */
  orderNum: number;
  /** 客单价（数值，单位元） */
  averageOrderAmount: number;
  /** 在线设备数 */
  onlineDeviceNum: number;
  /** 在线率百分数值：3.33 表示 33.33%（分母为 0 时后端给 0） */
  onlineDeviceRate: number;
}

/** 订单数据统计（GET /markDashboard/orderStatistics，单对象非数组） */
export interface OpsOrderStatistics {
  /** 订单流水（数值，单位元） */
  orderFlowAmount: number;
  /** 订单数量 */
  orderNum: number;
  /** 卖断订单数 */
  soldOrderNum: number;
  /** 退款订单数量 */
  refundOrderNum: number;
  /** 退款订单金额（数值，单位元） */
  refundOrderAmount: number;
  /** 平均客单价（数值，单位元） */
  averageOrderAmount: number;
  /** 在线设备数 */
  onlineDeviceNum: number;
  /** 在线率百分数值：3.33 表示 33.33%（分母为 0 时后端给 0） */
  onlineDeviceRate: number;
}

/** 每日明细行（GET /markDashboard/dailyDetails） */
export interface OpsDailyDetailRow {
  /** 日期（后端给 "MM/dd" 短格式，如 "09/12"） */
  dateTime: string;
  /** 数值：type=1 时是金额（元），type=2 时是订单数量 */
  data: number;
}

// ---------------------------------------------------------------------------
// 名册端点（GET /platform/agent/page、GET /platform/tenant/pageTenant）
// 用途：用户按名字问某代理商/商户时，先在这里把名字换成 ID，再拿 ID 调
// markDashboard 系列端点。投影只留教学链路需要的字段——上游 VO 有三十多个
// 字段（图片、费率、分成比例……），全量透传只会稀释模型注意力。
// ---------------------------------------------------------------------------

/** 代理商名册行（UmsOutletsVO 投影，GET /platform/agent/page） */
export interface OpsAgentPageRow {
  /** 代理商ID（即 markDashboard 系列的 agentId） */
  id: number;
  /** 代理商标识 */
  outletsNo?: string;
  /** 代理商名称 */
  outletsName: string;
  /** 代理商类型：1.直营 2.合伙人 3.其他 */
  agentType?: number;
  /** 设备总数 */
  deviceTotal?: number;
  /** 正常设备数 */
  deviceNormal?: number;
  /** 维护中设备数 */
  deviceMaintenance?: number;
  /** 商户数量 */
  tenantNum?: number;
  /** 订单总数（只统计年限内） */
  orderNum?: number;
  /** 状态：1-正常 0-停用 */
  status?: number;
}

/** 代理商名册分页信封（IPage 结构投影） */
export interface OpsAgentPage {
  records: OpsAgentPageRow[];
  total: number;
  size: number;
  current: number;
}

/** 商户名册行（UmsTenantPageVO 投影，GET /platform/tenant/pageTenant） */
export interface OpsTenantPageRow {
  /** 商户ID */
  id: number;
  /** 商户名称 */
  tenantName: string;
  /** 所属代理商名称 */
  agentName?: string;
  /** 订单总数 */
  orderNum?: number;
  /** 订单金额 */
  orderAmountNum?: number;
  /** 状态：1-正常 0-停用 */
  status?: number;
  /** 商户地址 */
  tenantAddress?: string;
}

/** 商户名册分页信封（IPage 结构投影） */
export interface OpsTenantPage {
  records: OpsTenantPageRow[];
  total: number;
  size: number;
  current: number;
}
