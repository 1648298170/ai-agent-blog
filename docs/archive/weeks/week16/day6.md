# 第 16 周 · Day 6：评估进 CI——把回归钉进合并门禁

> 对应手册任务：学习「评估进 CI：GitHub Action 集成、回归门禁、prompt/数据集版本化」，动手「配置 promptfoo CI：prompt 或模型变更自动跑回归，通过率跌幅 >3% 自动阻断合并」，当日产出「CI 评估门禁」。本篇只解决一个问题：评估不能依赖「有人记得跑」——把它钉进合并门禁，让「改个 prompt 悄悄劣化」从没人发现，变成上不了线。

## 今日目标

1. 说得清评估荒废的机制（人工记得才跑，活不过两周），以及门禁的技术内核（exit 非零 → check 变红 → required check 锁死合并按钮）
2. 掌握三件事的操作口径：promptfoo GitHub Action 的接法、3% 容忍线与基线对比脚本、prompt 和数据集的版本化纪律
3. 独立跑通一条完整链路：PR 触发自动评估、评论通过率对比表格、跌幅超 3 个百分点红灯阻断合并

## 概念讲解：为什么评估必须进 CI

评估这套东西，本周前五天你已经攒齐了：Day 1 的 30 条 golden dataset，Day 2 校准过的 judge，Day 4 的 promptfooconfig.yaml，昨天 DeepEval 的测试用例。本地一条命令，通过率立等可取。

问题是：这条命令，谁来保证每次改动之后真的被跑？

靠自觉的流程活不过两周。第一周新鲜，改 prompt 必跑；第二周赶需求，跑一半；第三周「就改了一句措辞，不至于吧」。直到某天线上事故回头查，才发现那个「不至于」的改动让参数幻觉翻了倍。评估工具一点没变，荒废的是人肉纪律——所有不进流程的质量手段，最后都走这条路。

传统代码早就趟过这个坑：没人靠「记得跑单测」保证质量，都是 CI 强制跑，红了不给合。评估是概率系统的测试套件，就该享受测试套件的待遇。单测防的是「改代码改坏了逻辑」，评估门禁防的是「改 prompt 改坏了行为」——后者更隐蔽，prompt 的 diff 里一句无害的措辞调整，人眼 review 根本看不出它让十条用例集体翻车。看不出来没关系，跑分看得出来。

到今天为止，EDD（评估驱动开发）的环就闭合了：改 prompt、换模型、动数据集 → 提 PR → CI 自动跑评估 → 与基线对比 → 跌幅超线则阻断 → 人在 diff 和跑分对比里做评审。「悄悄劣化」的前提是没人看见；门禁上完之后，劣化不但被看见，而且走不到 main。

整条链路的技术内核只有一句话：进程以非零码退出，GitHub 就把这次 check 标红；把这条 check 设为 main 的 required status check，红了就按不下合并按钮。今天的 YAML、脚本、阈值，全是为这一句话服务的。

## 核心知识

### 1. promptfoo GitHub Action：把评估挂到 PR 上

手跑评估是 `npx promptfoo eval`，进 CI 有两条路：自己拼 CLI 命令，或者用官方的 `promptfoo/promptfoo-action@v1`。Action 的增值有三样：自动感知 PR 里改了哪些 prompt 文件（只评变更的）、把结果整理成对比表格评论到 PR 下、内置各家 provider 的 key 注入口。今天的方案是两者混用——门禁那步用 CLI（要拿原始 JSON 自己算账），评论那步用 Action（要它的表格）。

完整 workflow 如下，落在 `.github/workflows/eval-gate.yml`，可照抄：

