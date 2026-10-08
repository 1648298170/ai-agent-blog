// registry.ts —— 数据源插件注册表：模块级 Map + 登记函数 + 解析函数。
// 与 tools/registry.ts 的 ToolRegistry 同一哲学（按名登记、吐出可用表），差别在于
// 这里登记的是「提供商」而非单个工具，且解析时按 isConfigured() 过滤——
// 「没配环境变量的第三方不产生任何行为变化」在这一点上落地。
// 模块级单例是有意为之：一个进程里同一批第三方只登记一次，API 侧的幂等登记
// （registerBuiltInDataSources）因此天然成立（Map 按名覆盖，重复调用无副作用）。
import type { DataSourceContext, DataSourceProvider, DataSourceTool } from "./types.js";
import { opsProvider } from "./providers/ops.js";

/** 提供商注册表：name → provider（模块级单例） */
const providers = new Map<string, DataSourceProvider>();

/** 登记一个数据源提供商（同名重复登记以最后一次为准，覆盖式——测试替换用） */
export function registerDataSource(provider: DataSourceProvider): void {
  providers.set(provider.name, provider);
}

/**
 * 解析当前进程里「已配置好」的数据源工具：只从 isConfigured() === true 的
 * 提供商收集。返回扁平的 DataSourceTool[]（名字在消费方合并时才定归属），
 * 一个都没配置时返回空数组——消费方合并空数组 = 零行为变化。
 */
export function resolveDataSourceTools(context: DataSourceContext): DataSourceTool[] {
  const out: DataSourceTool[] = [];
  for (const provider of providers.values()) {
    if (!provider.isConfigured()) continue; // 没配 env 的第三方：工具一个都不给
    out.push(...provider.createTools(context));
  }
  return out;
}

/**
 * 登记内置数据源（目前只有 ops）。幂等：Map 按名覆盖式登记，调用多少次
 * 结果都只有一份。API 侧在首次需要合并外部工具时调用（懒登记，避免进程
 * 启动期为用不上的第三方做初始化）。
 */
export function registerBuiltInDataSources(): void {
  registerDataSource(opsProvider);
}
