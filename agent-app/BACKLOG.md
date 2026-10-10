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

## ② Multi-Agent 教学落地（等现有七模块学完再开工）

**触发条件**：按各模块 README 建议顺序学完 tools → rag → memory → service → mcp → guardrails → evals（多 Agent 是单 Agent 的乘法，基础不牢学它容易糊涂）。

**教学主张**：多 Agent = 单 Agent 的乘法，不是玄学——每个"Agent"就是独立 system prompt + 独立职责 + 受控输入输出的 `runToolLoop` 组合。多 Agent 的新问题只有三个：**分工**（谁干什么）、**共享状态**（互相知道什么）、**质量闭环**（谁验收）。

### P1 升格叙事（半小时，零代码）
`service/README.md` 增补一章「你就是多 Agent：Supervisor 模式」——用已有代码教第一个多 Agent 模式：
- supervisor = 路由 Agent（硬规则 + 三分类），workers = 三个专家 Agent（独立 system prompt + 最小权限工具表），HandoffPack = Agent 间上下文交接
- 对照业界：LangGraph 的 supervisor 模式、CrewAI 的 manager+crew——同一思想不同皮肤

### P2 `teams/` 流水线（核心新增，模块八）
```text
packages/engine/src/teams/
├── types.ts       # TaskPlan / PlanStep / TeamResult 契约
├── blackboard.ts  # 共享黑板：任务状态单一事实源（内存版，接口留持久化缝）
├── planner.ts     # 规划 Agent：目标 → 有序步骤 JSON（宽松解析+重试一次，同 supervisor 套路）
├── executor.ts    # 执行 Agent：逐步骤调 runToolLoop（每步一个带工具的单 Agent）
├── critic.ts      # 评审 Agent：验收结果，不达标带反馈打回（重试上限，evals 思想进运行时）
├── pipeline.ts    # 编排：planner → (executor → critic)* 循环，全程 trace（🧩🔧🔍 区分角色）
└── index.ts + README.md（模块八，标准九节体例）
```
- 示例目标：「查订单 A-1024，未发货就建催发工单」——正好逼出规划/执行/验收三分工
- 依赖倒置（planner/critic 可注假件），离线单测全绿
- 入口：`pnpm team "目标"` CLI；真实成本 ≈ 3-8 次 LLM 调用/流水线

### P3 A2A 落地（week19 Day 4 的代码化）
- `GET /.well-known/agent-card.json`：本机 Agent Card（名称/skills/端点）
- `POST /a2a/tasks`：接收外部 Agent 委托 → 路由到对应 worker 或 teams 流水线 → 回传 artifact（契约进 packages/shared）
- 狗粮：起两个 agent-app 实例，A 读 B 的 Agent Card、委托「查订单」、收回结果

### 验收与风险
- P2 验收：typecheck 全绿 + 离线单测 + `pnpm team` 真实跑通（trace 可见三角色）
- 风险：glm-4-flash 计划 JSON 稳定性（宽松解析+重试一次+失败降级单步）；critic 打回死循环（重试上限 2 次，超限带「未完全达成」诚实收尾）

## ② 其他挂账（按 SECURITY.md / README 既有记录）

| 项 | 来源 | 触发条件 |
| --- | --- | --- |
| 在线评估（trace 回流数据集） | evals/README 路线图 | 有真实流量后 |
| MCP 服务器身份 TOFU 指纹 / 检索内容沙箱 | SECURITY.md 结构性档 | 安全篇深入时 |
| 认证 / 多租户 / 限流 | README「后续扩展」 | week20 生产化阶段 |
| evals 注入回归集（红队 E1-E8 载荷入 evals） | SECURITY.md 结构性档 | 学 evals 时顺手做 |
