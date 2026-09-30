// dependency-cruiser.cjs —— 引擎分层架构的机械化门禁（版本：dependency-cruiser 18.x）
//
// 分层地图（与 packages/engine/src 实际目录一一对应，规则从真实 import 关系反推而来）：
//
//   kernel（根文件）  agent-loop.ts / config.ts / llm.ts / trace.ts / json-utils.ts / types.ts / index.ts / typings/
//   L1  rag/          检索零件（最底层特性，谁都可以用）
//   L2  tools/ memory/ guardrails/   工具与记忆（只准往下用 rag）
//   L3  service/ mcp/ evals/         产品层（可用 L2 + L1）
//
// 约定：模块只能 import 【本层文件 + 更低层 + kernel + 外部包】；任何向上的边都是违规。
// 注意：kernel 根桶文件 index.ts 是包的公共出口，re-export 特性层不算违规（见引擎-agent-loop 规则的豁免说明）。
//
// 已核实的存量豁免（2026-09 逐文件核对 src 后确认，改代码前先更新这里的清单）：
//   - evals/runner.ts、evals/scorers/trajectory.ts、service/workers.ts 合法 import 了
//     kernel 的 agent-loop.ts（评测与工人都要跑 runToolLoop）——因此「禁止 import agent-loop」
//     规则只约束 rag/tools/memory/guardrails/mcp 五个层，不放行 evals 与 service。
//   - rag/ingest.ts（红队加固轮 H1，修 E3 知识库投毒）合法 import 了
//     guardrails/validate.ts（inspectTextInput 纯函数）与 guardrails/audit.ts（JSONL
//     纯追加日志）——入库闸是 SECURITY.md 加固清单 R1.1 指定的修复位置；两个目标模块
//     均零状态、不反向依赖 rag，不会产生传递性循环。因此「rag 禁止向上依赖」规则
//     对 guardrails 的这两个纯函数模块放行（to.pathNot 豁免），rag 依赖 L2 其余模块
//     与整个 L3 仍然全部禁止。
//
// 运行：pnpm lint:deps（退出码 0 = 通过，1 = 有违规）

const path = require("node:path");

// 分层正则（路径相对 agent-app 工作目录，dependency-cruiser 统一用正斜杠）
const RAG = "^packages/engine/src/rag/";
const L2 = "^packages/engine/src/(tools|memory|guardrails)/";
const L3 = "^packages/engine/src/(service|mcp|evals)/";
const AGENT_LOOP = "^packages/engine/src/agent-loop\\.ts$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      // 为什么：循环依赖会让模块初始化顺序不确定，运行期才爆「undefined 导出」，
      // 而且会让分层约束整体失效（A→B→A 之后「谁在上谁在下」失去意义）。
      name: "引擎-禁止循环依赖",
      severity: "error",
      comment: "packages/engine/src 内不允许任何循环依赖：初始化顺序不可控，分层也随之失效。",
      from: { path: "^packages/engine/src/" },
      to: { circular: true },
    },
    {
      // 为什么：rag 是最底层特性（L1）。它一旦反向依赖上层，所有依赖 rag 的层
      // 都会被拖进传递性循环，检索零件也就再也无法单独复用/单独测试。
      // 豁免（红队加固轮 H1）：rag/ingest.ts → guardrails/validate.ts + audit.ts
      // （入库闸指定位置，见文件头部豁免清单）——两个纯函数模块放行，其余 L2/L3 仍禁止。
      name: "引擎-rag禁止向上依赖",
      severity: "error",
      comment: "rag 是 L1 最底层：禁止依赖 L2（tools/memory/guardrails）与 L3（service/mcp/evals）；唯一豁免是 ingest.ts 的入库闸依赖 guardrails 的 validate/audit 两个纯函数模块。",
      from: { path: RAG },
      to: { path: [L2, L3], pathNot: "^packages/engine/src/guardrails/(validate|audit)\\.ts$" },
    },
    {
      // 为什么：L2（工具/记忆/护栏）是可独立复用的零件层；依赖 L3 产品层
      // 意味着「零件依赖整车」，换一个产品线零件就报废了。
      name: "引擎-L2禁止依赖L3",
      severity: "error",
      comment: "tools/memory/guardrails 是 L2 零件层：禁止依赖 L3 产品层（service/mcp/evals）。",
      from: { path: L2 },
      to: { path: L3 },
    },
    {
      // 为什么：guardrails 是「纯函数护栏」（PII 掩码 / 入参校验 / 工具白名单），
      // 有意保持零横向依赖——一旦它 import 工具或记忆，护栏就产生了自己的利益相关，
      // 审查时无法再假设「它只是在客观检查输入」。
      name: "引擎-guardrails禁止横向依赖",
      severity: "error",
      comment: "guardrails 是零依赖的纯函数护栏：禁止横向依赖同层的 tools 与 memory。",
      from: { path: "^packages/engine/src/guardrails/" },
      to: { path: "^packages/engine/src/(tools|memory)/" },
    },
    {
      // 为什么：agent-loop.ts 是 kernel 里唯一「有状态调度」的模块（模型调用 + 工具回灌循环）。
      // rag/tools/memory/guardrails/mcp 是被它调度的零件——零件反过来 import 循环本体，
      // 等于把调度器塞进了零件内部，必然产生隐藏耦合与潜在循环。
      // 豁免：evals（runner/scorers）与 service/workers 合法使用 runToolLoop（见文件头说明）。
      name: "引擎-零件层禁止引用agent-loop",
      severity: "error",
      comment:
        "rag/tools/memory/guardrails/mcp 不得 import kernel 的 agent-loop.ts（零件不认识调度器）。" +
        "evals 与 service 是合法使用者，不在此规则约束范围内。",
      from: { path: "^packages/engine/src/(rag|tools|memory|guardrails|mcp)/" },
      to: { path: AGENT_LOOP },
    },
    {
      // 为什么：孤儿模块 = 既没人 import 它、它也不 import 任何人（v18 语义）。
      // 多半是重构后的残骸——留着会误导后来者以为它还在服役。删掉或接回依赖图。
      // .d.ts 类型声明天然无依赖，不算孤儿。
      name: "引擎-禁止孤儿模块",
      severity: "error",
      comment:
        "packages/engine/src 内不允许孤儿模块（无入边也无出边，多半是重构残骸）。" +
        ".d.ts 声明文件豁免。",
      from: { orphan: true, pathNot: "\\.d\\.ts$" },
      to: {},
    },
  ],
  options: {
    // 用引擎自己的 tsconfig 解析模块（NodeNext：import "./x.js" 映射回 x.ts 靠它）。
    // 必须给绝对路径：tsconfig 里的 extends "../../tsconfig.base.json" 以配置文件自身目录为基准，
    // 传相对路径时 extends 解析会错位（TS5083）
    tsConfig: {
      fileName: path.resolve(__dirname, "packages/engine/tsconfig.json"),
    },
    // 不深入 node_modules：架构规则只关心引擎内部的边
    doNotFollow: { path: "node_modules" },
    // type-only import 也算依赖：类型层面的耦合同样是架构耦合
    tsPreCompilationDeps: true,
  },
};
