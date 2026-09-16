# 第 14 周 · Day 2：文档解析——把真实文档变成干净文本

> 对应手册任务：学习「文档解析：PDF/Markdown/TXT」，动手用 `pypdf` 或 `unstructured` 解析一份 PDF 文档，当日产出 `parse_doc.py` 文本提取脚本。本篇只解决一个问题：昨天的 RAG 流程图里，第一环画的是一个「文档」框；今天把这个框拆开——把硬盘上的 PDF、Markdown、TXT 变成带着出处元数据的干净文本，让后面的切块和检索有的吃，还吃得干净。

## 今日目标

1. 说得清 PDF 为什么是「排版不是语义」，双栏文档直读为什么会乱序
2. 会做工具选型：`pypdf`、`unstructured`、云服务各自的适用边界，以及「够用就停」的判断标准
3. 独立完成 `parse_doc.py`：解析 PDF 输出带 `source`/`page`/`section` 元数据的 `ParsedDocument`，页眉页脚清掉，断词修好，并人工抽查过至少一页

## 概念讲解：为什么文档解析是隐形坑

昨天的流程图里，第一环是个方框，里面写着「文档」。画图时它最小，真做时它最大：你手里从来不会有「干净的文档」，只有排版各异的 PDF。

先说一个颠覆直觉的事实：PDF 是排版，不是语义。你以为 PDF 里有标题、段落、表格，打开它的内部看一眼，这些统统不存在。PDF 的底层是一条指令流，本质是「在坐标 (72, 640) 处画一个 R，在 (82, 640) 处画一个 e……」。它描述的是印刷效果，不是文档结构。「这两行属于同一段」「这两个分栏该先读左边」这类信息，PDF 里没有答案，是人眼看渲染结果时脑补出来的。

拿双栏学术论文试一次最直观。版面是这样的：

```text
┌──────── 左栏 ────────┐   ┌──────── 右栏 ────────┐
│ Retrieval-Augmented │   │ 实验表明，分块大小对  │
│ Generation 通过检索 │   │ 召回率影响显著，过大  │
│ 外部知识库缓解大模型 │   │ 的切块会稀释查询向量  │
│ 的幻觉问题。         │   │ 的语义……             │
└──────────────────────┘   └──────────────────────┘
```

`extract_text()` 直读同一页，输出是这样的：

```text
Retrieval-Augmented 实验表明，分块大小对
Generation 通过检索 召回率影响显著，过大
外部知识库缓解大模型 的切块会稀释查询向量
的幻觉问题。 的语义……
```

左栏第一行和右栏第一行被焊进同一行，两句话互相插花，谁都读不成句。

乱序还只是一坑。页眉页脚每页报到，页码、期刊名、公司名会重复混进每一页正文；表格被拆成一串毫无规律的数字和表头残留；扫描件 PDF 更彻底，里面压根没有文字，只有一张张图片，`extract_text()` 直接返回空。

最坑的是这一切不报错。代码跑通，一个字符不少，token 数看着正常，只有人眼读过才发现是一锅乱炖。而 RAG 是条流水线，第一环脏了后面全脏：垃圾进，垃圾出，Embedding 算的是乱炖的向量，检索再准也召不回正确的语义。这一环值得单独花一天。

## 核心知识

本节代码围绕三个动作展开：选工具、提文本、存元数据。完整可运行的脚本以下面的动手任务为准。

### 1. 工具选型：够用的里头挑最轻的

| 工具 | 定位 | 优势 | 局限 |
| --- | --- | --- | --- |
| `pypdf` | 纯文本提取 | 纯 Python、零外部依赖、`pip install` 即用 | 双栏、表格会乱序，扫描件无能为力 |
| `unstructured` | 多格式万金油 | PDF/Word/HTML/邮件一套 API，内置版面分区 | 依赖链重、速度慢，效果依赖底层引擎 |
| 云服务（TextIn、阿里文档智能） | 重排版专业户 | 双栏、表格、扫描件都能还原阅读顺序 | 按量付费，文档要出域 |

