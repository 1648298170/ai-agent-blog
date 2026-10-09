# 04 · 三层记忆：会话 / 偏好 / 情景

> 一句话：LLM 是无状态的——它以为的"记得上文"，其实是你把历史消息重新塞进了 messages。
> 所谓 Agent 的记忆 = **谁来存历史（存储）+ 每次塞多少进 prompt（预算）**。
> 三层记忆就是三种策略：会话窗口管"刚才说了啥"，偏好表管"这个用户是谁"，情景记忆管"上次类似问题怎么解决的"。

---

## 它解决什么问题

```text
用户（第 2 轮）：那它多久能到？           ← "它"指上一轮的订单 A-1024
用户（第 3 天）：还是上次那个问题          ← "上次"在另一个会话里
用户（第 5 次）：我都来过五次了，怎么还不记得我 prefer 简洁回复？
```

三种"记性"，一种存储解决不了：

| 人类记忆对照 | 接口 | 存什么 | 生命周期 | 解决什么 |
|---|---|---|---|---|
| 工作记忆 | `SessionStore` | 逐字对话窗口 | 本会话内（Redis 版 24h TTL 跨重启） | "你刚才说什么来着？" |
| 长期语义记忆 | `PreferenceStore` | 提炼后的事实（"回复风格→简洁"） | 跨会话、按用户 | "它还不认识我" |
| 情景记忆 | `EpisodicStore` | 历史会话摘要 + 向量 | 跨会话、按相似度召回 | "接着昨天聊" |

每个接口都有**两份实现**（内存版默认 / 真实存储版可切），由环境变量一键切换——
这是本项目"依赖倒置"的实战样板：接口签名一行不改，业务代码零改动。

---

## 核心概念（5 分钟版）

### ① 记忆 = 存储问题 + 预算问题

塞太少：模型失忆，答非所问。塞太多：①贵（按 token 计费）②可能溢出
③"迷失在中间"（重要信息塞在中段反而被忽略）。三层记忆就是三种"存"与"塞"的折中。

### ② 算法与存储正交

压缩算法（40 阈值 / 滚动摘要 / 降级）在 `compression.ts` **唯一一份**，
内存版和 Redis 版都来借——每个文件只回答"数据放哪"这一个问题，改阈值只改一处。
同款模式复制全项目（rag 的 memory/json/pgvector 三实现），学会这一个，六个存储开关全懂。

### ③ env 工厂：一行换实现

| 环境变量 | 可选值 | 默认 |
|---|---|---|
| `SESSION_STORE` | `memory` / `redis` | `memory` |
| `PREFERENCE_STORE` | `memory` / `pg` | `memory` |
| `EPISODIC_STORE` | `memory` / `pgvector` | `memory` |

不配置（或值不认识）一律回内存默认——**离线优先铁律**：没装 Docker 的机器行为与最初版逐字节一致。

---

## 代码走读（`src/memory/`，11 个文件）

### 1. `types.ts`（104 行）—— 契约（宪法，勿改签名）

| 位置 | 内容 | 要点 |
|---|---|---|
| `ChatTurn`（L28） | 一轮对话 | `role`（user/assistant/system）+ `content` 明文 + 可选 `toolName`（标记该轮是"查完工具再回答"） |
| `SessionStore`（L44） | 短期记忆接口 | 五个方法，粒度是 **sessionId** 不是 userId（同一用户三个会话互不串台） |
| `SessionSummary`（L59） | 会话列表一行 | turns（压缩后条数）+ updatedAt（列表按它降序） |
| `PreferenceStore`（L75） | 长期记忆接口 | get / set / all，粒度是 **userId** |
| `EpisodicRecord`（L87） | 情景一条 | summary + embedding（摘要的语义向量）+ createdAt |
| `EpisodicStore`（L101） | 情景记忆接口 | remember（归档）/ recall（向量 top-k，默认 3） |

```ts
export interface SessionStore {
  append(sessionId: string, turn: ChatTurn): Promise<void>;        // 每轮写：问完写 user、答完写 assistant
  getWindow(sessionId: string, limit?: number): Promise<ChatTurn[]>; // ★ 塞进 prompt 的部分（默认 20）
  clear(sessionId: string): Promise<void>;                          // /new 清空
  listSessions(): Promise<SessionSummary[]>;                        // 历史会话列表（按活跃降序）
  getHistory(sessionId: string): Promise<ChatTurn[]>;               // 全量轮次（压缩后含摘要轮）
}
```

