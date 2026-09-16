# 第 16 周 · Day 5：DeepEval 实操——把评估写进 pytest 体系

> 对应手册任务：学习「DeepEval 实操：pytest 风格用例、G-Eval、任务完成度指标」，动手「用 DeepEval 给客服 Agent 写 5 个测试用例，`deepeval test run` 全绿」，当日产出 `test_agent.py`。本篇只解决一个问题：声明式配置表达不了的条件判断和断言，怎么全部搬进 Python 测试函数里，让 Agent 评估长在你现有的 pytest 体系上，而不是外挂一套谁也不维护的 YAML。

## 今日目标

1. 说得清声明式与代码式评估各自的边界，以及成熟团队为什么两个都用
2. 掌握三件东西：`assert_test` 断言骨架、G-Eval 自定义判据、TaskCompletionMetric 任务完成度
3. 独立完成 5 个客服 Agent 测试用例，覆盖工具调用、参数校验、拒答、格式、完成度，`deepeval test run test_agent.py` 跑到全绿

## 概念讲解：为什么评估要走代码流

昨天（Day 4，见[本周日程](/week16/)）用 promptfoo 把 golden dataset 变成了一份 YAML。跑通那一刻很爽，但继续往下做，你多半会撞上这样一堵墙。

用户说「帮我查一下订单」。这条输入的期望行为是条件式的：Agent 手里有订单号，就该去调 `query_order` 工具，然后检查参数对不对；没拿到订单号，就不该碰任何工具，回一句追问。同一个输入，两种轨迹，两套验收标准。YAML 的测试用例是「输入 → 期望」的平面结构，写不进「先看它调了什么工具，再决定检查什么」这种分支。

这还只是第一堵墙。往下数还有两堵：

- 想断言。工具到底调没调、订单号提取对不对，这些是结构化事实，一行 `assert` 就能判死。声明式配置里没有这个位置，只能绕道让 LLM 去猜，又慢又飘。
- 想进现有体系。仓库里已经有 pytest，有 CI，有测试报告。评估用例凭什么单独活在一个外挂工具里，跑法和报法都跟单测两套？

把三堵墙放在一起看，答案其实很老：评估本来就是测试的延伸。用例组织、参数化、fixture、CI 报告，pytest 十几年前就把这些解决完了，评估没有理由重新发明一遍。DeepEval 做的事情就一件：把「LLM 当裁判」包装成一种 pytest 断言。

所以声明式和代码式不是二选一，是分工：

| 维度 | promptfoo（声明式） | DeepEval（代码式） |
| --- | --- | --- |
| 上手成本 | 低，一份 YAML 就能跑 | 中，要写 Python |
| 条件与分支 | 基本表达不了 | 任意 Python 逻辑 |
| 接入现有测试体系 | 外挂，独立运行 | 原生 pytest，直接进 CI |
| 多模型矩阵对比 | 内置，改配置就行 | 要自己写循环 |
| 谁能维护 | 工程师之外的人也能改 | 基本只有工程师 |
| 定位 | 快筛、冒烟测试 | 深测、回归门禁 |

成熟团队两个都用：promptfoo 在改 prompt 时做快筛，DeepEval 承担需要断言和分支的深度回归。今天把第二件装上。

## 核心知识

本节的代码块都是独立示例，可以先单独跑通看效果。最终完整文件以下面的动手任务为准。

### 1. 安装与用法骨架

```bash
pip install deepeval pytest pytest-asyncio
```

装完还差一把钥匙：裁判模型。DeepEval 的指标默认拿 OpenAI 的模型当评委，所以先设置 `OPENAI_API_KEY` 环境变量（PowerShell 里 `$env:OPENAI_API_KEY="sk-..."`，Linux/macOS 用 `export`）。想换评委，在指标上用 `model` 参数指定。

骨架长这样：

```python
import pytest
from deepeval import assert_test
from deepeval.test_case import LLMTestCase
from deepeval.metrics import AnswerRelevancyMetric


@pytest.mark.asyncio
async def test_demo():
    output = await run_agent("你好")  # 你的 Agent，同步函数就去掉 await
    test_case = LLMTestCase(
        input="你好",
        actual_output=output,
    )
    metric = AnswerRelevancyMetric(threshold=0.7)
    assert_test(test_case, [metric])
```

关键一行是 `assert_test(test_case, [metric])`：它是普通 `assert` 的强化版，指标分数低于阈值时让测试失败，并把分数和裁判理由一起带出来，你不用自己去翻日志猜死因。`LLMTestCase` 是评估的最小单元，`input` 是用户输入，`actual_output` 是 Agent 的实际输出，所有指标都挂在这个对象上。

