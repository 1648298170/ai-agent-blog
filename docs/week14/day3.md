# 第 14 周 · Day 3：文本切块策略——RAG 质量的第一刀

> 对应手册任务：学习「文本切块策略：固定长度、递归、语义」，动手实现递归切块并对比固定切块的检索效果，当日产出「切块模块」。本篇只解决一个问题：Day 2 拿到的那份干净长文本，怎么切成语义完整的块，让后面的 Embedding、检索、生成每一步都拿到刚好够用的上下文。

## 今日目标

1. 说得清为什么必须切：Embedding 有长度上限，长文本语义会稀释，检索粒度就是你可用的粒度
2. 掌握 chunk_size 与 overlap 的权衡，以及固定、递归、语义三种切法各自的适用场景
3. 手写一个约 40 行的递归切块器，跑一轮「固定 vs 递归」的人工检索对比，当日产出 `chunker.py`

## 概念讲解：为什么必须切

Day 2 结束时你手里有一份干净文本：标题在、段落齐、没有乱码。第一反应很可能是：这还用处理？整篇存进去，检索时整篇拿回来，多省事。

三件事拦住你。

第一，Embedding 模型有输入上限。以 `text-embedding-3-small` 为例，单次输入最多 8191 个 token，超了直接报错。一份 50 页 PDF 轻松翻倍这个数，整篇嵌入这条路从物理上就走不通。

第二，更隐蔽：语义稀释。Embedding 把一整块文本压成一个固定维度的向量，相当于替这段话写一句「中心思想」。一段只讲夜视距离，向量就精准指向「夜视」这个方向；一份文档把安装步骤、售后政策、产品参数、促销话术全混在一起，向量指向的是所有主题的平均值，哪个方向都不像。用户问「夜视多少米」，这个糊掉的向量排不到前面，答案明明就在文档里，检索就是够不着。

第三，检索粒度等于可用粒度。RAG 里检索回来什么，LLM 就读什么。块太大，答案埋在两千字噪声里，既拖慢响应又白烧 token。真想整篇塞进上下文，那还要检索干什么。

所以切块不是预处理杂活，它是 RAG 质量的第一道闸。往后看一步：切完之后，Embedding 的精度、检索的命中、生成的质量，上限全被今天这一刀定死了。切得稀碎，后面每一步都在缝碎片；切得太糊，后面每一步都在捞噪声。

## 核心知识

本节的代码可以逐段贴进任何 Python 3.9+ 环境运行，最终完整文件以下面的动手任务为准。

### 1. chunk_size 与 overlap：两个参数定生死

chunk_size 决定每块多大，是切块的头号参数。太小，比如 50 字，块里只剩半句话：「不支持 5G Wi-Fi」，哪个设备不支持？主语在上一块里。这叫上下文碎片，检索命中了也没法用。太大，比如 4000 字，一块塞三个主题，语义稀释又回来了。中文文档的经验起点是 300 到 800 字符，先取中间值，再按文档结构调。

overlap 是相邻块的重叠长度，专治边界割裂。关键句正好骑在切分点上就会被腰斩，看实际效果，每 20 字一刀：

```
红外夜视有效距离 10 米，全彩模
式下为 5 米。
```

「全彩模式」被劈成「全彩模」和「式」，两个块各自读起来都莫名其妙。带 overlap 的切块让块尾部的若干内容在下一块开头再出现一次，这句话至少有一个完整副本，检索至少有一次机会拿到完整的它。

为什么是 10-20%？重叠的本质是拿存储和 token 换边界安全。设到 50%，一半内容要存两遍，检索时同一片段还可能占掉 Top-K 结果里的两个坑位，等于自己给自己制造重复答案。10-20% 足以盖住绝大多数跨边界的句子，代价可控。经验值：chunk_size=500 时，overlap 取 50 到 100。

### 2. 三种切块策略

**固定长度切块**：每 N 个字符一刀，简单到三行代码：

```python
def fixed_chunk(text: str, chunk_size: int = 500) -> list[str]:
    """固定切块：按 chunk_size 硬切，不看内容。"""
    return [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)]
```

优点是快、块长均匀、实现零门槛。缺点你也看见了：句子腰斩、段落分家、语义边界全凭运气。它不是不能用，是只能用在「内容本身就是流水账」的场景。

**递归分隔切块**：先按最「粗」的分隔符切，切不下去或者切完还超长，再降级用细一级的分隔符，层级通常是：

```
\n\n（空行/段落） → \n（换行） → 。（句子） → ，（分句） → 空格（词）
```

