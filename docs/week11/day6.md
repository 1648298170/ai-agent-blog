# 第 11 周 · Day 6：多供应商切换——一个 SDK 接完 Qwen、DeepSeek、GLM

> 对应手册任务：学习「多供应商切换：OpenAI 兼容协议、Qwen/DeepSeek/GLM API、模型选型与成本特性」，动手把 Day 1 的 CLI 改造成支持 3 家模型热切换（只改 base_url），做一张同题成本对比表，当日产出「多模型 CLI + 成本表」。本篇只解决一个问题：让只会跟一家模型说话的 `raw-chat.py`，变成一个 `--provider` 参数就能在三家之间切换的多模型 CLI，再用同一道题把三家的账算清楚。

## 今日目标

1. 说得清 OpenAI 兼容协议「兼容」的到底是什么，换供应商时真正要改的只有哪三样东西
2. 掌握 CLI 改造三板斧：`--provider` 参数、配置表驱动、pydantic-settings 管三家的 key
3. 独立完成同题对比实验：同一 prompt 跑三家，从 usage 算出真实成本，沉淀出自己的选型基准方法

## 概念讲解：为什么今天必须打通多供应商

Day 1 的 `raw-chat.py` 只会跟一家模型说话。单供应商就是单点故障：它涨价，你多花钱；它限流，你的服务降级；它停服维护，你的 Agent 直接哑掉。更要紧的是就业现实：国内的业务场景，主力模型基本是 Qwen、DeepSeek、GLM 这些国产系，合规、网络、成本三头都占。面试官问「你们为什么选这家模型、成本怎么控」，你得拿得出亲手跑出来的数据，而不是转述别人的测评。

好消息是这件事的工程成本低得离谱。Day 1 结尾其实剧透过：`OpenAI(base_url="https://api.deepseek.com")`，换个地址就能打 DeepSeek。原因不是各家心善，而是竞争使然：OpenAI 的 chat completions 协议成了行业事实标准，好比 USB 接口。后发的厂商想让开发者零成本迁入，最划算的做法就是兼容存量生态，于是 Qwen、DeepSeek、GLM、Kimi、豆包全线提供 OpenAI 兼容端点。你学过的 openai SDK、messages 结构、temperature、usage，一家不落全部通用。

把这层窗户纸捅破，供应商之间的差异就被压缩成三个字符串：base_url、api_key、model。地址决定打给谁，key 证明你是谁，模型名指定谁出来干活。除此之外，请求路径、消息结构、响应字段，一模一样。所以今天的改造思路顺理成章：把这三个字符串从代码里抽出来放进配置表，代码只保留那份不变的调用逻辑。新增一家供应商，配置表加一行，别处一个字不改。

最后一件必须当面说清的事：网络。国产 API 国内直连，OpenAI 官方需要代理，这是环境差异，不是玄学。后面踩坑一节会讲它反过来咬人的场景。

## 核心知识

本节的代码片段都可以单独存成 .py 跑。三家的 key 先去各自控制台注册领取，模型名以控制台「模型列表」页为准，本篇写的是常用起步名，不保证永远有效，这个习惯从今天养成。

### 1. OpenAI 兼容协议：三个字符串换一家模型

先看换供应商的最小动作到底有多小：

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",  # 换这行
    api_key=os.environ["QWEN_API_KEY"],                             # 换这行
)

