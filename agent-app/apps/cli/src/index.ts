// index.ts —— 统一 CLI 路由：tsx apps/cli/src/index.ts chat|kb|service
// chat：手写工具循环聊天；kb：知识库问答（先 pnpm kb:ingest 入库）；service：Supervisor 智能客服。
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
} else {
  console.log("用法：pnpm cli chat | kb | service");
  if (cmd !== undefined) {
    console.error(`未知命令：${cmd}`);
    process.exitCode = 1;
  }
}