直觉是：自然界写出来的文本，语义边界天然长成分级结构。段落边界最硬，句子边界次之，词边界最软。递归切块等于尽最大努力沿着最硬的边界下刀，只有实在没办法（整段没有任何分隔符）才退到硬切。它是目前工业界的默认选择，也是今天要手写的主角。

**语义切块**：把每个句子单独过一遍 Embedding，比较相邻句子的向量相似度，在相似度骤降的位置断开，那里往往就是话题切换点。效果最好，但每句一次 Embedding 调用，500 句的文档就是 500 次调用，成本和时间都上去了。先知道它存在，等检索质量真的卡在「话题切换处总是切碎」时再考虑，起步阶段递归切块够用。

### 3. 手写递归切块器：两段式设计

整个切块器拆成两半：`split_units` 负责把文本递归拆成语义单元，`chunk_text` 负责把单元带 overlap 地合并成块。先看拆的一半：

```python
SEPARATORS = ["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""]


def split_units(text: str, chunk_size: int, separators: list[str]) -> list[str]:
    """递归切分：能用大分隔符就不动用小分隔符，直到每段不超过 chunk_size。"""
    if len(text) <= chunk_size:
        return [text.strip()] if text.strip() else []
    sep, rest = separators[0], separators[1:]
    if sep == "":  # 一路降级到底还是超长，硬切兜底
        return [text[i:i + chunk_size] for i in range(0, len(text), chunk_size)]
    pieces = [p.strip() for p in text.split(sep) if p.strip()]
    if len(pieces) <= 1:  # 当前分隔符切不动，降级到下一级
        return split_units(text, chunk_size, rest)
    units: list[str] = []
    for piece in pieces:
        units.extend(split_units(piece, chunk_size, rest))
    return units
```

「递归」体现在两处。一是参数里的 `separators` 每层递归少一个：第一次用 `\n\n` 切出的每个段落，递归时只剩 `\n` 往后的层级可用。二是 `len(pieces) <= 1` 那行：文档里根本没有空行时，`\n\n` 一刀下去等于没切，原样带着下一级分隔符再进函数。最后兜底的 `""` 分隔符就是硬切，走到这一步说明这段文本铁板一块，只能认了。

再看合并的一半，overlap 就诞生在这里：

```python
def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:
    """切块入口：先拆成语义单元，再带 overlap 合并成块。"""
    units = split_units(text, chunk_size, SEPARATORS)
    chunks: list[str] = []
    current: list[str] = []
    length = 0
    for unit in units:
        if current and length + len(unit) > chunk_size:
            chunks.append("".join(current))
            keep = ""  # 从块尾回捞不超过 overlap 的内容，作为下一块的开头
            for u in reversed(current):
                if len(keep) + len(u) > overlap:
                    break
                keep = u + keep
            current, length = ([keep] if keep else []), len(keep)
        current.append(unit)
        length += len(unit)
    if current:
        chunks.append("".join(current))
    return chunks
```

逻辑是贪心：往当前块里塞单元，塞到装不下下一个就封口出货。封口之后，从尾部整单元地回捞，攒到 overlap 上限为止，捞到的内容作为下一块的起点。按整单元回捞而不是精确到 overlap 个字符，是为了不把好不容易保住的句子再切碎一次。一个副作用要心里有数：块长的真实上限约是 chunk_size + overlap，不是精确的 chunk_size。

## 动手任务：`chunker.py` 一步一步

手册任务：实现递归切块，对比固定切块的检索效果。拆成 5 步，全程约 30 分钟。

**第 1 步：建文件。** 在本周的练习目录新建 `chunker.py`，把核心知识里的 `SEPARATORS`、`split_units`、`chunk_text` 三段代码原样贴进去。贴完先别跑，此刻它还没有入口。

**第 2 步：加固定切块。** 同一个文件里补上对照组，参数和递归版保持一致，也让它支持 overlap，这样对比实验里唯一的变量才是「切法」本身：

```python
def fixed_chunk(text: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:
    """固定切块：每 chunk_size 字符一刀，每刀向前回退 overlap 字符。"""
    step = chunk_size - overlap
    slices = (text[i:i + chunk_size] for i in range(0, len(text), step))
    return [s for s in (x.strip() for x in slices) if s]
```

**第 3 步：准备样例并打印。** 写一段带标题、编号、问答的模拟产品文档贴进文件，然后跑起来直观看刀口落在哪：