再强调一遍：这就是一个普通的 pytest 测试函数。`@pytest.mark.asyncio` 负责 asyncio（所以装了 pytest-asyncio），参数化、fixture、conftest.py 全部照常工作。所谓「进现有体系」，指的是字面意思。

### 2. G-Eval：用自然语言写判据

Day 2 校准 judge 的时候，最费劲的不是想判据，是把判据翻译成一段稳定的评分 prompt：怎么一步步推理、怎么输出分数、怎么防它跑偏。G-Eval（来自同名论文，DeepEval 内置为 `GEval`）把这部分接走了：你只用自然语言写清楚「什么算好」，它自动生成思维链再打分。手写 rubric 最容易翻车的「教模型怎么评」环节，恰恰被省掉了。

两个实例，判据不同，套路相同：

```python
from deepeval.metrics import GEval
from deepeval.test_case import LLMTestCaseParams

completeness_metric = GEval(
    name="回答完整性",
    criteria=(
        "判断实际输出是否完整回应了用户输入："
        "用户问到的每个点都要有着落，不能只答一半，不能答非所问。"
    ),
    evaluation_params=[
        LLMTestCaseParams.INPUT,
        LLMTestCaseParams.ACTUAL_OUTPUT,
    ],
    threshold=0.7,
)

format_metric = GEval(
    name="格式合规",
    criteria=(
        "判断实际输出是否符合客服规范："
        "必须是中文，结尾必须附带给用户的下一步建议或操作指引。"
    ),
    evaluation_params=[LLMTestCaseParams.ACTUAL_OUTPUT],
    threshold=0.8,
)
```

三个参数各管一件事。`criteria` 写「好是什么样」，用业务语言说人话，越具体裁判越稳，中文直接写没问题。`evaluation_params` 声明裁判能看到哪些字段：判完整性的得同时看 `INPUT` 和 `ACTUAL_OUTPUT`，判格式的只看 `ACTUAL_OUTPUT` 就够，看得越少越不容易被带偏。`threshold` 是及格线，分数低于它测试就失败。

### 3. TaskCompletionMetric：事情办成没有

G-Eval 评的是「话说得好不好」，Agent 更要命的考核是「事办成没有」。用户要改配送日期，回复写得再礼貌再规范，没改成就是失败。`TaskCompletionMetric` 就是冲这个来的：

```python
from deepeval.metrics import TaskCompletionMetric
from deepeval.test_case import LLMTestCase

task_metric = TaskCompletionMetric(threshold=0.7)

test_case = LLMTestCase(
    input="帮我把订单 A-1024 改到下周三配送",
    actual_output="已把订单 A-1024 的配送日期改到下周三，确认短信已发送。",
)
task_metric.measure(test_case)

print(task_metric.score)   # 1.0 或 0.0
print(task_metric.reason)  # 裁判给出的判定理由
```

关键在它是二元判定：分数只有 0 和 1，不问答得多漂亮，只问用户的目标达成没有。Day 2 校准时得出的「二元判定优于打分」在这里直接落地，二元结论和人工标注的一致率天然更高。跟 G-Eval 的分工也就清楚了：G-Eval 评输出质量，TaskCompletion 评任务结果，两个一起挂到 `assert_test` 上就是一条完整的验收线。

`measure()` 是「先量一量」的用法，适合探索阶段手动看分数；要当门禁，还是 `assert_test(test_case, [task_metric])` 一刀切下去。

## 动手任务：`test_agent.py` 一步一步

手册任务：给客服 Agent 写 5 个测试用例，覆盖正确工具调用、参数校验、拒答场景、格式、完成度，跑到全绿。拆成 5 步，全程约 30 分钟。下面每一步的代码都往同一个文件 `test_agent.py` 里加，写完它就是当日产出。

**第 1 步：装包，配钥匙。** 核心知识里的安装命令跑一遍，然后设置 `OPENAI_API_KEY`。没钥匙的话，后面所有 LLM 指标都跑不动，普通 `assert` 倒是不受影响。

**第 2 步：写 Agent 薄壳。** 被测对象是第 13 周的客服 Agent。为了让今天这份代码照抄就能跑，先写一个行为相同的 mock，接口保持一致：进去一句话，出来 `output`（回复文本）加 `tool_calls`（工具调用记录）。以后接真实 Agent，只改 `run_agent` 一个函数。