### 2. `session.memory.ts`（112 行）+ `compression.ts`（110 行）—— 短期记忆与压缩

内存版就是两个 Map（会话表 + 活跃时间表）。两个值得读的点：

**写入即压缩**（`src/memory/session.memory.ts:77` 的 `doAppend`）：

```ts
private async doAppend(sessionId: string, turn: ChatTurn): Promise<void> {
  const turns = this.sessions.get(sessionId) ?? [];
  turns.push({ ...turn });
  // append 之后紧跟压缩判断；算法在 compression.ts（唯一实现）
  this.sessions.set(sessionId, await compressIfNeeded(sessionId, turns, this.summarize));
  this.updatedAt.set(sessionId, Date.now());
}
```

**每会话一条 Promise 链串行 append**（L50 的 `appendChains`）：这是一个真实生产缺陷的修复——
旧实现"读 Map → await 压缩（LLM 调用，秒级）→ 写回 Map"，同一会话两个并发 append
交错执行，后写者整体覆盖先写者，**消息就丢了**。压缩的秒级调用把竞态从"理论存在"
拉宽成"高并发下必然发生"。修法：把"读-压-写"整体挂到该会话的 Promise 链尾部串行；
跨会话不加全局锁（不放大无关会话的等待）。

压缩算法本体（`src/memory/compression.ts:66`）：

```ts
export async function compressIfNeeded(sessionId, turns, summarize) {
  if (turns.length <= COMPRESS_AFTER) return turns;      // 40 条以内：原样返回同一引用（零开销）

  const older = turns.slice(0, -KEEP_RECENT);            // 溢出的旧消息（压掉）
  const recent = turns.slice(-KEEP_RECENT);              // 最近 20 条原样保留
  // 窗口头若已有 "[会话摘要] " 前缀的 system 轮 → 并进这次一起压（滚动，事实不断档）
  ...
  try {
    summary = (await summarize("把下面的多轮对话压成不超过 150 字的摘要，保留关键事实与偏好…")).trim();
  } catch { summary = null; }                            // 无 key / 网关不通 → 降级

  if (summary === null) {
    trace("🧠", `…摘要不可用，降级为窗口截断（保最近 ${KEEP_RECENT} 条）`);
    return recent;                                       // 降级：纯窗口截断，主对话零感知
  }
  return [{ role: "system", content: SUMMARY_PREFIX + rolling }, ...recent];
}
```

```text
压缩前（43 条）：[u1,a1,…,u21,a21 │ u22,a22,…,u43]
压缩后（21 条）：[sys:"[会话摘要] 用户问了A，偏好B…" │ u24,a24,…,u43]
                    ↑ 摘要轮挂窗口头                    ↑ 最近 20 条原文
```

`Summarizer` 是可注入参数（L38）——selftest 注入假实现，离线覆盖"压缩成功 / 降级"两条路径。

### 3. `session.redis.ts`（341 行）—— 短期记忆·Redis 版

与内存版实现**同一个契约**（types.ts 一行未改），Redis 侧的数据形状：

```text
key    agent:sess:{sessionId}        ← list，每元素一条 ChatTurn 的 JSON（RPUSH 天然有序）
index  agent:sess:index              ← ZSET，score = 最后活跃时间（listSessions 的数据源）
TTL    24 小时，每次 append 都 EXPIRE 续期——「活跃会话永不过期，一天不动自动清场」
```

append 主流程（`src/memory/session.redis.ts:187` 的 `doAppend`，骨架）：

```ts
await redis.rpush(k, JSON.stringify(turn));                   // ① 消息先落袋为安（单命令原子）
await redis.zadd(SESSION_INDEX_KEY, Date.now(), sessionId);   // ② 活跃记账
const length = await redis.llen(k);                           // ③ 先看长度（O(1)），别每次拉全量
if (length > COMPRESS_AFTER) {
  // ④ 压缩重写是「读-改-写」，跨进程要互斥：SET NX PX 拿锁（拿不到就本轮跳过压缩，
  //    消息已落盘不丢，压缩顺延）→ LRANGE 全量 → compressIfNeeded → MULTI 原子重写
}
await redis.expire(k, SESSION_TTL_SECONDS);                   // ⑤ TTL 续期（未压缩路径）
```

并发安全两层防线：进程内每会话 Promise 链（同内存版）+ 跨进程 best-effort 分布式锁
（`SET NX PX` + Lua"持有人一致才 DEL"释放——防误删他人的锁）。