```python
SAMPLE = """产品概述
星盾智能摄像头 S2 是一款面向家庭安防的无线摄像头，支持 1080P 夜视与双向语音对讲。
本产品适合客厅、门口、庭院等场景，不支持户外淋雨环境。

安装步骤
1. 扫描说明书二维码下载星盾 App，注册账号。
2. 摄像头接通电源，等待指示灯快闪。
3. 在 App 中选择「添加设备」，按提示输入家庭 Wi-Fi 密码。仅支持 2.4G Wi-Fi，不支持 5G Wi-Fi。

常见问题
问：忘记密码怎么办？
答：在登录页点击「忘记密码」，通过注册手机号重置。
问：存储方式有哪些？
答：支持 32G 至 256G 的 TF 卡本地存储，也支持云端订阅存储，免费版保留 7 天。
问：夜视距离多远？
答：红外夜视有效距离 10 米，全彩模式下为 5 米。"""

if __name__ == "__main__":
    for name, fn in [("固定切块", fixed_chunk), ("递归切块", chunk_text)]:
        chunks = fn(SAMPLE, chunk_size=120, overlap=20)
        print(f"\n===== {name}，共 {len(chunks)} 块 =====")
        for i, ch in enumerate(chunks):
            print(f"--- 块 {i}（{len(ch)} 字）---\n{ch}")
```

chunk_size 故意压到 120，是为了让两种切法的差距肉眼可见。

**第 4 步：跑起来，盯住两件事。** 执行 `python chunker.py`。一看固定切块的刀口：大概率有句子被劈在中间，关键词命中的段落断头断尾。二看递归切块的边界：每块以完整句子收尾，下一块的开头带着上一块结尾的只言片语，那 20 个字符的 overlap 正在干活。

**第 5 步：对比实验。** 切得好看不算数，检索说了才算。Day 4 才讲 Embedding，今天先用关键词命中数当检索替身：

```python
def naive_retrieve(keywords: list[str], chunks: list[str], top_k: int = 1):
    """检索替身：按关键词命中数排序，Day 6 换成真的向量检索。"""
    scored = [(sum(ch.count(kw) for kw in keywords), i) for i, ch in enumerate(chunks)]
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [(i, chunks[i]) for score, i in scored[:top_k] if score > 0]


QUESTIONS = [
    (["5G", "Wi-Fi"], "摄像头支持 5G Wi-Fi 吗？"),
    (["免费", "保留"], "免费版云端存储保留几天？"),
    (["夜视", "距离"], "夜视有效距离是多少？"),
]

if __name__ == "__main__":
    for name, fn in [("固定切块", fixed_chunk), ("递归切块", chunk_text)]:
        chunks = fn(SAMPLE, chunk_size=120, overlap=20)
        print(f"\n===== {name} =====")
        for kws, q in QUESTIONS:
            hits = naive_retrieve(kws, chunks)
            for i, ch in hits:
                print(f"[问] {q}\n[块 {i}] {ch}\n")
            if not hits:
                print(f"[问] {q}\n[未命中]\n")
```

判读标准只有一条：只看检索回来的这个块，能不能直接写出完整答案。拿张纸画三列表格，问题一行，固定切块的命中一行，递归切块的命中一行，各自标「能用」或「残缺」。固定切块常见的翻车方式是关键词命中了，答案的后半句却在隔壁块里。这张判分表收好，第 15 周 Day 5 做量化评估时，人工判分就换成命中率这类硬指标，今天的手工记录就是那时的基线。

顺手祛个魅，用 LangChain 校准一下：

```python
# pip install langchain-text-splitters
from langchain_text_splitters import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
    chunk_size=120,
    chunk_overlap=20,
    separators=["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""],
)
print(splitter.split_text(SAMPLE))
```

参数一个不差：chunk_size、chunk_overlap、separators，语义和你手写的完全一致，跑出来的块数和边界也大体吻合。它比你多出来的东西是工程细节，比如 `keep_separator` 可以保留句末标点（我们的 `split` 把「。」吃掉了），`length_function` 可以把计量单位换成 token。核心逻辑就是你今天写的那 40 行，框架不是魔法。

::: tip 运行命令
全程只需 `python chunker.py`，零第三方依赖；跑 LangChain 对照前先 `pip install langchain-text-splitters`。判分表拍张照或存成文本，跟 `chunker.py` 一起留档。
:::

## 常见踩坑

**坑 1：把字符当 token。** 我们手写版的 chunk_size 单位是字符，但 Embedding 的长度上限、LLM 的上下文窗口、API 账单全都按 token 计。一个汉字在不同 tokenizer 里大约折 0.5 到 1 个 token，英文一个单词大约 1 到 2 个 token。300-800 字符的经验值之所以靠谱，正是因为它落在多数场景的 token 安全区内。Day 4 拿到真 tokenizer 之后，回头把主力参数按 token 校准一遍。

