// service/index.ts —— 智能客服产品核心 barrel：supervisor（路由）/ workers（三工人）/ handoff（转人工）。
// 自 apps/service 上移进引擎包：CLI（apps/cli 的 service REPL）与 HTTP API（apps/api 的
// /api/service）共用这一套产品逻辑——app 之间禁止互相 import，公共核心一律进包。
// 子路径 @agent-app/engine/service 的出口即本文件。
export * from "./supervisor.js";
export * from "./workers.js";
export * from "./handoff.js";
