# 第 21 周 · Day 1：LLM 可观测性——让每一次调用都看得见

> 对应手册任务：学习「LangSmith Tracing 接入 + OTel GenAI 规范与 Langfuse 开源替代」，动手「配置 LANGCHAIN_TRACING_V2 查看 Trace 树；再用 Docker 自托管一个 Langfuse，对比两者数据模型」，产出「Trace 可视化」。本篇只解决一个问题：Agent 答错、超时、烧钱的时候，你能打开一个页面，看清这一次回答背后每一步 LLM 调用和工具执行的输入、输出、耗时与花销，而不是对着日志盲调。

## 今日目标

1. 说得清 Agent 为什么必须有 tracing：一次回答十几步调用，普通日志为什么救不了你
2. 掌握 LangSmith 三个环境变量的零代码接入，能逐层读懂 Trace 树；再用 Docker 自托管一个 Langfuse 并跑通接入
3. 能对比两者的数据模型，说得出 OTel GenAI 规范「埋点一次，后端随意换」的架构意义

## 概念讲解：为什么 Agent 必须做 tracing

先看一个再熟悉不过的场景。Agent 上线第三天，用户反馈：问「帮我查一下订单 A-001 发没发货」，Agent 答非所问，还等了 40 秒。你登上服务器 grep 日志，然后发现根本没法查。

普通 Web 应用好排查，因为一次请求是一条直线：进来一个 request id，从 controller 穿到 service 再穿到数据库，日志按 id 一过滤，整条链路都在。一次请求干了什么，几行日志说得清。

Agent 的一次回答不是直线，是一棵不停分叉的树。用户那句话进去，agent 节点先调一次 LLM，让它决定「要不要用工具、用哪个」；LLM 说要查订单，于是执行 `order_query`；查出来的 JSON 喂回 LLM；LLM 看完决定再查物流；又执行、又喂回……用户感觉只是问了一句，机器内部一次回答 15 次调用：5 次 LLM、6 次工具、4 次中间组装。这时候靠日志，有三宗罪。

第一宗，串不起来。15 条日志平铺在时间线里，谁是谁的下一步、这次工具返回喂给了哪次 LLM，日志自己不会说。想串起来就得在每条日志里手埋 trace_id 和 parent_id，自己写组装逻辑，大多数人坚持不过三天。

第二宗，内容没法打。LLM 一次调用的输入是完整 messages 数组，工具的返回是嵌套 JSON，一条几百 KB 很正常。全量打，日志盘两天就爆；截断打，丢掉的恰恰是「LLM 到底看到了什么」这个最关键的信息。而排查 Agent 问题，十有八九要看的就是它。

第三宗，没有账。这次回答烧了多少 token、哪个模型花了多少钱、哪一步耗了 30 秒，这些是结构化数据，printf 打不出来。别忘了第 16 周讲评估时的那句话：评估数据从哪来？很大一部分就来自线上 trace 的日积月累。没有 trace，评估集只能手编，手编的评估集测不出真问题。

tracing 做的事一句话讲完：把一次请求从头到尾的所有事件，记成一棵树。树根是这次 invoke，每次 LLM 调用、每次工具执行是树上的节点，节点上挂着完整输入输出、耗时、token、费用。出问题打开 UI，整棵树摊开，哪一步出的事一目了然。这不是 LLM 圈的新发明，分布式系统里这叫 distributed tracing，OpenTelemetry 已经干了十几年；LLM 可观测性做的事，是把「一次 LLM 调用」也标准化成这棵树上的节点。

## 核心知识

### 1. LangSmith 接入：三个环境变量，零代码

LangSmith 是 LangChain 官方的可观测性平台，接入方式简单到离谱。去 smith.langchain.com 注册，生成 API 密钥，然后在终端里配三个环境变量：

```bash
export LANGCHAIN_TRACING_V2=true
export LANGCHAIN_API_KEY=lsv2_pt_你的密钥
export LANGCHAIN_PROJECT=my-first-agent
```

之后什么都不用改。原来怎么跑 LangChain / LangGraph 代码，现在还怎么跑：

```python
# pip install langchain-openai langgraph
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent

@tool
def add(a: int, b: int) -> int:
    """两数相加"""
    return a + b

llm = ChatOpenAI(model="gpt-4o-mini")
agent = create_react_agent(llm, [add])

result = agent.invoke(
    {"messages": [("user", "3 加 5 等于几？把结果再乘 2 告诉我")]},
)
print(result["messages"][-1].content)
```

