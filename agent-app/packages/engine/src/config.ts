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

/**
 * 读 .env 并与进程环境变量合并（环境变量优先），返回合并后的键值表。
 *
 * 配置有两个独立来源，本函数负责把它们按优先级合并成一张表：
 *   来源 ① .env 文件   —— 部署时的「默认值」，由 parseEnvFile 手动逐行解析
 *                         （Node 原生不读 .env 文件，本项目刻意不引 dotenv，解析全透明）
 *   来源 ② process.env —— 进程出生时由操作系统注入的真实环境变量
 *                         （Shell 的 $env:XX / CI 的 secrets / Docker 的 environment 段 /
 *                          测试的 vi.stubEnv，全都走这里）
 *
 * 优先级：② > ① —— 真实环境变量是「临时覆盖」，.env 是「默认值」。
 * 典型用途：CI 里只设 secrets 就能跑（仓库不放 .env）；本地临时换 key 调试不用改文件。
 *
 * 查找顺序：cwd 向上 → 本模块目录向上，先找到的 .env 生效——
 * 无论从哪个目录启动（pnpm api / node dist / IDE），都能定位到项目根的 .env。
 */
export function loadEnv(): Record<string, string> {
  // 两个查找起点，回答两个不同的「在哪」：
  //   process.cwd()                    → 「你从哪里启动的」（跟着启动目录变）
  //   dirname(fileURLToPath(import.meta.url)) → 「config.ts 自己住在哪」（文件的真实位置，
  //      先把 file:///D:/... 形式的 URL 转成普通路径，再取所在目录）——启动目录再怎么变它都不动。
  // 两处都试：从 agent-app 根跑 pnpm api 时 cwd 直接命中 .env；从别处启动时靠候选 ② 兜底。
  const candidates = [process.cwd(), dirname(fileURLToPath(import.meta.url))];

  let fileVars: Record<string, string> = {};
  for (const start of candidates) {
    const dir = findEnvDir(start); // 从起点逐级向上找 .env，找不到返回 undefined
    if (dir) {
      fileVars = parseEnvFile(dir);
      break; // 先找到的 .env 生效，不与更远处的合并——「就近原则」：谁离启动位置近听谁的，
    }        // 避免嵌套仓库/多个包各有一份 .env 时重复读、互相污染。
  }

  // 来源 ① 铺底，来源 ② 覆盖。三条规则都在这个循环里：
  const merged = { ...fileVars };
  for (const key of ENV_KEYS) {
    const v = process.env[key];
    //   规则一：只读 ENV_KEYS 白名单内的键——系统里恰好叫同名的社会环境变量不会被误当配置（缩小意外覆盖面）；
    //   规则二：非 undefined 且非空串才覆盖——设了但为空视同「没设」，.env 的默认值继续生效；
    //   规则三：覆盖方向永远是 环境变量 → 盖过 → .env 文件（② > ①，见函数头注）。
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
