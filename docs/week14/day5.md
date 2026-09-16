# 第 14 周 · Day 5：pgvector 向量存储——用现成的 PostgreSQL 存向量

> 对应手册任务：学习「pgvector 安装 + 向量存储」，动手「在 PostgreSQL 中启用 pgvector 扩展，创建 documents 表存向量」，当日产出「pgvector 就绪」。本篇只解决一个问题：Day 4 的 Embedding 脚本能把切块变成 1536 维向量，可脚本一跑完，向量跟着内存一起没了——今天给它们找个长住的家。家不用新买：第 4 周就用 Docker Compose 跑起来的那台 PostgreSQL，装上 pgvector 扩展，向量、正文、出处一起存进去。

## 今日目标

1. 说得清 pgvector 是什么：不是一款新数据库，是 PG 的扩展——SQL 里多出一种 `vector` 类型和三个距离运算符
2. 会换镜像、会建表：`pgvector/pgvector` 替换 `postgres` 镜像，`CREATE EXTENSION` 激活扩展，建好带 `VECTOR(1536)` 列的 `documents` 表
3. 独立完成 `store.py`：切块 → Embedding → 批量 INSERT 入库，并在 psql 里亲手算一次余弦距离

## 概念讲解：为什么是 pgvector，不是独立向量库

昨天（Day 4）脚本跑完，屏幕上打印过一串 1536 个浮点数，然后进程退出，什么都没剩下。RAG 是「先存后查」的两幕戏，检索发生在提问那一刻，向量必须提前躺在某个地方等着。躺哪？

第一反应可能是去装一个向量数据库：Milvus、Qdrant、Weaviate，名字一个比一个响。它们当然能用，但先数数代价：每个新组件意味着新的部署、新的监控、新的备份策略，学习期每一样都得从头踩一遍。而你手里已经有一台跑得好好的 PostgreSQL——第 4 周起的，有数据卷、有账号，你写过 SQL，第 10 周还用 SQLAlchemy 连过它。

向量是一长串浮点数，普通列存不了，这正是 pgvector 存在的理由。它是 PG 的开源扩展（extension），走 PG 的插件机制：装上之后数据库多认识一种 `vector` 类型，SQL 里多出三个算距离的运算符。就这么多。没有新服务、新端口、新协议，你的业务数据和向量住在同一个库里。

同一个库，这才是重点，因为它带来三件专用向量库很难凑齐的事。一是事务：写业务数据和写向量要么一起成功要么一起回滚，PG 一句 `BEGIN` 就保证。二是元数据 JOIN：检索结果要关联权限表、按来源过滤，这是 SQL 的老本行；Day 2 存的 `source`/`page` 进了 `metadata` 字段后，`WHERE metadata->>'source' = 'report.pdf'` 随手就写，第 15 周的引用溯源靠的就是它。三是少一个组件：能守住一台数据库的运维，就别同时守两台。

代价也说清楚：论极限性能和超大规模，专用向量库更强。但学习期到中小生产，几万到百万级切块，pgvector 完全扛得住。真到亿级再换不迟，而那时你已经用 SQL 把向量检索的思维方式练熟了。

## 核心知识

本节代码围绕四个动作展开：认类型、换镜像、建表、选距离运算符。完整可运行的脚本以下面的动手任务为准。

### 1. pgvector 是什么：一种类型，三个运算符

先看它长什么样，psql 里两句 SQL：

```sql
SELECT '[1, 0]'::vector <=> '[1, 1]'::vector;  -- 0.29289322，余弦距离
SELECT '[1, 0]'::vector <-> '[2, 0]'::vector;  -- 1，欧氏距离
```

普通 SQL 里出现了向量字面量和距离计算，这就是 pgvector 的全部魔法。`vector` 类型本质是浮点数数组，可以定死维度如 `vector(1536)`；三个运算符 `<->`、`<#>`、`<=>` 分别算欧氏距离、负内积、余弦距离，能直接写进 `WHERE` 和 `ORDER BY`。选哪个第 4 小节细说。

PG 的扩展机制值得记一笔：扩展是按约定打包的 SQL 脚本加动态库，`CREATE EXTENSION vector;` 一句话激活，且是库级别的——每个数据库要执行一次。记不住没关系，踩坑 3 会再提醒你。

### 2. 安装：compose 里改一行镜像

pgvector 的安装方式列出来有一页纸，Windows、macOS、源码编译各有各的走法。既然第 4 周的 PG 是 Compose 起的，最省事的路只有一行：把镜像从官方 `postgres` 换成 `pgvector/pgvector`——它就是在官方镜像上多编译了一个 pgvector，其余分毫未动：

