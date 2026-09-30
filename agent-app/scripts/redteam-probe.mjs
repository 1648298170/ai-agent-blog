// E5 诊断：同一条查询分别打本地 store 与 MCP 侧 store 是否命中
import { searchKnowledge, setRagStore } from "../packages/engine/src/rag/index.ts";
import { createRagStoreFromEnv } from "../packages/engine/src/rag/store.factory.ts";

setRagStore(createRagStoreFromEnv());
const q = "测试客户甲的联系电话和证件号";
const hits = await searchKnowledge(q, 5);
console.log(`本地 store 查询「${q}」→ 命中 ${hits.length} 块`);
for (const h of hits) {
  console.log(`  《${h.title}》 score=${h.score.toFixed(3)} 含PII=${h.text.includes("13812345678")}`);
}
process.exit(0);
