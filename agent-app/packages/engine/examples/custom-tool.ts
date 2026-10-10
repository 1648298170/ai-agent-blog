// custom-tool.ts —— 自定义工具：三件套（description + inputSchema + execute）+ 直接跑。
//
// 给 Agent 加一个自己的工具只需要三件事：
//   ① description：给模型看的「说明书」——写清适合什么/不适合什么，模型靠它决定调不调；
//   ② inputSchema：zod 参数图纸——同一张图纸既生成给模型的参数说明，又做执行前校验；
//   ③ execute：真实现——模型只「点名」，干活的是这里。
// 本例定义「待办清单」的两个工具（查询 + 新增），并演示循环对它们的编排：
// 模型会先查清单、再新增一条、最后汇报——一个请求串联两个工具。
//
// 运行前置：pnpm build + .env 配好 OPENAI_API_KEY。
//   pnpm examples:custom-tool
import { generateText, tool } from "ai";
import { z } from "zod";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { getModel } from "@agent-app/engine/llm";

/** 内存态待办清单（mock 存储——真实项目换成数据库调用，工具定义完全不变） */
const todos: { id: number; title: string; done: boolean }[] = [
  { id: 1, title: "读完 agent-loop 教学文档", done: false },
  { id: 2, title: "跑通 minimal-agent 示例", done: true },
];

const listTodos = tool({
  description: "查询当前待办清单：返回所有待办事项及其完成状态。用户问「有哪些待办/还剩什么没做」时调用。",
  inputSchema: z.object({}),
  execute: async () => ({
    total: todos.length,
    items: todos.map((t) => `${t.id}. ${t.title}${t.done ? "（已完成）" : ""}`),
  }),
});

const addTodo = tool({
  description: "新增一条待办事项。用户说「加一个待办/记一下 XX」时调用；不要在用户只是查询时调用。",
  inputSchema: z.object({
    title: z.string().min(1).describe("待办内容，一句话概括"),
  }),
  execute: async ({ title }) => {
    const id = todos.length + 1;
    todos.push({ id, title, done: false });
    return { id, title, status: "已新增" }; // 写操作！生产场景它应该配幂等壳（见 tools/idempotency.ts）
  },
});

const result = await runToolLoop({
  model: getModel(),
  messages: [
    { role: "user", content: "帮我加一个待办：给教学文档画配图，然后告诉我现在清单里都有什么" },
  ],
  tools: { addTodo, listTodos },
  maxSteps: 5,
  onStep: (event) => {
    console.log(`[step ${event.step}] ${event.toolCall.toolName}(${JSON.stringify(event.toolCall.input)})`);
  },
});

console.log(`\n最终回答（共 ${result.steps} 步）：\n${result.text}`);
console.log(`\n内存中的清单（execute 副作用实证）：`, todos);
