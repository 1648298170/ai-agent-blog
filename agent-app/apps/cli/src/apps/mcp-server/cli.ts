// apps/mcp-server/cli.ts —— pnpm mcp:server 入口：把引擎暴露成 stdio MCP 服务器
// 链路：createMcpServer()（注册 getOrderStatus / createTicket / searchKnowledge 三工具
// + docs://kb/{docId} 文档资源模板）→ connectStdio()（StdioServerTransport 接管
// stdin/stdout）→ 常驻等待 MCP 客户端（Claude Desktop / Cursor 等）的 JSON-RPC 消息。
//
// ── stdio 纪律（本文件唯一要守住的事）────────────────────────────────────
// stdio 传输里 stdout 归协议所有（SDK 逐行 JSON-RPC 帧），任何日志只能写 stderr：
// console.error / trace（trace.ts 本就写 stderr）都安全，console.log 一次就够把
// 客户端的解析器喂崩。与 chat/kb/cli.ts 同款约定：main(args) 导出供 index.ts 路由，
// 直接运行时自启。
import { pathToFileURL } from "node:url";
import { connectStdio, createMcpServer } from "@agent-app/engine/mcp";
import { enableTrace } from "@agent-app/engine/trace";

/**
 * MCP 服务器入口。args 支持 --trace（引擎执行轨迹，打到 stderr，不污染协议流）。
 * 进程会常驻到 stdin 关闭或客户端断开——这是 stdio MCP 服务器的正常形态。
 */
export async function main(args: string[] = []): Promise<void> {
  if (args.includes("--trace")) enableTrace();

  const server = createMcpServer();

  // 启动横幅走 stderr（stdout 是协议的）：一眼看清挂了什么，客户端不受任何影响
  console.error("=== agent-app MCP 服务器（stdio）已启动 ===");
  console.error("工具：getOrderStatus / createTicket / searchKnowledge；资源：docs://kb/{docId}");
  console.error("存储按 RAG_STORE 环境变量装配（默认 json 快照 .data/kb-store.json），等待 MCP 客户端连接…");

  await connectStdio(server);
}

// 直接运行（pnpm mcp:server）时自动执行；被 index.ts 路由导入时由调用方调 main(rest)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
