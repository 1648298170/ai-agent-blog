# 05 · RAG：让 Agent 查你自己的文档

> 一句话：LLM 的知识有截止日期、没读过你的私有文档、不知道时还会编。RAG（Retrieval-Augmented Generation）把「闭卷考试」变成「开卷考试」——**不是把知识塞进模型，而是给它一个可检索的书架**：回答前先查库，把命中的原文塞进 prompt，要求「只依据资料回答」。
> 本目录 `src/rag/`（11 个文件）就是这条链路的完整零件箱。

---

## 它解决什么问题

裸的 LLM 三个先天缺陷：训练数据有截止日期、不知道你公司的制度文档、不知道时一本正经地瞎说（幻觉）。

微调（fine-tune）能教风格、教领域话术，但改知识要重训——太贵太慢。RAG 的思路更便宜：

```text
用户问：「出差住宿标准是多少？」
模型心里：训练数据里没有你们公司的报销制度
        ↑ 但知识库里有 company-faq.md，检索出来喂给它就行
```

**解法**：入库时把文档切块、向量化、存起来；问答时把问题也向量化，按相似度找出最像的几块原文，拼进 prompt。模型的**生成能力**（组织语言）负责说话，**记忆**交给外挂检索系统（可更新、可溯源）——各干各的强项。

---

## 核心概念（5 分钟版）

### 五步链路（整个 rag/ 目录就是这五步）

```text
入库方向（pnpm kb:ingest）：
  读文件 → ①切块(chunker) → ②向量化(embedder) → ③入库(store) → 快照落盘(persistence)

问答方向（pnpm kb）：
  问题 → ②向量化(同一个模型!) → ④检索(retrieve, 余弦相似度 topK) → ⑤带引用回答
```

### 五个必懂的概念

**① 切块（chunk）**：检索的最小单位不是文档，是块。整篇文档压成一个向量只会得到「四不像」——一篇讲 5 个主题的文档，查询任何主题都不像。切块后每块只讲一个主题，每块一个向量才能命中。

**② overlap（重叠）**：切块按长度切，语义不看长度——一句话可能正好被拦腰切断。重叠让这句话在相邻两块里各出现一次，无论用户从哪个角度问，至少有一块「读得懂这句话」。默认每块上限 500 字、相邻块重叠 80 字（约 15%）。

**③ embedding（向量化）**：把文本压成 2048 维浮点向量（GLM `embedding-3`），意思越近的文本住得越近。**铁律：查询与入库必须用同一个模型**——不同模型是不同的坐标空间，跨空间比距离毫无意义（这就是换 embedding 模型必须全库重嵌的原因）。

**④ 余弦相似度**：只比向量方向、不比模长。`1` 同一件事，`0.8+` 基本同主题，`0` 无关。一段 500 字详述和一句 20 字问答只要主题相同，方向就该接近。

**⑤ 引用编号后端分配**：答案里的 `[1][2]` 编号由后端（`formatCitations`）分配，模型只负责标号——来源标题在模型手里是可以被编造的素材，在检索结果里才是事实。

---

## 代码走读（`src/rag/`，11 个文件）

| 文件 | 职责 | 要点 |
|---|---|---|
| `types.ts` | 契约（宪法） | `Chunk`（id/docId/title/text/index/embedding）+ `RagStore` 六方法 = 知识库的一生：upsert / deleteDoc / listDocs / readDoc / search / count |
| `chunker.ts` | ① 切块 | 递归三级瀑布：段落 → 句子 → 硬切，纯函数 |
| `embedder.ts` | ② 向量化 | 批量 32 条/批 + 中文配置错误礼仪 |
| `store.memory.ts` | ③ 存储·内存版 | Map + 余弦相似度（NaN 安全），自检与离线场景 |
| `store.pgvector.ts` | ③ 存储·PG 版 | pgvector + `<=>` 余弦距离，HNSW 索引仅 dim ≤ 2000 |
| `store.factory.ts` | ③ 换库总开关 | `RAG_STORE=memory\|json\|pgvector`，默认 json |
| `persistence.ts` | ③ JSON 快照 | 装饰器：内存库检索 + `.data/kb-store.json` 落盘 |
| `retrieve.ts` | ④ 检索总装 | `searchKnowledge` + `formatCitations` + `setRagStore` 接缝 |
| `ingest.ts` | 入库核心 | CLI 与 HTTP API 共用：抽文本 → 切块 → 向量化 → upsert |
| `index.ts` | 桶导出 | `@agent-app/engine/rag` 子路径的公共面 |
| `README.md` | 原理篇 | 数学地图 + 推荐学习顺序（先读它再读代码） |

### 切块的三级瀑布（`chunker.ts` L58-L109，简化到脉络）

