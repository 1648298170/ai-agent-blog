# agent-app 待办清单（BACKLOG）

> 挂账不遗忘。每项标注触发条件——到条件再开工，不提前透支。

## ⓪ 运行时健壮性整改（工业差距审查产出，2026-09-30）

> 全项目对照工业标准的差距审查结论：🔴 两项已立项修复（见下），其余按档挂账。

### 已立项（本轮修复）

- **#1 会话 append 并发竞态**：读数组 → await 压缩（LLM 秒级）→ 写回，并发互相覆盖丢消息（内存版与 Redis 版同病）
- **#2 SSE 客户端断开不中止生成**：abortSignal 未接线，断连后模型继续烧 token

### 🔴 待办（bug 级，修完 #1/#2 后接着做）

- ~~**#3 LLM 调用无显式超时/退避**~~ ✅ **已落地（2026-10-13）**：核实结论——ai SDK 内置传输层指数退避（maxRetries，429/5xx/网络错误自动重试）+ AbortSignal.timeout 超时，经 `llmCallPolicy()` 统一注入全部 8 处模型调用点；`AGENT_LLM_MAX_RETRIES`/`AGENT_LLM_TIMEOUT_MS` env 可配（默认 2 次 / 60s）；与应用层 JSON 合规重试正交（传输层管到达，应用层管守约）
- ~~**#4 pgvector HNSW 未生效**~~ ✅ **已落地（2026-10-13）**：三选一收敛为 halfvec 唯一正解（容器内 pgvector 扩展实测 0.8.6 ≥0.7）——rag/store.pgvector.ts 与 memory/episodic.pgvector.ts 列类型 vector→halfvec（半精度 HNSW 上限 4000 维，2048 默认即走索引），旧表 ensureSchema 自动 ALTER 迁移（数据保留零重嵌，17 行历史数据实测完好）；EMBEDDING_DIM 校验上限 16000→4000。真实库迁移实测 + RUN_INFRA_TESTS 全量 259/259
- **#11 chat 页职责边界只有软约束**（2026-09-30 实测）：SYSTEM_PROMPT 加了职责范围+越界策略后，glm-4-flash 对直接创作请求（"写首诗"）**仍然照写不误**——prompt 是软约束，与用户直接指令冲突时落败。结构化解法三选一：chat 流前加分诊（复用 service 的 supervise 思路做范围分类）/ 角色切换器（opencode 式，选角色=选 prompt+裁剪工具表）/ 干脆明确 chat 就是通用演示位（产品决策：这个页面本来就叫"演示助手"）。倾向第三种+文档声明：教学项目的演示位不必伪装成生产客服，真客服在 /service 页

### 🟡 待办（生产壳与工程链，可打包为「week20 生产化」批次）

- #5 API 生产壳：~~限流 + Helmet~~ ✅ **已落地（2026-10-13）**——helmet 安全头（CSP 关闭：Swagger UI 依赖内联脚本）+ @nestjs/throttler 全局限流（默认 100/min per IP，`AGENT_THROTTLE_LIMIT` 可配 / `THROTTLE_DISABLED=1` 可关，429 中文错误体）。**仍挂账**：认证 + 多租户 RBAC + CORS 收紧（范围另议）
- #5.1 思考过程可见性开关：`AGENT_SHOW_STEPS` 全局默认（教学项目默认开）+ `?steps=0` 单次覆盖（chat/service 两条 SSE 流都收，关则不发 step 事件、前端无需改）。**设计已定稿**：common 小函数读 env+query 双档，onStep 回调判开关，默认行为不变；安全动机=step 事件透传工具入参、推理文本暴露提示词形状（week19 E1 佐证）
- #6 结构化日志：~~pino JSON 模式~~ ✅ **已落地（2026-10-13）**——`AGENT_LOG_FORMAT=json` 双模式（logger.ts 切 pino、trace.ts 出 JSON 行），默认 text 逐字节不变。**仍挂账**：X-Request-ID 请求关联贯穿
- ~~#7 提交链机械约束~~ ✅ **已落地（2026-10-13）**：husky（pre-commit→lint-staged→prettier 增量格式化；commit-msg→commitlint 校验 conventional，中文 subject/长 header 已适配）+ `pnpm audit --audit-level high` 独立 CI（.github/workflows/audit.yml，不阻塞部署）
- ~~#8 统一 formatter~~ ✅ **已落地（2026-10-13）**：prettier 配置 + lint-staged 增量生效（刻意不做全仓格式化——存量 341 文件由提交触达时逐个收敛）
- #9 输出内容审核层（当前依赖 GLM 网关过滤器，不可控不可测）
- #10 token 用量聚合与成本面板（usage 飘过就丢；与 ① 水位线共享 usage 校准基建）

