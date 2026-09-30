// index.ts —— 统一 CLI 路由：tsx apps/cli/src/index.ts chat|kb|service|eval|mcp-server
// chat：手写工具循环聊天；kb：知识库问答（先 pnpm kb:ingest 入库）；service：Supervisor 智能客服；
// eval：评测套件；mcp-server：把引擎暴露成 stdio MCP 服务器（日志走 stderr，stdout 归协议）。
// 各子命令的参数原样透传（如 pnpm cli chat --selftest）。
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "chat") {
  const { main } = await import("./apps/chat/cli.js");
  await main(rest);
} else if (cmd === "kb") {
  const { main } = await import("./apps/kb/cli.js");
  await main(rest);
} else if (cmd === "service") {
  const { main } = await import("./apps/service/cli.js");
  await main(rest);
} else if (cmd === "eval") {
  const { main } = await import("./apps/eval/cli.js");
  await main(rest);
} else if (cmd === "mcp-server") {
  const { main } = await import("./apps/mcp-server/cli.js");
  await main(rest);
} else {
  console.log("用法：pnpm cli chat | kb | service | eval | mcp-server");
  if (cmd !== undefined) {
    console.error(`未知命令：${cmd}`);
    process.exitCode = 1;
  }
}