resp = client.chat.completions.create(
    model="qwen-plus",                                              # 换这行
    messages=[{"role": "user", "content": "用一句话介绍你自己"}],
)
print(resp.choices[0].message.content)
print(resp.usage.total_tokens)
```

关键在构造函数的两个参数：`OpenAI(base_url=..., api_key=...)`。不传 base_url，SDK 默认打 OpenAI 官方；传了，HTTP 请求就发往你指定的地址。路径怎么拼、请求体什么结构、响应里 choices 和 usage 长什么样，全按 OpenAI 协议来，所以 `chat.completions.create` 这一段一个字不用改。三家接入三要素汇成一张表，照抄就能通：

| 供应商 | base_url | 起步模型名 | key 在哪拿 |
| --- | --- | --- | --- |
| Qwen（阿里云百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 阿里云百炼控制台 |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | DeepSeek 开放平台 |
| GLM（智谱） | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 智谱开放平台控制台 |

两个提醒。第一，base_url 到表里那个结尾为止，别再往下拼路径：SDK 会自动在后面接自己的接口路径，你多补一段就是 404。第二，模型名会迭代，这张表只是今天的快照，接每家前花一分钟去控制台核一眼，别背。

### 2. CLI 改造：配置表驱动 + `--provider` 参数

三要素既然只有三个字符串，就别写三份 if-else，用一张字典配置表管起来。三把 key 还是老规矩，pydantic-settings 进 .env，前面周的方案原样搬来，只是字段从一把变三把：

```python
from openai import OpenAI
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    qwen_api_key: str = ""
    deepseek_api_key: str = ""
    glm_api_key: str = ""

    model_config = SettingsConfigDict(env_file=".env")


settings = Settings()

PROVIDERS = {
    "qwen": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-plus",
        "api_key": settings.qwen_api_key,
    },
    "deepseek": {
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "api_key": settings.deepseek_api_key,
    },
    "glm": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model": "glm-4-flash",
        "api_key": settings.glm_api_key,
    },
}


def build_client(name: str) -> tuple[OpenAI, str]:
    cfg = PROVIDERS[name]
    client = OpenAI(base_url=cfg["base_url"], api_key=cfg["api_key"])
    return client, cfg["model"]
```

.env 里对应三行 `QWEN_API_KEY=...`、`DEEPSEEK_API_KEY=...`、`GLM_API_KEY=...`，字段名和环境变量名一一对应，别串门。

关键在 `build_client`：调用逻辑从此和「具体是哪家」彻底解耦，明天要接 Kimi、豆包，配置表加一行就行。这就是配置表驱动的本意，变化的部分进表，不变的部分进代码。

命令行入口用 argparse 的 choices，直接把配置表的键当合法值：

```python
import argparse

parser = argparse.ArgumentParser(description="多模型对话 CLI")
parser.add_argument("--provider", choices=PROVIDERS, default="deepseek")
args = parser.parse_args()

client, model = build_client(args.provider)
```

关键在 `choices=PROVIDERS`：dict 直接迭代出键，`--provider` 传错值会当场报错并列出全部合法选项，参数校验白送。

### 3. 同题对比：usage 是账本，成本自己算

Day 1 让你养成「拿到回复看一眼 usage」的反射，今天它升级成账本。计价公式一句话：

成本 = prompt_tokens ÷ 1,000,000 × 输入单价 + completion_tokens ÷ 1,000,000 × 输出单价

单价单位是「元 / 每百万 token」，各家控制台的价格页可查。量级感受先给一个，数字别背：国产标准档普遍输入每百万几毛到几块人民币，输出侧再乘个几倍；旗舰推理档整体再贵一档；多数家有免费或低价的入门档，跑实验够用。价格常调整，你的表格里永远填当天查到的数，并注明日期。

对比实验的铁律是固定变量：同一道题、temperature=0、同样的 max_tokens，只换供应商，否则结论没法复现。题目别随便找，选一道贴近你业务的基准题，比如一段代码 review、一次 JSON 抽取、一道多步应用题，固定下来。以后「听说 XX 又升级了」，跑一遍基准，几分钟出结论，这比任何测评博主都可信。

选型心智也一样，别背结论，搭框架。按任务分桶：复杂推理、长上下文、便宜跑量、中文创作，每桶一道基准题，让分数说话。维度除了质量和成本，还有延迟、上下文长度、工具调用稳定性。今天的对比表顺手把「耗时」也记上，一列的事。

## 动手任务：`multi-chat.py` 一步一步

手册任务：把 Day 1 的 CLI 改造成支持 3 家模型热切换（只改 base_url），做一张同题成本对比表。拆成 5 步，全程约 30 分钟（不含注册账号）。

**第 1 步：拿三把 key。** 三家控制台各注册一个账号，开通模型服务，领新人额度或小额充值，各拿一把 key。建 .env 写三行，再确认 .gitignore 里有 .env。key 的长相各家不同，照控制台给的抄，前后别带空格。

**第 2 步：建 providers.py，把配置落下来。** 新建 providers.py，把核心知识第 2 节的 Settings、PROVIDERS、build_client 整段抄进去。配置单独成文件是有意为之：文件名不带连字符，才能被其他脚本 import，后面两步都要用它。

**第 3 步：移植 Day 1 的对话循环。** 新建 multi-chat.py，raw-chat.py 的主体循环一行不改地搬过来，只把开头换成 `--provider` 解析：

```python
import argparse
from providers import PROVIDERS, build_client


