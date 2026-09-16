# 第 16 周 · Day 3：Trajectory 评估——答案对，不代表路走对了

> 对应手册任务：学习「Trajectory 评估：工具选择、参数提取、结果利用、错误恢复、计划连贯、任务完成 6 个维度」，动手为 10 条 golden case 编写期望轨迹（该调哪个工具、该传什么参数），跑 Agent 对比实际轨迹差异，当日产出 `trajectory_eval.py`。本篇只解决一个问题：只看结果抓不到绕远路和调错工具碰运气。

## 今日目标

1. 说得清「结果对但轨迹错」为什么必须修、在生产环境是什么形态的雷
2. 掌握六个评估维度各自在查什么，每个维度能举出一个翻车判例
3. 独立完成 10 条 golden case 的期望轨迹标注，跑通对比脚本，拿到按维度的差异报告

## 概念讲解：为什么只看结果会漏掉隐患

看一个翻车现场。用户问「订单 A-1024 到哪了」，Agent 调 `get_order` 拿到物流单号，却不查物流，反而调了无关的 `convert_currency`，又多调一次 `search_web`，最后从返回的 `status: 已发货` 里拼了句话交给用户。用户没投诉。

昨天的结果评估给它打 PASS。可隐患全在过程里：废动作浪费 token 和延迟，「到哪了」压根没被回答，工具返回格式一变，碰巧的答案立刻答非所问。**结果对，轨迹错，就是一颗还没炸的雷。**

轨迹（trajectory）是一次运行的完整消息流：system prompt 进入，模型发起工具调用（名+参数），环境返回结果，模型继续推理、可能再调工具，直到给出最终回答。结果评估只采样最后一个点；轨迹评估把整条流当被测对象，逐段检查。

类比：[第 1 周](/week01/day1)给函数写单测，先保证每个函数对，再看整个程序。轨迹就是 Agent 的「单元」，被测对象从函数换成了工具调用。

## 核心知识

### 1. 六个维度：每一步在查什么

| 维度 | 查什么 | 典型翻车 |
| --- | --- | --- |
| 工具选择 | 该调的调了没，不该调的调没调 | 查天气调了日历工具 |
| 参数提取 | 关键参数传对没 | 订单号 `A-1024` 抠成 `1024` |
| 结果利用 | 工具返回读没读 | 返回 `temp: 18` 没进答案 |
| 错误恢复 | 出错后自愈没 | error 返回原文直接甩给用户 |
| 计划连贯 | 步骤顺序合理不 | 没拿到物流单号就查物流 |
| 任务完成 | 终态达没达 | 答一堆，没回应问题 |

逐个给判例。

**工具选择**：漏调，该查不查，参数靠编；多调，开头那个 `convert_currency` 就是。不需要工具的问题（如翻译）也硬调一圈，今天有 case 专抓。

**参数提取**：从自然语言里抠参数。「订单 A-1024」要原封进 `order_id`，「128 乘 46」要写成 `128*46` 不是 `128+46`。这步错后面全白搭，还错得安静。

**结果利用**：判例：`get_weather` 返回 `temp: 18`，答案却说「今天天气不错适合出行」，温度没进答案，白查。

**错误恢复**：判例：查不存在的订单返回 error。好轨迹是承认查不到并收尾；坏轨迹甩 error 原文给用户，或反复重试同一调用直到 token 耗尽。

**计划连贯**：`tracking_id` 是 `get_order` 的返回，没查订单就查物流，参数只能编。有依赖链的顺序必须锁；两城天气谁先谁后无所谓，不该锁。

**任务完成**：判例：问「都签收了吗」，Agent 输出一堆状态流水账，就是不回答「是否都签收」。前五步全对，最后没回应问题，一样不合格。

### 2. 期望轨迹：JSONL 与顺序约束

轨迹评估需要「标准答案轨迹」：golden case，一行一个 JSON 对象，写清输入、期望工具列表、关键参数、顺序约束。顺序约束只有两档：

- `strict`（严格序）：工具必须按列表顺序出现，用于有依赖链的步骤
- `any`（集合序）：列表里的工具都得调到，先后随意，用于多解路径

一条铁律：**多解路径别标死顺序，只锁安全关键序。**「先查订单再查物流」要锁，顺序错了参数就是编的；「上海和深圳哪个热」标成 strict 是给自己挖坑——Agent 交换顺序，功能全对，报告却全红，误报一大，团队很快不再信报告。类似的还有「先查询后写入」「先读后改」。

### 3. 软匹配与交并差

对比实际和期望，匹配规则要宽严得当。

