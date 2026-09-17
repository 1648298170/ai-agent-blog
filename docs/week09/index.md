# 第 9 周：Python 核心 + Pydantic

> 所属阶段：Python + FastAPI + Agent 核心（第 9–13 周）

## 本周目标

掌握 Python 类型注解、asyncio 异步编程、Pydantic v2 模型校验与配置管理，为后续 Agent 服务开发打好 Python 语言底座。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | Python 环境：venv/poetry、pip、项目结构 | 创建 `agent-service` 项目，用 poetry 管理依赖 | 项目骨架 |
| Day 2 | Python 类型注解：`Optional/Union/List/Dict/Literal` | 写一个带类型注解的数据处理函数，用 mypy 检查 | 类型注解通过 |
| Day 3 | asyncio 基础：`async/await`、`asyncio.gather` | 写 3 个异步函数模拟 API 调用，用 `gather` 并发执行 | `async_demo.py` |
| Day 4 | Pydantic v2 基础：BaseModel、Field、校验 | 定义 `UserCreate` 模型，含 email 格式和年龄范围校验 | Pydantic 模型 |
| Day 5 | Pydantic 嵌套模型 + 配置管理 | 用 `pydantic-settings` 管理环境变量配置 | `config.py` |
| Day 6 | Python 装饰器 + 上下文管理器 | 写一个计时装饰器和一个数据库连接上下文管理器 | 两个工具 |
| Day 7 | 周复盘 + 整理 | 用 Python 重写 Day 5 周的一个 JS 工具函数，对比差异，写周记 | 对比笔记 + 周记 |

## 教程进度

- ✅[Day 1 · Python 环境](/week09/day1)
- ✅[Day 2 · 类型注解](/week09/day2)
- ✅[Day 3 · asyncio](/week09/day3)
- ✅[Day 4 · Pydantic 基础](/week09/day4)
- ✅[Day 5 · 配置管理](/week09/day5)
- ✅[Day 6 · 装饰器与上下文](/week09/day6)
- ✅[Day 7 · 周复盘](/week09/day7)
