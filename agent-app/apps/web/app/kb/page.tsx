// app/kb/page.tsx —— 知识库管理页：上传入库 / 文档列表（删除）/ 问答试用三区。
// 布局响应式：移动端单列（上传 → 列表 → 问答），桌面端上传与列表双栏、问答通栏。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KbDocumentSummary, KbQueryAnswer } from "@agent-app/shared";
import DocList from "../../components/DocList";
import { deleteDocument, ingestDocument, listDocuments, queryKb } from "../../lib/api";

/** 前端扩展名闸：与后端 SUPPORTED_EXTENSIONS（.txt/.md/.pdf）对齐，先拦一道省一次上传 */
const ALLOWED_EXTENSIONS = [".txt", ".md", ".pdf"] as const;

export default function KbPage() {
  // 文档列表
  const [docs, setDocs] = useState<KbDocumentSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);

  // 上传
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  // 问答试用
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<KbQueryAnswer | null>(null);
  const [answerError, setAnswerError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDocs(await listDocuments());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 文件选择即校验扩展名（不合法直接红字提示，不发请求） */
  function handleFileChange(file: File | null): void {
    if (file === null) return;
    const lower = file.name.toLowerCase();
    const pass = ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
    if (!pass) {
      setSelectedFile(null);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
      setUploadMessage({
        kind: "error",
        text: `不支持的文件类型：「${file.name}」。当前支持 .txt / .md / .pdf`,
      });
      return;
    }
    setUploadMessage(null);
    setSelectedFile(file);
  }

  async function handleUpload(): Promise<void> {
    if (selectedFile === null || uploading) return;
    setUploading(true);
    setUploadMessage(null);
    try {
      const result = await ingestDocument(selectedFile);
      setUploadMessage({
        kind: "ok",
        text: `《${result.title}》${result.chunks} 块入库（知识库共 ${result.total} 块）`,
      });
      setSelectedFile(null);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
      await refresh();
    } catch (err) {
      setUploadMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(doc: KbDocumentSummary): Promise<void> {
    if (deletingDocId !== null) return;
    if (!window.confirm(`确认删除《${doc.title}》？该文档的 ${doc.chunks} 个切块将一并下架。`)) {
      return;
    }
    setDeletingDocId(doc.docId);
    try {
      await deleteDocument(doc.docId);
      await refresh();
    } catch (err) {
      window.alert(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeletingDocId(null);
    }
  }

  async function handleAsk(): Promise<void> {
    const text = question.trim();
    if (text === "" || asking) return;
    setAsking(true);
    setAnswer(null);
    setAnswerError(null);
    try {
      setAnswer(await queryKb(text));
    } catch (err) {
      setAnswerError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-20 py-4 md:pb-8">
      <h1 className="mb-4 text-lg font-bold">📚 知识库管理</h1>

      {/* 上传 + 列表：移动端单列，桌面端双栏 */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        {/* 上传区 */}
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold text-gray-700">上传文档入库</h2>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.md,.pdf"
              onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
              disabled={uploading}
              className="min-h-10 flex-1 cursor-pointer rounded-lg border border-gray-300 px-2.5 py-2 text-xs text-gray-600 file:mr-3 file:min-h-8 file:cursor-pointer file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:text-xs file:font-medium file:text-gray-700"
            />
            <button
              type="button"
              onClick={() => void handleUpload()}
              disabled={selectedFile === null || uploading}
              className="min-h-10 shrink-0 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {uploading ? "入库中…" : "入库"}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            支持 .txt / .md / .pdf，入库 = 切块 → 向量化 → 存档（真实 embedding 调用，稍等片刻）
          </p>
          {uploadMessage !== null && (
            <p
              className={`mt-3 rounded-lg px-3 py-2 text-sm ${
                uploadMessage.kind === "ok"
                  ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {uploadMessage.kind === "ok" ? "✅ " : "⚠ "}
              {uploadMessage.text}
            </p>
          )}
        </section>

        {/* 文档列表 */}
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">
              已入库文档{docs !== null ? `（${docs.length}）` : ""}
            </h2>
            <button
              type="button"
              onClick={() => void refresh()}
              className="min-h-8 rounded-md px-2 text-xs text-gray-500 hover:bg-gray-100"
            >
              刷新
            </button>
          </div>
          <DocList
            docs={docs}
            loadError={loadError}
            deletingDocId={deletingDocId}
            onDelete={(doc) => void handleDelete(doc)}
          />
        </section>
      </div>

      {/* 问答试用（通栏） */}
      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">问答试用</h2>
        <div className="flex items-center gap-2">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAsk();
            }}
            placeholder="针对已入库文档提问，如：出差住宿标准是多少？"
            disabled={asking}
            className="min-h-11 flex-1 rounded-lg border border-gray-300 px-3.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          <button
            type="button"
            onClick={() => void handleAsk()}
            disabled={asking || question.trim() === ""}
            className="min-h-11 min-w-14 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {asking ? "检索中…" : "提问"}
          </button>
        </div>

        {answerError !== null && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            ⚠ {answerError}
          </p>
        )}

        {answer !== null && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
            {answer.degraded && (
              <p className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
                  ⚠ 降级：检索原文
                </span>
                {answer.hint !== undefined && (
                  <span className="text-xs text-amber-700">{answer.hint}</span>
                )}
              </p>
            )}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
              {answer.answer}
            </p>
            {answer.citations.length > 0 && (
              <div className="mt-3 border-t border-gray-200 pt-3">
                <p className="mb-1.5 text-xs font-medium text-gray-500">引用来源：</p>
                <ul className="flex flex-wrap gap-2">
                  {answer.citations.map((citation) => (
                    <li
                      key={citation.no}
                      className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600"
                    >
                      [{citation.no}] {citation.title}
                      <span className="ml-1 text-gray-400">相似度 {citation.score}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
