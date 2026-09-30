# 读代码前先读这篇：Agent 为什么需要记忆，三层记忆怎么工作

> 本目录解决 Agent 的"记性"问题。与隔壁 `rag/` 同构：`types.ts` 是宪法，
> 每层都有"内存版（默认）+ 真实存储版（Redis/PG）"两套实现，由
> `SESSION_STORE` / `PREFERENCE_STORE` / `EPISODIC_STORE` 环境变量经 `factory.ts` 一行切换。
> 配合教程 [week17 · 记忆架构 + 上下文工程](../../../../../docs/week17/index.md) 与 week11 补篇 [记忆 TS 版](../../../../../docs/week11/memory-ts.md)。

---

## 一、第一性原理：LLM 本身没有任何记忆

每次 `generateText` 调用都是**无状态**的——模型以为的"记得上文"，其实是你把历史消息重新塞进了 `messages` 数组。所以 Agent 的"记忆"问题本质是两个工程问题：

1. **谁来存历史？**（存储）
2. **每次塞多少进 prompt？**（预算——上下文窗口有限且按 token 计费）

塞太少：模型失忆，答非所问。塞太多：①贵 ②可能溢出 ③"迷失在中间"（重要信息在中段反而被忽略）。**三层记忆就是三种"存"与"塞"的策略**。

## 二、三层记忆模型（对照人类记忆）

| 人类记忆 | 本目录 | 存什么 | 生命周期 | 解决什么问题 |
| --- | --- | --- | --- | --- |
| 工作记忆 | `SessionStore`（session.**memory**.ts 默认 / session.**redis**.ts 可切） | 逐字对话窗口 | 本会话内（Redis 版 24h TTL 跨重启） | "你刚才说什么来着？" |
| 长期语义记忆 | `PreferenceStore`（preference.**memory**.ts 默认 / preference.**pg**.ts 可切） | 提炼后的事实（"用户喜欢简洁回复"） | 跨会话、按用户 | "我都来过三次了它还不认识我" |
| 情景记忆 | `EpisodicStore`（episodic.**memory**.ts 默认 / episodic.**pgvector**.ts 可切） | 历史会话的摘要+向量 | 跨会话、按相似度召回（pgvector 版跨重启） | "还是上次那个问题" |

关键区别一句话：

- **短期 vs 情景**：短期是"逐字"且**困在本 sessionId 里**；情景是"摘要"且**跨会话检索**——用户说"接着昨天聊"，只有情景记忆能救
- **长期 vs 情景**：长期是"提炼后的结论"（KV 结构，确定性注入）；情景是"当时的经过"（向量检索，按相关性召回）

### 本目录文件地图（11 个文件）

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 契约：三接口 + `ChatTurn` + `SessionSummary`（含 listSessions/getHistory，勿改签名） |
| `session.memory.ts` | 短期记忆·内存版：窗口截断 + 超限滚动压缩 |
| `session.redis.ts` | 短期记忆·Redis 版：`agent:sess:{id}` list + 24h TTL 续期 + ZSET 会话索引（多实例共享） |
| `preference.memory.ts` | 长期记忆·内存版：两层 Map + 限长护栏 |
| `preference.pg.ts` | 长期记忆·PG 版：`user_preferences` 行级 upsert |
| `episodic.memory.ts` | 情景记忆·内存版：摘要向量 + 余弦 top-3 召回 |
| `episodic.pgvector.ts` | 情景记忆·pgvector 版：`episodic_memories` 表 + `<=>` 余弦 top-k（同分按入库顺序稳定；HNSW 索引仅 ≤2000 维） |
| `compression.ts` | **压缩算法唯一实现**（40 阈值/20 保留/滚动摘要/离线降级），内存版与 Redis 版共用 |
| `factory.ts` | **env 工厂总开关**：`SESSION_STORE=memory\|redis`、`PREFERENCE_STORE=memory\|pg`、`EPISODIC_STORE=memory\|pgvector`，默认内存 |
| `index.ts` | 桶导出（`@agent-app/engine/memory` 子路径的公共面） |
| `README.md` | 本文 |