跑完去 LangSmith 控制台，项目下多了一条 trace。关键在那三个环境变量：LangChain 的 Runnable 体系在执行时检查它们，发现 `LANGCHAIN_TRACING_V2=true` 就把每一步自动上报，一行埋点代码都不用写。JS 项目同样吃这三个变量，langchain.js 的行为一致。国内直连 OpenAI 不通的话，再补一个 `OPENAI_BASE_URL` 指向你的中转。

Trace 树怎么读。点开这条 trace，你会看到这样的层级：

```text
agent（graph 运行，总耗时 4.2s）
├── agent 节点：调 LLM 决定下一步
│   └── ChatOpenAI（gpt-4o-mini，1.8s，356 入 / 42 出 tokens，$0.0002）
│       输入：完整 messages（system + user）
│       输出：tool_calls → add(a=3, b=5)
├── tools 节点：执行工具
│   └── add（0.1s）
│       输入：{"a": 3, "b": 5}
│       输出：8
├── agent 节点：拿工具结果再调 LLM
│   └── ChatOpenAI（gpt-4o-mini，2.1s，……）
│       输出：最终回答「3 加 5 等于 8，再乘 2 是 16」
└── ……
```

每一层看什么：

- 树根（graph / chain）：这次 invoke 的总耗时、用户问题、最终输出。判断「慢不慢、对不对」先看这层定调
- LLM 节点：信息最厚的一层。完整 prompt（模型到底看到了什么）、完整回复、模型名、输入输出 token、估算费用、耗时。答错了基本都要来这层看 prompt
- 工具节点：工具名、入参 JSON、返回值、耗时、有没有抛异常。工具返回了脏数据，一眼现形

排查的顺序也从树来：总耗时高，逐层展开找最慢的那个节点；答案错，定位到出错环节的 LLM 节点看输入（问题往往出在上一步工具的返回里）；费用高，按节点把 token 加起来看谁在吃量。

### 2. 国内现实：LangSmith 的墙与顾虑，Langfuse 自托管

LangSmith 有两个绕不开的现实问题。一是访问不稳，langsmith.com 国内时通时不通，控制台加载全看运气。二是数据出境：每条 trace 里都有用户的原始问题、工具返回的业务数据，全部上报到境外服务器。个人学习无所谓，公司项目这一条直接一票否决。

所以要看 Langfuse：MIT 协议开源的 LLM 可观测性平台，功能与 LangSmith 同档，数据模型基本同构，可以整个部署在自己机器上。第 7 周练的 docker compose 功力今天派上用场：

```bash
git clone https://github.com/langfuse/langfuse.git
cd langfuse
docker compose up --wait
```

仓库根目录的 docker-compose.yml 会把全家桶拉齐：Langfuse 应用（web + worker）、PostgreSQL、ClickHouse（存 trace 明细）、Redis、MinIO。`--wait` 会等所有服务健康检查通过。起来之后浏览器打开 http://localhost:3000，注册账号，建一个组织、一个项目，在项目设置里创建 API Keys，拿到一对密钥：`pk-lf-` 开头的公钥和 `sk-lf-` 开头的私钥。

接入用 CallbackHandler，三个环境变量加一处 config：

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-你的公钥
export LANGFUSE_SECRET_KEY=sk-lf-你的私钥
export LANGFUSE_HOST=http://localhost:3000
```

```python
# pip install langfuse
from langfuse.langchain import CallbackHandler

handler = CallbackHandler()  # 自动读上面三个环境变量

