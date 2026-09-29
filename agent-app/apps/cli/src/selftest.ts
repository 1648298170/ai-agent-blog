// selftest.ts —— 无网络自检：切块器 + 余弦检索库 + 会话/偏好/情景存储 + 手写工具循环
// 不调任何真实模型接口（工具循环用 ai/test 的 MockLanguageModelV2 假模型），
// `pnpm selftest` 或 `pnpm chat --selftest` 都能跑，全绿即引擎零件完好。
// 单仓化改造：引擎零件改为从 @agent-app/engine 的包子路径导入（rag / memory / tools / …）。
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { MockLanguageModelV2 } from "ai/test";
import { runToolLoop, ToolLoopAgent } from "@agent-app/engine/agent-loop";
import {
  chunkText,
  cosineSimilarity,
  createInMemoryRagStore,
  formatCitations,
} from "@agent-app/engine/rag";
import type { Chunk, RetrievedChunk } from "@agent-app/engine/rag";
import {
  InMemorySessionStore,
  InMemoryPreferenceStore,
  InMemoryEpisodicStore,
  SUMMARY_PREFIX,
} from "@agent-app/engine/memory";
import { ToolRegistry, createDemoTools } from "@agent-app/engine/tools";
import { extractJson } from "@agent-app/engine/json-utils";
import { enableTrace, isTraceEnabled, preview } from "@agent-app/engine/trace";

/** 快速造一个 Chunk，embedding 可传 null（未向量的块） */
function makeChunk(id: string, docId: string, title: string, embedding: number[] | null): Chunk {
  return { id, docId, title, text: `${title} 的正文`, index: 0, embedding };
}

// ---------- 1. 切块器 ----------
async function testChunker(): Promise<void> {
  const text = "第一段短文本。\n\n" + "长".repeat(1200) + "\n\n第二段也短。";
  const chunks = chunkText(text); // 默认 maxLen=500, overlap=80

  assert.equal(chunks.length, 5, "两段短文 + 1200 字长段切成 3 片，共 5 块");
  assert.equal(chunks[0], "第一段短文本。");
  assert.equal(chunks[chunks.length - 1], "第二段也短。");
  for (const c of chunks) {
    assert.ok(c.length <= 500, `每块不得超过 maxLen：发现 ${c.length} 字的块`);
  }
  // overlap：长段相邻两块，后一块开头 = 前一块结尾 80 字
  const piece1 = chunks[1];
  const piece2 = chunks[2];
  assert.equal(piece2.slice(0, 80), piece1.slice(-80), "相邻块应保留 overlap");

  // 自定义参数：maxLen=100 overlap=20 切 250 字长段 → 3 片
  const small = chunkText("x".repeat(250), { maxLen: 100, overlap: 20 });
  assert.equal(small.length, 3);
  for (const c of small) assert.ok(c.length <= 100);

  // 空文本与纯空白不产出块
  assert.deepEqual(chunkText("   \n\n  "), []);
}

