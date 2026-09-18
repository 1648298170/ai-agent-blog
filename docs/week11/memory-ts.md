# 主线补篇 · 记忆 TS 版：让 TS Agent 记住用户

> 主线补篇，补的是[学习指南](/guide/)里给 TS 主线许下的「记忆 TS 版」。本篇只解决一个问题：三层记忆的概念与架构图你在[第 17 周 Day 1](/week17/day1) 画过了，Python + LangGraph 的实现也看过，但 TS 主线沿着 Day 4 的 `streamText` 走到今天，你的 Agent 依然是个每次见面都失忆的陌生人。今天用 AI SDK + ioredis + postgres.js + pgvector 把那张架构图落成能跑的 TS 代码，零件全部来自已学周，没有一件新家具。

## 三层记忆的 TS 落地总览

先对着第 17 周 Day 1 的四分类表把 TS 侧的选型钉死。语义记忆（RAG 知识库）第 14 周已经做完，本篇补剩下三层会碰到的三块存储，全部复用：

- **短期记忆 = 会话窗口**：Redis（第 6 周 Day 1 的 ioredis）按 `sessionId` 存最近 N 轮 messages，配 TTL 与截断两个阀门；本地偷懒可以用内存 Map 顶着。读写时机：组装 prompt 前读，每轮回答后写。
- **长期记忆 = 用户偏好**：PG 一张 `user_preferences` 长表（postgres.js，[学习指南](/guide/)给 TS 主线定的 PG 访问方式），存「称呼：Jerry」这类提炼后的事实。读写时机：会话开始读出来注入 system prompt，回答结束后异步抽取写入。
- **情景记忆 = 历史对话事件**：pgvector（第 14 周 Day 5 建的 `VECTOR(1536)` 那套）存「问 + 答」摘要的 Embedding，检索时带 `user_id` 过滤捞 top3 相似情景。读写时机：回答结束后归档，新对话提问前检索。

前置检查清单：第 6 周的 Redis 和 ioredis、第 11 周 Day 4 的 `streamText`、Day 3 的结构化输出概念、第 14 周 Day 4 的 Embedding 调用，缺哪块就先回哪周补。第 17 周 Day 2 到 Day 4 的 Python 版（「最近 N 轮 + 摘要」、偏好加载、情景检索）是本篇的镜像实现，两版对照着看，概念一遍就牢。

## 短期记忆：会话窗口

先回答为什么这层必须是独立存储：Day 4 的 `/api/chat/stream` 把 messages 全权交给了客户端，每次请求全量上送。单机 demo 没问题，可服务一重启、前端一刷新、多实例一负载均衡，「最近聊了什么」就没了。短期记忆就是把这份数据挪到服务端，按 `sessionId` 归档。

选 Redis 不选 PG，理由和第 6 周做缓存时一样：这层数据要的就是「会忘」。TTL 保证会话凉了数据跟着凉，截断保证读回来时只有最近 N 轮。第 17 周 Day 1 坑 3 说过，这两个阀门少一个，Redis 就退化成第二个 checkpoint 垃圾场。

```ts
import Redis from 'ioredis';
import type { ModelMessage } from 'ai';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

type SessionState = { summary: string; messages: ModelMessage[] };

const sessionKey = (sid: string) => `agent:sess:${sid}`;
const SESSION_TTL = 24 * 60 * 60; // 秒，一天不活跃就过期
const COMPRESS_AFTER = 40;       // 消息条数上限，20 轮

async function loadSession(sessionId: string): Promise<SessionState> {
  const raw = await redis.get(sessionKey(sessionId));
  return raw ? (JSON.parse(raw) as SessionState) : { summary: '', messages: [] };
}

async function saveSession(sessionId: string, state: SessionState) {
  // 'EX' 就是第 6 周 Day 1 那套 TTL 写法：每次保存都续期，活跃会话不过期
  await redis.set(sessionKey(sessionId), JSON.stringify(state), 'EX', SESSION_TTL);
}
```

序列化多说一句，这是 ioredis 和 AI SDK 的接缝：`ModelMessage` 就是 `{ role, content }` 普通对象，纯文本轮的 `content` 是 string，`JSON.stringify` 原样存、`JSON.parse` 原样回，展开进 `messages` 数组直接能用。带图片或工具调用的轮 `content` 是数组，也能序列化，但摘要逻辑处理起来烦，本篇只往里存纯文本轮。

