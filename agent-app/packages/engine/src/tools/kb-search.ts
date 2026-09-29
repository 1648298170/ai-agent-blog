// kb-search.ts —— 知识库检索工具：把 searchKnowledge 包成客服 knowledge 工人手里的锤子
// 引用编号由后端分配（第 15 周 Day 4 溯源思想）：execute 里给命中块编号 no，
// 模型只被允许在答案里回标 [no]，编号与标题的映射始终握在代码手里，编不了页码。
import { tool } from "ai";
import { z } from "zod";
import { searchKnowledge } from "../rag/retrieve.js";

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
    return {
      query,
      hitCount: hits.length,
      hits: hits.map((chunk, i) => ({
        no: i + 1, // 引用编号由后端分配，模型只负责回标 [n]
        title: chunk.title,
        text: chunk.text,
        score: Number(chunk.score.toFixed(3)), // 相似度：排查检索质量的第一手数据
      })),
    };
  },
});
