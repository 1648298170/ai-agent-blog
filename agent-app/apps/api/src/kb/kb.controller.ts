// kb.controller.ts —— /api/kb：multipart 入库 + 路径入库 + 问答
// multipart 用 FileInterceptor（字段名 file，内存存储：不落临时盘，buffer 直接进链路）。
// 入库核心经 @agent-app/engine/rag 消费（IngestResult 契约同源）。
import { BadRequestException, Body, Controller, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBadRequestResponse, ApiTags } from "@nestjs/swagger";
import type { IngestResult } from "@agent-app/engine/rag";
import { KbService } from "./kb.service.js";
import type { KbAnswer } from "./kb.service.js";
import { IngestPathDto, QueryKbDto } from "./dto.js";

@ApiTags("kb")
@Controller("api/kb")
export class KbController {
  constructor(private readonly kb: KbService) {}

  /**
   * multipart 入库：curl -F "file=@samples/company-faq.md" http://localhost:3000/api/kb/ingest
   * 支持 .txt / .md / .pdf；embedding 失败由全局过滤器转配置提示 JSON。
   */
  @Post("ingest")
  @UseInterceptors(FileInterceptor("file"))
  @ApiBadRequestResponse({ description: "缺少 multipart 字段 file / 文件类型不支持 / 文档内容为空" })
  async ingest(@UploadedFile() file: Express.Multer.File | undefined): Promise<IngestResult> {
    if (file === undefined) {
      throw new BadRequestException("缺少 multipart 字段 file（支持 .txt / .md / .pdf）");
    }
    return this.kb.ingestBuffer(file.originalname, file.buffer);
  }

  /** 路径入库（无头入口）：服务器本地文件路径 → 同一条入库主干 */
  @Post("ingest-path")
  @ApiBadRequestResponse({ description: "请求体校验失败 / 路径读取失败 / 文件类型不支持" })
  async ingestPath(@Body() dto: IngestPathDto): Promise<IngestResult> {
    return this.kb.ingestPath(dto.path);
  }

  /** 知识库问答：{ question, topK? } → { answer, citations, degraded } */
  @Post("query")
  @ApiBadRequestResponse({ description: "请求体校验失败（缺 question / topK 超出 1~10）" })
  async query(@Body() dto: QueryKbDto): Promise<KbAnswer> {
    return this.kb.query({ question: dto.question, topK: dto.topK });
  }
}