窗口超限了怎么办？第 17 周 Day 2 的答案是「最近 N 轮 + 摘要」：旧轮压成一段滚动摘要，新轮原样保留。TS 版一个函数搞定：

```ts
import { generateText } from 'ai';

async function compressSession(state: SessionState): Promise<SessionState> {
  if (state.messages.length <= COMPRESS_AFTER) return state;
  const older = state.messages.slice(0, -20);   // 被压缩的旧轮
  const recent = state.messages.slice(-20);     // 保住的最近 10 轮
  const transcript = older.map(m => `${m.role}: ${m.content}`).join('\n');
  const { text } = await generateText({
    model: llm,
    prompt:
      `把下面的多轮对话压成不超过 150 字的摘要，保留用户提到的关键事实与偏好。` +
      `已有摘要：${state.summary}\n\n${transcript}`,
  });
  return { summary: `${state.summary} ${text}`.trim(), messages: recent };
}
```

没有 Redis 的环境（比如火车上写代码），用内存 Map 把 `loadSession`/`saveSession` 里的 `redis.get/set` 换成 `store.get/set`，其余一行不改。代价心里有数：重启就没、多实例不共享、TTL 也没了。想更省事还可以上 Keyv，一层薄封装自带毫秒级 TTL，但第 6 周已经用过 ioredis，这里不引入新依赖。

## 长期记忆：用户偏好

短期记忆再好，会话一关就清零。第 17 周 Day 3 用两张表（画像 + 流水）做了完整版，本篇按 TS 主线的体量砍到一张长表，够用且更好懂：

```sql
CREATE TABLE user_preferences (
  user_id     TEXT NOT NULL,
  key         TEXT NOT NULL,          -- '称呼' / '职业' / '回复风格'
  value       TEXT NOT NULL,          -- 'Jerry' / '后端开发' / '简短'
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
```

为什么是 `(user_id, key)` 长表而不是 jsonb 一行：偏好天然是一行一条事实，复合主键配 upsert，「用户改口」就是覆盖一行的事，`updated_at` 用数据库的 `now()`（第 17 周 Day 3 坑 5 的教训：别用应用时间）。将来要做置信度、流水回溯，往这张表上加列或加表都顺。

写入的关键工序是提炼：不能把 20 轮原文塞进 PG，要让 LLM 从对话里抽出「用户明确亲口说过的」偏好。这正是第 11 周 Day 3 结构化输出的用武之地，TS 版比 Python 版还省事：`response_format` 严格模式加 Pydantic 校验两步，在 AI SDK 里合成一个 `generateObject`，schema 用 zod 写一遍，翻译和校验都是 SDK 的活。

```ts
import { generateObject } from 'ai';
import { z } from 'zod';

const preferenceSchema = z.object({
  preferences: z.array(z.object({
    key: z.string().describe('偏好类别短语，如：称呼、职业、回复风格'),
    value: z.string().describe('用户原话的概括'),
  })),
});

const EXTRACT_PROMPT = `你是用户偏好抽取器，从对话中抽取用户【明确亲口说过】的偏好和事实。
规则：
1. 只摘录用户明确说出的信息，禁止推测和总结
2. 常见类别：称呼、职业、技术栈、语言偏好、回复风格
3. 对话里没有任何明确偏好时返回空数组
4. 健康状况、财务状况、证件号、精确住址、政治与宗教观点，提到也不许输出

