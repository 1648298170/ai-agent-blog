# 第 9 周 · Day 1：Python 工程环境——venv、Poetry 与项目骨架

> 对应手册任务：学习「Python 环境：venv/poetry、pip、项目结构」，动手创建 `agent-service` 项目并用 Poetry 管理依赖，当日产出项目骨架。本篇只解决一个问题：一个写惯了 Node 的工程师切到 Python 时，环境隔离、依赖声明、目录结构、代码风格各自对应哪件旧工具，第一天就把地基打对，让阶段三所有 Agent 代码都长在这套骨架上。

## 今日目标

1. 说得清 Python 为什么必须用虚拟环境，它和 npm 的 node_modules 隔离思路差在哪
2. 掌握 Poetry 的日常操作：init、add（含 dev 依赖）、lock、固定 Python 版本
3. 独立搭出 agent-service 骨架：app/ 包 + tests/ + ruff 检查通过，模块导入一次不踩坑

## 概念讲解：为什么 Python 离不开虚拟环境

先回想 Node 的世界。`npm install axios` 装到哪？当前项目的 `./node_modules`。十个项目十个 node_modules，互不打扰，npm 天生就这么设计。你从没操心过「A 项目的 axios 会不会覆盖 B 项目的 axios」，因为压根不存在共享的安装位置。

Python 的默认行为正好相反。`pip install fastapi` 装进的是这个 Python 解释器自己的 site-packages 目录，机器上所有项目共享这一份，相当于 npm 只有 `install -g` 一种模式。两个后果立刻出现。第一，版本互相覆盖：项目 A 要 fastapi 0.110，项目 B 要 0.115，后装的顶掉先装的，A 什么时候坏的都不知道。第二，全局越滚越大：今天装个爬虫库，明天装个命令行工具，一年后 `pip list` 几百个包，哪些属于哪个项目已经说不清，删也不敢删。

虚拟环境（venv）就是来解决这个问题的：给项目造一份私有的 site-packages。`python -m venv .venv` 在项目下生成一个 `.venv` 目录，里面有一份独立的解释器和一套空的包目录，「激活」之后，python 和 pip 都指向这份私有副本，与全局再无关系：

```powershell
python -m venv .venv          # 创建
.\.venv\Scripts\Activate.ps1  # 激活（PowerShell 写法，cmd 用 activate.bat）
deactivate                    # 退出，回到全局
```

差异的本质一句话：node_modules 是「依赖跟项目走」，天然的，不需要你做任何事；Python 是「依赖跟环境走」，环境要你手动创建和切换。npm 把这一步隐掉了，Python 把它显式交到你手上，所以每个 Node 背景的新手都要在第一天补这一课。

补课的工具不止一个，先认全再动手。pip 是官方安装器，相当于一个不带 lock 文件的 npm install，只管装，不管隔离也不管记录。venv 是标准库自带的隔离方案，只管隔离，不管依赖清单。Poetry 把两件事合起来：自动建虚拟环境、维护 pyproject.toml（项目清单）和 poetry.lock（版本锁定），对标 npm + package.json + package-lock.json 的整套体验。另有后起之秀 uv，和 ruff 同一家公司出品，速度极快，知道有它即可，本手册统一用 Poetry。

## 核心知识

### 1. pyproject.toml：Python 版的 package.json

Python 生态以前用 requirements.txt 声明依赖，就是一个纯包名列表，没有标准位置放项目元信息。现在 PEP 621 把一切统一进 pyproject.toml。先看全景对照表，今天遇到任何「这在 Node 里是什么」都可以回来查：

| 这件事 | Node 世界 | Python 世界 |
| --- | --- | --- |
| 项目清单 | package.json | pyproject.toml |
| 锁定文件 | package-lock.json | poetry.lock |
| 依赖目录 | node_modules，跟项目走，可删可重建 | .venv，跟机器走，删了 poetry install 重建 |
| 恢复依赖 | npm install | poetry install |
| 加依赖 | npm install fastify | poetry add fastapi |
| 加开发依赖 | npm install -D vitest | poetry add --group dev pytest |
| 在项目环境里跑命令 | npx tsc / npm run dev | poetry run python -m app.main |
| 声明解释器版本 | "engines": { "node": ">=20" } | requires-python = ">=3.12" |
| lint + format | ESLint + Prettier 两个工具 | ruff 一个工具 |

