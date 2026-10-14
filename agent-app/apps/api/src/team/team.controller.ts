// team.controller.ts —— /api/team：多 Agent 编排的 SSE 流式端点（BACKLOG ② 在线观测档）。
//
// SSE 事件序列（OrchestrationEvent 五类直通 + done/error 收尾，事件形状 = engine 原样）：
//   session → state（状态迁移）→ task-completed / task-failed 交替 → escalated（可选）→ done
//   事件字段与 engine 的 OrchestrationEvent 逐字段一致（type 透传，不做二次包装）——
//   web 端拿到的是编排器的一手事件流，不是 api 的转述。
//
// 与 chat/service 两条流同款的骨架：长度闸在 SSE 头之前、三响应头 + flushHeaders、
// finally res.end() 收尾。
// 成本提醒：编排一次 ≈ 3-8 次模型调用（拆单 + 每子任务工具循环 + 验收），
// 全局限流（THROTTLE_LIMIT）对滥用兜底，正常用户按次使用无感。
import { Controller, Get, Query, Res } from "@nestjs/common";
import { ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { assembleTeamOrchestrator } from "@agent-app/engine/orchestrator";
import type { OrchestrationEvent } from "@agent-app/engine/orchestrator";

const GOAL_MAX_CHARS = 2000;

@ApiTags("team")
@Controller("api/team")
export class TeamController {
  /** SSE 流式编排：GET /api/team/stream?goal=...&id=...（断点续跑：同 id 重入跳过已完成） */
  @Get("stream")
  @ApiExcludeEndpoint()
  async stream(
    @Query("goal") goal: string | undefined,
    @Query("id") id: string | undefined,
    @Query("maxTokens") maxTokens: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // 长度闸在 SSE 头之前判（chat.stream 同款）：头一旦 flush 就给不出 4xx
    if (goal !== undefined && goal.length > GOAL_MAX_CHARS) {
      res.status(400).json({ statusCode: 400, message: `目标描述过长（上限 ${GOAL_MAX_CHARS} 字符）` });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    if (goal === undefined || goal.trim() === "") {
      write({ type: "error", message: "缺少必填查询参数 goal（GET /api/team/stream?goal=...）" });
      res.end();
      return;
    }
    const orchestrationId = id?.trim() || `team-${Date.now().toString(36)}`;
    write({ type: "session", orchestrationId });

    // 事件透传：engine 的 OrchestrationEvent 原样出站（不做二次包装——web 端
    // 拿到的是编排器的一手事件流）
    const sink = (event: OrchestrationEvent): void => write(event);

    const { orchestrator } = assembleTeamOrchestrator({ traceSink: sink });

    try {
      await orchestrator.runAsync(
        {
          id: orchestrationId,
          goal: goal.trim(),
          tasks: [],
          maxTokens: parseMaxTokens(maxTokens),
        },
        undefined,
      );
      write({ type: "done", orchestrationId });
    } catch (err) {
      // 编排失败（验收不达标 / 预算超支 / 升级人工等）——终态已由编排器落盘，
      // 同 id 重入可断点续跑；这里把失败原因带给前端（中文错误礼仪）
      write({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
        orchestrationId,
      });
    } finally {
      res.end(); // 无论如何收尾，不留悬空连接
    }
  }
}

function parseMaxTokens(raw: string | undefined): number | undefined {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