典型组合：不设环境变量 = 全内存（离线优先，行为与最初版一致）；`SESSION_STORE=redis` + `PREFERENCE_STORE=pg`（`pnpm infra:up` 起库后切换）= 跨重启、跨进程的真实持久化；`EPISODIC_STORE=pgvector` 一并切上则情景记忆也跨重启（与偏好共用同一个 PG 实例，`EMBEDDING_DIM` 口径也同 `rag/`）。

### 为什么要两个版本？——"算法"和"存哪"是正交的两件事

内存版与 Redis 版实现**同一个 `SessionStore` 契约**（`types.ts` 一行未改），区别只在三件事：**数据放哪、活多久、谁能看见**：

| 维度 | 内存版（默认） | Redis 版 |
| --- | --- | --- |
| 数据形状 | 两个 Map（会话表 + 活跃时间表） | list `agent:sess:{id}` + ZSET `agent:sess:index` |
| 生命周期 | 跟进程共存亡，重启全没 | 24h TTL + 每轮续期：活跃不过期，闲置自动清场 |
| 可见范围 | 单进程私有（CLI 看不见 API 的会话） | 多进程共享同一份（`SESSION_STORE=redis` 的核心收益） |
| 依赖/失败 | 零依赖，基本不会失败 | 需 Redis 服务；连接失败给中文修复指引而非英文堆栈 |

保留两个版本（而不是只留 Redis 版）的三个理由：

1. **离线优先（本项目铁律）**：内存版零依赖——没 Docker、没网、CI 流水线里，`pnpm selftest` 照样全绿（压缩成功/降级两条路径都能注入假 summarizer 离线验证）。学习与自测不该被基础设施绑架
2. **两种场景真实存在**：本地学习/自测用内存版（快、零运维）；跨重启、跨进程（web API 看到 CLI 的会话）、自动过期才需要 Redis。付运维成本前先问自己需不需要
3. **接口留缝的活教材**：Redis 版落地时 `types.ts` 一行没改——"先定契约，实现可替换"的实证

**这不是重复代码**：压缩算法（40 阈值/滚动摘要/降级）在 `compression.ts` 唯一一份，两版只是同一算法的两个适配器——每个文件只回答"数据放哪"这一个问题，改阈值只改一处，两版同时生效。同款模式复制全项目：`RagStore`（memory/json/pgvector）、`PreferenceStore`（memory/pg），学会这一个，六个存储开关全懂。

## 三、各层的原理与算法

### 3.1 短期记忆：截断 + 滚动摘要压缩（session.memory.ts）

窗口不能无限堆（贵/溢出/迷失在中间），也不能直接砍（第 3 轮说过的偏好第 30 轮还要用）。策略：**超过 40 条就把最老的溢出部分让 LLM 压成 ≤150 字摘要**，以合成 `system` 轮挂在窗口头，最近 20 条原文保留。

```
压缩前（43 条）：[u1,a1,…,u21,a21 │ u22,a22,…,u43]
压缩后（21 条）：[sys:"[会话摘要] 用户问了A，偏好B…" │ u24,a24,…,u43]
                    ↑ 摘要轮挂窗口头                    ↑ 最近 20 条原文
```

两个精妙处：

- **滚动**：下次再超 40，旧摘要并入新摘要一起压——事实不因多轮压缩断档
- **降级**：压缩本身要调 LLM。没配 key / 网关不通 → 退回纯窗口截断，主对话零感知（离线优先原则）

没有复杂数学，核心是**信息压缩的取舍**：事实保留、token 归零。

### 3.2 长期记忆：KV 表 + upsert（preference.memory.ts)