```ts
// chunker.ts L121 —— 入口：一篇纯文本 → 块数组（纯函数，不碰网络不碰存储）
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxLen = Math.max(1, options.maxLen ?? 500);   // 默认每块上限 500 字
  const overlap = Math.min(options.overlap ?? 80, maxLen - 1); // 重叠 80 字（~15%）
  const chunks: string[] = [];
  for (const para of splitParagraphs(text)) {          // 第一层：空行分段
    if (para.length <= maxLen) chunks.push(para);      // 短段落整段成块
    else chunks.push(...splitLongParagraph(para, maxLen, overlap)); // 超长段下钻
  }
  return chunks;
}

// chunker.ts L58 —— 第三层兜底：滑动窗口硬切，步长 = maxLen - overlap
function hardCut(sentence: string, maxLen: number, overlap: number): string[] {
  const step = maxLen - overlap;
  const pieces: string[] = [];
  for (let start = 0; start < sentence.length; start += step) {
    pieces.push(sentence.slice(start, start + maxLen)); // 相邻窗口天然共享 overlap
    if (start + maxLen >= sentence.length) break;
  }
  return pieces;
}
```

中间层 `splitLongParagraph`（L85）：句子往缓冲区攒，攒满 500 字出块；出块时把上一块尾巴（overlap 字）接到下一块开头。**太大 vs 太小的取舍**：块太大则一块混多主题，向量四不像；太小则上下文断裂，拼进 prompt 的资料读不懂。

### 批量向量化（`embedder.ts` L35-L62，骨架）

```ts
const BATCH_SIZE = 32; // L10：一次几十条是正确姿势，一条一个请求是几百次 HTTP 往返

export async function embed(texts: string[]): Promise<number[][]> {
  if (!getConfig().apiKey) throw configError("向量化失败：未配置 API Key（OPENAI_API_KEY 为空）");
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const { embeddings } = await embedMany({ model: getEmbeddingModel(), values: batch });
    if (embeddings.length !== batch.length) {          // 防御：多退少补 = 全库语义错乱
      throw new Error(`返回 ${embeddings.length} 条向量，与输入的 ${batch.length} 条不对齐`);
    }
    vectors.push(...embeddings); // 跨批按顺序拼接，保住「下标即对应」契约
  }
  return vectors;
}
```

隐形契约：**texts[i] 的向量就是返回值第 i 项**。入库方（`ingest.ts` L99-106）就是拿同一个下标把 `chunk.text` 和 `vectors[i]` 配对写进 `Chunk.embedding` 的——任何乱序都会让「块 A 配上块 B 的语义」，检索结果全错。

### 余弦检索（`store.memory.ts` L18 + L87）

```ts
// L18 —— 只看方向不看模长；脏数据（NaN/零向量/维度不符）一律返回 0，检索不被单条脏数据炸掉
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0; // NaN 坐标当场出局
    dot += a[i] * b[i]; normA += a[i] * a[i]; normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0; // 零向量：没有方向可言
  return Number.isFinite(dot / denom) ? dot / denom : 0;
}

// L87 search 三步：①圈候选（跳过未向量化的块 + docId 硬过滤）②逐块打分 ③降序取前 k
```

### 存储三件套与换库接缝

- **`persistence.ts`（默认）**：JSON 快照装饰器。入库 CLI 与问答 CLI 是**两个进程**，快照落在 `.data/kb-store.json`（L12）让知识库跨进程存活。检索全权委托内存库（毫秒级零开销），只在 upsert/deleteDoc 后同步写盘；`ready ??= load()`（L61）保证并发下快照只读一次。
- **`store.pgvector.ts`（真实持久化）**：`RAG_STORE=pgvector` 时启用（pg16 + `<=>` 余弦距离 + HNSW 索引）。注意 L129 的硬限制：**ANN 索引（HNSW/IVFFlat）只支持 ≤2000 维**，而 GLM embedding-3 默认 2048 维——超限时跳过 ANN 索引，检索自动走精确顺序扫描（`ORDER BY embedding <=> $1` 语法不变，几百~几千块毫秒级）。
- **`store.factory.ts` L36**：`createRagStoreFromEnv()` 一行换库，不认识的环境变量回默认 json——**离线优先**：没装 Docker 的机器行为与改造前逐字节一致。

### 检索出口与入库编排（`retrieve.ts` L52 + `ingest.ts` L53）

```ts
// retrieve.ts L52 —— 检索出口：查询向量化 → store.search → 🔎 轨迹
export async function searchKnowledge(query: string, k = 5, filter?: RagFilter) {
  const cappedK = Math.min(k, MAX_RETRIEVAL_K); // L83：k 再大也最多 50 块（红队加固，防整库拼进上下文）
  const [queryEmbedding] = await embed([query]); // 查询也要过同一个 embedding 模型！
  const hits = await store.search(queryEmbedding, cappedK, filter);
  trace("🔎", `检索 → 「${query}」命中 ${hits.length} 块，top1：《${hits[0].title}》相似度 ${hits[0].score.toFixed(3)}`);
  return hits;
}
```

`ingest.ts` 的入库主干（L61-L107）：`docId = 文件名 + 内容哈希前 8 位`（同内容重投命中同 id，upsert 覆盖不翻倍）→ `chunkText` 切块 → 每块过注入扫描（L75-89，命中即**整篇拒收**——红队加固，防知识库投毒）→ `embed` 向量化 → `store.upsert`。

---

## 跑起来验证（先跑再读，体感翻倍）