// ---------- 2. 余弦相似度 + 内存 RAG 库 ----------
async function testRagStore(): Promise<void> {
  // 余弦相似度基本功：正交为 0、同向为 1、模长无关
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([2, 0], [5, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(cosineSimilarity([], []), 0, "脏数据（空向量）返回 0 不抛错");
  assert.equal(cosineSimilarity([1, 0], [1]), 0, "维度不一致返回 0 不抛错");

  const store = createInMemoryRagStore();
  await store.upsert([
    makeChunk("c1", "d1", "退货政策", [1, 0, 0]),
    makeChunk("c2", "d1", "物流时效", [0, 1, 0]),
    makeChunk("c3", "d2", "住宿标准", [1, 1, 0]), // 未归一化也能算：只看方向
    makeChunk("c4", "d2", "未向量的块", null), // 未向量的块不参与检索
  ]);
  assert.equal(await store.count(), 4);

  // 检索排序：[1,0,0] 方向最近的是 c1，其次是 c3（夹角 45 度，得分 ≈ 0.707）
  const hits = await store.search([1, 0, 0], 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "c1");
  assert.ok(Math.abs(hits[0].score - 1) < 1e-9);
  assert.equal(hits[1].id, "c3");
  assert.ok(Math.abs(hits[1].score - Math.SQRT1_2) < 1e-9);

  // docId 硬过滤：候选集先圈住，相似度只在圈内排序
  const filtered = await store.search([1, 0, 0], 10, { docId: "d1" });
  assert.deepEqual(filtered.map((h) => h.id), ["c1", "c2"]);

  // 删除链路：整篇文档的所有切块一并清掉，查不到残留
  await store.deleteDoc("d1");
  assert.equal(await store.count(), 2);
  const after = await store.search([1, 0, 0], 10);
  assert.deepEqual(after.map((h) => h.id), ["c3"], "null 向量块不该被检索到");
}

// ---------- 3. 引用拼装（纯函数） ----------
async function testCitations(): Promise<void> {
  const chunks: RetrievedChunk[] = [
    { ...makeChunk("c1", "d1", "退货政策", [1]), score: 0.9 },
    { ...makeChunk("c2", "d1", "物流时效", [1]), score: 0.8 },
  ];
  assert.equal(formatCitations(chunks), "[1] 退货政策\n[2] 物流时效");
  assert.equal(formatCitations([]), "", "空结果不出占位");
}

// ---------- 4. 会话窗口（短期记忆） ----------
async function testSessionStore(): Promise<void> {
  const store = new InMemorySessionStore();
  for (let i = 1; i <= 25; i++) {
    await store.append("s1", { role: i % 2 === 0 ? "assistant" : "user", content: `t${i}` });
  }
  const window = await store.getWindow("s1", 20);
  assert.equal(window.length, 20, "截断阀门：只回最近 20 轮");
  assert.equal(window[0].content, "t6", "窗口从第 6 轮开始（旧的被截掉）");
  assert.equal(window[19].content, "t25");
  assert.equal((await store.getWindow("s1")).length, 20, "默认 limit=20");

  // 另一个会话互不串门
  await store.append("s2", { role: "user", content: "另一个会话" });
  assert.equal((await store.getWindow("s2", 20)).length, 1);

  await store.clear("s1");
  assert.equal((await store.getWindow("s1", 20)).length, 0);
  assert.equal((await store.getWindow("s2", 20)).length, 1, "clear 只清目标会话");
}

// ---------- 5. 用户偏好（长期记忆） ----------
async function testPreferenceStore(): Promise<void> {
  const store = new InMemoryPreferenceStore();
  await store.set("u_001", "称呼", "Jerry");
  await store.set("u_001", "回复风格", "简短");
  assert.equal(await store.get("u_001", "称呼"), "Jerry");
  assert.equal(await store.get("u_002", "称呼"), null, "用户之间不串数据");

  await store.set("u_001", "称呼", "老王"); // 用户改口 = 覆盖一行
  assert.equal(await store.get("u_001", "称呼"), "老王");
  assert.deepEqual(await store.all("u_001"), { 称呼: "老王", 回复风格: "简短" });
}

// ---------- 6. 情景记忆（向量检索） ----------
async function testEpisodicStore(): Promise<void> {
  const store = new InMemoryEpisodicStore();
  await store.remember({
    sessionId: "s1",
    summary: "用户问了订单 A-1024 的物流",
    embedding: [1, 0, 0],
    createdAt: new Date().toISOString(),
  });
  await store.remember({
    sessionId: "s2",
    summary: "用户问了退款到账时间",
    embedding: [0, 1, 0],
    createdAt: new Date().toISOString(),
  });

  const hits = await store.recall([1, 0, 0], 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].sessionId, "s1", "方向最近的情景排最前");
  assert.ok(Math.abs(hits[0].score - 1) < 1e-9);
  assert.equal(hits[1].sessionId, "s2");
  assert.ok(hits[0].score >= hits[1].score, "按相似度降序");
}

// ---------- 8. 递归切块边界情况（空文本 / 短文本 / 分句 / 硬切 / overlap） ----------
async function testChunkerEdges(): Promise<void> {
  // 空文本与单句短文本：不产出块 / 整段原样成块
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("一句话。"), ["一句话。"]);
  assert.deepEqual(chunkText("短", { maxLen: 10, overlap: 2 }), ["短"]);

  // 有句末标点的长段：按句攒块，块边界落在句边界上（不拦腰切句）
  const s = (tag: string) => tag + "甲".repeat(48) + "。"; // 每句恰好 50 字
  const chunks = chunkText(s("一") + s("二") + s("三") + s("四") + s("五") + s("六"), {
    maxLen: 200,
    overlap: 40,
  });
  assert.equal(chunks.length, 2, "200 上限装下 4 句，剩下 2 句进第二块");
  assert.equal(chunks[0], s("一") + s("二") + s("三") + s("四"), "块内句子完整，不被拦腰切");
  assert.ok(chunks[1].endsWith(s("五") + s("六")), "剩余句子整句保留");
  assert.equal(
    chunks[1].slice(0, 40),
    chunks[0].slice(-40),
    "相邻块共享 overlap：后块开头 = 前块结尾 40 字",
  );

  // 整段没有任何句末标点：句子层切不动 → 第三层硬切兜底
  const bare = "无标点" + "字".repeat(1000);
  const hard = chunkText(bare, { maxLen: 300, overlap: 60 });
  assert.ok(hard.length >= 3, "1003 字按 300 上限至少 3 片");
  for (const c of hard) assert.ok(c.length <= 300, `硬切块不得超过 maxLen：${c.length}`);
  for (let i = 1; i < hard.length; i++) {
    assert.equal(hard[i].slice(0, 60), hard[i - 1].slice(-60), `硬切相邻块共享 overlap（第 ${i} 块）`);
  }
  assert.equal(hard[0], bare.slice(0, 300), "首块从原文开头起");
  assert.equal(hard[hard.length - 1], bare.slice(-hard[hard.length - 1].length), "末块盖到原文结尾");

  // 同一段里混入无标点长串：先出清句缓冲区，再对长串硬切（层间接缝）
  const mixed = chunkText(s("一") + s("二") + "流".repeat(450) + s("四"), { maxLen: 200, overlap: 40 });
  assert.equal(mixed.length, 4, "两句成一块 + 500 字单句硬切成 3 块");
  assert.equal(mixed[0], s("一") + s("二"));
  for (let i = 2; i < mixed.length; i++) {
    assert.equal(mixed[i].slice(0, 40), mixed[i - 1].slice(-40), "硬切块之间共享 overlap");
  }

  // 单句超过 maxLen 且以句号结尾：同样走硬切（长度兜底优先于「保句完整」）
  const cut = chunkText("字".repeat(250) + "。", { maxLen: 100, overlap: 20 });
  assert.ok(cut.length >= 3);
  for (const c of cut) assert.ok(c.length <= 100);
  for (let i = 1; i < cut.length; i++) {
    assert.equal(cut[i].slice(0, 20), cut[i - 1].slice(-20));
  }
}

