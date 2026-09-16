# 第 15 周 · Day 6：知识库管理界面——上传、列表、删除，给 RAG 补上另一半

> 对应手册任务：学习「前端知识库管理界面」，动手在 Next.js 中实现“上传文档 + 查看已上传列表”，当日产出「知识库 UI」。本篇只解决一个问题：对话链路早已跑通，文档进库却还靠第 14 周的命令行脚本——今天补上管理面，上传、列表、删除各就各位，企业系统的另一半才算落地。

## 今日目标

1. 说得清为什么上传必须秒回：大文件处理动辄几十秒，同步必超时，「秒回 + 后台跑 + 轮询状态」是铁律
2. 掌握四个技术点：UploadFile 流式读、类型白名单与落盘规范、BackgroundTasks 处理链、documents 状态表与状态流转
3. 独立完成 Next.js 知识库页面：拖拽多文件上传带进度、列表轮询刷新状态、删除带确认弹层，删完 chunk 与向量一并清掉

## 概念讲解：为什么上传必须异步

检索、重排、引用、评估（日程见[第 15 周目录](/week15/)）本周都做完了，但有件事没戳破：加文档靠的还是第 14 周写的入库脚本。学习自用无所谓，企业场景立刻露馅：运营同学要更新员工手册，难道给她开服务器权限？

企业系统从来不只是对话页。用户视角是「我问你答」，运营视角是「知识从哪来、进没进去、错了怎么删」，这就是管理面的四个功能：上传、列表、删除、跳转对话。前三个是今天的活，最后一个是传完马上提问验证的一行链接。

上传是唯一的硬骨头，难点不在 multipart 语法，在耗时长。算笔账：50 页的 PDF，解析几秒，切块一瞬间，两三百个 chunk 分批向量化再写 pgvector，全程 30 秒起步。接口若同步等它跑完，会一口气撞上三堵墙。

第一，网关超时。Nginx 默认 60 秒砍连接，接口还在跑，浏览器已经收到 504。

第二，吞吐被拖垮。每个上传占用一个 worker 半分钟，五个人并发上传，整个服务一起卡死。

第三，体验是黑盒。用户盯着转圈一分钟，不知道进度也不敢刷新。

解法是把「慢活」从请求生命周期里剥离，第 6 周用 BullMQ 干过同一件事：接口只负责收文件、落盘、插一条 pending，毫秒级返回；「解析→切块→向量化→入库」交给后台任务，边跑边推进状态；前端轮询列表看流转。今天用 FastAPI 自带的 BackgroundTasks 做简版，与 BullMQ 的边界看自测第 5 题。一句话记住：大文件同步处理必超时，异步是铁律。

## 核心知识

### 1. 功能清单与数据流

四个功能，各自背后是一次明确的数据动作：

| 功能 | 交互形态 | 背后的数据动作 |
| --- | --- | --- |
| 上传 | 拖拽区，多文件 | 落盘 + documents 插 pending |
| 列表 | 文件名 / 切块数 / 状态 / 时间 | 查 documents 表，3 秒轮询 |
| 删除 | 确认弹层 | 删行 + 级联清 chunks（含向量）+ 删源文件 |
| 跳转对话 | 一行链接 | 无数据动作，传完去验证检索 |

数据流：拖进文件 → 接口秒回 pending → 后台改成 processing → 跑完写 done 和 chunk_count → 列表轮询到变化 → 点「去对话页验证」。

### 2. documents 状态表：RAG 的第一张元数据表

第 14 周那张 `documents` 表里住的是切块和向量，其实一直在当 chunk 表用。今天给它正名，文件级与块级分两层：

```sql
ALTER TABLE documents RENAME TO chunks;      -- 旧表正名为 chunks

CREATE TABLE documents (                     -- 新的 documents 是文件级元数据表
  id          TEXT PRIMARY KEY,              -- 服务端生成的文档 ID，全程只用它，不信任用户输入
  filename    TEXT NOT NULL,                 -- 原始文件名，仅用于展示
  status      TEXT NOT NULL DEFAULT 'pending', -- pending / processing / done / failed
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error       TEXT,                          -- failed 时记一句话原因，排查全靠它
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chunks ADD COLUMN doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE;
CREATE INDEX idx_chunks_doc_id ON chunks(doc_id);
```