我的判断标准：先拿 `pypdf` 抽前几页，人眼扫一遍。顺序大体对、页眉页脚能用正则清掉，就到此为止——本篇教程和大多数文字型 PDF 都停在这一档。左右栏交错严重、表格多，再换 `unstructured` 试一轮版面分区。合同表格要精确到单元格、或者干脆是扫描件，直接上云服务，别在本地死磕。选型不是选最强的，是选「够用的里头最轻的」。

### 2. pypdf 实操：逐页提取与三条清洗规则

最小闭环长这样：

```python
from pypdf import PdfReader

reader = PdfReader("report.pdf")
print(f"共 {len(reader.pages)} 页")
for i, page in enumerate(reader.pages, start=1):
    text = page.extract_text() or ""
    print(f"=== 第 {i} 页 ===\n{text[:120]}")
```

关键一行是 `page.extract_text() or ""`：遇到扫描页、纯图片页，pypdf 返回的是 `None` 而不是空字符串，不兜底后面 `.strip()` 直接炸。`enumerate(..., start=1)` 给了从 1 起数的页码——这是全程唯一能拿到页码的时刻，先记下来，第 4 小节要用。

提取只是第一步，真正决定质量的是清洗。三条规则：

```python
import re

# 页眉页脚的常见形态，命中一条就整行丢弃
NOISE_PATTERNS = [
    re.compile(r"^第\s*\d+\s*页.*$"),      # 第 3 页 / 第 3 页，共 12 页
    re.compile(r"^\d+\s*/\s*\d+$"),        # 3 / 12
    re.compile(r"^Page \d+( of \d+)?$", re.IGNORECASE),  # Page 3
    re.compile(r"^\d{1,3}$"),              # 光秃秃的页码行
]

def clean_page(raw: str) -> str:
    lines = [ln.strip() for ln in raw.splitlines()]
    kept = [ln for ln in lines if not any(p.match(ln) for p in NOISE_PATTERNS)]
    text = "\n".join(kept)
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)  # 修复英文断词
    text = re.sub(r"\n{3,}", "\n\n", text)         # 压缩连续空行
    return text.strip()
```

关键两组正则。断词那行把 `comput-` + 换行 + `er` 焊回 `computer`——PDF 里英文长词排不下会拆到下一行，不修的话词表里多出无穷多残词，Embedding 和检索都跟着遭殃。空行那行只压「三个及以上」连续换行，段落间的一个空行留着，Day 3 判断段落边界时还用得上。

### 3. Markdown/TXT：结构是白送的，别扔掉

Markdown 解析不需要库，但别止步于 `read_text()` 一把梭。标题层级是作者亲手划的语义边界，`##` 下面这坨内容大概率属于同一主题——这对 Day 3 的切块是最好用的信号，现在就得按标题切开存：

```python
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")

def parse_markdown(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    sections, section, buf = [], "正文", []
    for line in lines:
        m = HEADING_RE.match(line)
        if m:
            if buf:
                sections.append(("\n".join(buf).strip(), section))
            section, buf = m.group(2).strip(), []
        else:
            buf.append(line)
    if buf:
        sections.append(("\n".join(buf).strip(), section))
    return sections
```

关键一行是 `HEADING_RE.match(line)`：碰到标题行，把攒着的内容按「当前标题」归档，再开新段。输出是一串 `(正文, 所属标题)`，标题进了元数据，不再混在正文里。TXT 就没有这份待遇了，无结构、无标题，退回纯文本，套用 `clean_page` 清一遍完事。

### 4. ParsedDocument：统一出口，元数据是第 15 周的地基

三种格式解析完，必须汇进同一个结构，后面切块、Embedding 的代码只认它：

```python
from pydantic import BaseModel

class ParsedSection(BaseModel):
    text: str               # 这一页/这一节的正文
    page: int               # 页码，Markdown/TXT 固定为 1
    section: str = "正文"   # 所属标题，Markdown 来自 #

class ParsedDocument(BaseModel):
    source: str             # 文件名
    sections: list[ParsedSection]
```