def main():
    parser = argparse.ArgumentParser(description="多模型对话 CLI")
    parser.add_argument("--provider", choices=PROVIDERS, default="deepseek")
    args = parser.parse_args()

    client, model = build_client(args.provider)  # 原来的 client 和 MODEL 两行，换成这一行
    print(f"当前供应商：{args.provider}（{model}）")

    messages = [
        {"role": "system", "content": "你是一个简洁的中文技术助手，回答不超过三句话。"},
    ]
    total_prompt = total_completion = 0

    print("multi-chat 已启动（exit 退出，reset 清空历史）")

    while True:
        try:
            user_input = input("\n你> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user_input:
            continue
        if user_input in ("exit", "quit"):
            break
        if user_input == "reset":
            messages = [messages[0]]  # 只留 system，其余全丢
            print("（历史已清空）")
            continue

        messages.append({"role": "user", "content": user_input})  # 第一次 append

        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=0.7,
            max_tokens=500,
        )
        reply = resp.choices[0].message.content
        messages.append({"role": "assistant", "content": reply})  # 第二次 append

        u = resp.usage
        total_prompt += u.prompt_tokens
        total_completion += u.completion_tokens
        print(f"\n助手> {reply}")
        print(f"[本轮 {u.prompt_tokens}+{u.completion_tokens} | 累计 {total_prompt}+{total_completion} tokens]")


if __name__ == "__main__":
    main()
```

关键在 `if __name__ == "__main__":`：循环包进 main()，这个文件才不会在被 import 时自己跑起来，前面周讲过的老规矩。Day 1 那两次 append 原样都在，变的只有 client 和 model 从哪来。

**第 4 步：三家各跑一遍。** 依次执行 `python multi-chat.py --provider qwen`、`--provider deepseek`、`--provider glm`，各问同一个问题。三家都能回话，热切换就通了。顺手体会一下：你改的只有命令行上那一个词。

**第 5 步：同题基准，填成本表。** 新建 bench.py，固定一道题跑三家：

```python
import time
from providers import PROVIDERS, build_client

QUESTION = (
    "一家咖啡店原价 30 元一杯，成本 12 元。现在降价 20% 促销，"
    "销量需要提升百分之多少才能保住原来的总利润？给出计算过程。"
)

for name in PROVIDERS:
    client, model = build_client(name)
    start = time.perf_counter()
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": QUESTION}],
        temperature=0,
        max_tokens=800,
    )
    seconds = time.perf_counter() - start
    u = resp.usage
    print(f"\n=== {name} / {model} === 耗时 {seconds:.1f}s")
    print(f"输入 {u.prompt_tokens} tokens，输出 {u.completion_tokens} tokens")
    print(resp.choices[0].message.content)
