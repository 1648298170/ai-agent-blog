// registry.ts —— 极简工具注册表：register 按名登记，getAll 吐出
// 可直接喂给 generateText 的 tools 形状（Record<string, Tool>）。
// 应用侧各建各的 registry，工具列表按应用职责裁剪，互不干扰。
import type { AgentTool } from "../types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  /** 按名登记一个工具；同名重复注册以最后一次为准（覆盖式） */
  register(name: string, tool: AgentTool): this {
    this.tools.set(name, tool);
    return this; // 链式调用：registry.register(a, ta).register(b, tb)
  }

  /** 吐出 { 工具名: 工具 } 的普通对象，即 generateText({ tools }) 要的形状 */
  getAll(): Record<string, AgentTool> {
    const out: Record<string, AgentTool> = {};
    for (const [name, tool] of this.tools) {
      out[name] = tool;
    }
    return out;
  }

  /** 已登记的工具名列表（排障日志用） */
  names(): string[] {
    return [...this.tools.keys()];
  }
}