最简单的一层，几乎没有算法：`(userId, key) → value` 长表，"用户改口" = 同 key 覆盖。唯一值得注意的是**护栏**：偏好是提炼后的短事实，key/value 超长即脏数据，截断/丢弃防止注入 system prompt 的偏好区被撑爆。

它体现的原则：**确定性知识用确定性结构存**——不需要向量、不需要 LLM 检索，`all()` 一把读出注入 prompt 即可。

### 3.3 情景记忆：摘要向量化 + 余弦 top-k（episodic.memory.ts)

复用 `rag/` 的整套数学：每段会话结束 → LLM 压摘要 → 摘要过 embedding 模型 → 归档；新会话拿当前问题向量 `recall()` → 余弦 top-3 → 注入 prompt。

与 RAG 唯一的区别是**检索对象**：rag 搜"文档切块"，这里搜"历史会话摘要"。`cosineSimilarity` 直接 import 自 `rag/store.memory.ts`——一份实现两处受益。为什么存摘要不存逐字：摘要短（向量便宜）、天然降噪，且"上次大概聊了什么"就够唤醒上下文了。

### 3.4 会话记录：listSessions / getHistory（跨层能力，2026-09 新增）

`SessionStore` 在三方法之外新增两个只读成员（接口增量，三实现都已落地）：

- `listSessions()`：所有会话的摘要列表（sessionId / 条数 / 最后活跃时间），按活跃降序
  - Redis 版用 ZSET `agent:sess:index`（score = 最后活跃 epoch）+ 死成员自动清账（key 过期即从索引摘除）
  - 内存版用平行 Map 记录活跃时间
- `getHistory(sessionId)`：全量轮次（压缩后如实包含摘要轮；LRANGE / Map 拷贝）

**消费方**（都在 engine 之外，本目录只管存取）：

- `GET /api/chat/sessions` 与 `GET /api/chat/sessions/:id`（chat 会话，`s_` 前缀）
- `GET /api/service/sessions` 与 `GET /api/service/sessions/:id`（客服会话，`cs_` 前缀）
- web 端：chat 页**刷新自动恢复历史**、「🕘 历史会话」面板列出并切换会话；service 页同款恢复

**会话隔离**：chat 与 service 共用同一个存储（键空间共享），靠 sessionId 前缀区分——隔离过滤在 API 层做（`s_` / `cs_` startsWith），存储层不做假设。

## 四、原理 → 代码对照表（学习自测清单）

| 你应该能回答 | 对应实现 |
| --- | --- |
| LLM 明明"能记住上文"，为什么说它没记忆？ | `types.ts` 头注释：无状态，"记得"= 你重新塞了 messages |
| 三层各自解决什么问题？一句话区分？ | 本文第二节表格 |
| 对话太长为什么不直接砍旧消息？ | `session.memory.ts` 头注释：丢事实 vs 贵/溢出的折中 |
| "[会话摘要] "前缀是干嘛的？ | `session.memory.ts` `SUMMARY_PREFIX`：识别合成轮，滚动压缩时并入 prompt |
| 用户改口了怎么办？ | `preference.memory.ts`：同 (userId,key) 覆盖 = upsert |
| "接着上次聊"靠哪层实现？ | `episodic.memory.ts` `recall()`：跨会话向量检索摘要 |
| 情景记忆和 RAG 的关系？ | 同一套余弦 top-k，检索对象从"文档块"换成"会话摘要" |
| chat 和 service 的历史会话会互相串吗？ | API 层按 sessionId 前缀过滤（`s_` / `cs_`），存储层不做假设 |
| Redis 版会话为什么不会无限堆积？ | 24h TTL + 每轮续期：活跃会话永不过期，一天不活跃自动清场 |
| 为什么要内存 + Redis 两个版本？ | 本文二节末：算法与存储正交——离线默认/场景分界/契约先行，算法只有 `compression.ts` 一份 |

全答上来再读实现；答不上回到对应章节。

## 五、推荐学习顺序（总计约 2 小时）

