# 第 8 周：云部署 + Nginx + 可观测性入门

> 所属阶段：后端工程化 + 数据 + 部署（第 5–8 周）

## 本周目标

掌握云服务器部署、Nginx 反向代理与 HTTPS 证书配置，并接入结构化日志、Prometheus / Grafana 指标监控与健康检查，完成应用上云。

阶段二里程碑要求——确认：认证 + Redis + Docker + CI/CD + 云部署 + 监控全链路。

## 本周日程

| 天 | 学习内容 | 动手任务 | 当日产出 |
| --- | --- | --- | --- |
| Day 1 | 云服务器基础：SSH、防火墙、安全组 | 在云服务器上安装 Docker + Docker Compose | 可用的云环境 |
| Day 2 | Nginx 反向代理 + HTTPS | 配置 Nginx 代理 api 和 web，用 Certbot 申请 Let's Encrypt 证书 | HTTPS 可访问 |
| Day 3 | 部署全栈应用到云服务器 | 用 GitHub Actions 的 SSH 步骤自动部署到云服务器 | 自动部署链路 |
| Day 4 | 日志：结构化日志 + 日志收集 | 用 `pino` 输出 JSON 日志，配置 Nginx access log | 结构化日志 |
| Day 5 | 指标：Prometheus + Grafana 入门 | 用 `prom-client` 暴露 `/metrics`，Prometheus 抓取，Grafana 画图 | 基础监控面板 |
| Day 6 | 健康检查 + 优雅关闭 | 实现 `/health` 端点，配置 NestJS 优雅关闭 | 健康检查端点 |
| Day 7 | 阶段二里程碑验收 + 周复盘 | 确认：认证 + Redis + Docker + CI/CD + 云部署 + 监控全链路 | 里程碑项目 v2 + 周记 |

## 教程进度

- ✅[Day 1 路 云服务器](/week08/day1)
- ✅[Day 2 路 Nginx 与 HTTPS](/week08/day2)
- ✅[Day 3 路 自动部署](/week08/day3)
- ✅[Day 4 路 结构化日志](/week08/day4)
- ✅[Day 5 路 监控入门](/week08/day5)
- ✅[Day 6 路 健康检查与优雅关闭](/week08/day6)
- ✅[Day 7 路 阶段二里程碑](/week08/day7)

## 本周参考

cloud-native-fullstack-course 的 Prometheus/Grafana/OpenTelemetry 模块可重点参考。