```yaml
name: Prompt 评估门禁

on:
  pull_request:
    paths:
      - 'prompts/**'
      - 'promptfooconfig.yaml'
      - 'evals/**'
      - '.github/workflows/eval-gate.yml'

jobs:
  eval-gate:
    runs-on: ubuntu-latest
    permissions:
      contents: read        # 拉代码
      pull-requests: write  # 允许在 PR 下评论
    steps:
      - uses: actions/checkout@v4

      - name: 全量跑评估，结果落盘
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          PROMPTFOO_FAILED_TEST_EXIT_CODE: '0'
        run: >
          npx --yes promptfoo@latest eval
          -c promptfooconfig.yaml
          -o evals/results.json
          --no-progress-bar
          --no-share

      - name: 回归门禁，跌幅超 3 个百分点就红
        run: node evals/gate.mjs

      - name: 把通过率对比评论到 PR
        if: always()
        env:
          PROMPTFOO_FAILED_TEST_EXIT_CODE: '0'
        uses: promptfoo/promptfoo-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config: promptfooconfig.yaml
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          prompts: 'prompts/**'
```

逐处拆开看。

`on.pull_request.paths`：只有 prompt、评估配置、数据集（evals/ 目录）变了才触发。改 README 的 PR 不烧评估的钱，这是成本控制的第一道闸。

`permissions` 里 `pull-requests: write`：Action 要往 PR 下评论，没这个权限它只能沉默。`GITHUB_TOKEN` 是每次运行自动发的临时身份，不用你管。

`OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}`：key 从仓库 Secrets 注入。第 7 周 Day 6 讲过的规矩在 CI 里的对应物——密钥不进代码，进环境；YAML 和 config 里只有占位符，仓库里搜不到半个 key。顺带一个安全细节：fork 出来的 PR 默认拿不到你的 Secrets，这是 GitHub 防你泄漏的机制，不是 bug。

`PROMPTFOO_FAILED_TEST_EXIT_CODE: '0'`：promptfoo 默认只要有一条用例 fail 就以非零码退出。我们要的是「和基线比跌幅」而不是「必须全绿」，所以先把这个默认退出行为关掉，红不红交给下一步的门禁脚本判。反过来，Action 自带一个 `fail-on-threshold` 输入（低于某百分比就红），那是绝对阈值，拦「绝对水平差」；今天要拦的是「相对劣化」，两者不冲突，先把相对的做出来。

评论那步的 `prompts: 'prompts/**'`：告诉 Action 只盯 prompts/ 下的变更文件，PR 里改了哪个 prompt 就评哪个，没改 prompt 的 PR 它自动跳过。`if: always()` 保证门禁红了评论也照样发——红灯的时候，作者最需要看到的就是那张对比表。

### 2. 门禁阈值：基线、3 个百分点、以及锁死合并的最后一步

门禁的账很简单：main 上存一个基线通过率，PR 里跑完和它比，跌幅超过容忍线就 exit 1。三个问题依次回答：基线怎么存、线画在哪、红灯怎么变成「合不了」。

基线存文件，`evals/baseline.json`，长这样：

```json
{
  "passRate": 86.67,
  "passes": 26,
  "total": 30,
  "updatedAt": "2026-09-15T22:10:00.000Z"
}
```

四个字段：基线跑分、过掉条数、总数、时间戳。它本身进 git，有版本历史，谁改的、为什么改，追溯得到。

线为什么画在 3 个百分点。概率系统的通过率天然有波动，同一份配置跑两遍，一两条边界用例来回翻是正常的，这是噪声；prompt 改动造成的整体下滑，这是信号。容忍线的职责是把两类错误同时压住：画在 0%，噪声天天报警，团队很快学会「红灯就重点跑一遍直到绿」，门禁的威信两个星期耗光；画在 10%，30 条的数据集上要 3 条稳定翻车才拦人，劣化早就溜进 main 了。3% 居中，而且有个干净的数学含义：30 条的集合上，1 条 = 3.3 个百分点，超过 3% 就是「哪怕一条用例稳定翻车也过不了门」——灵敏是刻意的。前提是噪声得先压住：Day 2 的二元判定 rubric、低温度 judge、缓存复现（同一 prompt 同一用例直接用旧结果，不再摇一次骰子）都是干这个的。数据集长到 100 条之后，1 条只值 1 个点，单条噪声翻车落进容忍线以内，3% 的含义自然升级成「3 条同时翻车才拦」——阈值不用动，让数据集去长大。

判账的脚本 `evals/gate.mjs`，全文可照抄：

