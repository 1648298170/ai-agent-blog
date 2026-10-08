// config.ts —— 极简环境配置：手动解析 .env，不引 dotenv
// 规矩同教程第 11 周 Day 1：key 进环境变量，不进代码；缺 key 不在此处抛错，
// chat 必须能在无 key 时启动，首次调用 LLM 失败时再给出清晰提示（见 apps/chat/cli.ts）。
// .env 查找策略（monorepo 后的实战教训）：从 cwd 和本模块所在目录分别向上逐级查找——
// 否则 `node apps/api/dist/main.js` 换个目录启动就会丢 .env，空 key 打网关直接 401。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 解析后的类型化配置：apiKey / baseURL / model / embeddingModel 四件套 */
export interface AppConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  embeddingModel: string;
}

/** 本项目关心的环境变量清单（环境变量优先于 .env 文件，与 dotenv 默认行为一致）
 *
 * 前四个是 LLM 网关四件套；INFRA_KEYS 是持久化基座开关（week14 pgvector / week17 Redis）：
 * 三个 *_STORE 开关决定工厂（rag/store.factory.ts、memory/factory.ts）装配哪个实现，
 * 连接串与维度由对应实现读取——全部有安全默认值，不配置 = 离线默认（json 快照 + 内存记忆）。
 */
const ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "EMBEDDING_MODEL",
  "RAG_STORE",
  "SESSION_STORE",
  "PREFERENCE_STORE",
  // 2026-09 补遗：EPISODIC_STORE 此前漏在清单外——进程环境变量方式会被丢掉，
  // 只有写进 .env 文件才生效（与 README「临时环境变量也行」的口径不符）。
  // Docker 容器里没有 .env（env 全靠 compose 注入），缺这一行情景记忆会静默回退内存版。
  "EPISODIC_STORE",
  "PG_CONNECTION_STRING",
  "REDIS_URL",
  "EMBEDDING_DIM",
  // 2026-09 外部数据源插件（datasource/providers/ops）：运营后台地址 / 令牌头名 / 令牌
  // 方案 / 超时。进清单的理由与 EPISODIC_STORE 同款：不进清单时进程环境变量会被丢掉、
  // 只有写 .env 文件才生效——冒烟与容器注入（docker compose environment）走的都是进程环境变量。
  // OPS_TOKEN_SCHEME 是冒烟探明 SPA 真实拦截器发「裸 token」后留的后门：默认裸值，
  // 设为 Bearer 可切 "Bearer <token>" 形态。
  "OPS_BASE_URL",
  "OPS_TOKEN_HEADER",
  "OPS_TOKEN_SCHEME",
  "OPS_TIMEOUT_MS",
] as const;

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

/** 从 startDir（含自身）逐级向上找包含 .env 的目录；到盘符根仍没有则返回 null */
function findEnvDir(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".env"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // 已到根
    dir = parent;
  }
}

/** 读 .env 并与进程环境变量合并（环境变量优先），返回合并后的键值表。
 * 查找顺序：cwd 向上 → 本模块目录向上，先找到的 .env 生效——
 * 无论从哪个目录启动（pnpm api / node dist / IDE），都能定位到项目根的 .env。
 */
export function loadEnv(): Record<string, string> {
  const candidates = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  let fileVars: Record<string, string> = {};
  for (const start of candidates) {
    const dir = findEnvDir(start);
    if (dir) {
      fileVars = parseEnvFile(dir);
      break; // 先找到的 .env 生效，不与更远处的合并
    }
  }
  const merged = { ...fileVars };
  for (const key of ENV_KEYS) {
    const v = process.env[key];
    // 2026-09 修正：显式设成空串的进程环境变量也要覆盖 .env 文件值（与 dotenv
    // 语义一致——dotenv 从不改动已存在的环境变量，哪怕它是空串）。旧逻辑把空串
    // 当「没设」，会让「stub 空 base 地址 → 数据源应关闭」这类显式置空失效，
    // .env 里残留的旧值反 leaked 回来（isConfigured 单测在带 OPS_BASE_URL 的
    // .env 机器上稳定复现）。消费方全部对空串做了归一（trim/默认值兜底），
    // 显式空串覆盖不会改变任何运行行为，只是把「进程优先」承诺补齐。
    if (v !== undefined) merged[key] = v;
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
