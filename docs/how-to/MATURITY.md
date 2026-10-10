# MATURITY · 模块成熟度矩阵

> 教学模板的诚实声明：每个模块离生产还差几步。三档定义——
> **Demo**：跑通概念，重启丢状态，单进程；**单实例**：单机可长期跑（持久化/容错有了）；**生产前置**：上生产前还差什么。
> 「诚实边界」比「什么都能」更值钱——上生产前按这张表补课。

---

## 内核与能力件

| 模块 | 档位 | 现状 | 生产前置（缺什么） |
|---|---|---|---|
| `agent-loop.ts` | 单实例 | maxSteps 保险丝、abort 中止、错误回灌、入参校验闸 | 无重试/退避（模型调用失败即失败）；无并发步数熔断指标 |
| `llm.ts` | 单实例 | OpenAI 兼容网关一键切换、懒创建 | 无多厂商故障切换/限流；无 token 用量统计 |
| `config.ts` | 单实例 | 白名单 + 双来源合并 | 密钥管理建议接 secrets 管理器（而非 .env 文件） |
| `trace.ts` | Demo | stderr + 图标，开关控制 | 无结构化输出（JSON 行）、无 trace-id 贯穿、无采样 |
| `tools/idempotency` | Demo | 进程内存 TTL 缓存，重启即清 | 跨实例部署需 Redis SETNX 版（接口已留，实现未写） |
| 审批登记簿（api 层） | Demo | 进程内存，重启 = 全部过期 | 同上；多实例需共享登记簿 |
| `evals/` | 单实例 | 76 例版本化数据集 + 基线；CI 已接 Tier 1 门禁 | Tier 2/3 未进 CI（需 key）；在线评估（真实流量回流）未做 |

## 存储（同接口多实现，env 一键切换）

| 存储 | 档位 | 现状 | 生产前置 |
|---|---|---|---|
| RagStore `json` | Demo | `.data/kb-store.json` 快照 | 仅单进程，无并发写保护 |
| RagStore `memory` | Demo | 进程内 | 重启全丢 |
| RagStore `pgvector` | 单实例 | HNSW 检索、幂等建表 | 连接池调优、备份策略 |
| SessionStore `memory` | Demo | 进程内 Map | 重启失忆（刻意默认） |
| SessionStore `redis` | 单实例 | TTL 24h 续期、压缩分布式锁 | 多 Redis 哨兵/集群配置 |
| PreferenceStore `pg` / EpisodicStore `pgvector` | 单实例 | 行级 upsert / 向量召回 | 同 pgvector 行 |

## 产品线与安全

| 模块 | 档位 | 现状 | 生产前置 |
|---|---|---|---|
| `service/` | 单实例 | 硬规则 + 三分类 + 降级转人工 | 会话恢复体验（CLI 重启失忆） |
| `guardrails/` | 单实例 | PII 脱敏、注入扫描、审计账本（JSONL 文件） | 审计账本进只追加存储；注入黑名单定期更新 |
| MCP 集成 | 单实例 | stdio 子进程桥 | 远程 MCP（SSE/HTTP 传输）未接 |
| web/api | 单实例 | SSE 流式、审批 UI、历史面板 | 认证、多租户 RBAC、限流（week20 已声明未做） |

## 使用建议

1. **学习/演示**：全部 Demo 档即可用，零配置（`.env` 只需 LLM key）。
2. **单机自用/内网工具**：把存储开关切到 `pgvector`/`redis`（`pnpm infra:up`），就是单实例档。
3. **对外服务**：按「生产前置」列逐项补课——那张列就是你的待办清单。
