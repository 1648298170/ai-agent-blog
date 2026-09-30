// 红队清理脚本：从共享知识库删除红队夹具文档，并打印删除前后的文档清单
// 用法：npx tsx scripts/redteam-cleanup.mjs [关键字...]（默认 poisoned-note / pii-note）
import { setRagStore, getRagStore } from "../packages/engine/src/rag/index.ts";
import { createRagStoreFromEnv } from "../packages/engine/src/rag/store.factory.ts";

const keywords = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["poisoned-note", "pii-note"];

setRagStore(createRagStoreFromEnv());
const store = getRagStore();

const before = await store.listDocs();
console.log("删除前文档清单：");
for (const d of before) console.log(`  ${d.docId}（${d.chunkCount} 块）`);

for (const d of before) {
  if (keywords.some((kw) => d.docId.includes(kw))) {
    await store.deleteDoc(d.docId);
    console.log(`已删除：${d.docId}`);
  }
}

const after = await store.listDocs();
console.log("删除后文档清单：");
for (const d of after) console.log(`  ${d.docId}（${d.chunkCount} 块）`);
const leftover = after.filter((d) => keywords.some((kw) => d.docId.includes(kw)));
console.log(leftover.length === 0 ? "✔ 红队夹具已全部清除" : `✘ 仍残留 ${leftover.length} 个红队文档`);
process.exit(0);