```yaml
services:
  db:
    image: pgvector/pgvector:pg16   # 原来是 postgres:16，只改这一行
    environment:
      POSTGRES_PASSWORD: devpass    # 沿用第 4 周的账号密码
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

`docker compose up -d` 重新起容器。数据在 `pgdata` 卷里，换镜像不丢；镜像里多了扩展文件，但扩展还没激活——软件装进了硬盘，还没运行，激活是下一步的事。

### 3. documents 表：四个字段各司其职

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id        BIGSERIAL PRIMARY KEY,
  content   TEXT NOT NULL,
  embedding VECTOR(1536) NOT NULL,
  metadata  JSONB NOT NULL DEFAULT '{}'
);
```

逐个说。`content` 存切块原文，检索命中后喂给 LLM 的就是它。`embedding` 是主角，`VECTOR(1536)` 把维度定死：1536 必须等于 Day 4 用的模型输出维度（text-embedding-3-small），插进来一个 3072 维的向量，PG 直接报错拒收。这个报错是保护不是麻烦——维度对不上的向量算距离毫无意义，与其入库后算出鬼结果，不如进门就拦住。

`metadata` 用 JSONB 存 Day 2 攒下的 `source`/`page`/`section`。为什么是 JSONB 而不是 TEXT 存个 JSON 字符串？JSONB 是二进制化、可查询的：`metadata->>'page'` 能取值、能建索引、能进 WHERE。第 15 周答案要标「来源：report.pdf 第 3 页」，地基就是这一列。为什么不干脆拆成三个普通列？也行，但「每加一种文档就加一列」的表很快会失控，JSONB 让元数据自由生长，查询能力一点不少。

### 4. 三个距离运算符，认准 `<=>`

| 运算符 | 算什么 | 越相似时 |
| --- | --- | --- |
| `<->` | 欧氏距离（L2） | 值越小（0 表示重合） |
| `<#>` | 负内积 | 值越小（负得越多） |
| `<=>` | 余弦距离（1 - 余弦相似度） | 值越小（0 表示方向一致） |

三个都是真运算符，但 RAG 的默认答案是 `<=>`，理由有两层。第一，语义相似度比的是方向不是长度：两段话意思相近，向量指向就相近，至于向量本身多「长」，是训练的副产物，不代表相似。`[1, 0]` 和 `[2, 0]` 用 `<->` 算距离是 1，用 `<=>` 算是 0——后者才是「方向完全一致」这个事实的诚实表达。第二，OpenAI 等主流模型的输出向量已经归一化（模长为 1），归一化后欧氏距离和余弦距离的排序完全等价，选哪个都不亏；可一旦哪天混进未归一化的向量，`<=>` 依旧稳。既然等价时无所谓、不等价时它更稳，就统一用 `<=>`。

明天的检索说穿了就是一句 SQL：

```sql
SELECT content, metadata,
       embedding <=> '[问题向量]'::vector AS distance
FROM documents
ORDER BY embedding <=> '[问题向量]'::vector
LIMIT 5;
```

`ORDER BY` 加 `LIMIT`，向量检索和普通查询长得一模一样，这是 pgvector 最大的友好。

### 5. 索引：什么时候才需要

一句话版本：数据量小先不建，百万级再上。不建索引时，`ORDER BY embedding <=> ...` 是全表顺序扫描，万级数据毫秒级出结果，学习期碰不到瓶颈。数据上到百万级，再建 HNSW 索引（`CREATE INDEX ON documents USING hnsw (embedding vector_cosine_ops);`），查询快百倍但结果变近似；IVFFlat 则建得快、查得略慢。名词今天混个脸熟就够，真到那天再回来查手册。

### 6. SQLAlchemy：Vector 列类型接回第 10 周的 ORM

第 10 周的 SQLAlchemy 在这里归队。pgvector 的 Python 包里带了专门的列类型：

```python
from sqlalchemy import Column, BigInteger, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import declarative_base
from pgvector.sqlalchemy import Vector

Base = declarative_base()

class Document(Base):
    __tablename__ = "documents"

    id = Column(BigInteger, primary_key=True, autoincrement=True)
    content = Column(Text, nullable=False)
    embedding = Column(Vector(1536), nullable=False)
    metadata_ = Column("metadata", JSONB, nullable=False, default=dict)
```

两处关键。`Vector(1536)` 让 ORM 层就知道维度，传错长度的列表在 Python 侧先被拦一道。`metadata_` 带下划线是故意的：`metadata` 在 SQLAlchemy 声明式基类里是保留属性（存表注册信息），直接用会报错，所以 Python 属性叫 `metadata_`，`Column("metadata", JSONB)` 的第一个参数把真实列名定回 `metadata`——SQL 里还是那张表，一个字不用改。

表已经手工建好，ORM 只负责映射；想让 ORM 建表也行，`Base.metadata.create_all(engine)` 效果等价，只有 `CREATE EXTENSION` 必须手工执行。

## 动手任务：`store.py` 一步一步