对话记录：
user: {user}
assistant: {assistant}`;

const SENSITIVE = ['病历', '诊断', '薪资', '存款', '负债', '身份证号'];

async function extractAndSavePreferences(userId: string, userText: string, assistantText: string) {
  const { object } = await generateObject({
    model: llm,
    schema: preferenceSchema,
    prompt: EXTRACT_PROMPT.replace('{user}', userText).replace('{assistant}', assistantText),
  });
  // 第二层防御：LLM 的禁令不是百分百可靠，写库前再跑一遍关键词兜底
  const safe = object.preferences.filter(
    p => !SENSITIVE.some(kw => `${p.key}${p.value}`.includes(kw)),
  );
  for (const p of safe) {
    await sql`
      INSERT INTO user_preferences (user_id, key, value)
      VALUES (${userId}, ${p.key}, ${p.value})
      ON CONFLICT (user_id, key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = now()`;
  }
}
```

规则 1 是抽取出错率的分水岭，第 17 周 Day 3 坑 2 的原话：每条结果都要能在对话原文里找到出处，找不到的就是脑补。隐私红线也是那边搬来的，两层防御一行不少。

读取这侧是一个纯函数：把偏好渲染进 system prompt 的模板。它是「Agent 启动时注入」的落点，也是第 17 周 Day 5 Prompt 模板里「用户偏好」区的 TS 实现：

```ts
type Preference = { key: string; value: string };

async function loadPreferences(userId: string): Promise<Preference[]> {
  return sql`SELECT key, value FROM user_preferences WHERE user_id = ${userId}`;
}

export function buildSystemPrompt(
  prefs: Preference[],
  episodes: Episode[],
  sessionSummary: string,
): string {
  const parts = ['你是用户的编程助手，回答务实、简短。'];
  if (prefs.length > 0) {
    parts.push('已知用户偏好，回答时必须遵守：\n' + prefs.map(p => `- ${p.key}：${p.value}`).join('\n'));
  }
  if (episodes.length > 0) {
    parts.push('与该用户的历史对话情景，仅供参考：\n' + episodes.map(e => `- ${e.summary}`).join('\n'));
  }
  if (sessionSummary) {
    parts.push(`本次会话更早内容的摘要：${sessionSummary}`);
  }
  return parts.join('\n\n');
}
```

空偏好、空情景、空摘要时对应段落整个不出现，prompt 不留「暂无」这种废话占位。

## 情景记忆：向量检索

偏好解决「用户是谁」，情景解决「我们一起经历过什么」。用户上次问过部署的事，这次说「接着上次的问题」，靠的不是偏好表，是那次对话本身。第 17 周 Day 4 的做法：对话摘要转向量入库，新对话时检索相似情景。

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE conversation_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,
  summary    TEXT NOT NULL,
  embedding  VECTOR(1536) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_user ON conversation_events (user_id);
```

`VECTOR(1536)` 对齐 `text-embedding-3-small` 的输出维度，第 14 周 Day 5 的规矩。Embedding 调用照抄第 14 周 Day 4 的 openai SDK 直连写法（生成模型走 AI SDK provider，Embedding 可以是另一家，两把 key 互不干扰）：

```ts
import OpenAI from 'openai';

const embedClient = new OpenAI({
  apiKey: process.env.EMBED_API_KEY ?? process.env.OPENAI_API_KEY,
});

async function embed(text: string): Promise<number[]> {
  const res = await embedClient.embeddings.create({
    model: 'text-embedding-3-small', // 入库和检索必须是同一个模型，一个字符都不能差
    input: text,
  });
  return res.data[0].embedding;
}
```

归档和检索，SQL 和第 14 周 Day 6 的检索函数一个模子，只多了一件事：

```ts
type Episode = { summary: string; score: number };
const MIN_SCORE = 0.3; // 阈值别拍脑袋，按第 15 周 Day 5 的标定方法校准

async function archiveEpisode(userId: string, userText: string, assistantText: string) {
  const summary = `用户问：${userText.slice(0, 200)}\n助手答：${assistantText.slice(0, 200)}`;
  const vecLiteral = `[${(await embed(summary)).join(',')}]`; // pgvector 只认文本形式的向量字面量
  await sql`
    INSERT INTO conversation_events (user_id, summary, embedding)
    VALUES (${userId}, ${summary}, ${vecLiteral}::vector)`;
}

async function searchEpisodes(userId: string, query: string, topK = 3): Promise<Episode[]> {
  const vecLiteral = `[${(await embed(query)).join(',')}]`;
  const rows = await sql`
    SELECT summary, 1 - (embedding <=> ${vecLiteral}::vector) AS score
    FROM conversation_events
    WHERE user_id = ${userId}
    ORDER BY embedding <=> ${vecLiteral}::vector
    LIMIT ${topK}`;
  return rows.filter(r => r.score >= MIN_SCORE);
}
```

多的那件事就是 `WHERE user_id = ${userId}`。这行是第 15 周 Day 4 metadata 过滤的近亲：那边用 `metadata->>'source'` 区分知识库文档和对话，这边更简单，情景记忆单独一张表，用实打实的列做过滤。但语义一样狠：没有这行，A 用户的历史会变成 B 用户的「回忆」，检索再准也是事故。向量字面量的拼法（`[` + 逗号连接 + `::vector` 转型）是第 14 周 Day 6 讲过的原样复用。

理想节奏是「会话结束时归档一次」，但会话结束没有可靠的钩子（TTL 过期是 Redis 侧的事，惊动不到你）。教程按每轮归档实现：粒度细、实现简单，代价是多几次 Embedding 调用，量大了再改成攒批。

## 组装：一个 withMemory 包装函数

零件齐了，总装。目标：路由层一行调用，三层记忆的读、拼、写全部收进一个 `withMemory`。文件放 `lib/memory.ts`，上面四节的函数加下面两段，头部补齐连接与模型：

```ts
import postgres from 'postgres';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://postgres:dev123@localhost:5432/agent');

// 生成模型：连 OpenAI 本家就不设 LLM_BASE_URL；DeepSeek 等兼容站照第 11 周 Day 6 换
const llmProvider = createOpenAI({
  baseURL: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY,
});
const llm = llmProvider.chat(process.env.LLM_MODEL ?? 'gpt-4o-mini');
```

主角来了，注意读它的顺序：读三层 → 拼上下文 → 调 `streamText` → 返回后异步写回：

```ts
export async function withMemory(input: {
  sessionId: string;
  userId: string;
  message: string;
  signal?: AbortSignal;
}) {
  const { sessionId, userId, message, signal } = input;

  // 1. 读三层：短期窗口 + 长期偏好 + 相似情景，后两个互不依赖，并发去拿
  const session = await loadSession(sessionId);
  const [prefs, episodes] = await Promise.all([
    loadPreferences(userId).catch(() => [] as Preference[]),
    searchEpisodes(userId, message).catch(() => [] as Episode[]),
  ]);

  // 2. 拼上下文：system 装长期与情景，窗口装短期，本轮问题垫底
  const messages: ModelMessage[] = [
    { role: 'system', content: buildSystemPrompt(prefs, episodes, session.summary) },
    ...session.messages,
    { role: 'user', content: message },
  ];

  // 3. 调 streamText：Day 4 的主角原封不动，记忆只是给它喂了更好的 messages
  return streamText({
    model: llm,
    messages,
    abortSignal: signal,
    onFinish: ({ text }) => {
      // 4. 返回之后异步写回：整段搬到事件循环下一拍，响应路径零等待
      setTimeout(() => {
        writeBack(sessionId, userId, message, text).catch(err =>
          console.error('[memory] 写回失败:', err),
        );
      }, 0);
    },
  });
}

async function writeBack(sessionId: string, userId: string, userText: string, assistantText: string) {
  // 短期：追加这一问一答，超限就压缩摘要，整体写回 Redis
  const session = await loadSession(sessionId);
  session.messages.push(
    { role: 'user', content: userText },
    { role: 'assistant', content: assistantText },
  );
  await saveSession(sessionId, await compressSession(session));

  // 长期：抽取偏好 upsert 进 PG
  await extractAndSavePreferences(userId, userText, assistantText);

  // 情景：问 + 答摘要转向量入库
  await archiveEpisode(userId, userText, assistantText);
}
```

写回为什么这么绕：`onFinish` 触发时流已经吐完，用户侧本来就没有延迟可加，但写回里藏着一次抽取调用、一次 Embedding、几次 SQL，加起来可能两三秒。`setTimeout(…, 0)` 把整段挪出当前执行栈，失败只记日志不炸主流程。要可靠性别用 setTimeout，把 `writeBack` 塞进 BullMQ（第 6 周 Day 4 的队列），重试和持久化都是现成的。

路由层薄成一张纸，新建 `app/api/chat/memory/route.ts`：

```ts
import { withMemory } from '@/lib/memory';

export async function POST(req: Request) {
  const { sessionId, userId, message } = await req.json();
  const result = await withMemory({ sessionId, userId, message, signal: req.signal });
  return result.toUIMessageStreamResponse();
}
```

真实项目里 `userId` 从认证态来（第 5 周的 JWT），别信客户端上送的字段。前端如果用 Day 5 的 useChat 全量上送 messages，把这层的 `message` 换成数组末尾那条即可，服务端持有的窗口依旧是权威。

## 验收实验

文字步骤，全程约 20 分钟。实验成功的标志只有一句话：新会话里，Agent 知道你是谁。

**第 1 步：起存储。** PG 用第 14 周 Day 5 的 pgvector 镜像，Redis 一个官方镜像：

```bash
docker run -d --name agent-pg -e POSTGRES_PASSWORD=dev123 -e POSTGRES_DB=agent -p 5432:5432 pgvector/pgvector:pg16
docker run -d --name agent-redis -p 6379:6379 redis:7
```

**第 2 步：建表。** 把长期和情景两节的 DDL 存成 `memory-schema.sql`，灌进去：

```powershell
Get-Content memory-schema.sql | docker exec -i agent-pg psql -U postgres -d agent
```

bash 用户把 `Get-Content` 换成 `cat`。进 psql 用 `\dt` 确认两张表都在。

**第 3 步：备项目。** 复用 Day 4 的 Next.js 项目，装包：`npm i ai @ai-sdk/openai zod openai ioredis postgres`。`.env.local` 里写 `OPENAI_API_KEY`、`DATABASE_URL`、`REDIS_URL` 三项，key 别硬编码进文件。

**第 4 步：放代码，起服务。** `lib/memory.ts`（四节函数加总装段）加 `route.ts`，`npm run dev`。

**第 5 步：会话 A，植入记忆。**

```bash
curl -N -X POST http://localhost:3000/api/chat/memory \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"s1","userId":"u_001","message":"叫我 Jerry，我是后端开发，回答尽量简短"}'
```

流式回答正常吐字就算第一步过。等两秒让异步写回落地，然后查三处：psql 里 `SELECT * FROM user_preferences;` 应该有「称呼：Jerry」「职业：后端开发」这样的行；`SELECT id, left(summary, 40) FROM conversation_events;` 有一行带向量的事件；`docker exec agent-redis redis-cli GET agent:sess:s1` 吐出一串 JSON。

**第 6 步：会话 B，验证记忆。** 换 `sessionId` 为 `s2`，`userId` 不变，问「我是做什么的？该怎么称呼我？」。Agent 的回答里应该出现「后端开发」和「Jerry」。关键在于：`s2` 的 Redis 窗口是空的，这个答案没有任何一轮历史可看，它只可能来自偏好注入和情景检索，两条长期通道各自独立作证。

**第 7 步：反证隔离。** `userId` 换成 `u_002` 问同样的问题，Agent 应该一脸茫然。不知道，才证明 `WHERE user_id` 那行过滤真的在拦人。顺带把 Day 4 的验收再来一遍：`curl -i -N` 看响应头，还是 `text/event-stream`，记忆没有动传输层一根毛。

## 常见踩坑

**坑 1：serverless 上后台写回被杀。** `setTimeout` 的写回在常驻进程（本地 dev、Docker、Vercel 外的部署）没问题；Next.js 跑在 serverless 函数里时，响应一结束进程就可能被回收，写回半途而废。症状：会话 A 说完，库里啥都没有。解法：Vercel 用 `waitUntil` 挂住，或者干脆走 BullMQ 外部队列。

**坑 2：Embedding 换了模型没重嵌。** 第 14 周 Day 6 的铁律在记忆这里同样生效：`text-embedding-3-small` 换成别家模型，维度不同报错，维度恰好相同更阴险，检索分数全是噪声。旧事件全部重嵌，没有捷径。

**坑 3：把多模态轮塞进会话窗口。** content 是数组的消息（图片、工具结果）`JSON.stringify` 后读回来类型还对，但 `compressSession` 的模板字符串会把数组拍成乱码摘要。存之前判一下 `typeof content === 'string'`，非文本轮只留一句占位。

**坑 4：写回竞态。** 用户在写回完成前（那一两秒里）连发第二条，`writeBack` 里的 `loadSession` 读到的是旧状态，第一条问答可能被顶掉。教程体量先接受它；要严格，把 Redis 追加改成同步路径，只有抽取和归档留异步。

**坑 5：偏好表膨胀后全量注入。** 用了两个月，一个用户几十条 key，每次全塞 system prompt，token 白烧还互相打架（「回复简短」和「多解释原理」共存时 Agent 精神分裂）。到期给 `user_preferences` 加 updated_at 淘汰或按相关性挑前几条，别全端上桌。

## 自测 5 题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 三层记忆各自落在哪个存储组件上？读写时机分别是什么？

::: details 参考答案
短期是 Redis 按 sessionId 存的会话窗口（或本地 Map），组 prompt 前读、每轮回答后写；长期是 PG 的 `user_preferences` 表，会话开始读出来注入 system prompt、回答结束后异步抽取写入；情景是 pgvector 的 `conversation_events` 表，回答结束后归档「问 + 答」摘要向量、新对话提问前检索 top3 相似情景（带 user_id 过滤）。
:::

2. Redis 这层的 TTL 和轮数截断分别防什么？少了会怎样？

::: details 参考答案
TTL 防跨会话垃圾堆积，会话不活跃数据跟着过期，守住「该忘就忘」；截断（配合滚动摘要）防单会话内读回时上下文爆炸。少 TTL，Redis 堆满死会话变成第二个 checkpoint 垃圾场；少截断，token 账单随轮数线性起飞。两个阀门是短期记忆区别于「原样回放」的全部身份。
:::

3. `generateObject` 对应第 11 周 Day 3 的哪两步？比 Python 版省了什么？

::: details 参考答案
对应 `response_format` 的 json_schema 严格模式（约束生成）和 Pydantic 校验（解析把关）两步。省在合一：zod schema 写一遍，SDK 既翻译给端点约束输出、又负责解析校验，不像 Python 那边 Schema 生成和校验代码是两段要人肉同步的逻辑。带错误信息的重试如果要加，思路和 Day 3 一样。
:::

4. `searchEpisodes` 的 SQL 里 `WHERE user_id = ${userId}` 去掉会怎样？它和第 15 周溯源的 metadata 过滤是什么关系？

::: details 参考答案
去掉后检索跨用户：A 用户的历史对话会作为「回忆」注入 B 用户的 prompt，隐私事故加答非所人。它和溯源的 metadata 过滤（`metadata->>'source'` 区分知识库与对话）是同一思想在不同表结构上的落法：向量检索必须配一个硬过滤把候选集圈住，相似度只该在圈内的候选间排序。本篇情景记忆单独建表，过滤条件落成实打实的列。
:::

5. 写回为什么放在 `onFinish` 里再套一层 `setTimeout`？这个设计的代价是什么？

::: details 参考答案
`onFinish` 触发时流已吐完，不增加用户延迟；但写回含抽取、Embedding、多次 SQL，可能两三秒，`setTimeout(…, 0)` 把它挪出当前执行栈，失败只记日志不影响响应路径。代价是竞态：用户在写回落地前连发下一条，读到的是旧会话状态，上一问一答可能丢失；严格场景要么同步写 Redis 要么上 BullMQ 队列。
:::

## 延伸阅读

- [AI SDK 文档：Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)，`generateObject` 的官方说明，偏好抽取那步的一手出处
- [AI SDK 文档：streamText 参考](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)，`onFinish` 钩子的完整签名，写回时机就挂在它上面
- [ioredis GitHub](https://github.com/luin/ioredis)，`set` 的 EX 选项与键过期行为，第 6 周知识的原始出处
- [postgres.js GitHub](https://github.com/porsager/postgres)，标签模板查询与参数绑定的细节
- [pgvector GitHub](https://github.com/pgvector/pgvector)，`<=>` 操作符与 HNSW 索引，事件表上量之后回来查

今天的产出 `lib/memory.ts` 留好。接上 Day 5 的 useChat，就是一个记得住用户的完整聊天应用；想再进一步，语义缓存（把「问过的问题 → 满意过的答案」也向量化复用）不过是在 `conversation_events` 旁边再加一张表、检索命中就直接回的事，零件今天已经全部摸过一遍了。
