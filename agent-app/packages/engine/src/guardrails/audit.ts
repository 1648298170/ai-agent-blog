// guardrails/audit.ts —— 审计日志：安全事件的 JSONL 追加落盘（红队加固轮 H10）
//
// ── 为什么审计要独立成层、且必须「永不崩主流程」────────────────────────────
// E4/E6 的裁决、E2 的扫描命中此前只在 SSE 帧与 stderr 里飘过——事后无法回答
// 「什么时候拦了什么」。审计是事后可追溯性的底线：闸门拒绝、人工裁决、入库拒收、
// 用户消息拒绝都值得留一条不可抵赖的时间线。因此它的失败纪律与业务相反：
// 业务失败要抛错给用户看，审计失败必须静默——写日志的动作绝不能反过来
// 破坏被它记录的那条安全路径（fire-and-forget + try/catch 全包）。
//
// ── 落盘形态：JSONL 追加，一行一事件 ────────────────────────────────────────
// 每行 { ...details, event, time }：事件名与时间戳由本层强制注入且放在最后
// （details 里的同名字段不会覆盖它们）。无轮转，教程规模够用——正式部署
// 接集中式日志采集（filebeat/otel）时替换本实现即可，调用方零改动。
//
// ── 路径解析：与 rag/persistence.ts 的 kb-store.json 同款 ─────────────────
// 默认 agent-app/.data/audit.log（跟随 cwd、.data/ 已进 .gitignore）。
// AGENT_AUDIT_LOG 环境变量可整体改写路径：测试指向临时文件避免污染真实
// .data/，部署可指向独立数据卷。第三个参数允许显式传路径（单测用）。
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** 默认落盘位置：agent-app/.data/audit.log（每次调用时解析，env 覆盖即时生效） */
function defaultAuditPath(): string {
  return process.env.AGENT_AUDIT_LOG ?? join(process.cwd(), ".data", "audit.log");
}

/**
 * 追加一条审计事件（同步写、fire-and-forget）。
 * 任何 I/O 异常都被吞掉：审计失败不能阻断业务/安全路径的正常返回——
 * 这与闸门的「拒绝即数据」是同一条纪律的两面：可观测性永远不做拦路石。
 */
export function auditLog(event: string, details: Record<string, unknown>, filePath?: string): void {
  try {
    const target = filePath ?? defaultAuditPath();
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(
      target,
      JSON.stringify({ ...details, event, time: new Date().toISOString() }) + "\n",
      "utf8",
    );
  } catch {
    // 静默失败（磁盘满/权限不足等）：主流程继续，安全动作本身已经完成
  }
}