result = agent.invoke(
    {"messages": [("user", "3 加 5 等于几？把结果再乘 2 告诉我")]},
    config={"callbacks": [handler]},
)
```

跑完打开 Langfuse 的 Traces 页，同一条 agent 树长在了你自己的服务器上。两边对照着看：

| 维度 | LangSmith | Langfuse（自托管） |
| --- | --- | --- |
| 数据模型 | trace → runs 树（llm / tool / chain run） | trace → observations 树（span / generation / event），基本同构 |
| 埋点方式 | 环境变量，零代码 | CallbackHandler 一行，或 OTLP 直发 |
| 数据存放 | LangSmith 云 | 你的机器，不出域 |
| 费用 | 免费额度后按用量计费 | 软件免费，付机器和运维的钱 |
| 附加能力 | 评估、数据集、提示词管理一体 | 社区版也有评估、数据集、提示词，够个人和小团队用 |

「基本同构」值得展开一句。两边都是「一次请求一棵树，树上是分层节点」，差别只在叫法：LangSmith 把节点统称 run；Langfuse 统称 observation，再细分三种——span 是通用步骤，generation 专指 LLM 调用（带 model、token、cost 字段），event 是没有时长的时间点。你在一边学会了读 Trace 树，换到另一边立刻就会读，概念迁移成本接近零。

### 3. OTel GenAI 规范：埋点一次，后端随意换

上面两套平台有个共同的隐患：埋点和平台绑死。LangSmith 靠自家 SDK 上报，Langfuse 的 CallbackHandler 也一样。哪天想换后端，或者公司本来就有统一观测体系（Jaeger、Grafana 那套），埋点代码就得推倒重来。

OpenTelemetry（OTel）就是来解决这个的。它是 CNCF 的可观测性标准：trace、metric、log 三种数据，一套 SDK，一套传输协议（OTLP）。代码里用 OTel SDK 埋点，数据最终发到哪个后端，只取决于 exporter 配的一个 URL。

LLM 场景还差一块拼图：一次 LLM 调用该记哪些字段？模型名、token 数、温度……各家 SDK 各自定义，很乱。OTel 社区在推 GenAI 语义约定（semantic conventions），统一用 `gen_ai.*` 前缀描述：

```text
gen_ai.system.name         = openai        # 哪家的系统
gen_ai.request.model       = gpt-4o-mini   # 请求的模型
gen_ai.usage.input_tokens  = 356           # 输入 token
gen_ai.usage.output_tokens = 42            # 输出 token
```

两个要点。第一，这套约定目前还是开发态（development），字段名仍可能调整，别当稳定 API 硬依赖；但方向没有悬念，OpenAI、LangChain、Langfuse、各大 APM 厂商都在向它靠。第二，Langfuse 原生吃 OTLP：自托管实例自带一个 OTLP 端点（`http://localhost:3000/api/public/otel`），任何按 OTel 规范发出的 trace 都直接收，不用装适配器。

这两件事加起来的架构意义就一句话：埋点一次，后端随意换。你按 OTel 标准埋好 LLM 调用，今天发 Langfuse，明天公司统一观测平台，改一个 endpoint 就迁走，业务代码一行不动。以后评估任何观测平台，「是否原生支持 OTLP」应该排在功能清单第一行。

## 动手任务：两条链路各跑一遍

手册任务：配置 LANGCHAIN_TRACING_V2 在 LangSmith 看到 Trace 树，再 Docker 自托管 Langfuse 跑同一条 Trace，对比两者数据模型。拆成 5 步，全程约 40 分钟（不含拉镜像）。

**第 1 步：注册 LangSmith 拿密钥。** 打开 smith.langchain.com 注册，在 Settings → API Keys 生成一个 `lsv2_pt_` 开头的密钥，再新建项目 `my-first-agent`。这步只需要浏览器。访问不畅就先跳到第 3 步，Langfuse 不依赖 LangSmith。

**第 2 步：跑最小 agent，读 Trace 树。** 终端里配好三个 `LANGCHAIN_*` 变量加 `OPENAI_API_KEY`，把「核心知识 1」的代码存成 `trace_demo.py` 跑一次。然后打开 LangSmith 点开这条 trace，把三样东西记进备忘录：总耗时、两次 LLM 调用各自的 token 数、add 节点的入参出参。第 5 步要拿 Langfuse 对比。

**第 3 步：docker compose 起 Langfuse。** 确认 Docker 在跑，执行上面那段 `git clone` 三连。`docker compose ps` 确认全部 healthy 后，打开 http://localhost:3000 注册，建组织、建项目，创建 API Keys 记下 `pk-lf-` / `sk-lf-` 一对密钥。

**第 4 步：同一个问题再跑一次，这次进 Langfuse。** 配好三个 `LANGFUSE_*` 变量，代码里加 handler（记得 `pip install langfuse`），invoke 同样的问题。刷新 Langfuse 的 Traces 页，这棵树现在长在你自己的机器上。

**第 5 步：两边对照，写下三行结论。** 各点开一条 trace，逐项回答：树的根节点各叫什么（run 与 trace/observation）；LLM 节点各叫什么、token 和费用字段长在哪；工具节点怎么展示入参出参。三行结论加两张 Trace 树截图，就是今天「Trace 可视化」的产出。以后任何新平台到手，先问这三个问题，五分钟摸清它的数据模型。

::: tip 镜像拉取慢？
Langfuse 全家桶镜像不小，国内网络第一次拉要有耐心。给 Docker 配好镜像加速，或者挑晚上拉。第 7 周的老办法今天全能用上。
:::

## 常见踩坑