```python
import pytest
from dataclasses import dataclass, field

from deepeval import assert_test
from deepeval.test_case import LLMTestCase, LLMTestCaseParams
from deepeval.metrics import GEval, TaskCompletionMetric


@dataclass
class AgentResult:
    output: str
    tool_calls: list = field(default_factory=list)


async def run_agent(user_input: str) -> AgentResult:
    """mock 客服 Agent，接真实 Agent 时只改这个函数。"""
    if "订单" in user_input and "查" in user_input:
        order_id = next((w for w in user_input.split() if w.startswith("A-")), None)
        if order_id is None:
            return AgentResult(
                output="好的，请提供订单号（形如 A-1024），我马上为您查询。",
                tool_calls=[],
            )
        return AgentResult(
            output=f"订单 {order_id} 已发货，预计 3 天内送达。建议您留意物流短信。",
            tool_calls=[{"name": "query_order", "args": {"order_id": order_id}}],
        )
    if "退款" in user_input:
        return AgentResult(
            output="抱歉，退款业务超出我的处理范围，已为您转接人工客服。",
            tool_calls=[{"name": "transfer_human", "args": {"reason": "退款业务"}}],
        )
    return AgentResult(
        output="您好，我是客服助手。建议您描述具体问题，我会尽力协助。",
        tool_calls=[],
    )
```

mock 的四条路正好喂饱今天五类场景：查到订单号就调工具，查不到就追问，退款转人工，剩下闲聊兜底。

**第 3 步：定义指标。** 把核心知识里的 `completeness_metric` 和 `format_metric` 两个定义原样贴进文件，紧跟薄壳之后，再加一行任务完成度：

```python
task_metric = TaskCompletionMetric(threshold=0.7)
```

**第 4 步：写 5 个用例。** 这一步是今天的主菜，体会「普通 assert + assert_test」怎么分工：轨迹上的硬事实交给 assert，免费且毫秒级；文本质量交给裁判。

```python
@pytest.mark.asyncio
async def test_query_order_calls_right_tool():
    """用例 1：正确工具调用——查订单必须真的调了 query_order。"""
    result = await run_agent("帮我查一下订单 A-1024 的物流")
    assert any(c["name"] == "query_order" for c in result.tool_calls)
    test_case = LLMTestCase(
        input="帮我查一下订单 A-1024 的物流",
        actual_output=result.output,
    )
    assert_test(test_case, [completeness_metric])


@pytest.mark.asyncio
async def test_missing_order_id_asks_back():
    """用例 2：参数校验——缺订单号时应当追问，而不是瞎猜一个去调工具。"""
    result = await run_agent("帮我查一下订单")
    assert result.tool_calls == []    # 没拿到参数，就不准碰工具
    assert "订单号" in result.output   # 追问必须说清要什么
    test_case = LLMTestCase(
        input="帮我查一下订单",
        actual_output=result.output,
    )
    assert_test(test_case, [completeness_metric])


@pytest.mark.asyncio
async def test_refund_out_of_scope():
    """用例 3：拒答场景——超范围要明说并转人工，不能编退款政策。"""
    result = await run_agent("怎么申请退款？")
    assert any(c["name"] == "transfer_human" for c in result.tool_calls)
    refuse_metric = GEval(
        name="拒答得当",
        criteria=(
            "用户提出了客服系统范围外的请求。判断实际输出是否："
            "明确告知无法处理、没有编造政策或答案、给出了转人工的替代路径。"
        ),
        evaluation_params=[
            LLMTestCaseParams.INPUT,
            LLMTestCaseParams.ACTUAL_OUTPUT,
        ],
        threshold=0.8,
    )
    test_case = LLMTestCase(
        input="怎么申请退款？",
        actual_output=result.output,
    )
    assert_test(test_case, [refuse_metric])


@pytest.mark.asyncio
async def test_reply_format():
    """用例 4：格式合规——回复是中文，结尾带下一步建议。"""
    result = await run_agent("你好")
    test_case = LLMTestCase(input="你好", actual_output=result.output)
    assert_test(test_case, [format_metric])


@pytest.mark.asyncio
async def test_task_completion():
    """用例 5：任务完成度——查物流这件事最终办成了没有。"""
    result = await run_agent("帮我查一下订单 A-1024 现在到哪了")
    assert "A-1024" in result.output  # 回复里带订单号，说明真的查了
    test_case = LLMTestCase(
        input="帮我查一下订单 A-1024 现在到哪了",
        actual_output=result.output,
    )
    assert_test(test_case, [task_metric])
```

到这里 `test_agent.py` 就完整了：import、薄壳、三个模块级指标，加五个用例。`refuse_metric` 故意定义在函数内，它只服务拒答这一个场景，不值得放到模块级跟别人共用。

**第 5 步：跑起来。**

```bash
deepeval test run test_agent.py
```

输出先是一张逐用例的表：每个指标一行，分数、阈值、通过与失败、裁判理由都列出来，最后是总览。第一次跑如果提示登录 Confident AI（DeepEval 背后团队的可视化平台），选跳过也能拿到本地结果；登录的好处是每次运行自动同步上网页端，能看分数的历史趋势。五个用例全过，就是全绿。

