// minimal-agent.ts —— 最小可运行 Agent：手写循环 + 一个 mock 工具，全文件不到 40 行。
//
// 这就是 agent-loop 的最小形态：给模型一份工具清单（名称 + 说明 + 参数图纸），
// 模型自己决定调不调、调哪个、调几次——「北京和上海今天哪个更热？」必须查两次
// 天气才能回答，所以你会在输出里看到它走了至少 3 步（查→查→答）。
//
// 运行前置：agent-app 目录先 pnpm build（examples 引的是 engine 的构建产物），
// .env 里配好 OPENAI_API_KEY（走 GLM 网关）。
//   pnpm examples:minimal
import { generateText, tool } from "ai";
import { z } from "zod";
import { runToolLoop } from "@agent-app/engine/agent-loop";
import { getModel } from "@agent-app/engine/llm";

/** 一个 mock 工具：真实项目里这里换成任何能联网/查库的函数，模型侧完全无感 */
const getWeather = tool({
  description: "查询某城市当前天气（温度与天气状况）",
  inputSchema: z.object({
    city: z.string().describe("城市名，如 北京"),
  }),
  execute: async ({ city }) => {
    // mock：固定数据。模型的参数（city）来自它自己生成——这里能拿到就是结构化调用的证据
    return { city, condition: "晴", temperatureC: city.includes("上海") ? 28 : 23 };
  },
});

const result = await runToolLoop({
  model: getModel(),
  messages: [{ role: "user", content: "北京和上海今天哪个更热？" }],
  tools: { getWeather },
  maxSteps: 5,
  // 每步广播：看模型是怎么「分步思考」的（第 1 步查北京、第 2 步查上海、第 3 步回答）
  onStep: (event) => {
    console.log(`[step ${event.step}] 调用 ${event.toolCall.toolName}(${JSON.stringify(event.toolCall.input)})`);
  },
});

console.log(`\n最终回答（共 ${result.steps} 步）：\n${result.text}`);