```

跑完把数据填进这张表，单价当天去各家价格页查：

| 供应商 | 模型 | 输入 tokens | 输出 tokens | 输入单价（元/百万） | 输出单价（元/百万） | 本次成本（元） | 耗时（秒） | 回答质量一句话 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

单次成本通常小到厘级，保留四位小数，别用科学计数法，看着直观。质量那列用自己的话写，算错了就是算错了。这道题本身就是选型基准题的雏形：有唯一正确答案，能分出推理高下。

::: tip 运行提示
Windows 控制台中文乱码先 `chcp 65001`，老话。跑基准前确认代理状态（见坑 3）。三家账号都值得注册一遍，新人额度跑完今天的实验绰绰有余。想让对话中途换供应商，加一个 `/switch` 命令重新调一次 build_client 就行，留作课后题。
:::

## 常见踩坑

**坑 1：base_url 拼错，还怪 SDK。** SDK 会在 base_url 后面自动拼接口路径，所以你只给到表里那个结尾为止。手贱多补一段路径，或者把末尾的 `/v1` 丢了，都会得到 404，报错信息还不太指向真相。排查顺序：先照抄表格原样跑通，再谈修改。

**坑 2：模型名过期或拼错。** 模型名不属于协议，是各家自己的目录，`qwen-plus` 写成 `qwenplus`，报错文案每家还不太一样。养成习惯：接一家，先开控制台的模型列表页，复制粘贴，不手打。

**坑 3：挂着代理访问国产 API 反而超时。** openai SDK 底层是 httpx，默认读 HTTP_PROXY、HTTPS_PROXY 环境变量。你为了访问 OpenAI 开的全局代理，会让发往百炼的请求也绕道出境，轻则变慢重则超时。解法：把三个域名加进 NO_PROXY，或跑国产前临时清掉代理变量。国内直连本来就是国产 API 的优势，别让代理把它吃掉。

**坑 4：对比实验不固定变量。** 温度不同、题目不同、拿字符数当 token 数、只看输入单价不看输出单价，任何一条都能让结论作废。尤其记住输出单价通常是输入的好几倍：同样 token 数，生成多的那家不一定便宜。

**坑 5：背选型结论。** 「推理最强是 X、性价比之王是 Y」这类句子保质期以周计，模型迭代比教程更新快得多。该留下的是方法：固定的基准题、固定的公式、可复现的表。面试里「我怎么持续评估和切换模型」这套动作，比任何一句现成结论都值钱。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 换一家供应商，代码里最少要改几处？分别是什么？

::: details 参考答案
三处：base_url、api_key、model。各家兼容 OpenAI 协议，请求路径、消息结构、响应字段都不变，SDK 调用代码零修改。工程上把这三样放进配置表，新增供应商等于加一行配置。
:::

2. OpenAI 兼容协议，「兼容」的具体是哪些东西？

::: details 参考答案
HTTP 端点的路径规则、请求体结构（messages、temperature、max_tokens 等字段）、响应结构（choices、usage 等字段）。SDK 只认这套形状，不关心背后是谁家的模型，所以同一个 OpenAI 类能打所有提供兼容端点的厂商。
:::

3. 一次调用的成本怎么从 usage 算出来？

::: details 参考答案
prompt_tokens ÷ 1,000,000 × 输入单价，加 completion_tokens ÷ 1,000,000 × 输出单价。单价以各家控制台价格页当日为准，输出单价通常数倍于输入，两边必须分开算。
:::

4. 挂着代理跑 Qwen 超时，第一反应查什么？

::: details 参考答案
查代理环境变量。openai SDK 基于 httpx，默认遵循 HTTP_PROXY/HTTPS_PROXY，而国产 API 国内直连即可。把对应域名加进 NO_PROXY，或临时清掉代理变量再试。
:::

5. 「复杂推理选谁、便宜跑量选谁」这种结论为什么不建议直接背？该怎么形成自己的版本？

::: details 参考答案
模型迭代快、价格常调整，任何结论都有保质期，还依赖具体任务。正确姿势：按任务分桶，每桶固定一道基准题，用今天的流程（同题、temperature=0、记 usage 和耗时、按公式算钱）定期复测，把结论当快照，不当真理。
:::

## 延伸阅读

- [阿里云百炼文档](https://help.aliyun.com/zh/model-studio/)，Qwen 系列的模型清单、OpenAI 兼容模式说明与价格页入口
- [DeepSeek 开放平台文档](https://api-docs.deepseek.com/)，接口说明与定价，中文直读
- [智谱开放平台](https://open.bigmodel.cn/)，GLM 系列的模型列表、价格与控制台入口

今天的 `multi-chat.py`、`providers.py` 和那张成本表留好。后面不管学工具调用还是结构化输出，凡是想验证「换个模型行不行」，都拿它当横向测试台跑一遍；第 21 周给整个 Agent 群记成本账时，今天这张表就是方法论的第一页。