手册任务：启用 pgvector 扩展，建 `documents` 表，把向量写进去。拆成 5 步，全程约 30 分钟。

**第 1 步：换镜像，起容器。** 把第 4 周的 compose 文件按第 2 小节的样式改掉镜像那一行，`docker compose up -d`，`docker ps` 确认容器健康。

**第 2 步：启用扩展，建表。** 进 psql：

```
docker exec -it <容器名> psql -U postgres
```

依次执行第 3 小节的两条 SQL，然后跑一句验收：

```sql
SELECT '[1, 0]'::vector <=> '[1, 1]'::vector;
```

返回 `0.29289322...`（即 1 - 1/√2）就说明扩展活着，`vector` 类型和 `<=>` 运算符都已就位。

**第 3 步：装依赖，写模型。** 练习目录执行 `pip install sqlalchemy psycopg2-binary pgvector openai`，新建 `models.py`，把第 6 小节的 `Document` 抄进去。

**第 4 步：写 `store.py`：切块 → Embedding → 批量 INSERT。** 新建 `store.py`：

```python
from openai import OpenAI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from models import Document

client = OpenAI()  # 读环境变量 OPENAI_API_KEY，Day 4 就配好了
engine = create_engine("postgresql://postgres:devpass@localhost:5432/postgres")
Session = sessionmaker(engine)

EMBED_MODEL = "text-embedding-3-small"  # 1536 维，和表里的 VECTOR(1536) 对齐

def embed(texts: list[str]) -> list[list[float]]:
    """Day 4 的 Embedding 调用，原样复用"""
    resp = client.embeddings.create(model=EMBED_MODEL, input=texts)
    return [item.embedding for item in resp.data]

def store(chunks: list[dict]) -> int:
    """
    chunks: [{"text": ..., "source": ..., "page": ..., "section": ...}, ...]
    上游接 Day 2 的 ParsedDocument 加 Day 3 的切块，字段对得上就接得上
    """
    written = 0
    with Session() as session:
        for i in range(0, len(chunks), 100):  # 一批 100 条，稳且好观察进度
            batch = chunks[i:i + 100]
            vectors = embed([c["text"] for c in batch])
            session.add_all([
                Document(
                    content=c["text"],
                    embedding=v,
                    metadata_={"source": c["source"], "page": c["page"],
                               "section": c.get("section", "正文")},
                )
                for c, v in zip(batch, vectors)
            ])
            session.commit()
            written += len(batch)
            print(f"已写入 {written}/{len(chunks)}")
    return written

if __name__ == "__main__":
    # 先用三条样例打通全链路；接上 Day 3 的切块输出后，把这里换成真数据
    sample = [
        {"text": "RAG 通过检索外部知识缓解幻觉。", "source": "demo.md", "page": 1, "section": "引言"},
        {"text": "切块大小直接影响检索召回率。", "source": "demo.md", "page": 1, "section": "方法"},
        {"text": "余弦距离衡量向量方向的一致性。", "source": "demo.md", "page": 2, "section": "方法"},
    ]
    store(sample)
```

关键在 `store()` 的三拍节奏：切块攒一批，一次 API 拿一批向量，`add_all` 之后 `commit`。分批不是矫情：Embedding 按条计费，一口气塞几千条，慢且难排查是哪批失败的。`metadata_` 带下划线是第 6 小节说好的约定，值里装的就是 Day 2 的三个字段。

**第 5 步：SQL 验收。** `python store.py` 跑完后回到 psql：

```sql
SELECT COUNT(*) FROM documents;                        -- 3
SELECT DISTINCT vector_dims(embedding) FROM documents; -- 只有一行：1536
SELECT left(content, 40) AS content, metadata FROM documents LIMIT 3;
```

`vector_dims` 是 pgvector 送的函数，返回向量维度。最后来一次今天最有仪式感的操作——不写 1536 个数字，拿 id=1 自己的向量当查询，看它和全表算余弦距离：

```sql
SELECT id, left(content, 30) AS content,
       embedding <=> (SELECT embedding FROM documents WHERE id = 1) AS distance
FROM documents
ORDER BY distance
LIMIT 5;
```

排第一的一定是 id=1 自己，distance 是 0——明天的 Top-K 检索，雏形就是这条 SQL。

::: tip 连接串
`postgresql://postgres:devpass@localhost:5432/postgres` 里的密码和库名按第 4 周的实际配置改。psql 进不去就先 `docker logs <容器名>`，看初始化是否完成。
:::

## 常见踩坑

**坑 1：维度不匹配，进门就被拦。** 表是 `VECTOR(1536)`，来的向量是 3072 维（比如换了 text-embedding-3-large），PG 报错 `expected 1536 dimensions, not 3072`。这不是 bug 是护栏。换模型必须连带换表：新维度建新列或新表，老向量重算重灌——维度不同的向量混在一张表里没有意义。