// ---------- 9. 退化向量余弦（零向量 / NaN / Infinity，绝不产出 NaN） ----------
async function testDegenerateCosine(): Promise<void> {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0, "零向量没有方向可言");
  assert.equal(cosineSimilarity([0, 0, 0], [0, 0, 0]), 0);
  assert.equal(cosineSimilarity([Number.NaN, 1], [1, 0]), 0, "NaN 坐标按脏数据处理");
  assert.equal(cosineSimilarity([1, Number.NaN], [Number.NaN, 1]), 0);
  assert.equal(cosineSimilarity([Number.POSITIVE_INFINITY, 0], [1, 0]), 0, "Infinity 坐标按脏数据处理");
  assert.equal(cosineSimilarity([1e308, 1e308], [1e308, 1e308]), 0, "平方溢出成 Infinity 的同样出局");
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-9, "正常路径不受影响");

  // 内存 RAG 库：零向量块得分 0、有限、可排序，检索不被脏数据炸掉
  const store = createInMemoryRagStore();
  await store.upsert([
    makeChunk("z1", "d1", "零向量块", [0, 0, 0]),
    makeChunk("z2", "d1", "正常块", [1, 1, 0]),
  ]);
  const hits = await store.search([1, 1, 0], 5);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, "z2", "正常块排前面");
  for (const h of hits) assert.ok(Number.isFinite(h.score), "得分必须是有限数");

  // 情景记忆：退化 embedding 的记录得分 0，同样不产生 NaN
  const episodic = new InMemoryEpisodicStore();
  await episodic.remember({
    sessionId: "s1",
    summary: "脏数据",
    embedding: [0, 0],
    createdAt: new Date().toISOString(),
  });
  await episodic.remember({
    sessionId: "s2",
    summary: "正常",
    embedding: [1, 0],
    createdAt: new Date().toISOString(),
  });
  const eh = await episodic.recall([1, 0], 5);
  assert.equal(eh[0].sessionId, "s2");
  for (const e of eh) assert.ok(Number.isFinite(e.score), "情景得分必须是有限数");
}

