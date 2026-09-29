// all-exceptions.filter.ts —— 全局异常过滤器：把引擎抛出的中文错误转成统一 JSON
// 错误礼仪对齐 CLI（apps/chat/cli.ts）：未知/LLM/配置类错误 → 500 + 中文 message +
// 可选 hint（怎么改 .env）；HttpException（含 ValidationPipe 的 400）原样放行，
// 不吞框架的标准错误形状。
// 响应体形状 ApiErrorBody 定义在 @agent-app/shared（跨端契约）。
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import type { ApiErrorBody } from "@agent-app/shared";
import { getConfig } from "@agent-app/engine/config";

/** LLM 主链路的配置指引（同 apps/chat/cli.ts 的提示） */
const LLM_HINT =
  "请检查 .env 是否已按 .env.example 配置：OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL" +
  "（无 .env 时默认走智谱 GLM 网关）";

/** embedding 链路的配置指引（同 kb 入库 CLI 的提示：换网关时 embedding 模型要跟着换） */
const EMBEDDING_HINT =
  "请检查 .env 是否已按 .env.example 配置：OPENAI_API_KEY / OPENAI_BASE_URL / EMBEDDING_MODEL；" +
  "默认智谱 GLM 网关自带 embeddings（embedding-3），换网关时 EMBEDDING_MODEL 要跟着换，" +
  "注意 DeepSeek 网关不提供 embeddings 接口";

/**
 * 判断错误是否与 LLM/配置相关，是则给出对应配置指引。
 * 判据：embedding 关键词优先（提示更具体）；否则看「没配 key」或报错文本里的鉴权/模型特征。
 */
export function buildConfigHint(exception: unknown): string | undefined {
  const message = exception instanceof Error ? exception.message : String(exception);
  if (/embedding|向量化|embeddings/i.test(message)) {
    return EMBEDDING_HINT;
  }
  if (getConfig().apiKey === "" || /api key|401|unauthorized|模型|llm|openai|deepseek|bigmodel|glm/i.test(message)) {
    return LLM_HINT;
  }
  return undefined;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  /** Nest 官方 Logger（替换裸 console.error）：带上过滤器类名作上下文，方便日志检索 */
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // HttpException（400 校验 / 404 路由等框架已知错误）原样放行
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      response
        .status(status)
        .json(typeof body === "string" ? { statusCode: status, message: body } : body);
      return;
    }

    // 未知错误（引擎/LLM/配置）：中文 message + 可选配置指引，不吐英文堆栈
    const detail = exception instanceof Error ? exception.message : String(exception);
    this.logger.error(`[api] ${request.method} ${request.url} 未处理异常：${detail}`);
    const payload: ApiErrorBody = {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: `服务器内部错误：${detail}`,
    };
    const hint = buildConfigHint(exception);
    if (hint !== undefined) payload.hint = hint;
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(payload);
  }
}