第 9 周练过的 Pydantic 在这里直接派上用场：字段带类型，下游代码 `doc.sections[0].page` 点出来就有提示，比裸字典放心。更重要的为什么是现在存元数据：「这段话在第几页、属于哪一节」这个信息只在解析时存在，切块进了向量库就永久消失。第 15 周做引用溯源，答案要标「来源：report.pdf 第 3 页」，字段地基就是今天这三个。现在不存，到时候全量重跑。

## 动手任务：`parse_doc.py` 一步一步

手册任务：解析一份 PDF 文档。拆成 5 步，全程约 25 分钟。

**第 1 步：装依赖，建文件。** 在本周练习目录执行 `pip install pypdf pydantic`，新建 `parse_doc.py`。下面每步的代码都往这个文件里加，写完它就是当日产出。

**第 2 步：定义数据结构。** 把第 4 小节的 `ParsedSection`、`ParsedDocument` 原样抄进去，再补上 `import re`、`from pathlib import Path`。

**第 3 步：写 PDF 解析加清洗。** 抄入 `NOISE_PATTERNS` 和 `clean_page`，然后写：

```python
def parse_pdf(path: Path) -> ParsedDocument:
    reader = PdfReader(path)
    sections = []
    for i, page in enumerate(reader.pages, start=1):
        cleaned = clean_page(page.extract_text() or "")
        if cleaned:
            sections.append(ParsedSection(text=cleaned, page=i))
    return ParsedDocument(source=path.name, sections=sections)
```

关键在 `ParsedSection(text=cleaned, page=i)`：页码在循环里顺手存进去，每一段正文从此带着出处。

**第 4 步：挂上 Markdown/TXT，统一入口跑起来。** 抄入 `HEADING_RE` 和 `parse_markdown`（把返回值改成 `ParsedSection(text=..., page=1, section=section)`），再加：

```python
def parse_txt(path: Path) -> ParsedDocument:
    cleaned = clean_page(path.read_text(encoding="utf-8"))
    return ParsedDocument(source=path.name,
                          sections=[ParsedSection(text=cleaned, page=1)])

def parse(path: str) -> ParsedDocument:
    p = Path(path)
    if p.suffix.lower() == ".pdf":
        return parse_pdf(p)
    if p.suffix.lower() in (".md", ".markdown"):
        return parse_markdown(p)
    if p.suffix.lower() == ".txt":
        return parse_txt(p)
    raise ValueError(f"暂不支持的格式：{p.suffix}")

if __name__ == "__main__":
    import sys
    doc = parse(sys.argv[1])
    chars = sum(len(s.text) for s in doc.sections)
    print(f"{doc.source}：{len(doc.sections)} 个片段，共 {chars} 字符")
    for s in doc.sections[:3]:
        print(f"\n[page={s.page} section={s.section}]\n{s.text[:150]}")
```

关键在 `parse()` 这个分发函数：三种格式、一个出口，下游永远只面对 `ParsedDocument`。

**第 5 步：人眼验收。** 挑输出里的第 2、3 页，对着原 PDF 逐行扫：页眉页脚还剩多少、段落顺序对不对、英文断词有没有修好。发现新噪声就回 `NOISE_PATTERNS` 加规则，再跑。

::: tip 运行命令
`python parse_doc.py 你的文件.pdf`。手边没 PDF 就去 arXiv 随便下一篇论文，双栏排版正好当压力测试，乱序、页眉页脚、断词一坑不落。
:::

## 常见踩坑

**坑 1：`extract_text()` 返回 None 不判空。** 扫描页、纯图片页没有字符流，pypdf 返回 `None`，后面 `.splitlines()` 直接 `AttributeError`。一行 `or ""` 解决。跑批几百份文档时，这一行决定脚本能不能活着跑完。

