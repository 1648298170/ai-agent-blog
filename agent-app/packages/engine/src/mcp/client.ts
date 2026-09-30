// mcp/client.ts —— MCP 客户端桥：连接外部 MCP 服务器，把它的工具表接进引擎
//
// ── 本文件在整条链路里的位置 ────────────────────────────────────────────
//
//   出方向（P1）：引擎 AgentTool ──server.ts──→ MCP 客户端（Claude Desktop…）
//   进方向（P2）：外部 MCP 服务器 ──stdio──→ StdioClientTransport ──→ Client
//                ──listTools──→ adapter.ts ──→ Record<string, AgentTool>
//                ──→ 原样合入 chat REPL 的工具表（agent-loop 零感知）
//
// 狗粮闭环：pnpm chat --mcp "cmd /c pnpm mcp:server" —— 引擎的聊天代理通过
// 本桥消费引擎自己的 MCP 服务器，进出两个方向在同一条 stdio 管线上互验。
//
// ── 两条连接通道，同一个桥形状 ──────────────────────────────────────────
//   createMcpClientBridge        stdio：spawn 子进程（真实外部服务器 / 狗粮冒烟）
//   createInMemoryMcpClientBridge 内存：Client ↔ McpServer 同进程对（离线测试、
//                                不想 spawn 的嵌入式场景）——服务器侧先 connect
//                                （P1 实证：client 的 connect 会立刻发 initialize，
//                                server 没挂上传输就成了发往虚空的超时请求）。
//
// ── stdio 的 Windows 纪律 ──────────────────────────────────────────────
// StdioClientTransport 用 child_process.spawn 且不开 shell：Windows 上 pnpm/npx
// 是 .cmd 垫片，spawn 直唤会 ENOENT/EINVAL——解法不是全局 shell:true（等于给
// 命令行开注入口），而是文档化命令形态：--mcp "cmd /c pnpm mcp:server"，
// 让 cmd.exe 当垫片层。桥本身保持传输用法上的正统。
//
// ── close 语义（从 SDK 1.31.0 源码核实）────────────────────────────────
// Client.close() → transport.close() 的既定序列：先 child.stdin.end()（优雅
// EOF），等 2s；直连子进程还活着 → SIGTERM，再等 2s；还活着 → SIGKILL。
// Windows 下直连子进程是 cmd.exe，孙进程（真正的 node 服务器）靠 stdin EOF
// 传播退出（stdio 服务器读完 stdin 就自然退出，P1 实证）。若某个外部服务器
// 无视 EOF，杀 cmd.exe 收不了它的孙进程——这是 Windows 无进程组杀的既有限制，
// 传输上暴露了 pid getter 供调用方审计兜底，不在桥里加双杀的黑科技。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentTool } from "../types.js";
import { mcpToolToAgentTool } from "./adapter.js";

/** 客户端桥：一次连接 + 适配好的工具表 + 关闭句柄 */
export interface McpClientBridge {
  /** 服务器标识（stdio = 命令行原文；in-memory = "in-memory"），日志与排障用 */
  name: string;
  /** 适配后的工具表：可直接合入 runToolLoop 的 ToolSet */
  tools: Record<string, AgentTool>;
  /** 断开连接；stdio 场景按 SDK 序列收掉子进程（见文件头 close 语义） */
  close(): Promise<void>;
}

/** stdio 桥的连接参数（spawn 参数的直通投影，与 StdioServerParameters 对齐） */
export interface StdioMcpBridgeOptions {
  /** 可执行文件（Windows 下 .cmd 垫片需经 cmd /c，见文件头 Windows 纪律） */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** 客户端身份：与服务器端 SERVER_VERSION 同口径（升级时两处一起改） */
const CLIENT_INFO = { name: "agent-app", version: "0.1.0" } as const;

/** 连接 + listTools + 逐个适配（两条通道共用的桥装配段） */
async function listAndAdapt(client: Client): Promise<Record<string, AgentTool>> {
  const { tools: descriptors } = await client.listTools();
  const tools: Record<string, AgentTool> = {};
  for (const descriptor of descriptors) {
    tools[descriptor.name] = mcpToolToAgentTool(client, descriptor);
  }
  return tools;
}

/** 把连接期失败翻译成带修复指引的中文错误（保留原始信息） */
function describeConnectError(server: string, err: unknown): Error {
  return new Error(
    `无法连接 MCP 服务器（${server}）：${err instanceof Error ? err.message : String(err)}。` +
      '请检查命令行能否在终端直接跑通；Windows 下 pnpm/npx 等 .cmd 命令需要包一层 cmd /c，例如 --mcp "cmd /c pnpm mcp:server"。',
  );
}

/**
 * 连接一个 stdio MCP 服务器（spawn 子进程），listTools 并把全部工具适配成
 * 引擎工具表。任何一步失败都会收掉已 spawn 的子进程再抛中文错误——
 * 连接失败的桥不留孤儿进程。
 */
export async function createMcpClientBridge(options: StdioMcpBridgeOptions): Promise<McpClientBridge> {
  const name = [options.command, ...(options.args ?? [])].join(" ");
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    // SDK 的 env 是「整体替换」而非合并：只传 { FOO: 1 } 会把 PATH 一起丢掉，
    // cmd /c pnpm 当场解析失败。这里显式继承默认安全变量再叠加调用方的覆盖项。
    env: options.env === undefined ? undefined : { ...getDefaultEnvironment(), ...options.env },
  });
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport); // connect 内部 start()：spawn + initialize 握手
    const tools = await listAndAdapt(client);
    return { name, tools, close: () => client.close() };
  } catch (err) {
    // 连上但 listTools 失败：子进程已经起来了，先收掉再抛错，不留孤儿
    await client.close().catch(() => {});
    throw describeConnectError(name, err);
  }
}

/**
 * 同进程内存桥：把一个现成的 McpServer 经 InMemoryTransport 接给 Client，
 * 返回与 stdio 桥同一形状的桥。离线测试与「狗粮但不 spawn」的路径走这里；
 * close 同时关两端（Client 与传入的 Server）——内存传输不像 stdio 有进程退出
 * 兜底，不显式关掉 server 它会一直挂在已死的传输上。
 */
export async function createInMemoryMcpClientBridge(server: McpServer): Promise<McpClientBridge> {
  const client = new Client(CLIENT_INFO);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // 顺序铁律：server 先 connect（P1 实证），client 后 connect（发 initialize）
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const tools = await listAndAdapt(client);
    return {
      name: "in-memory",
      tools,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  } catch (err) {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    throw describeConnectError("in-memory", err);
  }
}
