// config.ts —— 极简环境配置：手动解析 .env，不引 dotenv
// 规矩同教程第 11 周 Day 1：key 进环境变量，不进代码；缺 key 不在此处抛错，
// chat 必须能在无 key 时启动，首次调用 LLM 失败时再给出清晰提示（见 apps/chat/cli.ts）。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 解析后的类型化配置：apiKey / baseURL / model / embeddingModel 四件套 */
export interface AppConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  embeddingModel: string;
}

/** 本项目关心的环境变量清单（环境变量优先于 .env 文件，与 dotenv 默认行为一致） */
const ENV_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "EMBEDDING_MODEL"] as const;

/**
 * 手动解析 .env 文件：只认 KEY=VALUE 行；# 开头是注释；成对引号会剥掉。
 * 文件不存在返回空表，绝不抛错。
 */
function parseEnvFile(dir: string): Record<string, string> {
  const envPath = join(dir, ".env");
  if (!existsSync(envPath)) return {};

  const vars: Record<string, string> = {};
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue; // 没有 = 或 key 为空，跳过

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/** 读 .env 并与进程环境变量合并（环境变量优先），返回合并后的键值表 */
export function loadEnv(): Record<string, string> {
  const merged: Record<string, string> = parseEnvFile(process.cwd());
  for (const key of ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined && v !== "") merged[key] = v;
  }
  return merged;
}

/** 拿类型化配置，带默认值：默认走智谱 GLM 网关（OpenAI 兼容协议，自带 embeddings） */
export function getConfig(): AppConfig {
  const env = loadEnv();
  return {
    apiKey: env.OPENAI_API_KEY ?? "",
    baseURL: env.OPENAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    model: env.OPENAI_MODEL || "glm-4-flash",
    embeddingModel: env.EMBEDDING_MODEL || "embedding-3",
  };
}
