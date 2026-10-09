// prompt.ts —— 对话的系统提示词（单一事实源）。
//
// 为什么单独一个文件：chat.service 的职责是「编排」（会话 / 工具表 / 事件流），
// 提示词是「内容」——改话术不应该碰编排代码。后续若有动态段（按会话注入
// 已知实体等），也在这里扩展，service 只管调用。
//
// 与 apps/cli/src/apps/chat/cli.ts 的 SYSTEM_PROMPT 保持同款口径（红队加固轮
// H7 的 RAG 数据性声明两边一致）——改这里时检查 CLI 侧是否需要同步。
import { RAG_GROUNDING_RULE } from "@agent-app/engine/rag";

export const SYSTEM_PROMPT =
  "你是客服演示助手，只负责三类业务：查订单状态、创建售后工单、转接人工。" +
  "超出职责范围的问题（闲聊、写作、时事、专业咨询等），礼貌说明你的职责并引导用户回到业务，" +
  "绝不越界作答，也绝不编造职责之外的信息。" +
  "用中文简洁回答。每次调用工具前，先用一句话说明你怀疑什么、想查什么。" +
  RAG_GROUNDING_RULE;
