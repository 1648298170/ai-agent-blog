# 第 7 周：Docker + CI/CD

> 所属阶段：后端工程化 + 数据 + 部署（第 5–8 周）

## 本周目标

掌握 Docker 镜像 / 容器与 docker-compose 多服务编排，并用 GitHub Actions 搭建 lint / test / build / push 镜像的完整 CI/CD 流水线。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | Docker 基础：镜像、容器、Dockerfile | 为 NestJS 写一个多阶段 Dockerfile，构建并运行 | `api.Dockerfile` |
| Day 2 | docker-compose：多服务编排 | 写 `docker-compose.yml` 编排 api + postgres + redis | 一键启动全栈 |
| Day 3 | 前端 Docker 化 + Nginx 静态服务 | 为 Next.js 写 Dockerfile，用 Nginx 服务静态资源 | `web.Dockerfile` + Nginx 配置 |
| Day 4 | GitHub Actions 基础：workflow/on/jobs/steps | 写一个 CI workflow，在 push 时跑 lint + test | `.github/workflows/ci.yml` |
| Day 5 | CD：构建镜像 + 推送到 registry | 在 CI 中增加 build + push 到 GitHub Container Registry | 自动构建镜像 |
| Day 6 | 环境变量管理 + 密钥注入 | 用 GitHub Secrets 注入数据库密码，写 `.env.example` | 安全配置 |
| Day 7 | 周复盘 + 整理 | 从零走一遍 push → CI → 镜像 → 部署的完整流程，写周记 | 流程文档 + 周记 |

## 教程进度

- ✅[Day 1 路 Dockerfile](/week07/day1)
- ✅[Day 2 路 compose 编排](/week07/day2)
- ✅[Day 3 路 前端容器化与 Nginx](/week07/day3)
- ✅[Day 4 路 GitHub Actions](/week07/day4)
- ✅[Day 5 路 镜像推送](/week07/day5)
- ✅[Day 6 路 密钥管理](/week07/day6)
- ✅[Day 7 路 周复盘](/week07/day7)

## 本周参考

30 天 DevOps 路线中 Day 6 是 Docker 基础，Day 21–23 是 CI/CD 和 GitHub Actions。