**坑 2：清洗正则宁漏勿杀。** `^\d{1,3}$` 这条光秃页码规则，碰上正文里的独立数字行——列表编号、年份——会误删正文。清洗前先做个统计：把前 10 页每页的首行和末行打出来，看清重复模式再对着真实样本写规则，别凭想象写。一条规则删错一行正文的代价，远大于它漏掉十条页眉。

**坑 3：断词修复只对英文排版开。** `(\w)-\n(\w)` 能焊回 computer，但表格里的 `2023-` + 换行 + `2024 财年` 会被错焊成 `20232024`，中文排版压根没有断词。中文为主的文档关掉这条，或收窄成 `[a-z]-\n[a-z]`。

**坑 4：Markdown 切分被代码块骗。** Python/Shell 注释、代码示例里的 `# 设置` 都长得像标题，一锅切会把代码块拦腰斩断。教程场景的笔记文档可以先不管；严谨做法是遇到 ``` 围栏就整段跳过，不匹配标题。

**坑 5：元数据不存，第 15 周等着重跑。** 「这段话在第几页」只在解析时存在，切块向量化之后永久丢失。引用溯源要输出「来源：report.pdf 第 3 页」，靠的就是今天 `ParsedSection` 里的 `source` 和 `page`。当时偷的懒，之后加倍还。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么双栏 PDF 直读会乱序？`extract_text()` 按什么顺序拼文本？

::: details 参考答案
PDF 内部只有字符和坐标，没有段落和阅读顺序。`extract_text()` 按内容流近似逐行拼文本，双栏版式下左右两栏同一水平线的行被拼在一起，两栏句子交错。还原阅读顺序需要版面分析，这正是 `unstructured` 和云服务做的事。
:::

2. `pypdf`、`unstructured`、云服务三档怎么选？

::: details 参考答案
先 `pypdf` 抽几页人工验收，顺序可接受、页眉页脚可清就用它；乱序修不动换 `unstructured` 试版面分区；表格要精确到单元格、或是扫描件，直接云服务。标准是「够用的里头最轻的」，不是最强的。
:::

3. `re.sub(r"(\w)-\n(\w)", r"\1\2", text)` 修复什么？什么时候要关？

::: details 参考答案
修复英文「单词排不下拆行」留在行尾的连字符，把 `comput-` + 换行 + `er` 焊回 `computer`。中文文档（中文无断词）或表格里连字符有真实含义（年份区间、编号）时要关掉或收窄，否则把真信息焊没了。
:::

4. `source`/`page`/`section` 为什么必须在解析阶段存？

::: details 参考答案
解析是全程唯一知道「这段话来自第几页、属于哪一节」的时刻，切块和向量化之后这些信息不再可得。第 15 周引用溯源要标「来源：某文件第 N 页」，字段地基就是这三个，现在不存，到时候只能全量重解析。
:::

5. Markdown 的标题层级对 Day 3 切块意味着什么？

::: details 参考答案
标题是作者亲手划的语义边界，按 `#`/`##` 切出来的块主题集中，比固定长度切块更贴内容，Embedding 的向量更纯，检索直接受益。这就是解析时保留结构、而不是压成一坨纯文本的原因。
:::

## 延伸阅读

- [pypdf 官方文档：Text Extraction](https://pypdf.readthedocs.io/en/stable/user/extract-text.html)，`extract_text` 的行为细节和参数，写清洗规则前值得通读
- [unstructured GitHub](https://github.com/Unstructured-IO/unstructured)，多格式解析库的入口，README 里的 `partition` API 十分钟看懂
- [TextIn 文档解析](https://www.textin.com/)，合合信息的解析服务，拿同一篇双栏论文试免费额度，对比 `pypdf` 的输出，直观感受版面分析的差距

今天的产出 `parse_doc.py` 和 `ParsedDocument` 留好。明天（见[本周日程](/week14/)）做文本切块，输入就是今天的输出：每段文本带着 `page` 和 `section`，切块函数只管怎么切，不用再操心这段话从哪来。到第 15 周引用溯源时，你会回来感谢今天存下的字段。
