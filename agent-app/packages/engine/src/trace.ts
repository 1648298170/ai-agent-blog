// trace.ts —— 执行轨迹开关：把 Agent 每一步（模型调用 / 工具调度 / 路由判定 / 检索命中 /
// 记忆压缩）打印到 stderr，对应教程 week11 手写循环的「想给每步打日志就在对应行插入」与
// week20 的 Thought / Action / Observation 面板思想。
//
// 开启方式（二选一）：
//   1. 环境变量 AGENT_TRACE=1（HTTP API 服务器同样生效：$env:AGENT_TRACE="1"; pnpm api）
//   2. CLI 传参 --trace（pnpm chat --trace / pnpm kb --trace / pnpm service --trace）
//
// 输出走 stderr 而不是 stdout：stdout 保持干净（管道 / 重定向不被轨迹污染），
// 控制台上两者都可见，观察时不损失任何信息。

/** 轨迹是否已开启（读环境变量，默认关） */
export function isTraceEnabled(): boolean {
  const v = process.env.AGENT_TRACE;
  return v === "1" || v === "true";
}

/** 代码里强制开启轨迹（CLI 的 --trace 参数走这里） */
export function enableTrace(): void {
  process.env.AGENT_TRACE = "1";
}

/**
 * 长值截成一眼能看懂的预览：轨迹是给人扫读的，不是结构化日志。
 * 字符串原样展示（不套 JSON 引号）；其他值 JSON 序列化（失败退回 String）；
 * 超长截断并标注原始长度。
 */
export function preview(value: unknown, max = 200): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
    if (text === undefined) text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字符）` : text;
}

/**
 * 打一条轨迹。未开启时直接返回（一行布尔判断，热路径零负担）。
 * icon 约定：▶ 思考（模型调用） ⚙ 行动（要调工具） ✓/✗ 观察（工具结果）
 *           🧭 路由（supervisor 判定） 🔎 检索（RAG 命中） 🧠 记忆（压缩事件）
 */
export function trace(icon: string, message: string): void {
  if (!isTraceEnabled()) return;
  process.stderr.write(`${icon} ${message}\n`);
}
