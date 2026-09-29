// components/DocList.tsx —— 知识库文档列表：卡片行（标题 / docId / 块数 / 删除），
// 卡片式天然适配窄屏（移动端单列），删除按钮触达区 ≥40px。
"use client";

import type { KbDocumentSummary } from "@agent-app/shared";

export default function DocList({
  docs,
  loadError,
  deletingDocId,
  onDelete,
}: {
  docs: KbDocumentSummary[] | null;
  loadError: string | null;
  deletingDocId: string | null;
  onDelete: (doc: KbDocumentSummary) => void;
}) {
  if (loadError !== null) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        文档列表加载失败：{loadError}
      </div>
    );
  }
  if (docs === null) {
    return <p className="animate-pulse text-sm text-gray-400">正在加载文档列表…</p>;
  }
  if (docs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 px-4 py-8 text-center text-sm text-gray-400">
        知识库还是空的——先上传一份文档（.txt / .md / .pdf）
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {docs.map((doc) => (
        <li
          key={doc.docId}
          className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-800">{doc.title}</p>
            <p className="truncate font-mono text-xs text-gray-400">{doc.docId}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
              {doc.chunks} 块
            </span>
            <button
              type="button"
              onClick={() => onDelete(doc)}
              disabled={deletingDocId !== null}
              className="min-h-10 rounded-lg border border-red-200 px-3 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deletingDocId === doc.docId ? "删除中…" : "删除"}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