// ---------- 10. 会话压缩（滚动摘要 + 离线降级，全程注入假摘要器，零网络） ----------
async function testSessionCompression(): Promise<void> {
  // —— 成功路径：注入假摘要器（离线、确定性），第 41 条触发压缩 ——
  const prompts: string[] = [];
  const store = new InMemorySessionStore({
    summarize: async (prompt) => {
      prompts.push(prompt);
      return "用户关注订单物流，偏好简短回复。";
    },
  });
  for (let i = 1; i <= 41; i++) {
    await store.append("s1", { role: i % 2 === 0 ? "assistant" : "user", content: `t${i}` });
  }
  // 压缩后：窗口头是合成 system 摘要轮 + 最近 20 条（t22..t41），旧轮 t1..t21 压进摘要
  const win = await store.getWindow("s1", 100);
  assert.equal(win.length, 21, "1 条摘要轮 + 20 条最近轮");
  assert.equal(win[0].role, "system");
  assert.equal(win[0].content, SUMMARY_PREFIX + "用户关注订单物流，偏好简短回复。");
  assert.equal(win[1].content, "t22");
  assert.equal(win[20].content, "t41");
  // 摘要提示词：教程同款（150 字 + 已有摘要 + 多轮 transcript），只覆盖被压的旧轮
  assert.equal(prompts.length, 1, "未超阈值期间不发起摘要调用");
  assert.ok(prompts[0].includes("150 字"));
  assert.ok(prompts[0].includes("已有摘要"));
  assert.ok(prompts[0].includes("t21"), "被压的最后一轮进 transcript");
  assert.ok(!prompts[0].includes("t22"), "未压缩的最近轮不进 transcript");

  // 滚动：再攒 20 条触发二次压缩，旧摘要并入 prompt、拼进新摘要轮
  for (let i = 42; i <= 61; i++) {
    await store.append("s1", { role: i % 2 === 0 ? "assistant" : "user", content: `t${i}` });
  }
  const win2 = await store.getWindow("s1", 100);
  assert.equal(win2.length, 21);
  assert.equal(
    win2[0].content,
    SUMMARY_PREFIX + "用户关注订单物流，偏好简短回复。 用户关注订单物流，偏好简短回复。",
    "滚动摘要 = 旧摘要 + 新摘要",
  );
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].includes("用户关注订单物流"), "二次压缩把已有摘要带进 prompt（滚动）");
  assert.ok(prompts[1].includes("t41") && !prompts[1].includes("t42"));

  // —— 离线降级：摘要器抛错（等价无 API Key / 网关不通），只保最近 20 条、不出摘要轮 ——
  const offline = new InMemorySessionStore({
    summarize: async () => {
      throw new Error("模拟离线：未配置 OPENAI_API_KEY");
    },
  });
  for (let i = 1; i <= 41; i++) {
    await offline.append("s1", { role: "user", content: `t${i}` });
  }
  const downgraded = await offline.getWindow("s1", 100);
  assert.equal(downgraded.length, 20, "降级只保最近 20 条");
  assert.equal(downgraded[0].content, "t22");
  assert.ok(downgraded.every((t) => t.role !== "system"), "降级不产出摘要轮");
  await offline.append("s1", { role: "user", content: "t42" }); // 降级后继续写不反复炸
  assert.equal((await offline.getWindow("s1", 100)).length, 21, "截断回到 20 条后阈值内静默追加");

  // —— 默认构造（真实摘要器）在阈值内绝不触发 LLM：40 条原样保留 ——
  const plain = new InMemorySessionStore();
  for (let i = 1; i <= 40; i++) {
    await plain.append("s1", { role: "user", content: `t${i}` });
  }
  const plainWin = await plain.getWindow("s1", 100);
  assert.equal(plainWin.length, 40, "未超阈值（40 条）不压缩");
  assert.equal(plainWin[0].content, "t1");
}