字段级的对应看一份真实的 pyproject.toml（动手任务做完你就有一份，下面是关键部分，生成内容以你操作时的解析结果为准）：

```toml
[project]
name = "agent-service"
version = "0.1.0"
description = "阶段三的 Agent 服务"
requires-python = ">=3.12"
dependencies = [
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
]

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"
httpx = ">=0.27"
ruff = ">=0.6"
```

两处值得注意。`dependencies` 写在 [project] 表里，这是 PEP 621 标准写法，Poetry 2 起的新项目都用它；老教程里依赖写在 [tool.poetry.dependencies] 下，那是 1.x 的私有格式，见到别慌，是同一件事。dev 依赖不是 Python 标准概念，属于 Poetry 的「依赖组」，所以永远住在 [tool.poetry.group.dev.dependencies] 里，作用等同 devDependencies：开发和测试要，生产不要。

poetry.lock 和 package-lock.json 一个脾气：记录全部依赖（含依赖的依赖）的精确版本，提交进 git，团队每个人 poetry install 出来的环境完全一致。日常不用手动碰它，poetry add 会自动更新；只有当你手改了 pyproject 或想刷新时才跑一次 `poetry lock`。

### 2. 目录结构与 `__init__.py`

今天要搭的骨架长这样（`.venv` 也在根目录下，由 Poetry 自动创建，图中省略）：

```
agent-service/
├─ app/
│  ├─ __init__.py
│  ├─ main.py
│  └─ core/
│     ├─ __init__.py
│     └─ config.py
├─ tests/
│  ├─ __init__.py
│  └─ test_main.py
├─ pyproject.toml
├─ poetry.lock
├─ .python-version
├─ .gitignore
└─ README.md
```

对照 Node：app/ 相当于 src/，业务代码全住这；tests/ 放测试，pytest 只收集 `test_` 开头的文件，相当于 vitest 默认收 `*.test.ts`。

最陌生的是 `__init__.py`：一个通常为空的文件，作用是把文件夹标记成一个「包」。JS 里目录天然就是模块路径，Python 没有这个标记的目录虽然在 3.3 之后也能被导入（叫命名空间包），但省掉它迟早踩坑，最典型的是 pytest 碰到两个同名测试文件时报 import 冲突。规矩就一条：每个包目录都放一个空 `__init__.py`。它也不必永远为空，包被 import 时它会执行，可以用来对外暴露公共 API，现在不用管。

### 3. 导入规则：包内一律绝对导入

JS 的 import 写的是文件路径，`import { x } from "./core/config"`，从当前文件出发找。Python 的 import 写的是包名，`from app.core.config import settings`，从项目根出发，由 sys.path 负责找。这是新手第一天必踩的坑，先把规矩立死：本项目内一律绝对导入，从顶层包名 app 写起。

相对导入也存在：`from .config import settings` 表示同包的 config，`from ..models import User` 表示上一层的 models。它们只在「文件被当作包成员导入」时才成立，你直接运行这种文件会当场报错，后面踩坑一节细说。记住结论：写绝对导入，出了问题好排查。

### 4. ruff 与 Python 版本固定

ruff 是用 Rust 写的 Python lint + format 工具，一个二进制顶 ESLint 加 Prettier 两个，顺手还做 import 排序。lint 部分抓未使用变量、可疑写法；format 部分统一引号和换行。配置直接写进 pyproject.toml：

```toml
[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "W", "I"]
```

E/W 是代码风格，F 是 pyflakes 抓的实质问题，I 是 import 排序，相当于编辑器里的 organize imports。常用命令就两条：`ruff check .` 查问题，`ruff format .` 格式化，对照 `npm run lint` 和 `npm run format`。

版本固定做两层。`requires-python = ">=3.12"` 写在 pyproject 里，声明「本项目需要 3.12 以上」，相当于 engines 字段，但它只是声明，不会替你切换解释器。再放一个 .python-version 文件，内容就一行 `3.12`，pyenv 和 Poetry 都认它，用它决定项目实际用哪个解释器。两层一起，同事 clone 下来 poetry install 一下，环境和你完全一致。本手册全程 Python 3.12+。