### 4. `preference.memory.ts`（49 行）/ `preference.pg.ts`（124 行）—— 长期记忆

最简单的一层：`(userId, key) → value` 长表，"用户改口" = 同 key 覆盖（PG 版就是
`INSERT ... ON CONFLICT DO UPDATE` 行级 upsert，主键 `(user_id, key)`）。
内存版的写入护栏（`src/memory/preference.memory.ts:31`）：

```ts
async set(userId: string, key: string, value: string): Promise<void> {
  const safeKey = key.trim().slice(0, MAX_KEY_LEN);       // key ≤ 50 字符
  const safeValue = value.trim().slice(0, MAX_VALUE_LEN); // value ≤ 500 字符
  if (!safeKey || !safeValue) return;                     // 空 key / 空白值直接丢弃
  ...
}
```

护栏与 PG 版逐条对齐（换存储不换业务规则）——防脏数据把注入 system prompt 的偏好区撑爆。
会话开始时 `all()` 读出全部偏好注入 system prompt，模型立刻"认识"老用户。

### 5. `episodic.memory.ts`（54 行）/ `episodic.pgvector.ts`（172 行）—— 情景记忆

复用 rag 的整套数学，只是检索对象从"文档切块"换成"历史会话摘要"
（`cosineSimilarity` 直接 import 自 `rag/store.memory.js`）：

```ts
async recall(embedding: number[], k = 3) {
  const scored = this.records.map((record, order) => ({
    sessionId: record.sessionId, summary: record.summary,
    score: cosineSimilarity(embedding, record.embedding),   // 与 rag/ 共用的余弦
    order,
  }));
  scored.sort((a, b) => b.score - a.score || a.order - b.order);  // 同分按入库先后（稳定可复现）
  return scored.slice(0, k);
}
```

pgvector 版换引擎不换数学：`ORDER BY embedding <=> $1`（余弦距离）取 top-k，
score = 1 - distance，外层再按 seq 稳定排序；HNSW 索引仅 ≤2000 维（与 rag 同一限制）。
为什么存摘要不存逐字：摘要短（向量便宜）、天然降噪，"上次大概聊了什么"就够唤醒上下文。

### 6. `factory.ts`（70 行）—— env 工厂总开关

```ts
export function createSessionStoreFromEnv(env: Record<string, string> = loadEnv()): SessionStore {
  const value = (env.SESSION_STORE ?? DEFAULT_SESSION_STORE).trim().toLowerCase();
  if (value === "redis") return createRedisSessionStore();
  if (value !== DEFAULT_SESSION_STORE) {
    console.warn(`[memory] 未认识的 SESSION_STORE=「${env.SESSION_STORE}」，按默认 memory 处理`);
  }
  return new InMemorySessionStore();     // 铁律：不配置（或不认识）一律内存默认
}
```

`createPreferenceStoreFromEnv`（L49）/ `createEpisodicStoreFromEnv`（L61）同款。
消费方（cli 各 REPL 启动、api 的服务层）只调工厂，**永远不知道背后是哪个实现**。

---

## 跑起来验证（先跑再读，体感翻倍）

```powershell
cd agent-app
pnpm chat
```

在 REPL 里连聊几句（`/new` 开新会话，`/exit` 退出）：

```text
你：订单 A-1024 到哪了？      ← 助手回答已发货
你：那它多久能到？            ← "它"接得住 = 会话窗口在干活（getWindow 的最近 20 轮）
/new                          ← "已开启新会话（旧会话历史不再带入）"：窗口清空
那它多久能到？                ← 模型失忆（不知道"它"是谁）——这就是"逐字窗口困在本会话内"
/exit 后重新 pnpm chat         ← 同样失忆：内存版随进程消亡 + 新 sessionId
```

离线全测（零网络：三层存储 + 压缩成功/降级两条路径，注入假 Summarizer）：

```powershell
pnpm selftest
```

想看**真实持久化**（跨进程、跨重启）？起 Docker 基座后切 Redis：

```powershell
pnpm infra:up                                   # pgvector(pg16) + redis(7)，等 healthy
$env:SESSION_STORE = "redis"; pnpm chat         # 聊几句后 /exit
docker compose exec redis redis-cli --scan --pattern "agent:sess:*"    # 会话 key 在
docker compose exec redis redis-cli ttl "agent:sess:<你的sessionId>"   # TTL > 0（24h 且每次写入续期）
Remove-Item Env:SESSION_STORE                   # 清掉开关，立刻回到默认离线行为
pnpm test:infra                                 # 基础设施集成测试（RUN_INFRA_TESTS=1）
```

