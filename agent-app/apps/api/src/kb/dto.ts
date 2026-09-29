// kb/dto.ts —— 知识库接口的请求体契约（DTO 用 class，理由同 chat/dto.ts）
// @ApiProperty 供 Swagger（/api/docs）生成 Schema：中文描述与校验规则一一对应。
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsString, Max, Min, IsOptional } from "class-validator";

/** POST /api/kb/ingest-path：服务端本地文件路径入库（multipart 之外的无头入口） */
export class IngestPathDto {
  @ApiProperty({ description: "服务端本地文件路径（支持 .txt / .md / .pdf）", example: "samples/company-faq.md" })
  @IsString({ message: "path 必须是字符串" })
  @IsNotEmpty({ message: "path 不能为空" })
  path!: string;
}

/** POST /api/kb/query：知识库问答 */
export class QueryKbDto {
  @ApiProperty({ description: "要检索的问题", example: "出差住宿标准是多少" })
  @IsString({ message: "question 必须是字符串" })
  @IsNotEmpty({ message: "question 不能为空" })
  question!: string;

  /** 返回条数，默认 5，允许 1~10（与 kb-search 工具的 k 约束一致） */
  @ApiPropertyOptional({ description: "检索返回条数（默认 5，允许 1~10）", minimum: 1, maximum: 10, default: 5 })
  @IsOptional()
  @IsInt({ message: "topK 必须是整数" })
  @Min(1, { message: "topK 最小为 1" })
  @Max(10, { message: "topK 最大为 10" })
  topK?: number;
}