### 🟢 教学取舍（诚实标注，不算欠债）

纯向量检索无混合/重排（week15 进阶）；judge 无校准集；MCP 仅 stdio；listSessions 无分页；.env 明文密钥（生产需 secrets manager）。

## ① 压缩水位线升级：按模型上下文上限 × buffer 替代固定条数阈值 ✅ **已落地（2026-10-13）**

> **落地说明**：照下方设计稿实现，改动边界守约（只动 `compression.ts` 水位策略 + factory 组装 + session 两实现透传 + config 一个 key）。与设计稿的一处升级：估算②「字符数×系数」层直接被 `memory/token-estimate.ts`（tiktoken/chars 可切）取代，比字符系数更精确。实现：配置 `MODEL_CONTEXT_TOKENS`（env 直配或按 OPENAI_MODEL 查表，查表未命中**有告警**后不启用——40d534a 消除静默失效）后，压缩按 token 水位触发（全窗口估算 > 窗口×75%），保留量从尾部贪心至 ≤ 窗口×50%（targetRatio 0.5，审查纠正过误用 bufferRatio 的 25% 语义）；未配置走条数阈值现状行为逐字节不变。watermark 用例：首批 8 例 + 40d534a 增补 2 例（扩充命中/空模型名不告警）共 10 例，全量 248 过。

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

- ~~`pnpm team "目标"` CLI 入口~~ ✅ **已落地（2026-10-13）**：`pnpm team "目标"`（动态）/ `pnpm team --plan plan.json`（静态）/ `--trace --id --max-tokens`；demo 工具过幂等壳；真实动态冒烟 3 任务全链路通过（含 critic 拒绝→打回→降级的完整验收链）；顺带修掉 extractJson 不支持 JSON 数组的引擎 bug（LlmPlanner 任务单解析必挂）
- P1 升格叙事（半小时，零代码）：`service/README.md` 增补「你就是多 Agent：Supervisor 模式」——supervisor = 路由 Agent，workers = 三个专家 Agent（独立 system prompt + 最小权限工具表），HandoffPack = Agent 间上下文交接；对照 LangGraph supervisor / CrewAI manager+crew
- P3 A2A 落地（week19 Day 4 的代码化）：`GET /.well-known/agent-card.json` + `POST /a2a/tasks`（接收外部 Agent 委托 → 路由到 worker 或编排流水线）；狗粮：双实例互调
- 在线观测档位：编排事件流接 SSE（前端看拆/派/跑实时轨迹）、token 成本聚合（与 #10 共享基建）

## ③ 输出质量闸：Reflection / 生成-评审循环（待立项，2026-10-13 调研入账）

> **缺口**：三条输出路径中 kb/service/chat 的「模型输出即结束」，无质量判定（编排器的 Critic 闭环只覆盖 `pnpm team`）。业界主流 = 分层质量闸光谱：**确定性代码校验（零成本）> 级联 judge（小模型）> Reflexion 循环（1.5-1.9x token）**，按「错误的代价」选闸门高度，而非在线全量 judge。
>
> **关键调研数据**（2026-10，来源：LangGraph/OpenAI Agents SDK/ADK 官方文档 + niteagent/solana.garden 生产复盘 + MS Foundry 评估体系）：级联触发省 20% token、质量仅 -2%；单 judge 精度 82%、3-judge 投票 91%（成本×3）；Reflexion 生产案例一次成功率 38%→71%（token 1.9x）；多 Agent 辩论式 3x 成本慎用；**质量退化检测**（重试后分数下降回退首轮）是生产复盘反复强调的保护。