> 内存 Map / Redis / pgvector 三份实现的行为一致性由 `pnpm test:engine` +
> `pnpm test:infra` 双层看护（`test/memory-factory.spec.ts` 验证工厂装配）。

---

## 设计取舍（面试级追问）

| 追问 | 回答 |
|---|---|
| 窗口为什么默认 20 轮？ | 覆盖绝大多数指代消解的跨度，又不至于让每轮 prompt 成本失控；`getWindow(sessionId, limit)` 是调用方可调的参数，不是写死的真理 |
| 压缩阈值为什么固定 40 条，不按 token 水位线动态触发？ | 简单、可预测、可测试（selftest 能逐字断言行为）。token 水位线更精细但要处理"单条消息超预算"等边角；固定条数是教学优先的取舍，水位线是自然的演进方向 |
| 为什么压缩算法单独抽成 compression.ts？ | 内存版和 Redis 版要用**同一套**阈值/滚动/降级——算法一份、适配器两份；否则改个阈值要改两处，两版行为漂移 |
| Redis TTL 为什么每次 append 续期？ | 会话的生命周期是"活跃"而非"创建后 24h"。续期 = 活跃会话永不过期、闲置一天自动清场——比定时扫描清理便宜且精准 |
| 情景记忆为什么存摘要不存逐字？ | 摘要短（embedding 便宜）、天然降噪；检索目标是"唤醒上次聊了什么"，不需要逐字复刻 |
| 偏好为什么用 KV 表而不是向量库？ | 确定性知识用确定性结构：`all()` 一把读出全量注入 prompt，不需要"相似度检索"这种概率语义——向量是给"模糊召回"用的 |
| env 工厂的值写错了会怎样？ | console.warn 提示 + 回退内存默认（`src/memory/factory.ts:42`），绝不启动崩溃——离线优先铁律的最后一道防线 |

---

## 自测题（先凭记忆答，再看文末答案）

1. 三层记忆各自解决什么问题？用户说"接着昨天聊"，靠哪一层？它和前两层的本质区别是什么？
2. 会话压缩的"滚动"是什么意思？如果压缩时没配 API key，会发生什么？
3. 内存版和 Redis 版实现了同一个接口，为什么说"types.ts 一行未改"是本目录最重要的设计？换实现时业务代码要动几行？

<details><summary>答案</summary>

1. 会话窗口管本会话逐字上下文；偏好管跨会话的用户事实（KV 注入）；
   "接着昨天聊"靠**情景记忆**：当前问题向量化 → recall() 在历史会话摘要里做余弦 top-k →
   命中的摘要注入 prompt。与前两层的本质区别：它是**跨会话、按相似度模糊召回**的
   （前两层一个困在本 sessionId、一个只做确定性全量注入）。
2. 滚动 = 窗口头已有"[会话摘要] "前缀的旧摘要时，下次压缩把它与新溢出消息**并在一起重压**，
   事实不因多轮压缩断档。没配 key → defaultSummarizer 抛错 → compressIfNeeded 捕获后
   降级为纯窗口截断（只保最近 20 条，不出摘要轮），主对话零感知（`src/memory/compression.ts:96`）。
3. 接口先行 = 依赖倒置：业务代码只依赖 `SessionStore` / `PreferenceStore` / `EpisodicStore`
   抽象，六个实现（memory/redis、memory/pg、memory/pgvector）都是可替换零件。
   换实现 = 改一个环境变量（`SESSION_STORE=redis`），工厂函数自动装配，业务代码**零行改动**。

</details>

---

## 延伸阅读

- [02-llm-config-trace.md](./02-llm-config-trace.md) —— `*_STORE` 开关为什么进得了配置（ENV_KEYS 白名单）
- [05-rag.md](./05-rag.md) —— 情景记忆借走的那套余弦检索的完整版（规划中）
- [../src/memory/README.md](../src/memory/README.md) —— 本目录自带深度导读（含压缩竞态修复的完整时间线）
- [ARCHITECTURE.md](../../../ARCHITECTURE.md) —— 三层记忆在整体架构中的位置
- `docs/week11/memory-ts.md` —— 教程《记忆 TS 版》（`npm run docs:dev` 起博客看）
- `docs/week17/index.md` —— 记忆架构 + 上下文工程周（Redis TTL 续期的出处）
- `docs/week14/index.md` —— pgvector 周（`<=>` 余弦检索与 HNSW 维度限制）