// ---------- 11. 偏好/情景存储细节（限长护栏 / 默认 top3 / 稳定排序） ----------
async function testStorePolish(): Promise<void> {
  // 偏好 value 上限：超长截断，空白值不入库
  const prefs = new InMemoryPreferenceStore();
  await prefs.set("u_001", "备注", "长".repeat(800));
  const stored = await prefs.get("u_001", "备注");
  assert.ok(stored !== null);
  assert.equal(stored.length, 500, "value 超过 500 字被截断");
  await prefs.set("u_001", "空的", "   ");
  assert.equal(await prefs.get("u_001", "空的"), null, "空白值不入库");

  // 情景记忆：recall 不传 k 时默认 top3（教程口径），同分按入库先后稳定排序
  const episodic = new InMemoryEpisodicStore();
  for (let i = 1; i <= 5; i++) {
    await episodic.remember({
      sessionId: `s${i}`,
      summary: `情景 ${i}`,
      embedding: [1, 0, 0], // 全部同向 → 同分 1
      createdAt: new Date().toISOString(),
    });
  }
  const top3 = await episodic.recall([1, 0, 0]);
  assert.equal(top3.length, 3, "默认 k=3");
  assert.deepEqual(
    top3.map((e) => e.sessionId),
    ["s1", "s2", "s3"],
    "同分时按先来后到稳定排序",
  );
}

// ---------- 7. 手写工具循环（MockLanguageModelV2 假模型，无网络） ----------

