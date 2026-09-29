// kb.service.ts —— 知识库业务：apps/kb/cli.ts 的 HTTP 化（入库 + 带引用问答）
// 构造时挂 JSON 快照库（与 CLI 同一份 .data/kb-store.json，跨进程共享）。
// 问答流程同 CLI：检索 top-k → 空结果老实说不知道 → 命中块拼进 prompt →
// 只依据资料作答并标 [1][2]；LLM 挂了降级返回检索原文 + 出处（不给报错页）。
// 单仓化改造：入库核心（extract / ingestSource）上移 @agent-app/engine/rag，
// 不再跨 app 引 apps/kb 的实现——CLI 与 HTTP API 走同一条包内主干。
import { BadRequestException, Injectable } from "@nestjs/common";
import { extname, resolve } from "node:path";
import { basename } from "node:path";
import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { createModel } from "@agent-app/engine/llm";
import {
  createJsonRagStore,
  extractTextFromBuffer,
  extractTextFromFile,
  ingestSource,
  searchKnowledge,
  setRagStore,
  SUPPORTED_EXTENSIONS,
} from "@agent-app/engine/rag";
import type { IngestResult, RetrievedChunk } from "@agent-app/engine/rag";
import { ConfigProvider } from "../common/config.provider.js";

// 与 apps/kb/cli.ts 完全一致的提示词与提示语
const SYSTEM_PROMPT =
  "你是知识库问答助手，只依据用户消息里「资料」一节给出的内容回答，" +
  "引用哪段就在句末标注编号，如 [1][2]。" +
  "资料里没有答案就直说不知道，禁止编造。回答用中文，简洁准确。";

const EMPTY_REPLY = "知识库里没有找到相关内容，这题我不答。请先入库对应文档，或换个问法试试。";

/** 命中块 → 编号资料（引用编号由后端分配、模型只负责标号，编不了出处） */
function buildGroundedPrompt(question: string, hits: RetrievedChunk[]): string {
  const material = hits.map((chunk, i) => `[${i + 1}]（${chunk.title}）\n${chunk.text}`).join("\n\n");
  return `资料：\n${material}\n\n问题：${question}`;
}

/** 引用来源的 JSON 形状：编号 + 标题 + 相似度（CLI 的 formatCitations 打印块对应物） */
export interface Citation {
  no: number;
  title: string;
  score: number;
}

/** POST /api/kb/query 响应 */
export interface KbAnswer {
  answer: string;
  citations: Citation[];
  /** true = LLM 不可用，answer 是检索原文拼接（kb.md 降级预案） */
  degraded: boolean;
  /** degraded 时给出的配置指引 */
  hint?: string;
}

@Injectable()
export class KbService {
  constructor(private readonly config: ConfigProvider) {
    setRagStore(createJsonRagStore()); // 与 CLI 同一份快照：入库与问答跨进程共享
  }

  /** 校验扩展名（multipart 上传与 ingest-path 共用的闸） */
  private assertSupportedExt(fileNameOrPath: string): string {
    const ext = extname(fileNameOrPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw new BadRequestException(`不支持的文件类型：「${ext || "无扩展名"}」。当前支持 .txt / .md / .pdf`);
    }
    return ext;
  }

  /** multipart 入库：上传文件的 buffer → 抽文本 → 主干链路 */
  async ingestBuffer(fileName: string, buffer: Buffer): Promise<IngestResult> {
    const ext = this.assertSupportedExt(fileName);
    const text = await extractTextFromBuffer(buffer, ext);
    if (text.trim() === "") {
      throw new BadRequestException(`文档内容为空，无块可入库：${fileName}`);
    }
    return ingestSource(fileName, text);
  }

  /** 本地路径入库（无头入口）：服务端磁盘文件 → 主干链路（与 CLI kb:ingest 同一条路） */
  async ingestPath(path: string): Promise<IngestResult> {
    const filePath = resolve(path);
    this.assertSupportedExt(filePath);
    let text: string;
    try {
      text = await extractTextFromFile(filePath);
    } catch (err) {
      throw new BadRequestException(
        `读取文件失败：${filePath}（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
    const fileName = basename(filePath);
    if (text.trim() === "") {
      throw new BadRequestException(`文档内容为空，无块可入库：${filePath}`);
    }
    return ingestSource(fileName, text);
  }

  /**
   * 知识库问答（apps/kb/cli.ts 单轮版）：
   * 检索失败（embedding 报错）原样抛出 → 全局过滤器给配置提示 JSON；
   * 空结果老实说不知道；LLM 失败降级为检索原文 + 出处。
   */
  async query(input: { question: string; topK?: number }): Promise<KbAnswer> {
    const hits = await searchKnowledge(input.question, input.topK ?? 5);

    const citations: Citation[] = hits.map((chunk, i) => ({
      no: i + 1,
      title: chunk.title,
      score: Number(chunk.score.toFixed(3)),
    }));

    if (hits.length === 0) {
      return { answer: EMPTY_REPLY, citations, degraded: false };
    }

    const messages: ModelMessage[] = [{ role: "user", content: buildGroundedPrompt(input.question, hits) }];
    try {
      const { text } = await generateText({ model: createModel(), system: SYSTEM_PROMPT, messages });
      return { answer: text, citations, degraded: false };
    } catch {
      // 降级（kb.md）：LLM 挂了，检索链路还活着——原文和出处照样交出去，不给报错页
      const degradedAnswer = hits
        .map((chunk, i) => `[${i + 1}]（${chunk.title}）${chunk.text}`)
        .join("\n");
      return {
        answer: degradedAnswer,
        citations,
        degraded: true,
        hint: this.config.hasApiKey()
          ? "LLM 暂不可用，本次返回检索原文与出处（未经润色）"
          : "LLM 暂不可用（未配置 OPENAI_API_KEY），本次返回检索原文与出处；" +
            "请复制 .env.example 为 .env 并配置 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL",
      };
    }
  }
}