**工具名精确匹配。** 调了 `get_orders` 而不是 `get_order`，就是调错工具，没得商量——拼错名字本身就是要抓的 bug。

**参数用子集匹配。** 期望只写关键参数，实际覆盖了就算过：给 `get_weather` 多传 `unit` 不影响正确性。数值还要归一：`199`、`"199"`、`199.0` 语义相同，字符串比对会误报。

对比就是交并差：匹配上的是交集；期望有、实际没有是漏调；实际有、期望没有是多调。各维度从这三个集合取证据。

## 动手任务：trajectory 评估脚本一步一步

手册任务：为 10 条 golden case 标注期望轨迹，跑 Agent 对比实际轨迹。拆成 5 步，全程约 40 分钟。

**第 1 步：装依赖、建文件。** 在本周练习目录执行 `pip install langgraph langchain-openai`，设好 `OPENAI_API_KEY`。新建 `trajectory_eval.py` 和 `golden_cases.jsonl`，后面每步代码都往 `.py` 文件加。

**第 2 步：定义工具和 Agent。** 五个工具全用 mock 数据，离线可跑：

```python
import json
from pathlib import Path

from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent

WEATHER = {"北京": {"city": "北京", "temp": 18},
           "上海": {"city": "上海", "temp": 24},
           "深圳": {"city": "深圳", "temp": 27}}
ORDERS = {"A-1024": {"order_id": "A-1024", "status": "已发货", "tracking_id": "SF-888-666"},
          "A-2048": {"order_id": "A-2048", "status": "已签收", "tracking_id": "YT-123-456"}}
LOGISTICS = {"SF-888-666": {"tracking_id": "SF-888-666", "carrier": "顺丰", "location": "北京朝阳区"},
             "YT-123-456": {"tracking_id": "YT-123-456", "carrier": "圆通", "location": "上海浦东新区"}}

@tool
def get_weather(city: str) -> dict:
    """查询指定城市当前气温，city 为城市名，如「北京」。"""
    return WEATHER.get(city) or {"error": f"未收录城市：{city}"}

@tool
def get_order(order_id: str) -> dict:
    """根据订单号查询订单状态与物流单号。"""
    return ORDERS.get(order_id) or {"error": f"订单 {order_id} 不存在"}

@tool
def get_logistics(tracking_id: str) -> dict:
    """根据物流单号查询包裹当前位置与承运商。"""
    return LOGISTICS.get(tracking_id) or {"error": f"物流单号 {tracking_id} 不存在"}

@tool
def calculator(expression: str) -> dict:
    """计算一个算术表达式，如 "128*46"。"""
    try:
        return {"expression": expression, "result": eval(expression)}  # 仅演示，别上生产
    except Exception as e:
        return {"error": f"表达式非法：{e}"}

@tool
def convert_currency(amount: float, to: str = "CNY") -> dict:
    """把美元金额换算成目标货币，amount 为美元数。"""
    return {"amount": amount, "to": to, "result": round(amount * 7.2, 2)}

def build_agent():
    return create_react_agent(
        model=ChatOpenAI(model="gpt-4o-mini", temperature=0),
        tools=[get_weather, get_order, get_logistics, calculator, convert_currency],
    )
```

关键在 docstring：`create_react_agent` 靠它告诉模型「有什么可用」，写得含糊，工具选择维度跟着遭殃——它也是 prompt 的一部分。

**第 3 步：写 10 条 golden case。** 在 `golden_cases.jsonl` 里一行一条：`expected_tools` 是期望工具列表（`args` 只写关键参数），`order` 是顺序约束，`expect_error_from` 标注「该工具在本 case 就该失败」，`answer_must_contain` 是答案必须包含的关键内容（`null` 不作要求）。分三组：

第一组，考工具选择和参数提取：

```json
{"case_id": "weather_01", "input": "北京今天多少度", "expected_tools": [{"name": "get_weather", "args": {"city": "北京"}}], "order": "any", "expect_error_from": [], "answer_must_contain": "18"}
{"case_id": "math_01", "input": "帮我算一下 128 乘 46 等于多少", "expected_tools": [{"name": "calculator", "args": {"expression": "128*46"}}], "order": "any", "expect_error_from": [], "answer_must_contain": "5888"}
{"case_id": "usd_01", "input": "199 美元折合人民币多少钱", "expected_tools": [{"name": "convert_currency", "args": {"amount": 199, "to": "CNY"}}], "order": "any", "expect_error_from": [], "answer_must_contain": "1432.8"}
{"case_id": "tr_01", "input": "把「今天天气不错」翻译成英文", "expected_tools": [], "order": "any", "expect_error_from": [], "answer_must_contain": null}
```

