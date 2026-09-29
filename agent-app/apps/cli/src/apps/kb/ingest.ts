// apps/kb/ingest.ts —— 知识库入库 CLI：pnpm kb:ingest <文件路径>
// 链路（教程《RAG TS 全链路》第三步 + products/kb.md 离线链路）：
//   读文件（.txt/.md 直读，.pdf 走 pdf-parse 子路径）→ ingestSource 主干
//   （切块 → 向量化 → 快照落盘）→ 打印入库统计。
// 离线优先：无 API key 时 embedding 失败，打印清晰中文配置提示后以非零码退出，不吐堆栈。
// 单仓化改造：主干链路上移 @agent-app/engine/rag 的 ingestSource（HTTP API 复用同一条路，
// app 之间禁止互相 import），本文件只保留 CLI 的参数解析、前置校验与打印——输出与行为不变。
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnv } from "@agent-app/engine/config";
import { extractTextFromFile, ingestSource, SUPPORTED_EXTENSIONS } from "@agent-app/engine/rag";
import type { IngestResult } from "@agent-app/engine/rag";

/** embedding 失败的统一配置提示（错误礼仪同 apps/chat/cli.ts） */
function printEmbeddingHint(detail: string): void {
  console.error("入库失败：调用 embedding 接口出错，无法向量化。请检查 .env 是否已按 .env.example 配置：");
  console.error("  OPENAI_API_KEY / OPENAI_BASE_URL / EMBEDDING_MODEL");
  console.error("  默认智谱 GLM 网关自带 embeddings（EMBEDDING_MODEL=embedding-3）；换网关时模型要跟着换，DeepSeek 网关没有 embeddings");
  console.error(`  错误详情：${detail}`);
}

/**
 * 入库入口。args[0] 是文件路径；缺参数只打印用法（exit 1）。
 */
export async function main(args: string[] = []): Promise<void> {
  const target = args.find((a) => !a.startsWith("-"));
  if (target === undefined) {
    console.log("用法：pnpm kb:ingest <文件路径>    支持 .txt / .md / .pdf");
    process.exitCode = 1;
    return;
  }

  const filePath = resolve(target);
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    console.error(`不支持的文件类型：「${ext || "无扩展名"}」。当前支持 .txt / .md / .pdf`);
    process.exitCode = 1;
    return;
  }

  let text: string;
  try {
    text = await extractTextFromFile(filePath);
  } catch (err) {
    console.error(`读取文件失败：${filePath}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const trimmed = text.trim();
  if (trimmed === "") {
    console.error(`文档内容为空，无块可入库：${filePath}`);
    process.exitCode = 1;
    return;
  }

  const fileName = basename(filePath);
  let result: IngestResult;
  try {
    // 主干链路（切块 → 向量化 → 快照落盘）：embedding 失败抛带配置指引的中文 Error
    result = await ingestSource(fileName, text);
  } catch (err) {
    printEmbeddingHint(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  console.log(`入库完成：${result.fileName}`);
  console.log(`  标题：${result.title}    docId：${result.docId}`);
  console.log(`  本次切块 ${result.chunks} 块，知识库当前共 ${result.total} 块`);
  // 落点提示跟随 RAG_STORE（loadEnv：环境变量优先于 .env）：json（默认）写快照文件；
  // pgvector 写 PG 表；memory 进程退出即失
  const kind = (loadEnv().RAG_STORE ?? "").trim().toLowerCase();
  if (kind === "pgvector") {
    console.log("  已写入 PostgreSQL（kb_chunks 表），运行 pnpm kb 即可提问");
  } else if (kind === "memory") {
    console.log("  已写入内存库（进程退出即失，仅自检用），运行 pnpm kb 即可提问");
  } else {
    console.log("  快照已写入 .data/kb-store.json，运行 pnpm kb 即可提问");
  }
}

// 直接运行（pnpm kb:ingest）时自动执行；被路由导入时由调用方调 main(rest)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
