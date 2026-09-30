// mcp/server.ts —— MCP 服务器：把引擎的既有工具与知识库文档暴露成 Model Context Protocol
//
// ── 为什么要有这一层（先说为什么，再说怎么做）──────────────────────────────
// 引擎的工具循环（agent-loop.ts）只认 Record<string, AgentTool>：本地调它，
// Claude Desktop / Cursor / 任何 MCP 客户端也调它。与其为"外部世界"另写一套
// 工具出口（维护两份 schema、两份执行逻辑，改一处漏一处），不如把同一批
// AgentTool 翻译成 MCP 协议——协议在边界上被消化，agent-loop 零感知——
// MCP 工具与本地工具对循环不可区分。
//
// ── 本文件在整条链路里的位置 ────────────────────────────────────────────
//
//   本地路径：REPL ──→ registry.getAll() ──→ runToolLoop({ tools })
//   MCP 路径：MCP 客户端 ──stdio/inMemory──→ McpServer ──→ 同一批 AgentTool.execute
//                                            └→ resources ──→ RagStore.listDocs/readDoc
//
// 两条路径共用同一批工具对象与同一份 zod schema（单一真源）：schema 不复制、
// 描述不复制，改名改参只改 demo-tools.ts / kb-search.ts 一处。
//
// ── API 面板（对应 MCP 三大原语中的两个）─────────────────────────────────
//   TOOLS     getOrderStatus / createTicket / searchKnowledge
//             —— 演示工具两个 + 知识库检索一个；escalateToHuman 不注册：
//             转人工是客服产品线的会话内动作（HandoffPack 要吃会话上下文），
//             MCP 是无会话的协议边界，挂出去只会收到缺上下文的空调用。
//   RESOURCES docs://kb/{docId} 资源模板：list = listDocs()（目录），
//             read = readDoc(docId)（正文）——知识库文档对 MCP 客户端可枚举可阅读。
//
// ── 存储装配（与 apps/kb/cli.ts 同款接缝）────────────────────────────────
// resolveStore() 惰性装配：首次真正用到存储时，若宿主仍未 setRagStore（全局还是
// retrieve.ts 的出厂内存库），才按 env 工厂换库（默认 json 快照，RAG_STORE=pgvector
// 切 PG）——与 kb CLI 启动行为逐字一致。宿主（测试 / 嵌入方）先注入的库绝不覆盖。
//
// ── stdio 纪律 ──────────────────────────────────────────────────────────
// stdio 传输的 stdout 归协议所有（JSON-RPC 逐行帧），任何日志只能走 stderr——
// 在 stdout 打一行启动横幅 = 往协议流里塞脏字节，客户端解析当场崩。
// 所以 connectStdio 只挂 StdioServerTransport，日志留给 CLI 入口往 stderr 打。
import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createDemoTools } from "../tools/demo-tools.js";
import { searchKnowledgeBase } from "../tools/kb-search.js";
import { createRagStoreFromEnv } from "../rag/store.factory.js";
import { getRagStore, setRagStore } from "../rag/retrieve.js";
import type { RagStore } from "../rag/types.js";
import type { AgentTool } from "../types.js";

/** 服务器元信息：版本与 engine package.json 保持同一口径（升级时两处一起改） */
const SERVER_VERSION = "0.1.0";

/** 出厂默认库的引用快照：本模块加载时 retrieve.ts 的模块级单例刚建好、
 * 宿主还没来得及 setRagStore——用它判别"宿主是否已注入自己的库"。
 */
const pristineDefaultStore: RagStore = getRagStore();

/**
 * 解析当前该用的 RAG 存储（惰性装配，首次调用后幂等）：
 * - 宿主已 setRagStore（引用 ≠ 出厂默认）→ 原样使用（测试注入的种子库、嵌入方的库）
 * - 宿主没动过（引用 === 出厂默认）→ 按 env 工厂换库，行为对齐 apps/kb/cli.ts：
 *   RAG_STORE=json（默认）读 .data/kb-store.json 快照，pgvector 读 PG
 */
function resolveStore(): RagStore {
  if (getRagStore() === pristineDefaultStore) {
    setRagStore(createRagStoreFromEnv());
  }
  return getRagStore();
}

