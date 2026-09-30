// kb-search.ts —— 知识库检索工具：把 searchKnowledge 包成客服 knowledge 工人手里的锤子
// 引用编号由后端分配（第 15 周 Day 4 溯源思想）：execute 里给命中块编号 no，
// 模型只被允许在答案里回标 [no]，编号与标题的映射始终握在代码手里，编不了页码。
// 红队加固轮两处变更：
//   H7（修 E3）——命中块原文套围栏 + notice 携带数据性声明：工具输出是知识库内容
//   回灌模型的主通道，E3 证明这里零防线时模型 3/3 把载荷当指令执行；
//   H8（修 E5 补口）——AGENT_GUARD_PII=1 时本地工具输出同样过 PII 脱敏：
//   此前闸只包 MCP 来源工具，本地 searchKnowledgeBase 把完整号码直接回灌模型。
import { tool } from "ai";
import { z } from "zod";
import { maskPii } from "../guardrails/pii-mask.js";
import { fenceCitation, RAG_GROUNDING_RULE, searchKnowledge } from "../rag/retrieve.js";

/** AGENT_GUARD_PII 的布尔口径（与 chat CLI 的护栏开关同款：1 或 true 才生效，默认关） */
function isPiiMaskEnabled(): boolean {
  const raw = process.env.AGENT_GUARD_PII;
  return raw === "1" || raw === "true";
}

/** 检索公司知识库：返回带编号与出处的最相关文档切块，回答时按编号标注引用 */
export const searchKnowledgeBase = tool({
  description:
    "检索公司知识库，返回与问题最相关的文档切块（含引用编号、标题、正文、相似度）。回答时引用哪块就标注对应编号，如 [1][2]",
  inputSchema: z.object({
    query: z.string().describe("检索问题，如「出差住宿标准一晚多少钱」"),
    k: z.number().int().min(1).max(10).optional().describe("返回条数，默认 5"),
  }),
  execute: async ({ query, k }) => {
    const hits = await searchKnowledge(query, k ?? 5);
    const mask = isPiiMaskEnabled();
    return {
      query,
      hitCount: hits.length,
      // H7：数据性声明随工具结果同行——模型在哪个入口看到资料，规则都在场
      notice: RAG_GROUNDING_RULE,
      hits: hits.map((chunk, i) => ({
        no: i + 1, // 引用编号由后端分配，模型只负责回标 [n]
        title: chunk.title,
        // H7 围栏 + H8 脱敏：原文先过 PII 闸（开时）再进围栏——围栏标记本身不含 PII
        text: fenceCitation(i + 1, chunk.title, mask ? maskPii(chunk.text) : chunk.text),
        score: Number(chunk.score.toFixed(3)), // 相似度：排查检索质量的第一手数据
      })),
    };
  },
});