## 动手任务：搭出 agent-service 骨架，一步一步

手册任务：创建 agent-service 项目，用 Poetry 管理依赖。拆成 5 步，全程约 30 分钟。

**第 1 步：装 Python 3.12+ 和 Poetry。** 先确认版本：

```powershell
python --version   # Python 3.12.x 或更高即可；命令不存在就去 python.org 装，勾上 Add python.exe to PATH
```

装 Poetry 用官方安装器，装完重开一个终端让 PATH 生效：

```powershell
(Invoke-WebRequest -Uri https://install.python-poetry.org -UseBasicParsing).Content | python -
poetry --version
```

**第 2 步：建项目、初始化清单。**

```powershell
mkdir agent-service
cd agent-service
poetry init
```

init 是一串问答：包名 agent-service，版本 0.1.0，描述随意，作者回车用默认，license 跳过。其中「Compatible Python versions」这题关键，回答 `>=3.12`。后面问交互式定义依赖，一路选 no，依赖用 add 加，比手填准确。生成 pyproject.toml 后，把解释器也钉住：

```powershell
Set-Content .python-version "3.12"
```

注意别用 `echo "3.12" > .python-version`，PowerShell 5.1 的 `>` 会写出带 BOM 的 UTF-16，工具读不出来。

**第 3 步：加依赖。** 运行依赖加 fastapi 和 uvicorn，阶段三的 Agent 服务会一直用它们；开发依赖加 pytest、httpx（跑 FastAPI 测试要用）和 ruff：

```powershell
poetry add fastapi "uvicorn[standard]"
poetry add --group dev pytest httpx ruff
```

poetry add 每次做三件事：写进 pyproject、更新 poetry.lock、装进虚拟环境。此刻虚拟环境已经自动建好了，你没有手动碰过 venv，这就是 Poetry 存在的意义。验证一下：

```powershell
poetry run python -c "import fastapi; print(fastapi.__version__)"
```

能打印版本号，说明依赖进了项目环境，而且清单、锁文件、环境三样是同步的。

**第 4 步：建目录和代码。**

```powershell
mkdir app, tests
mkdir app\core
New-Item -ItemType File app\__init__.py, app\core\__init__.py, tests\__init__.py
```

写入 `app/core/config.py`：

```python
SERVICE_NAME = "agent-service"
```

写入 `app/main.py`（FastAPI 的细节后面几天展开，今天只看结构）：

```python
from fastapi import FastAPI

from app.core.config import SERVICE_NAME

app = FastAPI(title=SERVICE_NAME)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

注意 main.py 里的导入是从顶层包写起的绝对导入。写入 `tests/test_main.py`：

```python
from fastapi.testclient import TestClient

from app.main import app