**坑 1：环境变量配了没生效。** 最高频翻车：变量 export 在 A 终端，代码跑在 B 终端，或者 IDE 的运行配置没继承环境。症状是代码跑完，控制台空空如也。在代码里加一行 `print(os.environ.get("LANGCHAIN_TRACING_V2"))`，None 就是没进进程。另外 `.env` 文件不会自动读，要么 export，要么用 python-dotenv 显式 `load_dotenv()`。

**坑 2：一条命令把数据清光。** `docker compose down -v` 会连卷一起删，攒了一周的 trace 瞬间归零。练习库想保数据，用 `docker compose stop` 或不带 `-v` 的 `down`，`-v` 只在想彻底重置时才碰。

**坑 3：把 trace 当日志无限期攒。** 一条 trace 几百 KB 很正常，测试期一天几百条没事，上线后量级一起来，ClickHouse 和 MinIO 都会涨。在平台里配好 retention（保留天数），做评估 30 天绰绰有余，别默认永久保存。

**坑 4：只看总耗时，不展开 LLM 节点的 prompt。** 树根告诉你慢，但答案在叶子。一个高频真实 bug：工具返回了超长内容，下一轮 LLM 输入 token 暴涨，又慢又贵。这种问题只有展开 LLM 节点看它的输入 messages 才能发现。习惯定死：先树根定位，再叶子取证。

**坑 5：在生产代码里手写 gen_ai.* 字段。** 语义约定还在 development 阶段，字段名说改就改。把 `gen_ai` 属性的组装收拢到一个模块，或者直接用现成的 OTel exporter，别在业务代码里到处手写，升级时你会感谢这个决定。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. Agent 的一次回答靠日志为什么排查不动？说出至少两个结构性原因。

::: details 参考答案
一是调用多且嵌套：一次回答十几步 LLM / 工具调用，日志是平铺的，没有父子关系，串不起来；二是单条数据大：完整 messages 和嵌套 JSON 动辄几百 KB，全打爆盘、截断丢关键信息；三是缺结构化账本：token、费用、每步耗时 printf 打不出来，而评估恰恰依赖这些数据。
:::

2. LangSmith 零代码接入靠哪三个环境变量？原理是什么？

::: details 参考答案
`LANGCHAIN_TRACING_V2=true`、`LANGCHAIN_API_KEY`、`LANGCHAIN_PROJECT`。原理是 LangChain 的 Runnable 体系在运行时检查这些变量，开启后自动把每一步执行上报 LangSmith，业务代码一行不改。
:::

3. Trace 树里 LLM 节点和工具节点各能看什么？排查「答案错了」先看哪里？

::: details 参考答案
LLM 节点：完整输入 messages、输出（文本或 tool_calls）、模型名、token 数、费用、耗时。工具节点：工具名、入参、返回值、耗时、异常。答案错先找出错环节的 LLM 节点看它的输入——错误经常不在 LLM，而在它上一步收到的工具返回。
:::

4. Langfuse 自托管相比 LangSmith，换到了什么、付出了什么？什么场景必须选它？

::: details 参考答案
换到数据不出域（用户问题和业务数据留在自己机器）和软件零授权费；付出的是自己维护全家桶、升级备份自己扛。涉及用户隐私、商业敏感数据或有数据出境合规要求的场景，基本必须自托管。
:::

5. 「埋点一次，后端随意换」靠什么实现？`gen_ai.*` 现在能放心硬依赖吗？

::: details 参考答案
靠 OpenTelemetry：代码用 OTel SDK 按语义约定埋点，数据走 OTLP 协议，换后端只改 exporter 的 endpoint，比如 Langfuse 原生收 OTLP，今天发它明天迁别家都不动埋点。`gen_ai.*` 目前是开发态规范，字段仍可能变，不能当稳定 API，属性组装要收口到一处。
:::

## 延伸阅读

- [LangSmith 官方文档](https://docs.smith.langchain.com)，Tracing 接入与 Trace 树解读的原始出处，环境变量一节和本篇对照着看
- [Langfuse 自托管指南](https://langfuse.com/self-hosting)，docker compose 全家桶的架构说明、升级与备份注意事项都在这里
- [OTel GenAI 语义约定](https://opentelemetry.io/docs/specs/semconv/gen-ai/)，`gen_ai.*` 属性的完整清单和当前状态（development），做选型前值得通读

今天的两条 Trace 链路跑通后，你的 Agent 从此有了「行车记录仪」。回头看，从 [/week01/day1](/week01/day1) 的 `createResponse<T>` 到今天，这条主线其实没变过：先让每一步看得见，才谈得上每一步可靠。本周后面几天，就在这个底座上继续拆生产化的其他关卡。