```js
// 回归门禁：本次通过率比基线跌超过 3 个百分点就退出 1
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const THRESHOLD = 3; // 容忍的最大跌幅（百分点）
const resultsPath = 'evals/results.json';
const baselinePath = 'evals/baseline.json';

const { stats } = JSON.parse(readFileSync(resultsPath, 'utf8')).results;
// 报错/超时的用例不在 successes 里，按不过算，防止分母缩水抬高跑分
const total = stats.successes + stats.failures + (stats.errors ?? 0);
if (total === 0) {
  console.error('评估结果为空，门禁没法判');
  process.exit(1);
}
const passRate = (stats.successes / total) * 100;

// node evals/gate.mjs --update：把本次跑分写回基线（只在 main 上用）
if (process.argv.includes('--update')) {
  writeFileSync(
    baselinePath,
    JSON.stringify(
      {
        passRate: Number(passRate.toFixed(2)),
        passes: stats.successes,
        total,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`基线已更新：${passRate.toFixed(2)}%（${stats.successes}/${total}）`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error('找不到 evals/baseline.json，先在 main 上跑 --update 生成基线');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')).passRate;
const drop = baseline - passRate;

console.log(`基线 ${baseline.toFixed(2)}%，本次 ${passRate.toFixed(2)}%，跌幅 ${drop.toFixed(2)} 个百分点`);
if (drop > THRESHOLD) {
  console.error(`超过 ${THRESHOLD} 个百分点的容忍线，合并阻断。翻车用例见 PR 评论的对比表`);
  process.exit(1);
}
console.log('门禁通过');
```

关键一段是 `drop > THRESHOLD` 之后的 `process.exit(1)`：非零退出，workflow 那一步标红，整个 check 标红。但红灯只有配上 branch protection 才有牙齿：仓库 Settings → Branches → Add branch protection rule，branch name pattern 填 `main`，勾选 Require status checks to pass before merging，在搜索框里勾上 `eval-gate`（required check 的名字就是 job 名）。从这一刻起，红灯的 PR 合并按钮是灰的。这一步不设，前面所有 YAML 都是装饰——红了照样能点合并，纸糊的门禁。

### 3. 版本化与成本：prompt 是代码，评估要花钱

门禁能成立，前提是被门禁的对象都有版本。三样东西进 git，各归各位。

prompt 进 `prompts/` 目录，一个 prompt 一个独立文件，config 里用 `file://` 引用：

```yaml
# promptfooconfig.yaml 的 prompts 段，providers 和 tests 沿用 Day 4 的配置
prompts:
  - file://prompts/customer_service.txt
```

换来的是：prompt 改动变成一等公民的代码改动。PR 的 diff 里，prompt 文件的红红绿绿一行行摆着，「顺手调了句措辞」再也藏不住；出了劣化，git blame 一秒定位到是哪次提交改的哪一句。prompt 埋在业务代码字符串里的写法，这些全都做不到。

数据集进库，变更走 PR。Day 1 说「数据集即代码」，今天兑现：golden JSONL 在 `evals/` 里，加条目、改标注都开 PR。妙处在于自洽——数据集的变更 PR 本身就被这个门禁评估，你改错了标注，跑分立刻反映出来。基线文件也同理：它更新必须走 PR，评审看得见，标准不许偷换。

最后是钱。CI 每次全量跑，调用数 ≈ 用例数 ×（被测 1 次 + judge 1 次），30 条就是 60 次上下，再加评论那步的增量，一次 PR 推送一百次调用打不住。现在不疼，数据集到几百条、团队 PR 一多就疼了。三个习惯现在养成：judge 用小模型——Day 2 校准时一致率过了 80% 的 rubric，便宜模型执行得了；路径过滤加增量——无关 PR 不触发，评论只评变更文件；夜里全量对账——加一条 `on: schedule` 的 workflow 每晚在 main 上全量跑一遍并 `--update` 刷新基线，白天 PR 只做增量。第 21 周会专门算成本账，今天先把习惯立住。

## 动手任务：配通门禁，一步一步