四条各藏考点：`weather_01` 基线单工具；`math_01` 考表达式抠得准；`usd_01` 考数值加枚举双参数；`tr_01` 期望轨迹是空的——翻译不需要工具，调了就是过度工具使用。

第二组，考顺序约束和多实体：

```json
{"case_id": "weather_02", "input": "上海和深圳今天哪个城市更热", "expected_tools": [{"name": "get_weather", "args": {"city": "上海"}}, {"name": "get_weather", "args": {"city": "深圳"}}], "order": "any", "expect_error_from": [], "answer_must_contain": "深圳"}
{"case_id": "order_01", "input": "订单 A-1024 的包裹现在到哪了", "expected_tools": [{"name": "get_order", "args": {"order_id": "A-1024"}}, {"name": "get_logistics", "args": {"tracking_id": "SF-888-666"}}], "order": "strict", "expect_error_from": [], "answer_must_contain": "北京"}
{"case_id": "order_02", "input": "订单 A-2048 发货了吗", "expected_tools": [{"name": "get_order", "args": {"order_id": "A-2048"}}], "order": "any", "expect_error_from": [], "answer_must_contain": "已签收"}
{"case_id": "order_04", "input": "订单 A-1024 和 A-2048 都签收了吗", "expected_tools": [{"name": "get_order", "args": {"order_id": "A-1024"}}, {"name": "get_order", "args": {"order_id": "A-2048"}}], "order": "any", "expect_error_from": [], "answer_must_contain": "已签收"}
```

`weather_02` 是集合序样本：两次同名调用不同参数，谁先谁后都对。`order_01` 是严格序样本：查物流依赖查订单返回的单号，期望参数里 `tracking_id` 直接写了 `SF-888-666`，把依赖链钉进用例。`order_02` 考最小路径：`status` 就够回答，再调 `get_logistics` 算多调。

第三组，考错误恢复：

```json
{"case_id": "order_05", "input": "帮我查订单 A-999 的物流到哪了", "expected_tools": [{"name": "get_order", "args": {"order_id": "A-999"}}], "order": "any", "expect_error_from": ["get_order"], "answer_must_contain": null}
{"case_id": "weather_03", "input": "纽约今天多少度", "expected_tools": [{"name": "get_weather", "args": {"city": "纽约"}}], "order": "any", "expect_error_from": ["get_weather"], "answer_must_contain": null}
```

这两条的工具必然返回 `error`，好轨迹是承认查不到、正常收尾，而不是甩原文或无限重试。`answer_must_contain` 留空是有意的：多种说法都对，锁死字眼只会制造误报。

**第 4 步：提取轨迹、软匹配、六维度判定。** 这是脚本的核心，接着往 `trajectory_eval.py` 里加：