**触发条件**：kb/service 上线后有真实质量反馈；或水位线基建（已备：estimateTokens） wanting 应用。

**分层设计**（按错误的代价选闸门高度，全部 opt-in 默认关——离线优先）：

- 第一批（确定性闸，零 LLM 成本，**建议必做**）：kb citation 校验——引用编号真实存在、命中分数 ≥ 阈值、空检索时拒答的诚实性校验（业界共识：确定性代码 > LLM judge，LitRAG 幻觉召回 1.000 的做法）
- 第二批（llm-judge 级联）：轻量打分 < 阈值才触发完整 judge（judge 用 glm-4-flash 自身，成本 ≈ 主回答 1/10）；**质量退化回退**（重试后分数下降则保留首轮——防越改越差）；judge 用合并维度单次调用（MS Foundry 模式：多维打包 1 次 judge 降成本）
- 第三批：SSE `reflection` 事件（判定结果 + 反馈，前端可折叠展示——对齐 #5.1 可见性哲学）
- 后置（挂账）：Reflexion 反思记忆——失败经验按 task family 持久化、锚定确定性评估信号、人工可删（依赖 #10）

**已有地基**：estimateTokens（水位线估算）、编排器 Critic 三实现（contains/llm-judge/manual 判定骨架可复用）、AGENT_GUARD_* env 开关模式、SSE 骨架三端同款。

**明确不做**：chat 自由对话不接反思（无客观验收标准，judge 误判率高于收益）；guardrails 模块保持零网络零 key 纪律（LLM 自检放 api 层，与 `AGENT_GUARD_LLM_SCAN` 同款分层）。

**验收（预设）**：kb citation 闸为纯函数零成本；llm-judge 级联可控（抽样/阈值可配）；reflection 事件进 SSE 合同；全部开关关闭时与现状逐字节一致；judge 误判有回退（质量退化检测）。

## ② 其他挂账（按 SECURITY.md / README 既有记录）

| 项                                                                                                                                                                 | 来源                             | 触发条件                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------- |
| Skills 第二批：**渐进披露**——system prompt 只放「name: description」清单 + 内置工具 `load_skill(name)`（Agent 判断需要时自己读全文）；几十个技能时的上下文成本正解 | skills/ 第一批落地（2026-10-15） | 技能数量 >10 或出现真实上下文压力时                |
| Skills 教学篇：docs 站补「能力扩展 vs 知识扩展」对照章（MCP 给锤子 / Skill 给手册，--mcp 与 --skills 并排讲），含写一个技能的动手任务                              | skills/ 第一批落地（2026-10-15） | 下次动 docs/guide 或 MCP 专题教程时顺手            |
| 在线评估（trace 回流数据集）                                                                                                                                       | evals/README 路线图              | 有真实流量后                                       |
| MCP 服务器身份 TOFU 指纹 / 检索内容沙箱                                                                                                                            | SECURITY.md 结构性档             | 安全篇深入时                                       |
| 认证 / 多租户 / CORS 收紧                                                                                                                                          | README「后续扩展」               | week20 生产化阶段（限流+helmet 已落地 2026-10-13） |
| evals 注入回归集（红队 E1-E8 载荷入 evals）                                                                                                                        | SECURITY.md 结构性档             | 学 evals 时顺手做                                  |
| EXTENDING.md 增补编排器/幂等扩展指引（per-task 预算、IDEMPOTENCY_STORE 切换、llmCallPolicy 定制）                                                                  | 四轮复查遗留的可选文档债         | 下次动 docs/how-to 时顺手                          |
