// scripts/mcp-dogfood.mjs —— MCP 狗粮冒烟（真实 stdio spawn + 真实 GLM 模型，非 vitest）
//
// 验的是 P2 的头号承诺：聊天代理通过 MCP 客户端桥消费我们自己的 MCP 服务器——
//   pnpm chat --mcp "cmd /c pnpm mcp:server" --trace
// 管线：chat（真实 GLM key）──stdio spawn──→ cmd /c pnpm mcp:server（P1 服务器）
// 断言三件套 + 两份过程证据：
//   ① 启动行：已接入 MCP 服务（N 个工具：…getOrderStatus…）
//   ② 轨迹行：⚙ 行动 step 1 → 要调 1 个工具：getOrderStatus（模型真的选了 MCP 工具）
//   ③ 干净退出：exitCode 0（REPL /exit 走通 + 桥 close 收掉 spawn 的子进程树）
//   证据 A：重名警告（getOrderStatus 被 MCP 版本覆盖——同名工具走的就是 MCP 通路）
//   证据 B：✓ 观察行（MCP 工具执行成功、structuredContent 回灌进循环）
//
// 为什么是独立脚本而不是 vitest：这条链路要真实 spawn（cmd→pnpm→tsx→stdio 服务器）
// 和真实模型调用（2-3 次 GLM），不满足离线铁律；进 vitest 会把 CI 变成网络依赖。
// 约定同 scripts/run-infra-tests.mjs：node 零依赖、从 agent-app 根目录可重复执行。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const IS_WIN = process.platform === "win32";

// Windows 双垫片：外层 spawn cmd /c 才能唤起 pnpm.cmd（Node ≥18.20 禁止无 shell 直唤 .cmd）；
// 内层 --mcp 的值同样要 cmd /c 包一层（StdioClientTransport 不开 shell，见 engine/mcp/client.ts）。
const argv = IS_WIN
  ? ["cmd", "/c", "pnpm", "chat", "--mcp", "cmd /c pnpm mcp:server", "--trace"]
  : ["pnpm", "chat", "--mcp", "pnpm mcp:server", "--trace"];
const [file, ...args] = argv;

/** 整体看门狗：tsx 冷启动 ×2 + 真实模型调用，给足余量；超时杀进程树兜底 */
const TIMEOUT_MS = 240_000;

const child = spawn(file, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");

let output = "";
const append = (chunk) => {
  output += chunk;
  process.stdout.write(chunk); // 实时透传，跑的人看得见进度
};
child.stdout.on("data", append);
child.stderr.on("data", append);

/** 杀掉整棵进程树（看门狗超时专用；Windows 无进程组，taskkill /T 按树收） */
function killTree() {
  if (child.pid === undefined) return;
  if (IS_WIN) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

const watchdog = setTimeout(() => {
  console.error(`\n[mcp-dogfood] 超时（${TIMEOUT_MS / 1000}s）：杀掉进程树后判失败。`);
  killTree();
  process.exit(1);
}, TIMEOUT_MS);
watchdog.unref();

/** 等启动行出现再喂输入：既确认桥装配完成，也避免把输入塞进还没接好的 REPL。
 *  失败路径（参数错误 / 接入失败）一到就提前判负，不等看门狗。 */
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("等不到 MCP 启动行（已接入 MCP 服务）——桥装配失败或服务器起不来")), TIMEOUT_MS);
  timer.unref();
  // 用累计输出做包含判断（append 先注册先执行，这里的 output 一定含最新 chunk），
  // 不依赖单次 chunk 边界恰好对齐关键词
  const onData = () => {
    if (output.includes("已接入 MCP 服务")) {
      cleanup();
      resolve();
    } else if (output.includes("接入 MCP 服务器失败") || output.includes("参数错误")) {
      cleanup();
      killTree();
      reject(new Error("chat 启动期报告 MCP 接入失败（详见上方输出）"));
    }
  };
  const onError = (err) => {
    cleanup();
    reject(new Error(`无法启动 ${file}：${err.message}`));
  };
  function cleanup() {
    clearTimeout(timer);
    child.stdout.off("data", onData);
    child.stderr.off("data", onData);
    child.off("error", onError);
  }
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.once("error", onError);
});

// 喂两行：一个真实问题（驱动模型选 MCP 工具）+ /exit（走 REPL 的干净退出路径）。
// stdin 的 EPIPE 静默吞掉（进程若中途死掉，退出码断言会兜底报告真正的问题）。
child.stdin.on("error", () => {});
child.stdin.write("查一下订单 A-1024\n");
child.stdin.write("/exit\n");
child.stdin.end();

const exitCode = await new Promise((resolve) => {
  child.once("close", (code) => resolve(code));
});

clearTimeout(watchdog);

// ── 断言与证据提取 ────────────────────────────────────────────────────────
const lines = output.split(/\r?\n/);
const pick = (keyword) => lines.find((line) => line.includes(keyword)) ?? "（未找到）";

const failures = [];
const expectIn = (label, text) => {
  if (!output.includes(text)) failures.push(`${label}（未出现：${text}）`);
};
const expectMatch = (label, pattern) => {
  if (!pattern.test(output)) failures.push(`${label}（未匹配：${pattern}）`);
};

expectIn("启动行 · MCP 接入", "已接入 MCP 服务");
expectIn("启动行 · 工具在列", "getOrderStatus");
expectMatch("轨迹 · ⚙ 行动", /⚙ 行动 step 1 → 要调 1 个工具：getOrderStatus/);
expectMatch("轨迹 · ✓ 观察（MCP 工具执行成功）", /✓ 观察 step 1 → getOrderStatus 返回/);
expectMatch("证据 · 重名覆盖警告（MCP 版本胜出）", /重名（.*getOrderStatus.*），已用 MCP 版本覆盖/);
expectIn("退出 · REPL 干净收口", "再见");
if (exitCode !== 0) failures.push(`退出码应为 0，实际 ${exitCode}`);

console.log("\n════ mcp-dogfood 过程证据 ════");
console.log(`  启动行   > ${pick("已接入 MCP 服务")}`);
console.log(`  行动轨迹 > ${pick("⚙ 行动")}`);
console.log(`  观察轨迹 > ${pick("✓ 观察")}`);
console.log(`  助手回复 > ${pick("助手>")}`);
console.log(`  退出码   > ${exitCode}`);

if (failures.length > 0) {
  console.error("\n[mcp-dogfood] 失败：");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\n[mcp-dogfood] 全部断言通过：MCP 工具已并入聊天工具表并被真实模型真实调用。");
process.exit(0);
