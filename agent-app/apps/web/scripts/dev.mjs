// scripts/dev.mjs —— web 开发服务器启动器：端口环境变量驱动（跨 shell）
// 为什么需要它：Next.js 15.5 的 dev 端口只认 shell 环境变量或 -p 旗标，
// 不认 .env 文件里的 PORT（.env 加载晚于端口绑定，实测证伪）——本包装器补上这一环：
// 端口解析优先级 = shell PORT > 本目录 .env 的 PORT > 3009（默认）。
// 用法：pnpm dev（默认 3009）；PORT=3010 pnpm dev（临时换端口）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const appDir = path.join(import.meta.dirname, "..");

/** 从本目录 .env 读单键（只认 KEY=VALUE 行，不覆盖 shell 已有值） */
function readEnvFileKey(key) {
  try {
    const line = fs
      .readFileSync(path.join(appDir, ".env"), "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith(`${key}=`));
    return line === undefined ? undefined : line.slice(line.indexOf("=") + 1).trim();
  } catch {
    return undefined;
  }
}

const port = process.env.PORT ?? readEnvFileKey("PORT") ?? "3009";
console.log(`[dev] web 开发服务器 → http://localhost:${port}（PORT=${process.env.PORT ? "来自 shell" : readEnvFileKey("PORT") ? "来自 .env" : "默认 3009"}）`);

const child = spawn("npx", ["next", "dev", "-p", port], {
  cwd: appDir,
  stdio: "inherit",
  shell: process.platform === "win32", // Windows 下 npx 需要 shell 解析 .cmd 垫片
});
child.on("exit", (code) => process.exit(code ?? 0));