```python
def extract_tool_calls(messages):
    """从消息流提取轨迹：所有工具调用 + 所有工具返回"""
    calls, results = [], []
    for m in messages:
        if m.type == "ai":
            for tc in m.tool_calls or []:
                calls.append({"name": tc["name"], "args": tc["args"]})
        elif m.type == "tool":
            results.append(str(m.content))
    return calls, results

def norm(v):
    """参数值归一：数字和数字字符串等价，其余按字符串比"""
    try:
        return round(float(v), 6)
    except (TypeError, ValueError):
        return str(v)

def soft_match(actual, expected):
    """工具名精确 + 关键参数子集匹配"""
    if actual["name"] != expected["name"]:
        return False
    act_args = actual.get("args") or {}
    for k, v in (expected.get("args") or {}).items():
        if k not in act_args or norm(act_args[k]) != norm(v):
            return False
    return True

def in_order(exp_tools, act_calls):
    """期望工具能否按顺序软匹配进实际调用流（参数感知的子序列检查）"""
    pos = 0
    for e in exp_tools:
        matched = False
        while pos < len(act_calls):
            a = act_calls[pos]
            pos += 1
            if soft_match(a, e):
                matched = True
                break
        if not matched:
            return False
    return True

def judge_case(case, messages, final_answer):
    calls, results = extract_tool_calls(messages)
    exp = case["expected_tools"]
    rows = []

    def add(dim, expected_desc, actual_desc, ok, why):
        rows.append({"case": case["case_id"], "dimension": dim,
                     "expected": expected_desc, "actual": actual_desc,
                     "verdict": "PASS" if ok else f"FAIL: {why}"})

    # ① 工具选择：漏调 / 多调（交并差）
    exp_names = sorted({t["name"] for t in exp})
    act_names = sorted({c["name"] for c in calls})
    missing = [n for n in exp_names if n not in act_names]
    extra = [n for n in act_names if n not in exp_names]
    why = ("漏调 " + str(missing) if missing else "") + (" 多调 " + str(extra) if extra else "")
    add("工具选择", ",".join(exp_names) or "（不调工具）", ",".join(act_names) or "（未调用）",
        not missing and not extra, why or "-")

    # ② 参数提取：工具名对上了，关键参数软匹配是否成功
    bad_params = []
    for e in exp:
        hit = next((c for c in calls if soft_match(c, e)), None)
        if hit is None:
            same_name = next((c for c in calls if c["name"] == e["name"]), None)
            if same_name is not None:
                bad_params.append(f"{e['name']} 期望 {e.get('args') or {}}，实传 {same_name['args']}")
    add("参数提取", "关键参数与期望一致", "; ".join(bad_params) or "一致",
        not bad_params, "; ".join(bad_params) or "-")

    # ③ 结果利用：工具返回里的关键事实，是否进入最终答案
    fact = case.get("answer_must_contain")
    if fact is None:
        add("结果利用", "（无关键事实标注）", "-", True, "-")
    elif not any(fact in r for r in results):
        add("结果利用", f"「{fact}」进入答案", "事实来自推理而非工具返回", True, "-")
    else:
        add("结果利用", f"「{fact}」进入答案", "已体现在答案中" if fact in str(final_answer) else "工具拿到了，答案没用",
            fact in str(final_answer), "工具返回里有该事实，最终答案未体现")

    # ④ 错误恢复：预期错误是否出现，出错后是否收尾
    expected_err = case.get("expect_error_from") or []
    err_tools = [m.name for m in messages
                 if m.type == "tool" and "error" in str(m.content)]
    healed = bool(str(final_answer).strip())
    if not err_tools:
        add("错误恢复", "不出现错误" if not expected_err else f"应触发 {expected_err}",
            "无错误", not expected_err, "预期的错误场景没触发，检查 mock 数据")
    else:
        is_expected = set(err_tools) & set(expected_err)
        add("错误恢复", f"{expected_err} 出错后妥善收尾" if is_expected else "不出现错误",
            f"{err_tools} 出错，已给出答复" if healed else f"{err_tools} 出错后未收尾",
            healed, "出错后没有给出最终答复")

    # ⑤ 计划连贯：strict 时检查依赖顺序
    if case.get("order") == "strict" and len(exp) > 1:
        add("计划连贯", " → ".join(t["name"] for t in exp),
            " → ".join(c["name"] for c in calls) or "（未调用）",
            in_order(exp, calls), "依赖顺序被打乱：后一步的输入来自前一步")
    else:
        add("计划连贯", "（集合序，不约束顺序）", "-", True, "-")

    # ⑥ 任务完成：关键内容是否出现在最终答案
    if fact is None:
        add("任务完成", "给出最终答复", str(final_answer)[:30],
            healed, "空回复")
    else:
        add("任务完成", f"答案包含「{fact}」", str(final_answer)[:30],
            fact in str(final_answer), "关键内容缺失")

    return rows
```

关键在 `judge_case` 只吃 `messages` 和 `final_answer`，不碰 Agent 内部：不管用什么框架，只要有消息流就能评，判定逻辑直接复用。

**第 5 步：跑批出报告。** 文件末尾加上主流程：

```python
def render_report(rows):
    head = ["| case | 维度 | 期望 | 实际 | verdict |", "| --- | --- | --- | --- | --- |"]
    body = [f"| {r['case']} | {r['dimension']} | {r['expected']} | {r['actual']} | {r['verdict']} |"
            for r in rows]
    return "\n".join(head + body)

def main():
    agent = build_agent()
    cases = [json.loads(line) for line in
             Path("golden_cases.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = []
    for case in cases:
        result = agent.invoke({"messages": [("user", case["input"])]})
        messages = result["messages"]
        rows.extend(judge_case(case, messages, messages[-1].content))
    report = render_report(rows)
    print(report)
    Path("trajectory_report.md").write_text(report, encoding="utf-8")

if __name__ == "__main__":
    main()
```

执行 `python trajectory_eval.py`，控制台输出 markdown 表格并落盘 `trajectory_report.md`，典型输出（节选）：

