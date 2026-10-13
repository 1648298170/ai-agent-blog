# agent-app 待办清单（BACKLOG）

> 挂账不遗忘。每项标注触发条件——到条件再开工，不提前透支。

## ⓪ 运行时健壮性整改（工业差距审查产出，2026-09-30）

> 全项目对照工业标准的差距审查结论：🔴 两项已立项修复（见下），其余按档挂账。

### 已立项（本轮修复）
- **#1 会话 append 并发竞态**：读数组 → await 压缩（LLM 秒级）→ 写回，并发互相覆盖丢消息（内存版与 Redis 版同病）
- **#2 SSE 客户端断开不中止生成**：abortSignal 未接线，断连后模型继续烧 token

### 🔴 待办（bug 级，修完 #1/#2 后接着做）
- **#3 LLM 调用无显式超时/退避**：429/5xx 指数退避+抖动的应用层策略缺失（需先核实 ai SDK provider 内置重试的边界）
- **#4 pgvector HNSW 未生效**：2048 维 > ANN 上限 2000，检索走顺序扫描——三选一拍板：换 ≤2000 维模型 / pgvector 0.7+ halfvec / 降维
- **#11 chat 页职责边界只有软约束**（2026-09-30 实测）：SYSTEM_PROMPT 加了职责范围+越界策略后，glm-4-flash 对直接创作请求（"写首诗"）**仍然照写不误**——prompt 是软约束，与用户直接指令冲突时落败。结构化解法三选一：chat 流前加分诊（复用 service 的 supervise 思路做范围分类）/ 角色切换器（opencode 式，选角色=选 prompt+裁剪工具表）/ 干脆明确 chat 就是通用演示位（产品决策：这个页面本来就叫"演示助手"）。倾向第三种+文档声明：教学项目的演示位不必伪装成生产客服，真客服在 /service 页

### 🟡 待办（生产壳与工程链，可打包为「week20 生产化」批次）
- #5 API 生产壳：认证 + 限流 + CORS 收紧 + Helmet（原有挂账）
- #5.1 思考过程可见性开关：`AGENT_SHOW_STEPS` 全局默认（教学项目默认开）+ `?steps=0` 单次覆盖（chat/service 两条 SSE 流都收，关则不发 step 事件、前端无需改）。**设计已定稿**：common 小函数读 env+query 双档，onStep 回调判开关，默认行为不变；安全动机=step 事件透传工具入参、推理文本暴露提示词形状（week19 E1 佐证）
- #6 结构化日志与请求关联 ID（X-Request-ID 贯穿，替代演示级 trace 图标流）
- #7 提交链机械约束：husky + lint-staged + commitlint + `pnpm audit` 进 CI
- #8 统一 formatter（prettier/biome）
- #9 输出内容审核层（当前依赖 GLM 网关过滤器，不可控不可测）
- #10 token 用量聚合与成本面板（usage 飘过就丢；与 ① 水位线共享 usage 校准基建）

### 🟢 教学取舍（诚实标注，不算欠债）
纯向量检索无混合/重排（week15 进阶）；judge 无校准集；MCP 仅 stdio；listSessions 无分页；.env 明文密钥（生产需 secrets manager）。

## ① 压缩水位线升级：按模型上下文上限 × buffer 替代固定条数阈值（week17 Day 2 学完后的首选练习）

**触发条件**：学完 `docs/archive/weeks/week17/day2.md`（短期记忆/compaction）——适合自己动手当练习，做完我验收；也可指定由我实现。

**现状的问题**（红队之外的诚实差距）：`compression.ts` 写死「40 条消息」触发压缩。工业做法（opencode / Claude Code）是**按模型上下文窗口算水位线**——条数不是 token 的合格代理变量（40 条"你好" vs 40 条 10KB 日志天差地别）；换小窗口模型或长文本工具输出时会失守。

**工业标准设计（照此实现）**：

```text
水位线 = 模型上下文窗口 × (1 - buffer比例)      ← buffer 默认 25%：留给回答 + 压缩调用本身
压缩触发：估算 token > 水位线
估算三层：
  ① 校准：上次 generateText 返回的 usage.inputTokens（SDK 现成，反馈式修正估算）
  ② 估算：字符数 × 模型系数（中文 ≈1 token/字，英文 ≈0.25/字符）
  ③ 兜底：无任何数据时退回条数阈值（= 现状行为，向下兼容）
压缩目标：压到窗口 50% 水位（而非固定保留 20 条）
配置：MODEL_CONTEXT_TOKENS 按模型查表（glm-4-flash=128K…），env 可覆盖
```

**改动边界**：只动 `compression.ts`（"算法唯一实现"接缝就是为此留的），session.memory / session.redis 零感知；MODEL_CONTEXT_TOKENS 进 config.ts 的 ENV_KEYS。

**验收**：单测——估算三层各自可断言（注假 usage/注假系数）；水位触发与 40 条兜底两条路径；两存储实现行为一致。动手实验不变：`pnpm service --trace` 看 🧠 事件。

## ② Multi-Agent 教学落地

> **状态更新（2026-10-13）**：P2 主体已由 `packages/engine/src/orchestrator/`（模块八，Effect 范式）落地——commit `48ad814` + `2a01e3d`。与原计划的差异：目录名 `teams/` → `orchestrator/`；文件划分改为 types/errors/policies/state-store/roles/defaults/orchestrator/index（无 blackboard/planner/executor/critic 单文件——三角色合入 roles.ts + defaults.ts，黑板职责由 StateStore 快照承担）；实现范式从手写 Promise 升级为 Effect.gen（结构化并发 / TestClock 虚拟时钟 / TaggedError 类型化错误）。critic 评审-打回已接线（manual→escalated、失败终态落盘后重入合法）、DAG 波次并行、per-task 预算均已实现，30 离线用例全绿。完整深讲见 `docs/reference/10-orchestrator.md`。

**仍挂账的子项**：
- `pnpm team "目标"` CLI 入口（apps/cli 加编排命令，消费 Orchestrator）
- P1 升格叙事（半小时，零代码）：`service/README.md` 增补「你就是多 Agent：Supervisor 模式」——supervisor = 路由 Agent，workers = 三个专家 Agent（独立 system prompt + 最小权限工具表），HandoffPack = Agent 间上下文交接；对照 LangGraph supervisor / CrewAI manager+crew
- P3 A2A 落地（week19 Day 4 的代码化）：`GET /.well-known/agent-card.json` + `POST /a2a/tasks`（接收外部 Agent 委托 → 路由到 worker 或编排流水线）；狗粮：双实例互调
- 在线观测档位：编排事件流接 SSE（前端看拆/派/跑实时轨迹）、token 成本聚合（与 #10 共享基建）

## ② 其他挂账（按 SECURITY.md / README 既有记录）

| 项 | 来源 | 触发条件 |
| --- | --- | --- |
| 在线评估（trace 回流数据集） | evals/README 路线图 | 有真实流量后 |
| MCP 服务器身份 TOFU 指纹 / 检索内容沙箱 | SECURITY.md 结构性档 | 安全篇深入时 |
| 认证 / 多租户 / 限流 | README「后续扩展」 | week20 生产化阶段 |
| evals 注入回归集（红队 E1-E8 载荷入 evals） | SECURITY.md 结构性档 | 学 evals 时顺手做 |