**坑 2：overlap 越大越保险。** 不是。重叠是复制，50% 的重叠等于一半内容存两遍，向量库里同一个片段出现两次，检索 Top-5 时它可能独占两席，你花五块钱只买到四种信息。10-20% 是安全性和成本之间的甜点位，先从这里起步，确有边界割裂的证据再加。

**坑 3：切完就扔，不留出处。** 切块时每个块至少应该带上来源文件名和块号，往后还要加标题路径。今天偷懒不记，Day 5 入库时就拼不回去，检索回来的块不知道出自哪份文档哪个章节，答案没法引用溯源，用户问你「这结论哪来的」，你只能沉默。切块函数顺手返回 `(块文本, 块号)` 的元组列表，成本几乎为零。

**坑 4：分隔符照抄英文默认。** LangChain 的 `RecursiveCharacterTextSplitter` 默认分隔符列表里没有中文句号「。」，中文文档直接用默认值，句子边界这层保护等于没开，递归切块退化成按空格切。中文场景务必自己传 separators，把「。！？；」补进去，就像第 5 步那样。

**坑 5：一套参数打天下。** 300-800 字符是通用起点，不是真理。表格密集的文档按行切更自然，Markdown 文档应该按标题层级切（LangChain 的 MarkdownHeaderTextSplitter 干的就是这事），代码块无论多长都不该被从中间劈开。原则只有一条：有结构就用结构，没结构再退回长度。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 整篇文档直接做一次 Embedding 去检索，有哪两层问题？

::: details 参考答案
第一层是硬限制：Embedding 模型有输入 token 上限（如 text-embedding-3-small 为 8191），超长直接报错。第二层是软伤害：语义稀释，多主题长文压成一个向量后指向各主题的平均方向，检索时哪个问题都匹配不准。另外检索粒度等于可用粒度，整篇返回等于没有检索。
:::

2. overlap 设成 0 和设成 50% 各有什么代价？

::: details 参考答案
设 0 省了存储，但骑在切分边界上的关键句会被腰斩，两个块各拿半句，哪边都答不了题。设 50% 是用存储和 token 买重复，一半内容入库两遍，检索时同一片段可能占掉 Top-K 的多个位置，信息密度被稀释。10-20% 能盖住多数跨边界句子，代价可控。
:::

3. 递归切块的「回退」发生在什么时候？分隔符顺序为什么是从 `\n\n` 到空格？

::: details 参考答案
两种情况触发回退：当前分隔符在文本里找不到（切了等于没切），或切出的片段仍然超过 chunk_size，就带着剩余层级递归调用。顺序对应语义边界的硬度：段落边界最硬，换行次之，句子再次，词最软，最后的空字符串兜底硬切。先沿最硬的边界下刀，语义单元保持得越完整。
:::

4. 固定切块把句子腰斩，为什么伤害的是检索效果，而不只是看起来难看？

::: details 参考答案
被腰斩的块去 Embedding 时，向量代表的是半句话的语义，和完整问题的相似度天然打折扣；就算关键词命中排进了 Top-K，块里也只剩答案的前半句，凑不出完整回应，等于命中了但不可用。overlap 之所以存在，就是给边界句子留一个完整副本。
:::

5. 什么情况下值得从递归切块升级到语义切块？

::: details 参考答案
文档里话题切换频繁但没有清晰的段落或标点结构（比如访谈转写稿、无格式的长文），递归分隔符找不到着力点，切块总是把话题切断时。代价是每句一次 Embedding 调用，成本随文档长度线性上涨，先确认瓶颈真在切块，再上这个方案。
:::

## 延伸阅读

- [LangChain：Text Splitters 概念页](https://python.langchain.com/docs/concepts/text_splitters/)，官方对各种切块策略的总览，`RecursiveCharacterTextSplitter` 的原始出处，和本篇对照着读
- [OpenAI：Embeddings 指南](https://platform.openai.com/docs/guides/embeddings)，模型输入 token 上限的一手数据，Day 4 之前值得通读
- [Pinecone：Chunking Strategies](https://www.pinecone.io/learn/chunking-strategies/)，把固定、递归、语义等策略的取舍讲得很系统的长文，适合周末补课

对照[本周日程](/week14/)，明天 Day 4 把今天切好的块喂给 Embedding API。`chunker.py` 和那张判分表留好，第 15 周 Day 5 做量化评估时，它们就是你的基线数据。