```text
原理 → 契约 → 最简单的一层 → 向量的一层 → 最复杂的一层 → 实战
```

| 步骤 | 文件 | 学什么 | 通关标准 | 时间 |
| --- | --- | --- | --- | --- |
| **0** | 本文 | 三层模型 + 各层原理 | 能回答第四节 7 问 | 20min |
| **1** | `types.ts` | 三个接口的读写时机与粒度（sessionId vs userId） | 能画出三层对照表 | 10min |
| **2** | `preference.memory.ts` | 最简单的一层：两层 Map + 护栏 | 能说出"改口即覆盖"和限长护栏的目的 | 15min |
| **3** | `episodic.memory.ts` | 向量召回层：remember/recall 与 RAG 的同构 | 能说出它和 `rag/store.memory.ts` 的异同 | 20min |
| **4** | `session.memory.ts` | 最复杂的一层：截断阀门 + 滚动压缩 + 离线降级 | 能画出"压缩前后窗口长什么样"（本文 3.1 图） | 40min |
| **5** | ✋ 动手验证 | 离线全测 | `pnpm selftest` 全绿（含压缩成功/降级两条路径） | 10min |
| **6** | 🔭 观察实战 | 在客服对话里制造 40+ 轮，开 trace 看 🧠 压缩事件 | `pnpm service --trace` 里亲眼见到"压缩 N 条为滚动摘要" | 20min |

选读（真实持久化已落地，按需）：

| 文件 | 学什么 |
| --- | --- |
| `compression.ts` | 压缩算法的唯一实现——为什么抽出来共享（Redis 版要用同一套） |
| `session.redis.ts` | Redis list + TTL 续期 + ZSET 会话索引 + 死成员清账 |
| `preference.pg.ts` | 行级 upsert 的 PG 落地（与内存版护栏逐条对齐） |
| `factory.ts` | env 驱动工厂：一行换实现，默认内存保离线 |

学习心法与 `rag/` 相同：**先最简单的（preference）建立信心，再最有概念的（episodic，借你已懂的 RAG 数学），最后啃最复杂的（session 压缩）**——顺序刻意不按文件名排。

## 六、随时可回的加油站

- **压缩看不懂** → 回 3.1 的前后对比图 + `session.memory.ts` 头注释
- **向量/余弦忘了** → 隔壁 `../rag/README.md` 第三、四节（两个模块共享同一套数学）
- **实现读不懂** → 每个文件头部注释 = 该文件的小地图

## 七、扩展路线（接口已留缝；三项 ✅ 全部落地）

| 现在 | 教程主线 | 状态 |
| --- | --- | --- |
| `SessionStore` 内存版 | **Redis**（`EX` TTL 天然匹配会话生命周期，多实例共享） | ✅ **已实现**：`session.redis.ts`（`agent:sess:{id}` list，TTL 24h 续期，与内存版共用 `compression.ts` 压缩算法；`SESSION_STORE=redis` 切换，默认 memory） |
| `PreferenceStore` 内存版 | **PG 长表**（行级 upsert、永不丢） | ✅ **已实现**：`preference.pg.ts`（`user_preferences` 表，`(user_id, key)` 主键 upsert；`PREFERENCE_STORE=pg` 切换，默认 memory） |
| `EpisodicStore` 内存版 | **pgvector**（万级历史也不怕，ANN 索引） | ✅ **已实现**：`episodic.pgvector.ts`（`episodic_memories` 表，`<=>` 余弦 top-k、同分按入库顺序稳定排序，追加式归档同内存版语义；HNSW 索引仅 ≤2000 维，与 `rag/store.pgvector.ts` 同一限制；`EPISODIC_STORE=pgvector` 切换，默认 memory） |

三个接口都没动过签名——这就是 `types.ts` 存在的意义。真实持久化的启动方式（Docker）与切换开关见根 README「真实持久化（Docker）」一节。
