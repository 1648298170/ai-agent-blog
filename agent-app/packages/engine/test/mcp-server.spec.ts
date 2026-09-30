// mcp-server.spec.ts —— MCP 服务器的协议往返测试（离线、零网络、零基础设施门控）
// 用 SDK 自带的 InMemoryTransport 把 McpServer ↔ Client 连成同进程对，
// 走真实 JSON-RPC 往返（listTools / callTool / listResources / readResource），
// 不碰 stdin/stdout（stdio 传输只属于 CLI 入口），也不调任何模型接口——
// searchKnowledge 只断言"在列"，不真调用（embedding 需要运行时密钥）。
// 存储种子：setRagStore(createInMemoryRagStore()) + upsert 未向量化块
// （readDoc / listDocs 不需要 embedding），afterAll 还原全局单例不污染他套件。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createInMemoryRagStore } from "../src/rag/store.memory.js";
import { createJsonRagStore } from "../src/rag/persistence.js";
import { getRagStore, setRagStore } from "../src/rag/retrieve.js";
import type { Chunk, RagStore } from "../src/rag/types.js";

// 本套件专用 docId 前缀（与 infra.*.spec.ts 的 spec- 前缀约定一致，一眼可辨来源）
const DOC_A = "spec-mcp-alpha";
const DOC_B = "spec-mcp-beta";
const TITLE_A = "MCP 测试文档甲";
const TITLE_B = "MCP 测试文档乙";

/** 造一个未向量化的测试块（readDoc / listDocs 不消费 embedding，null 即可） */
function makeChunk(docId: string, title: string, index: number, text: string): Chunk {
  return { id: `${docId}#${index}`, docId, title, text, index, embedding: null };
}