/** 造一个「第一次要工具，之后给答案」的假模型：真实 provider 的 tool call 参数是 JSON 字符串 */
function makeLoopMock() {
  let calls = 0;
  return new MockLanguageModelV2({
    doGenerate: async () => {
      calls += 1;
      const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      if (calls === 1) {
        return {
          finishReason: "tool-calls",
          usage,
          warnings: [],
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "getOrderStatus",
              input: JSON.stringify({ orderId: "A-1024" }),
            },
          ],
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      return {
        finishReason: "stop",
        usage,
        warnings: [],
        content: [{ type: "text", text: "订单已发货，明天 18 点前送达。" }],
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

async function testToolLoop(): Promise<void> {
  const model = makeLoopMock();
  const result = await runToolLoop({
    model,
    messages: [{ role: "user", content: "订单 A-1024 到哪了？" }],
    tools: createDemoTools(),
    maxSteps: 5,
  });

  assert.equal(result.steps, 2, "两步：要工具 → 拿结果作答");
  assert.equal(result.text, "订单已发货，明天 18 点前送达。");

  // 历史里应同时有调用意图（① 入账）和工具结果（③ 回灌）
  const historyJson = JSON.stringify(result.messages);
  assert.ok(historyJson.includes("call-1"), "历史应包含模型的调用意图");
  assert.ok(historyJson.includes('"tool-result"'), "历史应包含回灌的 tool-result 消息");
  assert.ok(historyJson.includes("已发货"), "工具的真实输出（mock 订单 A-1024）应回到历史");

  // ToolLoopAgent 类封装同款链路
  const agent = new ToolLoopAgent({ model: makeLoopMock(), tools: createDemoTools(), maxSteps: 5 });
  const reply = await agent.generate({ prompt: "订单 A-1024 到哪了？" });
  assert.equal(reply.text, "订单已发货，明天 18 点前送达。");
  assert.equal(reply.steps, 2);

  // 工具注册表：register/getAll 吐出的表与手写循环兼容
  const registry = new ToolRegistry();
  const demo = createDemoTools();
  for (const [name, t] of Object.entries(demo)) {
    registry.register(name, t);
  }
  assert.deepEqual(registry.names().sort(), ["createTicket", "escalateToHuman", "getOrderStatus"]);
  const viaRegistry = await runToolLoop({
    model: makeLoopMock(),
    messages: [{ role: "user", content: "订单 A-1024 到哪了？" }],
    tools: registry.getAll(),
    maxSteps: 5,
  });
  assert.equal(viaRegistry.text, "订单已发货，明天 18 点前送达。");

  // 保险丝：模型一直要工具时，步数用完必须抛错
  let alwaysToolCalls = 0;
  const endlessModel = new MockLanguageModelV2({
    doGenerate: async () => {
      alwaysToolCalls += 1;
      return {
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
        content: [
          {
            type: "tool-call",
            toolCallId: `call-${alwaysToolCalls}`,
            toolName: "getOrderStatus",
            input: JSON.stringify({ orderId: "A-1024" }),
          },
        ],
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
  await assert.rejects(
    runToolLoop({
      model: endlessModel,
      messages: [{ role: "user", content: "一直查" }],
      tools: createDemoTools(),
      maxSteps: 3,
    }),
    /步数用完/,
    "步数用完应抛错（自己的保险丝）",
  );
}

/** 轨迹模块：开关状态 + 长值预览截断（纯函数断言，不碰 stderr） */
async function testTrace(): Promise<void> {
  const saved = process.env.AGENT_TRACE;
  try {
    delete process.env.AGENT_TRACE;
    assert.ok(!isTraceEnabled(), "默认（未设 AGENT_TRACE）应关闭轨迹");
    enableTrace();
    assert.ok(isTraceEnabled(), "enableTrace() 后应开启");
    delete process.env.AGENT_TRACE;
    assert.ok(!isTraceEnabled(), "清掉环境变量应回到关闭");
    process.env.AGENT_TRACE = "0";
    assert.ok(!isTraceEnabled(), "AGENT_TRACE=0 不算开启");
    process.env.AGENT_TRACE = "true";
    assert.ok(isTraceEnabled(), "AGENT_TRACE=true 算开启");
  } finally {
    if (saved === undefined) delete process.env.AGENT_TRACE;
    else process.env.AGENT_TRACE = saved;
  }

  const long = "字".repeat(300);
  const p = preview(long, 100);
  assert.ok(p.startsWith("字".repeat(100)), "preview 应保留前缀");
  assert.ok(p.includes("共 300 字符"), "preview 截断时应标注原始长度");
  assert.equal(preview({ a: 1 }), '{"a":1}', "preview 对对象走 JSON 序列化");
  assert.equal(preview(undefined), "undefined", "preview 对 undefined 兜底 String()");
}

/** JSON 宽松提取：裸 JSON / markdown 围栏 / 前后废话 / 解析失败 */
async function testExtractJson(): Promise<void> {
  assert.deepEqual(extractJson('{"route":"order"}'), { route: "order" }, "裸 JSON 直接解析");
  assert.deepEqual(
    extractJson('```json\n{"route":"refund"}\n```'),
    { route: "refund" },
    "markdown 围栏应被剥掉",
  );
  assert.deepEqual(
    extractJson('好的，分类如下：{"route":"knowledge","reason":"制度问题"} 希望有帮助'),
    { route: "knowledge", reason: "制度问题" },
    "前后废话应被容忍",
  );
  assert.throws(() => extractJson("这不是 JSON，我只是闲聊"), /未按 JSON 约定回复/, "纯废话应抛中文错误");
}

/** 全部自检项：逐项跑，失败记录并最终以非零码退出 */
export async function runSelfTest(): Promise<void> {
  const tests: [name: string, fn: () => Promise<void>][] = [
    ["切块器 chunker", testChunker],
    ["余弦相似度 + 内存 RAG 库", testRagStore],
    ["引用拼装 formatCitations", testCitations],
    ["会话窗口 InMemorySessionStore", testSessionStore],
    ["用户偏好 InMemoryPreferenceStore", testPreferenceStore],
    ["情景记忆 InMemoryEpisodicStore", testEpisodicStore],
    ["手写工具循环 runToolLoop + ToolLoopAgent（假模型）", testToolLoop],
    ["递归切块边界情况 chunker edges", testChunkerEdges],
    ["退化向量余弦 degenerate cosine", testDegenerateCosine],
    ["会话压缩（滚动摘要 + 离线降级）", testSessionCompression],
    ["偏好/情景存储细节（限长 / 默认 top3）", testStorePolish],
    ["轨迹开关 trace（开关状态 + 预览截断）", testTrace],
    ["JSON 宽松提取 extractJson（围栏 / 废话 / 失败）", testExtractJson],
  ];

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`      ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failed > 0) {
    console.error(`自检未通过：${failed}/${tests.length} 项失败`);
    process.exitCode = 1;
  } else {
    console.log(`自检全部通过（${tests.length}/${tests.length}），未发起任何网络请求。`);
  }
}

// 直接运行（pnpm selftest）时自动执行；被 chat --selftest 导入时由调用方触发
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSelfTest();
}