关键一行是 `ON DELETE CASCADE`：删掉 documents 一行，全部 chunks 自动跟着消失，而向量就存在 chunks 行里，「连带清 chunk 与向量」一条外键兜住了。老数据 doc_id 为 NULL，不影响检索；建表脚本还能改就带上 doc_id，省掉这条 ALTER。

四个状态是一台小状态机：接口插记录写 pending，后台任务开跑写 processing，全部入库写 done 并带上 chunk_count，异常在 except 里写 failed。最后一条漏了，文档就永远卡在 processing，坑 3 专门讲它。

### 3. 上传接口三件事：流式读、白名单、落盘规范

FastAPI 收文件用 `UploadFile`，请求到达时文件体已写进临时文件，代码要做三件事。

第一，流式搬运。`await file.read()` 不带参数会把整个文件一次读进内存，200MB 扫描件直接把 worker 打爆。带上分片大小循环搬运，内存占用恒为一个分片：

```python
CHUNK_SIZE = 1024 * 1024  # 一次搬 1MB

with target_path.open("wb") as out:
    while data := await file.read(CHUNK_SIZE):
        out.write(data)
```

第二，类型白名单。收 pdf、md、txt、docx 就够，判断用扩展名。别信 `Content-Type` 头，那是客户端随口报的，curl 一句话就能伪造。

第三，落盘目录规范。不要拿用户文件名拼磁盘路径，`../../evil.pdf` 是真能传上来的。规范：服务端生成 doc_id 当目录名，源文件用固定名存，原始文件名只进数据库展示。

### 4. 后台任务：解析→切块→向量化→入库

接口秒回后，接力棒交给 `process_document`。它是普通函数，被 `add_task` 挂在响应之后执行——响应发出去了，它才在同一进程里慢慢跑：

```python
background_tasks.add_task(process_document, doc_id, str(target_path))
```

它做四件事：推进 processing、调用第 14 周的解析/切块/向量化函数、chunks 连向量入库并写 done、异常写 failed。全程不再碰 HTTP，输出就是数据库里的状态。

跟 BullMQ 对一下：BackgroundTasks 在进程内、无持久化、无重试，重启任务就丢；BullMQ 把任务存 Redis，有重试和并发控制。单机项目简版够用，什么时候换队列看自测第 5 题。

## 动手任务：知识库 UI 一步一步

手册任务：在 Next.js 中实现「上传文档 + 查看已上传列表」。拆成 6 步，约 40 分钟。前提：PostgreSQL + pgvector 还在，FastAPI 与 Next.js 沿用 Day 4 那套，CORS 照旧。

**第 1 步：建表。** 跑第 2 节的 SQL。验收：`\d documents` 能看到五列，旧表已改名 chunks 且多了 doc_id 列。

**第 2 步：上传接口。** FastAPI 侧新建 `routers/documents.py`：

```python
import os
import shutil
import uuid
from pathlib import Path

import psycopg
from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile

router = APIRouter()

ALLOWED_EXT = {".pdf", ".md", ".txt", ".docx"}  # 白名单，后端说了算
UPLOAD_DIR = Path("uploads")                    # 所有源文件的根目录
CHUNK_SIZE = 1024 * 1024


def get_conn():
    return psycopg.connect(os.environ["DATABASE_URL"])  # 换成你项目的连接方式


@router.post("/api/documents")
async def upload_document(background_tasks: BackgroundTasks, file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"不支持的类型 {ext}，仅收 {sorted(ALLOWED_EXT)}")

    doc_id = uuid.uuid4().hex[:12]
    display_name = Path(file.filename).name    # 剥掉路径只留文件名，防目录穿越
    target_dir = UPLOAD_DIR / doc_id           # 目录名 = doc_id，与用户输入彻底解耦
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = target_dir / f"source{ext}"

    with target_path.open("wb") as out:
        while data := await file.read(CHUNK_SIZE):  # 流式搬运，内存占用恒为 1MB
            out.write(data)

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, filename) VALUES (%s, %s)",
            (doc_id, display_name),
        )
        conn.commit()

    background_tasks.add_task(process_document, doc_id, str(target_path))
    return {"id": doc_id, "filename": display_name, "status": "pending"}
```