手册任务：配置 promptfoo CI，prompt 或模型变更自动跑回归，通过率跌幅 >3% 自动阻断合并。拆成 5 步，全程约 40 分钟。

**第 1 步：拆 prompt 进目录。** 把 Day 4 配置里内联的 prompt 挪出来，存成 `prompts/customer_service.txt`，config 的 prompts 段改成 `file://` 引用（照核心知识第 3 节那段）。本地跑一遍 `npx promptfoo@latest eval -c promptfooconfig.yaml`，确认拆完和拆前通过率一致——整理动作本身不许引入回归。

**第 2 步：在 main 上生成基线。** 切到 main，跑全量并落盘，再写回基线：

```bash
npx --yes promptfoo@latest eval -c promptfooconfig.yaml -o evals/results.json --no-cache --no-share
node evals/gate.mjs --update
git add evals/baseline.json && git commit -m "chore: 记录评估基线"
```

`--no-cache` 是故意的：基线要新鲜数字，不吃缓存。打开 baseline.json 看一眼，四个字段都在。

**第 3 步：落两个文件，存一个 Secret。** 核心知识第 1 节的 workflow 存成 `.github/workflows/eval-gate.yml`，第 2 节的脚本存成 `evals/gate.mjs`，提交推上 main。然后到 GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret，名字 `OPENAI_API_KEY`，值填 key。Secret 只写名字不写值进任何文件。

**第 4 步：无害改动，验证绿灯。** 开个新分支，在 `prompts/customer_service.txt` 里做一处无害调整（比如把「请提供订单号」改成「麻烦提供订单号」），push 并开 PR。盯三件事：Action 自动跑起来；PR 评论里出现通过率对比表格；checks 里 `eval-gate` 是绿的。三件事都在，PR 体验和门禁链路就通了。

**第 5 步：故意改坏，验证红灯锁门。** 在同一个 PR 里把 prompt 中约束编造的那句删掉（类似「查不到的信息直接说查不到，禁止编造」），push。预期：参数幻觉类用例集体翻车，跑分跌幅远超 3%，`eval-gate` 红掉。此时按第 2 节末尾的步骤设置 branch protection，把 `eval-gate` 设为 required check，回到 PR 确认合并按钮灰掉。最后恢复那句 prompt，push，看它转绿，合并。你亲眼看过一次红灯锁门，这套门禁才算真的存在。

::: tip 两个名字别搞混
required check 搜索框里填的是 job 名 `eval-gate`，不是 workflow 名「Prompt 评估门禁」。组织仓库开不了 branch protection 的话，找仓库管理员，这个设置默认在管理员手里。
:::

## 常见踩坑

**坑 1：workflow 写完就收工，不设 branch protection。** 最常见也最致命。Action 红了照样能点合并，门禁全程只是个表情包。整条链路的牙齿在 Settings → Branches 的 required status checks，这步没做，前面的 YAML、脚本、基线全是装饰。

**坑 2：阈值设 0%，追求必须全绿。** 概率系统接受区间思维，不接受洁癖。0 容忍意味着 judge 一丝抖动就红灯，团队两周内学会的应对是「重点跑一遍直到绿」，门禁从此只有装饰价值。允许 3 个百分点的噪声带，换来每次红灯都是真信号。抖动实在压不住时，Action 的 `repeat: 3` 加 `repeat-min-pass: 2`（每条用例跑三遍过两遍才算过）是正规的抑噪手段。

**坑 3：API key 写进 YAML 或 config。** 呼应第 7 周 Day 6 的老规矩：密钥不进代码。CI 里的对应做法是 Secrets 注入，YAML 里只有 `${{ secrets.OPENAI_API_KEY }}` 这个占位符。别图方便把 key 写死在 provider 配置里，推上公开仓库的那一刻就是事故。

**坑 4：基线更新时机乱来。** 在功能分支上跑 `--update`，等于把一份没评审过的跑分偷换成新标准，劣化从此查无此案。规矩一条：基线只反映 main。大改动（扩数据集、换模型）需要挪基线时，把 baseline.json 的更新放进同一个 PR，让人评审。另外基线不会永远有效——模型提供方悄悄更新版本，你什么都没改，跑分也会漂，所以夜间全量重跑刷新基线不是锦上添花，是对账。