def test_health() -> None:
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
```

顺手把不该进 git 的东西挡在外面：

```powershell
Set-Content .gitignore @(".venv/", "__pycache__/", ".pytest_cache/", ".ruff_cache/")
```

**第 5 步：跑通三件事。** 先测试：

```powershell
poetry run pytest
```

再起服务，另开一个终端请求它：

```powershell
poetry run uvicorn app.main:app --port 8000
Invoke-RestMethod http://127.0.0.1:8000/health   # 应显示 ok
```

`app.main:app` 用的就是同一套导入规则：模块路径 app.main，里面的变量 app。最后过 ruff：把核心知识第 4 节那段 [tool.ruff] 配置贴到 pyproject.toml 末尾，然后：

```powershell
poetry run ruff check .
poetry run ruff format .
```

check 零报错、format 无改动，骨架完成。当日产出就是整个 agent-service 目录。

::: tip poetry run 是什么
「在项目虚拟环境里执行命令」。以后凡是跑 python、pytest、ruff，前面都带 poetry run，等价于 npx。忘了带会怎样？命令会落回全局环境，要么找不到包，要么用错版本，见到报错先检查是不是漏了它。
:::

## 常见踩坑

**坑 1：手动激活虚拟环境被 PowerShell 拦下。** 报错「在此系统上禁止运行脚本」，Windows 默认策略不让跑 Activate.ps1。放开一次即可，只对当前用户生效，不需要管理员：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

不过用了 Poetry 之后很少手动激活，poetry run 已经帮你进了环境，这招留作备用。

**坑 2：cd 进 app 再 python main.py，报 ModuleNotFoundError: No module named 'app'。** Python 直接跑脚本时，是从脚本所在目录找导入的，你人在 app 里面，app 这个包根本不可见。规矩：永远在项目根目录执行，用 `poetry run python -m app.main` 的 -m 形式。这个报错会陪你整个新手期，见到它的第一反应就是「我是不是没在根目录」。

**坑 3：图省事写相对导入，直接运行就炸。** `from .config import ...` 被当包导入时没事，一旦你直接 python 跑这个文件，报 ImportError: attempted relative import with no known parent package。结论回到那条规矩：项目内一律绝对导入，相对导入留给「必然被当包导入」的场景，拿不准就别用。

**坑 4：裸 pip install 装依赖。** pip 装了但 pyproject 不知道，同事 poetry install 之后缺包；而且裸装进的是当前环境，全局污染的老问题又回来了。项目里的依赖必须 poetry add 进来，让清单、锁文件、环境三样同步。pip 在本手册只出场一次：第 1 步装 Poetry 那回。

**坑 5：把 .venv 当 node_modules 提交或拷贝。** .venv 里记录的是绝对路径，还绑着操作系统，拷到别人机器上基本不能用。对待它的心态和 node_modules 一样：不进 git，删了就 poetry install 重建，十秒钟的事。区别只是 node_modules 严格属于项目，.venv 严格属于这台机器。

## 自测问题

先自己答，再展开对照。答不上来的，回对应小节看一遍。

1. node_modules 和 .venv 都做隔离，思路差在哪？

::: details 参考答案
node_modules 是「依赖跟项目走」，npm 默认每项目一份，不需要你做任何事；Python 的依赖默认装进解释器的 site-packages，全局共享，venv 是手动给项目造的私有环境，靠激活或 poetry run 切换。前者隔离是默认，后者隔离是选择。
:::

2. pyproject.toml、poetry.lock、.venv，谁进 git？分别对应 Node 世界的什么？

::: details 参考答案
前两个进，.venv 不进。对应关系：pyproject.toml 对 package.json，poetry.lock 对 package-lock.json，.venv 对 node_modules（但 .venv 不可拷贝，只能重建）。
:::

3. poetry add fastapi 背后做了哪三件事？如果手动从 pyproject 里删掉这个依赖，环境里的 fastapi 会自动消失吗？

::: details 参考答案
三件事：写入 pyproject 的 dependencies、更新 poetry.lock、装进虚拟环境。手动删文件只改了清单，环境里的包还在。要对齐就跑 poetry lock 重新生成锁文件，再 poetry install（想让环境里多出来的包也清掉，加 --sync）。
:::

4. from app.core.config import settings 为什么从 app 写起？什么时候才允许 from .config import？

::: details 参考答案
Python 的导入按包名从项目根解析，和 JS 的文件相对路径不同，绝对导入从顶层包写起才能被稳定找到。相对导入只适合包内模块之间、且必然被当包导入的引用；直接运行的脚本、入口文件、测试一律不要用。
:::

5. requires-python = ">=3.12" 和 .python-version 各管什么？

::: details 参考答案
前者是声明，写在 pyproject.toml，告诉工具链和用户「低于 3.12 跑不了」，相当于 package.json 的 engines；后者是选择，内容一行 3.12，pyenv 和 Poetry 读它决定实际用哪个解释器，相当于 Node 生态的 .nvmrc。一个管「行不行」，一个管「用哪个」。
:::

## 延伸阅读

- [Poetry 官方文档](https://python-poetry.org/docs/)，本篇所有命令的原始出处，Basic usage 一章值得通读
- [PEP 621：在 pyproject.toml 里存项目元数据](https://peps.python.org/pep-0621/)，[project] 表每个字段的定义
- [ruff 官方文档](https://docs.astral.sh/ruff/)，规则表在 Rules 一节，E/F/W/I 之外按需再加
- [venv 标准库文档](https://docs.python.org/3/library/venv.html)，想手动体验一次创建/激活/停用看这里

今天的产出 agent-service 骨架留好。阶段三的所有 Agent 代码都在这个项目里长大，就像阶段一从 [Day 1 的泛型文件](/week01/day1) 起步一样，地基今天打完，明天开始往上砌墙。