关键在最后一行 `add_task`：函数和参数被登记，响应返回之后才执行，这一行就是「秒回」与「慢活」的分界线。

**第 3 步：后台处理链。** 同一个文件里加上状态机的另外三站：

```python
def process_document(doc_id: str, file_path: str):
    """解析→切块→向量化→入库，全程在后台跑，输出只有数据库里的状态。"""
    from ingest import parse_file, split_into_chunks, embed_batch  # 第 14 周的函数，按你的实际名字替换

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE documents SET status='processing' WHERE id=%s", (doc_id,))
        conn.commit()
    try:
        text = parse_file(file_path)
        pieces = split_into_chunks(text, chunk_size=500)
        vectors = embed_batch(pieces)          # 分批调 embedding，铁律：与检索侧同一个模型

        with get_conn() as conn, conn.cursor() as cur:
            for piece, vec in zip(pieces, vectors):
                cur.execute(
                    "INSERT INTO chunks (doc_id, chunk, embedding) VALUES (%s, %s, %s)",
                    (doc_id, piece, "[" + ",".join(map(str, vec)) + "]"),
                )
            cur.execute(
                "UPDATE documents SET status='done', chunk_count=%s WHERE id=%s",
                (len(pieces), doc_id),
            )
            conn.commit()                      # chunks 与 done 同一事务，要么都成要么都不成
    except Exception as exc:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET status='failed', error=%s WHERE id=%s",
                (str(exc)[:500], doc_id),
            )
            conn.commit()
```

关键在 `except` 不能省：后台任务的异常没有请求可以返回，不写 failed，文档就永远卡在 processing。

**第 4 步：列表与删除接口。** 继续追加：

```python
@router.get("/api/documents")
def list_documents():
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT id, filename, status, chunk_count, created_at "
            "FROM documents ORDER BY created_at DESC"
        )
        rows = cur.fetchall()
    return [
        {"id": r[0], "filename": r[1], "status": r[2],
         "chunkCount": r[3], "createdAt": r[4].isoformat()}
        for r in rows
    ]


@router.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str):
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT filename FROM documents WHERE id=%s", (doc_id,))
        if not cur.fetchone():
            raise HTTPException(404, "文档不存在")
        cur.execute("DELETE FROM documents WHERE id=%s", (doc_id,))  # CASCADE 连带清 chunks 与向量
        conn.commit()
    shutil.rmtree(UPLOAD_DIR / doc_id, ignore_errors=True)           # 源文件目录也清掉
    return {"deleted": doc_id}
```

关键在一致性：documents 行没了，CASCADE 连带清 chunks 与向量，源文件随后删，三处不剩才是「删除」。最后在 `main.py` 里 `app.include_router(router)`。

**第 5 步：Next.js 页面。** 新建 `app/kb/page.tsx`，上传、列表、轮询、删除确认全在一个组件里：

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";

const API = "http://localhost:8000";

type Doc = {
  id: string;
  filename: string;
  status: "pending" | "processing" | "done" | "failed";
  chunkCount: number;
  createdAt: string;
};

const STATUS_TEXT: Record<Doc["status"], string> = {
  pending: "排队中",
  processing: "处理中",
  done: "已完成",
  failed: "失败",
};