```powershell
cd agent-app
# 前置：.env 已按 .env.example 配好智谱 API Key

pnpm kb:ingest .\samples\company-faq.md   # 入库：切块 → 向量化 → 快照落盘，看「切块 N 块」输出
pnpm kb --trace                           # 问答 REPL，看 🔎 检索轨迹
```

进 REPL 后问「出差住宿标准是多少？」，观察：

```text
🔎 检索 → 「出差住宿标准是多少」命中 5 块，top1：《company-faq》相似度 0.83
答> 一线城市每晚不超过 600 元……[1]
引用来源：
[1] company-faq
```

三个值得试的边界：

1. **问库里没有的**（「明天天气如何？」）→ 老实说「知识库里没有找到相关内容」，不硬编——边界探测类问题的信任分水岭
2. **把 .env 里的 key 改错再问** → 打印中文配置提示（`embedder.ts` 的错误礼仪），REPL 不崩；LLM 挂了则走降级：返回检索原文 + 出处
3. **无网络自检**：`pnpm selftest` 离线穷举切块器与余弦检索的边界情况（用假向量，不调任何模型）

想摸真实持久化：`pnpm infra:up` 起 pgvector 后 `$env:RAG_STORE = "pgvector"` 再走同样两条命令——检索代码一行不改。

---

## 设计取舍（面试级追问）

| 追问 | 回答 |
|---|---|
| 为什么块大小 500 字 / 重叠 80 字？ | 太大则一块混多主题，向量四不像；太小则上下文断裂。300~500 字 + 10%~20% 重叠是教程实证的起点值，不是定理——该由评估集说话 |
| 为什么查询和入库必须同一个 embedding 模型？ | 不同模型是不同坐标空间：库里的向量和查询向量不在同一空间，夹角毫无意义。同理换维度模型必须 `DROP TABLE kb_chunks` 全库重嵌 |
| 暴力扫 O(n·d) 什么时候不够用？ | 几百块 × 微秒级 = 毫秒级，教学规模完全够。十万块以上才需要 ANN 索引（pgvector HNSW，O(log n) 近似）；但 ANN 只支持 ≤2000 维，2048 维默认走精确扫描 |
| 引用编号为什么由后端分配？ | 来源标题在模型手里是可以编造的素材，在检索结果里才是事实。编号与命中顺序严格对号，模型编不了出处 |
| 空结果为什么直说不知道，不硬答？ | 敢说不知道才敢信它说的知道。知识库没有的内容硬编，用户第一次发现就再也不信了 |
| LLM 挂了怎么办？ | 降级预案：检索链路还活着就交「原文 + 出处」，不给报错页——链路上哪段活着就交哪段的产出 |
| 内存库 + JSON 快照 vs 直接上 pgvector？ | 同一套 `RagStore` 接口三份实现，env 一键切换。默认 json = 零依赖（离线优先），教学和没装 Docker 的机器照常跑 |

---

## 自测题（先凭记忆答，再看文末答案）

1. 为什么不把整篇文档压成一个向量入库？切块的 overlap 又是防什么？
2. 检索时为什么**用户的问题**也要过一遍 embedding？换 embedding 模型后老数据为什么必须重嵌？
3. 答案末尾的 `[1][2]` 引用编号是谁分配的？为什么这样设计？

<details><summary>答案</summary>

1. 一篇讲 5 个主题的文档只会得到一个「四不像」向量，查询任何主题都不像；切块后每块一个主题、一个向量才能命中。overlap（重叠 80 字）防的是「一句话被拦腰切断」——按长度切不看语义，重叠让切口处的句子在相邻两块各出现一次，至少有一块保有完整上下文。
2. 检索的本质是「向量 vs 向量」比夹角：库里存的是块文本的向量，问题是新文本，必须用**同一个** embedding 模型把它映射到同一个坐标空间才有相似度可言。不同模型是不同坐标空间，跨空间比距离毫无意义——所以换模型必须全库重嵌。
3. 后端分配（`retrieve.ts` 的 `formatCitations`，编号与命中顺序严格对号），模型只负责在句末标号。来源标题在模型手里是可以被编造的素材，在检索结果里才是事实——模型编不了出处。

</details>

---

## 延伸阅读

- [../../packages/engine/src/rag/README.md](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/packages/engine/src/rag/README.md) —— 本模块原理篇：数学地图（embedding / 余弦 / Top-K）+ 八步学习顺序
- [ARCHITECTURE.md](https://github.com/1648298170/ai-agent-blog/blob/main/agent-app/ARCHITECTURE.md) ——「4.2 RAG 四件套」与踩坑实录
- [01-agent-loop.md](./01-agent-loop.md) —— 检索结果如何作为工具结果回灌循环（Agentic RAG 的基础）
- [../archive/weeks/week11/rag-ts.md](../archive/weeks/week11/rag-ts.md) —— 教程主线的 RAG TS 全链路篇（`npm run docs:dev` 起博客看）
- [../archive/weeks/week14/index.md](../archive/weeks/week14/index.md) —— RAG Pipeline 入门周（pgvector / HNSW 主线）
