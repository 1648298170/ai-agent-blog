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
  // LLM 调用策略（AI SDK 内建能力：maxRetries 指数退避 + abortSignal 超时——
  // 全部模型调用点经 llmCallPolicy() 统一注入，销 BACKLOG #3「无显式超时/退避」）
  "AGENT_LLM_MAX_RETRIES",
  "AGENT_LLM_TIMEOUT_MS",
  // 幂等层存储开关（memory | redis；redis 版用 SET NX PX，多实例/重启语义正确）
  "IDEMPOTENCY_STORE",
  // 日志形态（text = 教学 icon/console 直出；json = pino 结构化行——生产采集用）
  "AGENT_LOG_FORMAT",
  "AGENT_LOG_LEVEL",
  // token 估算器（tiktoken = js-tiktoken 编码近似；chars = 字符系数兜底）
  "AGENT_TOKEN_ESTIMATOR",
  // 压缩水位线（销 BACKLOG ①）：模型上下文窗口 token 数——配置后压缩按 token 水位
  // 触发（替代固定 40 条阈值）；未配置时按 OPENAI_MODEL 查表（glm-4-flash=128K 等），
  // 查表也未命中则水位线不启用（打告警不静默，走条数阈值现状行为）
  "MODEL_CONTEXT_TOKENS",
  // MCP callTool 超时毫秒数（外部服务器挂起防线；0 = 关闭超时回到无限等，默认 60000）
  "AGENT_MCP_TOOL_TIMEOUT_MS",
  // LLM 注入自检开关（=1 开启）：api 层语义二道防线。教训（同 EPISODIC_STORE 补遗）：
  // 键不在本清单时 process.env 值不进合并表——.env/环境变量写法都会静默失效
  "AGENT_GUARD_LLM_SCAN",
  // Skills 技能目录（agent 的「知识扩展」——与 MCP 的「能力扩展」互补，见 engine/skills/）：
  // 配置后 chat 启动扫描目录下 */SKILL.md，全量注入 system prompt；未配置 = 默认 .agent-skills
  "SKILLS_DIR",
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
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
    } // 避免嵌套仓库/多个包各有一份 .env 时重复读、互相污染。
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

/** LLM 调用策略：重试次数与单次调用超时（毫秒）——AI SDK 调用点经 llmCallPolicy() 消费 */
export interface LlmPolicy {
  /** 传输层重试次数（AI SDK 内置指数退避，429/5xx/网络错误自动重试）；默认 2 */
  maxRetries: number;
  /** 单次模型调用超时（毫秒），经 AbortSignal.timeout 实施；默认 60_000 */
  timeoutMs: number;
}

/** 读 LLM 调用策略（env 可覆盖，非法值回退默认——配置错误不应炸掉调用链） */
export function getLlmPolicy(): LlmPolicy {
  const env = loadEnv();
  const retries = Number.parseInt(env.AGENT_LLM_MAX_RETRIES ?? "", 10);
  const timeout = Number.parseInt(env.AGENT_LLM_TIMEOUT_MS ?? "", 10);
  return {
    maxRetries: Number.isFinite(retries) && retries >= 0 ? retries : 2,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 60_000,
  };
}

// ── 护栏家族（AGENT_GUARD_*）的 .env 回填 ─────────────────────────────────
// 背景：这六个开关的读取点（chat CLI / kb-search / chat.service / llm-injection-scan）
// 全部裸读 process.env，而 loadEnv() 只返回合并表、从不写回 process.env——
// 结果是「.env 里写 AGENT_GUARD_* 静默不生效」，与其他走 loadEnv 的开关行为不一致。
// hydrateGuardEnv 在每个读取点先回填一次：.env 只补缺，真实环境变量永远优先，
// 空串视同未设——三条规则与 loadEnv() 的合并循环（130-136 行）完全同款。

/** 护栏家族的环境变量清单：读取点散落 CLI/API/引擎三层，靠回填统一拿到 .env 默认值 */
export const GUARD_ENV_KEYS = [
  "AGENT_GUARD_PII",
  "AGENT_GUARD_ALLOWLIST",
  "AGENT_GUARD_CONFIRM",
  "AGENT_GUARD_INPUT",
  "AGENT_GUARD_MCP_STRICT",
  "AGENT_GUARD_LLM_SCAN",
] as const;

/** 把 .env 解析结果回填进 process.env（只碰 GUARD_ENV_KEYS；可变函数，测试负责快照恢复） */
export function fillGuardEnvKeys(fileVars: Record<string, string>): void {
  for (const key of GUARD_ENV_KEYS) {
    const current = process.env[key];
    if (current !== undefined && current !== "") continue; // 真实环境变量已设（非空）→ 不动
    const fromFile = fileVars[key];
    if (fromFile !== undefined && fromFile !== "") process.env[key] = fromFile;
  }
}

let guardEnvHydrated = false;

/**
 * 回填护栏开关（进程内幂等一次）。测试环境跳过：单测用真实环境变量控制开关，
 * 若本机 .env 的私有值渗进测试会造成本地与 CI 行为分叉（vitest 设 NODE_ENV=test）。
 */
export function hydrateGuardEnv(): void {
  if (guardEnvHydrated || process.env.NODE_ENV === "test") return;
  guardEnvHydrated = true;
  fillGuardEnvKeys(loadEnv());
}