export default function KnowledgeBasePage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({}); // 文件名 → 百分比
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Doc | null>(null); // 确认弹层挂谁

  const load = useCallback(async () => {
    const res = await fetch(`${API}/api/documents`);
    setDocs(await res.json());
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);      // 3 秒一轮，盯着状态流转
    return () => clearInterval(timer);          // 组件卸载必须停，见坑 4
  }, [load]);

  function uploadOne(file: File) {
    const xhr = new XMLHttpRequest();           // fetch 拿不到上传进度，进度条得用 XHR
    xhr.open("POST", `${API}/api/documents`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        setProgress((p) => ({ ...p, [file.name]: Math.round((e.loaded / e.total) * 100) }));
      }
    };
    xhr.onload = () => {
      setProgress((p) => {
        const next = { ...p };
        delete next[file.name];                 // 上传结束，撤掉这条进度
        return next;
      });
      if (xhr.status >= 400) {
        alert(`上传失败：${xhr.responseText}`);  // 比如传了白名单外的类型
        return;
      }
      load();                                   // 立刻刷一次，让 pending 马上出现在列表
    };
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    await fetch(`${API}/api/documents/${pendingDelete.id}`, { method: "DELETE" });
    setPendingDelete(null);
    load();
  }

  return (
    <main style={{ maxWidth: 720, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h1>知识库</h1>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          Array.from(e.dataTransfer.files).forEach(uploadOne);  // 多文件 = 逐个独立请求
        }}
        style={{
          border: `2px dashed ${dragging ? "#1677ff" : "#ccc"}`,
          padding: 40, textAlign: "center", borderRadius: 8,
        }}
      >
        把文件拖到这里（可多选：pdf / md / txt / docx）
        <div>
          <input
            type="file" multiple hidden id="picker"
            onChange={(e) => Array.from(e.target.files ?? []).forEach(uploadOne)}
          />
          <label htmlFor="picker" style={{ color: "#1677ff", cursor: "pointer" }}>
            或点击选择文件
          </label>
        </div>
      </div>

      {Object.entries(progress).map(([name, pct]) => (
        <div key={name}>{name}：{pct}%</div>
      ))}

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 24 }}>
        <thead>
          <tr>
            <th align="left">文件名</th><th>切块数</th><th>状态</th><th>上传时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id}>
              <td>{d.filename}</td>
              <td align="center">{d.status === "done" ? d.chunkCount : "-"}</td>
              <td align="center">{STATUS_TEXT[d.status]}</td>
              <td align="center">{new Date(d.createdAt).toLocaleString()}</td>
              <td align="center">
                <button onClick={() => setPendingDelete(d)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p><a href="/chat">去对话页验证检索 →</a></p>

      {pendingDelete && (
        <div
          onClick={() => setPendingDelete(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)",
                   display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", padding: 24, borderRadius: 8 }}>
            <p>确定删除「{pendingDelete.filename}」吗？</p>
            <p style={{ color: "#888" }}>
              它的 {pendingDelete.chunkCount} 个切块和向量会一并清除，不可恢复。
            </p>
            <button onClick={() => setPendingDelete(null)}>取消</button>{" "}
            <button onClick={confirmDelete} style={{ color: "red" }}>确认删除</button>
          </div>
        </div>
      )}
    </main>
  );
}
```

三个决策多说一句。多文件是「每个文件独立一条请求」：进度各算各的，单个失败不影响重传。进度条用 XHR：fetch 拿不到上传进度，`upload.onprogress` 才是正统写法。删除走确认弹层：连带清几百个 chunk 和向量，手滑一次就是真数据没了。

**第 6 步：联调验收。**

::: tip 验收清单
1. `curl -F "file=@员工手册.pdf" http://localhost:8000/api/documents` 应秒级返回 pending
2. 几秒后再 `curl http://localhost:8000/api/documents`，status 走完 processing 变 done，chunk_count 大于 0
3. 传 `test.exe` 收 400；传坏掉的 PDF，列表应出现 failed 和 error 原因
4. 删除后去对话页问原文，答案应降级为「知识库未覆盖」，Day 4 的降级路径正好用上
:::

## 常见踩坑

