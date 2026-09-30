// mcp/index.ts —— MCP 子域 barrel：出方向的服务器工厂 + 进方向的客户端桥与适配器。
// 子路径 @agent-app/engine/mcp 的出口即本文件。
//
//   server.ts   出：引擎工具 → MCP 服务器（tools + resources + stdio）
//   client.ts   进：外部 MCP 服务器 → 桥（stdio spawn / inMemory 同进程对）
//   adapter.ts  进：MCP 工具描述符 → 引擎 AgentTool（schema 照单全收）
export * from "./server.js";
export * from "./client.js";
export * from "./adapter.js";