**坑 5：成本和可复现性当不存在。** 两笔账。成本：评估调用量随用例数线性涨，PR 又是高频事件，小模型 judge、路径过滤、增量评论、夜间全量这四件从今天就做，别等账单教你做人。可复现：workflow 里 `promptfoo@latest` 每次拉最新版，版本升级可能改变判定行为，两天的跑分就不可比了——团队项目把版本锁死（比如 `promptfoo@0.118.0` 这种写法），升级单独走 PR。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. 为什么「评估会跑」和「评估总被跑」是两回事？人肉流程是怎么荒废的？

::: details 参考答案
「会跑」是有工具和命令，「总被跑」是有流程强制。人肉流程按新鲜感衰减：第一周必跑、第二周跑一半、第三周「不至于吧」，两周左右荒废。门禁用机制替代自觉：PR 触发自动评估，跌幅超线 exit 非零，required check 锁死合并按钮——质量手段不进流程，最后都会走这条路。
:::

2. 3 个百分点的容忍线是怎么权衡的？设成 0% 和 10% 各坏在哪？

::: details 参考答案
它要同时压住两类错误：把噪声当信号（误报）和把信号当噪声（漏报）。0% 天天误报，团队学会无视红灯，门禁威信耗尽；10% 在 30 条上要 3 条稳定翻车才拦，劣化早溜了。3% 在 30 条上等价于单条稳定翻车即拦（1 条 = 3.3 个点），灵敏是刻意的，前提是用二元 rubric、低温度 judge、缓存复现把噪声压住；数据集到 100 条后 1 条只值 1 个点，阈值含义自动升级为多条翻车才拦，不用改数。
:::

3. workflow 里 `PROMPTFOO_FAILED_TEST_EXIT_CODE: '0'` 是干什么的？不设会怎样？

::: details 参考答案
它关掉 promptfoo「有一条 fail 就非零退出」的默认行为，把红不红的裁判权交给后面的基线对比脚本。不设的话，任何单条用例失败都会让那一步直接标红，门禁退化成「必须全绿」——对概率系统来说这是天天误报，正是上一问里 0 容忍的死法。
:::

4. 门禁真正生效的最后一步是什么操作？没做这步，前面的一切算什么？

::: details 参考答案
在仓库 Settings → Branches 给 main 加 branch protection rule，把 `eval-gate` 这个 job 设为 required status check。没做这步，红灯的 PR 照样能合并，整套 workflow 只是挂在 PR 上的表情包，纸糊的门禁。
:::

5. prompt 和数据集版本化之后，一次「改 prompt」的 PR 里会出现什么？比把 prompt 埋在代码字符串里好在哪？

::: details 参考答案
会出现三样东西：prompt 文件的行级 diff、（若动了数据集）JSONL 的 diff、Action 评论的通过率对比表格。好处是改动可评审（diff 一行行看得见）、可追溯（git blame 定位到具体提交的具体一句）、可拦截（变更 PR 本身被门禁评估）。埋在代码字符串里的 prompt 三样全无，「顺手调一句」既看不见也拦不住。
:::

## 延伸阅读

- [promptfoo：GitHub Action 集成](https://www.promptfoo.dev/docs/integrations/github-action/)，今天用的 Action 的官方文档，输入项和缓存配置的权威出处
- [GitHub Docs：受保护分支](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)，branch protection 与 required status checks 的官方说明，门禁的最后一步照着这里点
- [GitHub Docs：在 Actions 中使用 Secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions)，Secrets 的创建、注入范围和 fork PR 的安全行为，第 7 周 Day 6 那套纪律的 CI 版

今天的 workflow、`gate.mjs` 和 `baseline.json` 留好：明天 Day 7 收本周的尾，把评估从离线搬到在线——10% 流量采样、差 trace 回流数据集的设计文档。至此 EDD 的环闭合了：数据集是尺，评估是量，今天这颗门禁螺丝，把量尺焊死在了流水线上。