**坑 1：`await file.read()` 一把读进内存。** UploadFile 底层虽是临时文件，`read()` 不带参数仍会把整个文件载入内存，200MB 扫描件就能让 worker 翻车。别靠「文件都不大」撑着，管理面一开放，用户什么都敢传。

**坑 2：白名单只做在前端。** 前端限制是体验，后端校验才是安全，curl 直接打接口就绕过去了。同理，落盘路径不能拼用户文件名，`../` 目录穿越是经典攻击。一句话：客户端传来的字符串，要么校验，要么别用于「执行」语义——路径、SQL、命令。

**坑 3：后台任务炸了没人知道。** BackgroundTasks 的异常不会返回给任何请求，不写 failed，文档就永远卡在 processing，前端无限轮询假状态。except 里必须显式写 failed 和 error，这是排查「为什么进不去」的唯一线索。

**坑 4：轮询停不下来。** 全部文档都 done/failed 了还每 3 秒打一次接口，纯浪费。简单版：回调里检查是否全是终态，是就拉长间隔或停掉，有新上传再恢复。反向反例更常见：忘了在 useEffect 的 return 里 clearInterval，人都切到对话页了，轮询还在跑。

**坑 5：删除不清向量，检索检出一个幽灵。** 只删 documents 行，chunks 和向量还在，对话页照样检出来，引用卡片还给一个「已删除」的文件。删除要三处一致：元数据、chunks 连向量、源文件；前两处同一事务，失败可回滚，数据库才是事实源。

## 自测问题

先自己答，再展开对照。

1. 上传接口为什么必须秒回？同步处理会撞上哪几堵墙？

::: details 参考答案
同步等「解析→切块→向量化→入库」撞三堵墙：反向代理默认 60 秒超时直接 504；每个上传占一个 worker 半分钟，几个并发就拖死整个服务；用户全程黑盒。秒回 + 后台跑 + 轮询，三堵墙一次拆完。
:::

2. pending / processing / done / failed 各在哪一行代码写入？分别由谁写入？

::: details 参考答案
pending 由上传接口的 INSERT 写入；processing、done、failed 都由后台任务写——开跑写 processing，全部入库后同事务写 done 和 chunk_count，except 写 failed 和 error。前端只读。
:::

3. 为什么类型白名单和落盘路径必须后端算？Content-Type 为什么不可信？

::: details 参考答案
前端校验 curl 直接打接口就能绕过；Content-Type 是客户端自报的，类型用扩展名判断，再靠解析器报错兜底。落盘路径若拼用户文件名，`../` 可穿越目录，所以目录名用服务端生成的 doc_id，原始文件名只进库展示。
:::

4. 删除一个文档要动哪几处数据？哪几步必须放在同一个事务里？

::: details 参考答案
三处：documents 行、chunks 连同向量（靠 CASCADE 或显式 DELETE）、磁盘源文件目录。前两处是数据库操作，必须同事务，失败可回滚，不留孤儿数据；文件删除放事务外，用 ignore_errors 容错。
:::

5. BackgroundTasks 和第 6 周的 BullMQ 本质差在哪？出现什么信号就必须换真队列？

::: details 参考答案
BackgroundTasks 在进程内、无持久化、无重试，重启任务就丢；BullMQ 把任务存 Redis，有重试、并发控制、失败隔离。必须换的信号：多机部署、任务量大到要排队削峰、丢任务会造成业务损失。任何一条命中，就把处理链搬进队列 worker。
:::

## 延伸阅读

- [FastAPI 官方：Request Files](https://fastapi.tiangolo.com/tutorial/request-files/)，UploadFile 行为与多文件接收的原始出处
- [FastAPI 官方：Background Tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/)，add_task 的执行时机与适用边界
- [MDN：Using XMLHttpRequest](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/Using_XMLHttpRequest)，上传进度监听的正统写法

今天的产出是一块能用的管理面。documents 这张元数据表让 RAG 第一次有了「文件级」视角：库里有什么、状态如何，一条 SQL 就能回答。明天 Day 7 画架构图时把它画进去，从上传、切块、向量化到检索、引用的链路就完整了。