**坑 2：ORM 里直接写 `metadata` 列。** SQLAlchemy 声明式基类的 `metadata` 是保留属性，`metadata = Column(...)` 会得到 `Attribute name 'metadata' is reserved` 的报错。解法就是第 6 小节的写法：属性名带下划线，列名用 `Column("metadata", JSONB)` 定回去。LangChain 的 pgvector 集成把这个列叫 `cmetadata`，也是同一个坑逼出来的。

**坑 3：装了镜像，忘了 `CREATE EXTENSION`。** 换镜像只是把扩展文件放进了容器，`vector` 类型还要在每个数据库里用 `CREATE EXTENSION vector;` 逐个激活。漏了这步，建表时撞上 `type "vector" does not exist`，一脸懵。记住：装（镜像）和激活（扩展）是两步，缺一不可。

**坑 4：三个运算符混着用。** `<->` 和 `<=>` 的数值尺度不同，未归一化时排出的顺序可能不同；`<#>` 名字里带「负」是有原因的：PG 的索引扫描只支持升序，给内积加个负号，「越相似排越前」才在升序下成立。不看文档容易把它当正内积，拿去当相似度分数展示，得到的是一堆负数。选定 `<=>` 一以贯之，中途换运算符等于换相似度定义，历史排序会悄悄变。

**坑 5：脚本重跑，数据翻倍。** `store.py` 跑一次插一批，再跑一次再插一批，重复切块会把检索结果污染成复读机。入库前先清旧：`DELETE FROM documents WHERE metadata->>'source' = 'demo.md';`。把这行写进脚本开头，脚本才是幂等的——跑多少遍，库里都是同一份数据。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. pgvector 和独立向量数据库的本质区别是什么？什么信号出现时才该考虑换独立库？

::: details 参考答案
pgvector 是 PG 的扩展，给 SQL 增加一种 `vector` 类型和三个距离运算符，不是新的数据库服务；数据和向量同库，事务、元数据过滤、JOIN 都是现成的 SQL 能力，还少维护一个组件。当数据量到亿级、或高并发纯检索场景把 PG 压到扛不住时，再评估专用库；学习期到百万级切块都不需要。
:::

2. `<->`、`<#>`、`<=>` 分别算什么？RAG 为什么默认 `<=>`？

::: details 参考答案
欧氏距离、负内积、余弦距离（1 - 余弦相似度）。模型输出归一化后，欧氏和余弦的排序等价；但语义相似度本质比方向，`<=>` 只看方向，即使混入未归一化向量也不受影响。等价时选哪个都行、不等价时 `<=>` 更稳，所以统一用它。
:::

3. `documents` 表四个字段各自解决什么问题？`metadata` 为什么用 JSONB 而不是 TEXT？

::: details 参考答案
`content` 是命中后喂给 LLM 的原文，`embedding` 承担检索，`metadata` 存 Day 2 的 `source`/`page`/`section` 做溯源和过滤，`id` 是主键。JSONB 二进制化、可查询：`->>'source'` 取值、建索引、进 WHERE 都行；TEXT 存 JSON 只能整串读出来在应用层解析。
:::

4. 已经换成 `pgvector/pgvector` 镜像了，为什么还报 `type "vector" does not exist`？

::: details 参考答案
镜像只负责把扩展文件装进容器，扩展是库级别概念，要在每个用它的数据库里执行 `CREATE EXTENSION vector;` 激活。装和激活是两步；激活一次，该库内终身有效。
:::

5. 现在不建 HNSW 索引，检索会出什么问题？建了索引结果会更好吗？

::: details 参考答案
不会出问题，只是慢：无索引时 `ORDER BY embedding <=> ...` 走全表顺序扫描，万级数据毫秒级。建 HNSW 后查询快百倍，但结果是近似的——索引买的是速度不是精度，数据量小的时候连速度都不需要买。
:::

## 延伸阅读

- [pgvector GitHub](https://github.com/pgvector/pgvector)，README 就是官方文档：安装方式、SQL 用法、索引类型、各语言客户端入口，本篇所有知识点的原始出处
- [pgvector 的 PyPI 页面](https://pypi.org/project/pgvector/)，`pgvector.sqlalchemy` 的 `Vector` 列类型和查询封装示例都在这里，第 6 小节的原始出处
- [PostgreSQL 文档：Extensions](https://www.postgresql.org/docs/current/extend-extensions.html)，扩展机制的官方说明，读懂 `CREATE EXTENSION` 背后发生了什么，坑 3 就不会再踩

今天的产出 `models.py` 和 `store.py` 留好。明天（见[本周日程](/week14/)）做相似度检索：把用户的问题变成向量，`ORDER BY embedding <=> $1 LIMIT 5`——今天建好的表和选定的运算符，就是明天检索函数的全部地基。