::: tip 两种跑法
`deepeval test run test_agent.py` 和 `pytest test_agent.py` 跑的是同一批用例：前者多一张汇总表并对接 Confident AI，后者是你在 CI 里已有的那条命令，断言同样生效。本地调试用前者，CI 里用后者，用例一行都不用改。
:::

## 常见踩坑

**坑 1：评估对象错位，mock 全绿不算数。** 今天的 mock 是为了跑通流程。真实接法是把 `run_agent` 的函数体换成第 13 周 Agent 的调用，此时如果用例红了，才是有价值的信息。永远记得评估对象是 Agent 本身，mock 全绿只说明你测试写对了。

**坑 2：裁判分数会漂，阈值要留缓冲。** 同一条用例跑两遍，LLM 打分差个 0.05 到 0.1 属于正常现象。两个对策：判据写具体，把「回答完整」拆成「用户问到的每个点都要有着落」这种可核对的条件；阈值别贴着历史分数定，留出 0.1 上下的缓冲，否则 CI 会随机红。

**坑 3：把所有判断都塞给裁判。** 调没调工具、参数提取对不对、回复里带没带订单号，全是结构化事实，普通 `assert` 又快又准又不要钱。LLM 指标只留给「文本好不好」这种机器难判的问题。判断标准很简单：能用 Python 表达式判定的，就别劳驾裁判。

**坑 4：async 测试静默变成「没跑」。** 忘装 pytest-asyncio 或者漏了 `@pytest.mark.asyncio` 装饰器，pytest 不会执行异步函数体，可能报个 warning 就把用例算失败，新手常在这卡半小时。装齐三件套（deepeval、pytest、pytest-asyncio），每个用例都带上装饰器。

**坑 5：分不清 measure 和 assert_test。** `metric.measure(test_case)` 只是量一下，分数挂在 `metric.score` 和 `metric.reason` 上，适合探索时手动看；`assert_test` 是断言，低了就失败，适合当门禁。别在门禁位置调用 measure 然后自己写 if 比分数，那等于手工重写了一遍 assert_test。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 声明式和代码式评估各自的边界在哪？成熟团队怎么搭配？

::: details 参考答案
声明式（promptfoo）胜在上手快、非工程师能维护、多模型矩阵开箱即用，但表达不了条件分支，只能外挂运行；代码式（DeepEval）能写任意 Python 逻辑、能断言结构化事实、原生进 pytest 和 CI，代价是要写代码。成熟团队两个都用：promptfoo 做改 prompt 后的快筛，DeepEval 做带断言和分支的深测与回归门禁。
:::

2. G-Eval 的 `criteria` 和 `evaluation_params` 各写什么？为什么比手写 rubric prompt 更稳？

::: details 参考答案
`criteria` 用自然语言写「什么算好」，是业务判据；`evaluation_params` 声明裁判能看到哪些字段（INPUT、ACTUAL_OUTPUT 等），控制裁判的信息面。更稳的原因：手写 rubric 最容易翻车的是「教模型怎么一步步打分」的推理链，G-Eval 让模型根据 criteria 自动生成思维链再打分，把这个高出错环节从人手里接走了。
:::

3. TaskCompletionMetric 和 G-Eval 怎么分工？

::: details 参考答案
G-Eval 评输出质量，分数连续（0 到 1）；TaskCompletionMetric 只判任务达成与否，二元结论（0 或 1）。一条完整的验收线经常是两个一起挂：话说得好不好交给 G-Eval，事办成没有交给 TaskCompletion。
:::

4. 「查订单必须调用 query_order」为什么建议用普通 assert 而不是 G-Eval？

::: details 参考答案
工具调没调是结构化事实，Python 表达式一行就能判死：免费、毫秒级、结果确定。交给 LLM 裁判反而引入打分漂移和 token 成本。能用确定性断言判定的，永远不要劳驾裁判。
:::

5. `deepeval test run` 和 `pytest` 两种跑法有什么区别？

::: details 参考答案
跑的是同一批用例。`deepeval test run` 额外输出逐指标汇总表，并可把结果同步到 Confident AI 平台看趋势；`pytest` 是 CI 里现成的命令，断言照样生效。本地看报告用前者，CI 门禁用后者，用例代码不用改。
:::

## 延伸阅读

- [DeepEval 官方文档](https://deepeval.com/docs)，安装、全部内置指标和 GEval 各参数的原始出处，今天只用到它一小角
- [G-Eval 论文](https://arxiv.org/abs/2303.16634)，《G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment》，自然语言判据加自动思维链这套打分方法的出处
- [Confident AI](https://www.confident-ai.com)，DeepEval 背后团队的平台，登录后测试结果自动上报，网页端可以看历史趋势和多模型对比

今天的产出 `test_agent.py` 留好，明天 Day 6 把它和 promptfoo 一起接进 GitHub Action，评估从「手动跑的脚本」升级成「合并前自动执行的回归门禁」。
