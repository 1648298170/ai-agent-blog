// types.ts —— 外部数据源插件契约（provider plugin pattern）。
// 为什么要有这层：业务数据散落在各家第三方运营后台（ops 只是第一个），如果
// chat 服务直接 import ops 的工具，每接一家第三方都要改消费方代码——违反开闭。
// 契约倒过来：第三方实现 DataSourceProvider（自报家门 + 自查配置 + 按请求造工具），
// 消费方只认 registry 的 resolveDataSourceTools，不认识任何具体第三方。
// 新增一家第三方 = providers/ 下加一个文件 + 在 registerBuiltInDataSources 登记，
// 消费方（API / CLI / 未来的端）零改动。
import type { AgentTool } from "../types.js";

/**
 * 请求级上下文：第三方访问凭据由调用方逐请求提供（HTTP 层的 X-Ops-Token 头），
 * 不进进程环境、不落盘、不进日志——token 是用户自己的钥匙，生命周期跟着请求走。
 */
export interface DataSourceContext {
  /** 第三方访问令牌（ops 运营后台的登录态凭证），缺省表示用户尚未填入 */
  token?: string;
}

/**
 * 一个数据源工具：名字 + 引擎 AgentTool。
 * 与本地工具同一契约（AgentTool），合并进工具表后对手写循环不可区分——
 * 模型不需要知道「查商家流水」背后是第三方 REST API。
 */
export interface DataSourceTool {
  name: string;
  tool: AgentTool;
}

/**
 * 数据源提供商插件：第三方接入本引擎的唯一扩展点。
 * - isConfigured()：启动/请求期自查（env 探测）。没配环境变量的第三方必须回答
 *   false——「默认零行为变化」这条铁律靠它在 resolve 时被过滤来落地；
 * - createTools(context)：按请求级凭据现造工具。每次调用新造（token 闭包捕获），
 *   不缓存——不同请求的 token 不同，缓存会把 A 用户的钥匙借给 B 用户。
 */
export interface DataSourceProvider {
  /** 提供商标识（注册表的 key），如 "ops" */
  name: string;
  /** 中文一句话：这家数据源能干什么（给接线和排障的人看，不给模型看） */
  description: string;
  /** env 探测：配置齐了才允许把工具交出去 */
  isConfigured(): boolean;
  /** 按请求级上下文（token 等）造一批工具 */
  createTools(context: DataSourceContext): DataSourceTool[];
}
