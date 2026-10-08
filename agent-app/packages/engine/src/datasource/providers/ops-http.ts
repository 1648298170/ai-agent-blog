// ops-http.ts —— ops 运营后台的 HTTP 管道：URL 组装 → 原生 fetch GET（超时 +
// 令牌头）→ HTTP / 业务码 / 网络三层错误归一成中文 Error。provider 主文件只管
// 「哪个端点配哪个 schema」，线上的脏活全在这里。
//
// 纪律：
// - 只用原生 fetch（Node 18+ 自带），不引新依赖；
// - token 永不进日志、永不出现在错误消息里（错误里带不含 token 的完整 URL 是
//   安全的，且是排障第一手信息）；
// - 所有错误都抛中文 Error 并带修复指引——工具 execute 抛错会被 runToolLoop
//   转成 error-json 回灌模型，模型看得懂的话术才能转述给用户。
import { loadEnv } from "../../config.js";

/** 未填 token 的统一话术：指向 UI 的 🔑 入口（web 对话页负责渲染输入框） */
export const OPS_MISSING_TOKEN_MESSAGE =
  "未填写 ops token：请在对话页点 🔑 填入访问令牌后重试。";

/** 统一响应壳：{code, message, data}，code 为 0 或 200 视为成功 */
interface CommonResult<T> {
  code?: number;
  message?: string;
  data: T;
}

/** 默认超时 10s：比 LLM 调用短——数据接口卡 10s 以上基本是网络/后台挂了 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** OPS_TIMEOUT_MS → 毫秒数：非正数/非数值一律回落默认（防手滑写错单位） */
function parseTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/** 去掉 base 末尾多余的斜杠（"http://x:8080/" + "/path" 会变双斜杠） */
function trimTrailingSlash(base: string): string {
  return base.replace(/\/+$/, "");
}

/** 超时/中止的统一判定：AbortSignal.timeout 超时抛 TimeoutError（DOMException） */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * 调一个 ops GET 端点，返回 data 字段（业务数据本体）。
 * 四层失败各自归一成带修复指引的中文 Error：
 * ① 没填 token（请求都没发） ② 网络层（超时/连不上） ③ HTTP 非 2xx（含 401/403
 * 认证特化话术） ④ 业务码非 0/200（后端在 200 里报业务错——Spring 常见形态）。
 */
export async function callOps<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  token: string | undefined,
): Promise<T> {
  // ① token 闸：缺失时不开口。放在 execute 内而非 createTools，让「没填钥匙」
  // 成为一个可被模型转述的结构化错误，而不是让整张工具表装配失败。
  if (token === undefined || token.trim() === "") {
    throw new Error(OPS_MISSING_TOKEN_MESSAGE);
  }

  const env = loadEnv();
  const base = env.OPS_BASE_URL ?? "";
  if (base.trim() === "") {
    throw new Error("ops 数据源未配置：环境变量 OPS_BASE_URL 为空，请让部署者在启动环境填入运营后台地址。");
  }

  // query string 平铺（Spring @ModelAttribute 风格）：undefined / 空串不进参数，
  // 让后端走自己的默认值（如 dateTime 缺省取当月）。
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    query.set(key, String(value));
  }
  const qs = query.toString();
  const url = `${trimTrailingSlash(base.trim())}${path}${qs === "" ? "" : `?${qs}`}`;

  // 令牌头：头名可配（OPS_TOKEN_HEADER，默认 Authorization）。
  // 方案冒烟已探明（2026-09）：运营后台 SPA 的真实拦截器是 e.headers.Authorization = token——
  // 裸值、无 Bearer 前缀，所以默认按裸值发；OPS_TOKEN_SCHEME=Bearer 可切回
  // "Bearer <token>" 形态（后台行为变化时唯一要动的开关）。
  const headerName = env.OPS_TOKEN_HEADER?.trim() || "Authorization";
  const scheme = env.OPS_TOKEN_SCHEME?.trim() ?? "";
  const headerValue = scheme === "" ? token : `${scheme} ${token}`;
  const timeoutMs = parseTimeoutMs(env.OPS_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { [headerName]: headerValue },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      throw new Error(`ops 请求超时（${timeoutMs}ms）：${url}。可稍后重试，或让部署者调大 OPS_TIMEOUT_MS。`);
    }
    throw new Error(
      `ops 网络请求失败：${url}（${err instanceof Error ? err.message : String(err)}）。请检查网络连通性与 OPS_BASE_URL 是否正确。`,
    );
  }

  // ③ HTTP 层：401/403 给认证特化话术（指向 🔑 输入口），其余状态码给通用修复指引。
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `ops 认证失败（HTTP ${res.status}）：访问令牌无效或已过期。请在对话页点 🔑 重新填入访问令牌后重试。`,
      );
    }
    throw new Error(
      `ops 接口返回 HTTP ${res.status}：${url}。请确认 OPS_BASE_URL 指向正确的运营后台地址后重试。`,
    );
  }

  // ④ 解析统一壳 {code, message, data}：非 JSON（网关拦截页/登录页）与业务码失败分开报。
  let body: CommonResult<T>;
  try {
    body = (await res.json()) as CommonResult<T>;
  } catch {
    throw new Error(
      `ops 接口返回了非 JSON 内容：${url}。可能是网关拦截页或登录页，请核对 OPS_BASE_URL 与访问令牌。`,
    );
  }
  if (typeof body.code === "number" && body.code !== 0 && body.code !== 200) {
    // 冒烟探明的认证现实：未登录/令牌失效走「HTTP 200 + code=401」而不是 HTTP 401——
    // 给认证特化话术（指向 🔑 入口），其余业务码给通用修复指引。
    if (body.code === 401) {
      throw new Error(
        `ops 认证失败（code=401）：${body.message ?? "未登录或令牌已过期"}。请在对话页点 🔑 重新填入访问令牌后重试。`,
      );
    }
    throw new Error(
      `ops 业务失败：code=${body.code}，message=${body.message ?? "（后端未给说明）"}。请核对查询参数（月份格式 yyyy-MM、代理商ID）或联系运营后台管理员。`,
    );
  }
  return body.data;
}
