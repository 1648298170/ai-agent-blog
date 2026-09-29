// chunker.ts —— 递归切块：先按空行分段（段落），段内按句末标点分句，单句仍超上限再硬切兜底
// 教程《RAG TS 全链路》chunk.ts 的对照实现：块间留 overlap，横跨切口的句子在相邻两块各留一份。
// 参数起点值同教程：每块 300~500 字（MAX_LEN=500）、重叠 10%~20%（OVERLAP=80）。
//
// ── 为什么要切块、为什么要有重叠 ──────────────────────────────────────────
// 1) 为什么不整篇入库？embedding 模型有输入上限，而且整篇压成一个向量，
//    "一篇讲 5 个主题的文档" 只会得到一个四不像向量——查询任何一个主题都不像。
//    切成块后每块只讲一个主题，"每块一个向量"才能命中。
// 2) 为什么要 overlap（重叠）？切块是按长度切的，语义不看长度——
//    一句话可能正好被拦腰切成两块。重叠让这句话在相邻两块里各出现一次，
//    无论用户从哪个角度问，至少有一块是"读得懂这句话"的。
//
// ── "递归"指什么：三级瀑布 ────────────────────────────────────────────────
//   整篇文本
//     ↓ 第一层：空行分段（段落是最自然的语义边界）
//   段落数组 ──≤ maxLen 的段──→ 直接成块
//     ↓ 超长段
//   第二层：按句末标点分句，句子往块里攒，攒满 500 字出块
//     ↓ 单句自己就超 500 字（整段没标点的极端文本）
//   第三层：滑动窗口硬切（步长 = maxLen - overlap，窗口间天然共享 overlap）
//
// ── 一个小例子看懂 overlap（maxLen=10, overlap=3）─────────────────────────
//   25 字无标点文本 "AAAAAAAAAAAAAAAAAAAAAAA"（第三层硬切，步长 = 10-3 = 7）
//   窗口：[0..10) [7..17) [14..24) [21..25)
//   块1 = AAAAAAAAAA
//   块2 = ###AAAAAAA   ← ### 是块1 的最后 3 个字（尾巴接到下一块开头）
//   块3 = ######AAAA
//   块4 = #########A
//   查询命中的关键内容若在切口附近，相邻两块至少有一块保有完整上下文。

/** 切块参数：maxLen 每块字符上限，overlap 相邻块重叠字符 */
export interface ChunkOptions {
  maxLen?: number;
  overlap?: number;
}

/** 默认参数同教程：每块上限 500 字，相邻块重叠 80 字（约 15%） */
const DEFAULT_MAX_LEN = 500;
const DEFAULT_OVERLAP = 80;

/** 第一层：空行分段。中文文档最自然的边界；段内连续空白压成一个空格（同教程 splitParagraphs） */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** 第二层：句末标点分句。中文句号/问号/叹号 + 英文对应 + 中英文分号，标点留在句尾 */
function splitSentences(para: string): string[] {
  return para.split(/(?<=[。！？!?.;；])\s*/).filter(Boolean);
}

/**
 * 第三层兜底：整串没有任何句末标点、单句超过 maxLen 时按滑动窗口拦腰硬切。
 * 窗口步长 = maxLen - overlap，相邻两块天然共享 overlap（上一块尾巴 = 下一块开头）。
 */
function hardCut(sentence: string, maxLen: number, overlap: number): string[] {
  const step = maxLen - overlap;
  const pieces: string[] = [];
  for (let start = 0; start < sentence.length; start += step) {
    pieces.push(sentence.slice(start, start + maxLen));
    if (start + maxLen >= sentence.length) break; // 窗口已盖到句尾
  }
  return pieces;
}

/**
 * 超长段的句子级重组：句子往缓冲区里攒，装不下下一句就出块；
 * 出块时把上一块尾巴（overlap 字）接到下一块开头 —— 教程 splitLongParagraph 同款。
 * 单句自己就超过 maxLen（典型：一长串没有标点的文本）时先出清缓冲区，再走 hardCut 硬切：
 * 硬切窗口之间自带 overlap，末片留在缓冲区与后续句子自然衔接。
 *
 * 缓冲区 buf 的攒块过程（maxLen=10, overlap=3，句子按 4 字造个例）：
 *   句子序列：S1(4) S2(4) S3(4) S4(4) S5(4)
 *   S1 → buf="S1"                       （空,buf 变 4）
 *   S2 → buf="S1S2"                     （4+4=8 ≤ 10，继续攒）
 *   S3 → 8+4=12 > 10，装不下 →
 *        out.push("S1S2")               （块1 出炉）
 *        buf = "S2" + "S3"              ← 块1 尾巴(3 字)接到下一块开头，这就是 overlap 的来源
 *   S4 → buf="S2S3S4"（12 > 10）→ out.push("S2S3")；buf = "S3" + "S4"
 *   S5 → buf="S3S4S5"… 循环往复，块与块之间永远共享一段尾巴
 *   收尾：buf 里剩下的最后一段也要出块（第 70 行 if (buf)）
 */
function splitLongParagraph(para: string, maxLen: number, overlap: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const sentence of splitSentences(para)) {
    if (sentence.length > maxLen) {
      // 单句超上限：句边界切不动它，退到硬切层；缓冲区里已有的句子先出块
      if (buf) {
        out.push(buf);
        buf = "";
      }
      const pieces = hardCut(sentence, maxLen, overlap);
      out.push(...pieces.slice(0, -1)); // 前面的整窗直接出块
      buf = pieces[pieces.length - 1]; // 末片进缓冲区，和后续句子继续攒
      continue;
    }
    if (buf && (buf + sentence).length > maxLen) {
      out.push(buf);
      buf = buf.slice(-overlap) + sentence; // 上一块尾巴接到下一块开头
    } else {
      buf += sentence;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 把一篇纯文本切成块数组（返回纯文本，不带 id/embedding，由入库方补齐元数据）。
 * - 短段落（≤ maxLen）整段成块
 * - 超长段落递归下钻：段落 → 句子 → （单句仍超限时）硬切
 * - 相邻块共享 overlap：横跨切口的句子在两边各留一份，两边都能被检索到
 *
 * 注意返回值只是字符串数组：切块和向量化刻意分成两步——
 * 元数据（id/docId/title）只有入库方知道，切块函数保持纯函数（输入文本、输出文本，
 * 不碰网络不碰存储），才能被自检离线穷举边界情况。
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const maxLen = Math.max(1, options.maxLen ?? DEFAULT_MAX_LEN);
  // overlap 必须小于 maxLen，否则滑动窗口不动会切出重复块（step = maxLen - overlap ≤ 0）
  const overlap = Math.min(options.overlap ?? DEFAULT_OVERLAP, maxLen - 1);

  const chunks: string[] = [];
  for (const para of splitParagraphs(text)) {
    if (para.length <= maxLen) chunks.push(para);
    else chunks.push(...splitLongParagraph(para, maxLen, overlap));
  }
  return chunks;
}
