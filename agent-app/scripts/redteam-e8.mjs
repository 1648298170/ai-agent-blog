// E8 资源边界实验：
// ① 函数级 searchKnowledge(query, k=10^6)：k 是否有上限
// ② MCP 协议级：tools/call searchKnowledge 传 k=10^6（zod schema 上限 10）是否被拒
import { spawn } from "node:child_process";
// 最小安全环境（对齐 SDK getDefaultEnvironment 的作用：给子进程 PATH 等基础变量即可，
// .env 由服务器进程自己从磁盘读）
const getDefaultEnvironment = () => ({
  PATH: process.env.PATH,
  SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot,
  TEMP: process.env.TEMP,
  ComSpec: process.env.ComSpec,
});
import { searchKnowledge, setRagStore } from "../packages/engine/src/rag/index.ts";
import { createRagStoreFromEnv } from "../packages/engine/src/rag/store.factory.ts";

// ① 函数级
setRagStore(createRagStoreFromEnv());
const t0 = Date.now();
const hits = await searchKnowledge("出差住宿标准", 1_000_000);
console.log(`① 函数级 k=10^6 → 返回 ${hits.length} 块（库里全部块），耗时 ${Date.now() - t0}ms —— 函数层无 k 上限`);

// ② MCP 协议级（同一条 spawn 链路）
const child = spawn("cmd", ["/c", "pnpm", "mcp:server"], {
  env: getDefaultEnvironment(),
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", () => {});

let seq = 0;
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});
function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const bad = await rpc("tools/call", { name: "searchKnowledge", arguments: { query: "出差住宿标准", k: 1_000_000 } });
console.log(`② MCP zod 闸 k=10^6 → isError=${bad.result?.isError ?? false}，内容=${JSON.stringify(bad.result?.content?.[0]?.text ?? bad).slice(0, 160)}`);

child.stdin.end();
await new Promise((r) => child.on("exit", r));
process.exit(0);