```
| case | 维度 | 期望 | 实际 | verdict |
| --- | --- | --- | --- | --- |
| weather_01 | 工具选择 | get_weather | get_weather | PASS |
| order_01 | 计划连贯 | get_order → get_logistics | get_order → get_logistics | PASS |
| order_02 | 工具选择 | get_order | get_logistics,get_order | FAIL: 多调 ['get_logistics'] |
| math_01 | 参数提取 | 关键参数与期望一致 | calculator 期望 {'expression': '128*46'}，实传 {'expression': '128 + 46'} | FAIL: ... |
| order_05 | 错误恢复 | ['get_order'] 出错后妥善收尾 | ['get_order'] 出错，已给出答复 | PASS |
```

读表：一行是「一个 case × 一个维度」，FAIL 行就是要修的证据，把表贴进 PR 描述，评审一眼知道看哪。

::: tip 省钱跑法
每条 case 都要真实调一次模型。调试判定逻辑时先录一份 `messages` 存成 JSON，反复调 `judge_case` 对着录像判，一分钱不花。
:::

## 常见踩坑

**坑 1：把所有顺序都标成 strict。** Agent 交换了两个可交换的步骤，功能全对，报告一片红。误报一大，团队就不看报告了，评估白做。标注前先问：这两步换个儿，结果会坏吗？会才锁。

**坑 2：参数用全量精确匹配。** 实际多传一个无关参数，或 `199` 被传成 `"199"`，全量比对直接判死。该用 `soft_match` 那种子集匹配加数值归一，把判死标准留给真正要抓的错。

**坑 3：拿工具返回内容做逐字比对。** 把返回值也写进期望、要求一字不差，mock 一动全部变红，而 Agent 行为没变。期望只约束 Agent 侧，环境侧交给 `expect_error_from` 粗粒度标注，混在一起用例就没法维护。

**坑 4：错误场景不标期望。** case 全是顺利路径，错误恢复能力永远没被测过，上线撞见脏数据就是事故现场。每个工具至少配一条「它失败了」的 case，写明预期出错后怎么办。

**坑 5：golden case 只加不减。** 产品改版删了工具、改了参数名，旧 case 没人清理，天天报红成背景噪音。每次工具增删改，case 同步过一遍。用例集是活文档，不是一次性作业。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 结果对了但轨迹错了，为什么必须修？

::: details 参考答案
因为这种正确是碰巧的。轨迹错意味着：有废动作（早晚在边界场景出错）、参数靠编（返回一变就答非所问）、依赖链是断的（换输入立刻露馅）。结果对是运气，轨迹对才是能力。
:::

2. `strict` 和 `any` 怎么选？举一个必须 `strict` 的场景。

::: details 参考答案
标准是「顺序错了，结果会不会坏」。有数据依赖或「先查询后写入」次序就必须 strict，比如先 `get_order` 拿到 `tracking_id` 才能查物流；顺序无关的多解路径一律 any，标死只会制造误报。
:::

3. 参数为什么用子集匹配而不是全量匹配？

::: details 参考答案
期望关心「关键参数有没有传对」，不是逐字一致。多传无关参数、数值换等价形态（199 / "199" / 199.0），功能都对，全量匹配会全判死，误报一大报告就没人信。工具名反而必须精确：名字错了就是调错工具。
:::

4. 「允许失败」在 JSONL 里怎么表达？

::: details 参考答案
用 `expect_error_from` 标注「该工具在本 case 就该失败」，`answer_must_contain` 通常留空。判定据此查两点：预期错误确实发生（mock 生效）；出错后仍给出收尾答复，而不是甩原文或无限重试。
:::

5. 六个维度里哪个最难全自动判定？为什么？

::: details 参考答案
结果利用。工具选择、参数、顺序能做集合与序列运算，任务完成有 `answer_must_contain` 兜底，但「有没有读懂返回」发生在推理内部，只能用「关键事实是否进入答案」近似。要判得更细得上 LLM-as-judge 或人审，脚本做初筛。
:::

## 延伸阅读

- [LangSmith：Evaluating Agents](https://docs.smith.langchain.com/evaluation/tutorials/agents)，LangChain 官方轨迹评估教程，本篇思路的产品化版本
- [LangGraph 文档](https://langchain-ai.github.io/langgraph/)，`create_react_agent` 与消息流结构的原始出处
- [τ-bench 论文](https://arxiv.org/abs/2406.12045)，评 Agent 工具使用能力的基准，判分设计对顺序约束怎么定松紧有参考价值

今天的产出 `trajectory_eval.py` 和 `golden_cases.jsonl` 留好：以后每次改 prompt、换模型、加工具，都先跑一遍这批 case 再谈上线。