/** unknown → Record 的运行时收窄：callTool 的联合返回类型里，structuredContent
 * 与 content 都被索引签名摊成 unknown，测试里先收窄再读字段（不用 as 断言）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// —— 全局单例的保存与还原：retrieve.ts 暴露 get/setRagStore，测试改完必须复原 ——
const previousStore: RagStore = getRagStore();

let server: ReturnType<typeof createMcpServer>;
let client: Client;

beforeAll(async () => {
  // 种子库：内存库 + 故意乱序 upsert——readDoc 必须按 index 还原阅读顺序，
  // 而不是 Map 的插入顺序（乱序是最能暴露排序缺失的种法）
  const seeded = createInMemoryRagStore();
  await seeded.upsert([
    makeChunk(DOC_A, TITLE_A, 2, "第三段（index 2）"),
    makeChunk(DOC_A, TITLE_A, 0, "第一段（index 0）"),
    makeChunk(DOC_A, TITLE_A, 1, "第二段（index 1）"),
    makeChunk(DOC_B, TITLE_B, 0, "乙文档唯一一段"),
  ]);
  setRagStore(seeded);

  // 协议对：先 server.connect 再 client.connect（client 的 connect 会立刻发起
  // initialize 请求，server 没挂上传输就成了发往虚空的超时请求）
  server = createMcpServer();
  client = new Client({ name: "spec-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await server.close();
  setRagStore(previousStore);
});

describe("MCP 工具面板 listTools / callTool", () => {
  it("三个引擎工具全部在列且带中文描述（getOrderStatus / createTicket / searchKnowledge）", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toHaveLength(3);
    expect(names).toContain("getOrderStatus");
    expect(names).toContain("createTicket");
    expect(names).toContain("searchKnowledge");
    for (const tool of tools) {
      expect(tool.description, `工具 ${tool.name} 缺少描述`).toBeTruthy();
    }
  });

  it("callTool getOrderStatus：结构化结果带订单状态字段（demo 单 A-1024 → 已发货）", async () => {
    const result = await client.callTool({ name: "getOrderStatus", arguments: { orderId: "A-1024" } });
    const structured: unknown = result.structuredContent;
    if (!isRecord(structured)) throw new Error("getOrderStatus 应返回 structuredContent");
    expect(structured.orderId).toBe("A-1024");
    expect(structured.status).toBe("已发货");
    expect(structured.eta).toBeTruthy();
    // content 通道同样有产出（文本 JSON，供不支持 structuredContent 的客户端读）
    const content: unknown = result.content;
    if (!Array.isArray(content)) throw new Error("getOrderStatus 应返回 content 数组");
    expect(content.length).toBeGreaterThan(0);
  });

  it("callTool createTicket：结果含工单号（TK-日期-序号）", async () => {
    const result = await client.callTool({
      name: "createTicket",
      arguments: { subject: "MCP 冒烟", description: "离线协议往返测试建的工单" },
    });
    const structured: unknown = result.structuredContent;
    if (!isRecord(structured)) throw new Error("createTicket 应返回 structuredContent");
    expect(String(structured.ticketId)).toMatch(/^TK-\d{8}-\d{4}$/);
    expect(structured.status).toBe("已创建");
  });

  it("searchKnowledge 在列但离线不调用（真调用需要 embedding 密钥，属 pnpm mcp:server 实测）", async () => {
    const { tools } = await client.listTools();
    const searchTool = tools.find((tool) => tool.name === "searchKnowledge");
    if (searchTool === undefined) throw new Error("searchKnowledge 工具缺席");
    expect(searchTool.description).toContain("知识库");
  });
});

describe("MCP 资源面板 listResources / readResource（知识库文档）", () => {
  it("资源列表来自种子库：每个 docId 一条，uri = docs://kb/{docId}，name = 文档标题", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((resource) => resource.uri);
    expect(uris).toContain(`docs://kb/${DOC_A}`);
    expect(uris).toContain(`docs://kb/${DOC_B}`);
    const docA = resources.find((resource) => resource.uri === `docs://kb/${DOC_A}`);
    if (docA === undefined) throw new Error(`资源 ${DOC_A} 缺席`);
    expect(docA.name).toBe(TITLE_A);
  });

  it("读资源：乱序入库的块按 index 升序、空行分隔拼回全文（阅读顺序不可乱）", async () => {
    const read = await client.readResource({ uri: `docs://kb/${DOC_A}` });
    const first = read.contents[0];
    if (first === undefined) throw new Error("readResource 应返回至少一条内容");
    if (!("text" in first)) throw new Error("资源内容应为文本（text）");
    expect(first.uri).toBe(`docs://kb/${DOC_A}`);
    expect(first.text).toBe("第一段（index 0）\n\n第二段（index 1）\n\n第三段（index 2）");
  });

  it("读资源：单块文档同样可读（内容含种子正文）", async () => {
    const read = await client.readResource({ uri: `docs://kb/${DOC_B}` });
    const first = read.contents[0];
    if (first === undefined || !("text" in first)) throw new Error("readResource 应返回文本内容");
    expect(first.text).toContain("乙文档唯一一段");
  });
});

describe("readDoc 存储级（内存库）", () => {
  it("chunks 计数与标题正确；docId 不存在 → 抛中文错误（同 embedder.ts 错误礼仪）", async () => {
    const store = createInMemoryRagStore();
    await store.upsert([
      makeChunk(DOC_A, TITLE_A, 1, "后段"),
      makeChunk(DOC_A, TITLE_A, 0, "前段"),
    ]);
    const doc = await store.readDoc(DOC_A);
    expect(doc).toEqual({
      docId: DOC_A,
      title: TITLE_A,
      chunks: 2,
      text: "前段\n\n后段",
    });
    // 未向量化块的 embedding 绝不外泄：返回形状里根本没有向量字段
    expect(Object.keys(doc).sort()).toEqual(["chunks", "docId", "text", "title"]);

    await expect(store.readDoc("spec-mcp-不存在")).rejects.toThrow(/文档不存在：spec-mcp-不存在/);
  });
});

describe("readDoc 存储级（JSON 快照装饰器：转发 + 落盘往返）", () => {
  // temp dir 模式同 evals.spec.ts：快照文件隔离在临时目录，绝不碰 .data/kb-store.json
  const dir = mkdtempSync(join(tmpdir(), "mcp-readdoc-"));
  const snapshotPath = join(dir, "kb-store.json");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("装饰器把 readDoc 转发给内层内存库；新实例从快照读回同一份全文", async () => {
    const store = createJsonRagStore(snapshotPath);
    await store.upsert([
      makeChunk(DOC_A, TITLE_A, 1, "后半"),
      makeChunk(DOC_A, TITLE_A, 0, "前半"),
    ]);

    // 转发路径：装饰器自身不实现读取，必须委托内层内存库（顺序 / 计数 / 标题逐项对上）
    const doc = await store.readDoc(DOC_A);
    expect(doc.chunks).toBe(2);
    expect(doc.text).toBe("前半\n\n后半");
    expect(doc.title).toBe(TITLE_A);

    // 持久化路径：同一快照文件新建实例，落盘的数据读回一致（跨进程共享的前提）
    const reopened = createJsonRagStore(snapshotPath);
    const reread = await reopened.readDoc(DOC_A);
    expect(reread).toEqual(doc);

    // 不存在：与内存版同一句中文错误（两个实现一张脸）
    await expect(store.readDoc("spec-mcp-不存在")).rejects.toThrow(/文档不存在：spec-mcp-不存在/);
  });
});