/** 引擎工具 → MCP 工具的翻译器（单一真源：schema 原样透传，不复制） */
function registerEngineTool(server: McpServer, name: string, engineTool: AgentTool): void {
  // 收窄检查：引擎工具的 inputSchema 一律是 zod schema（demo-tools / kb-search 的
  // 既有约定，MCP SDK 也直接吃 zod）。不是 zod 属于编码错误，当场炸出来而不是静默降级。
  if (!(engineTool.inputSchema instanceof z.ZodType)) {
    throw new Error(
      `工具 ${name} 的 inputSchema 不是 zod schema：MCP 注册需要 zod（单一真源约定），` +
        "请检查 tools/ 目录的工具定义。",
    );
  }
  const inputSchema: z.ZodTypeAny = engineTool.inputSchema;
  if (engineTool.execute === undefined) {
    // 引擎允许"无 execute、调度方自己执行"的工具（教程用法），但 MCP 服务器就是调度方，
    // 没有执行体的工具挂出去只能返回错误——注册期就拒绝
    throw new Error(`工具 ${name} 未提供 execute：MCP 侧无法代为执行，请补齐工具实现。`);
  }
  const execute = engineTool.execute;

  server.registerTool(
    name,
    {
      description: engineTool.description ?? name,
      inputSchema, // 同一份 zod schema：本地循环与 MCP 客户端看到同一张参数图纸
    },
    async (args) => {
      // MCP 入参已由 SDK 按 inputSchema 校验解析，这里直接喂引擎的 execute。
      // toolCallId/messages 是 ai v5 的 ToolCallOptions 必填项，MCP 侧没有对应概念，
      // 填合成值（引擎这三个工具都不消费它们）。
      const output = await execute(args, { toolCallId: `mcp-${name}-${randomUUID()}`, messages: [] });
      return {
        // 双通道输出：content 供人/模型读（文本 JSON），structuredContent 供程序读（原对象）
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

/**
 * 创建 MCP 服务器：注册引擎三工具 + 知识库文档资源模板。
 * 返回的 McpServer 尚未连接任何传输——测试用 InMemoryTransport 连 Client，
 * CLI 用 connectStdio() 挂标准输入输出，两条路互不越界。
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "agent-app", version: SERVER_VERSION });

  // ── TOOLS：引擎真实工具的 MCP 镜像（schema 与 execute 都是原对象，零复制）──
  const demoTools = createDemoTools();
  registerEngineTool(server, "getOrderStatus", demoTools.getOrderStatus);
  registerEngineTool(server, "createTicket", demoTools.createTicket);
  registerEngineTool(server, "searchKnowledge", searchKnowledgeBase);

  // ── RESOURCES：知识库文档。资源模板（而非静态注册）是刻意的：
  // 文档在运行时增删（入库 / 下架），静态注册只在构造瞬间拍一次快照会立刻过期；
  // 模板的 list 回调让每次 listResources 都现查 listDocs()，读时现调 readDoc()，
  // MCP 客户端永远看到知识库的当前真相。
  server.registerResource(
    "kb-doc",
    new ResourceTemplate("docs://kb/{docId}", {
      list: async () => {
        const docs = await resolveStore().listDocs();
        return {
          resources: docs.map((doc) => ({
            uri: `docs://kb/${doc.docId}`,
            name: doc.title,
            mimeType: "text/plain",
          })),
        };
      },
    }),
    { description: "知识库文档：uri 按文档 docId 寻址，读取返回按块序拼回的全文", mimeType: "text/plain" },
    async (uri, variables) => {
      const docId = variables.docId; // 模板变量由 SDK 的 URI 匹配解出
      if (typeof docId !== "string") {
        throw new Error(`资源 URI 变量 docId 非法：${uri.toString()}（应为单个字符串）`);
      }
      const doc = await resolveStore().readDoc(docId);
      return {
        contents: [{ uri: uri.toString(), text: doc.text, mimeType: "text/plain" }],
      };
    },
  );

  return server;
}

/**
 * 把服务器挂到标准输入输出（stdio 传输）。只有 CLI 入口调用——
 * 测试进程绝不碰 StdioServerTransport（stdin/stdout 是进程级资源，
 * InMemoryTransport 才是 vitest 里的协议往返通道）。
 */
export async function connectStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
}
