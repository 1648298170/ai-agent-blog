// show-steps.ts —— 思考过程可见性开关（BACKLOG #5.1）：
// step 事件透传工具入参与模型推理文本，暴露提示词形状（week19 E1 佐证的安全动机）。
// 双档设计（定稿于 BACKLOG #5.1）：
//   AGENT_SHOW_STEPS  全局默认——教学项目默认「开」（不发开关 = 现状行为，零变化）；
//                      生产置 0 全局关闭。
//   ?steps=0 / ?steps=1  单次覆盖——query 优先于 env，同一流式端点按需切换，
//                      前端无需任何改动（关则不发 step 事件，事件流形状自然收窄）。
// 读法：process.env 直接读——HTTP 壳（BFF）的关注点与引擎的 .env 密钥加载分层
//（同限流 THROTTLE_DISABLED 的取舍）。

/** 解析单条流式请求是否透出 step 事件。stepsQuery 来自 ?steps= 查询参数（可缺省） */
export function resolveShowSteps(stepsQuery: string | undefined): boolean {
  if (stepsQuery !== undefined) {
    const q = stepsQuery.trim().toLowerCase();
    if (q === "0" || q === "false" || q === "off") return false;
    if (q === "1" || q === "true" || q === "on") return true;
    // 非法值不猜：按未传处理，落到 env 默认
  }
  const env = (process.env.AGENT_SHOW_STEPS ?? "").trim().toLowerCase();
  if (env === "0" || env === "false" || env === "off") return false;
  return true; // 默认开：教学项目 step 面板是核心观测面，现状行为
}
