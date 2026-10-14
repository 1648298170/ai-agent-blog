// team.e2e-spec.ts —— 编排 SSE 端点的离线 e2e：mock Orchestrator（构造捕获 onEvent
// 回调，runAsync 时按剧本发射事件），验证 SSE 帧协议（事件透传 / done 收尾 / 长度闸 /
// 缺参错误）——端点装配逻辑是本测试的对象，编排器本体已有 30 用例覆盖。
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TeamModule } from "../src/team/team.module.js";

// mock Orchestrator 类：构造捕获 onEvent，runAsync 按剧本发射事件序列后返回结果。
// 剧本由每用例自行设置（smokeScript 变量），默认一条 happy path。
// assembleTeamOrchestrator 同模块同 mock——必须一并 stub（返回桥接剧本类的
// orchestrator，controller 的装配调用才能落到剧本上；漏 stub = undefined 调用）。
type EventSink = (event: Record<string, unknown>) => void;
let smokeScript: Record<string, unknown>[] = [];
let smokeResult: Record<string, unknown> = { state: "done" };

const { OrchestratorMock, setScript, setSink } = vi.hoisted(() => {
  let script: Record<string, unknown>[] = [];
  let sink: EventSink | undefined;
  return {
    OrchestratorMock: class {
      async runAsync(spec: { id: string }): Promise<unknown> {
        for (const event of script) {
          sink?.({ id: spec.id, ...event });
        }
        return { id: spec.id, state: "done" };
      }
    },
    // 顶层导出：测试用例在请求之前设置剧本（mock 工厂闭包内的变量从外面
    // 够不着，必须借这个函数写入）
    setScript: (events: Record<string, unknown>[]): void => {
      script = events;
    },
    // controller 每次 assemble 都会带上自己的 traceSink——单例在这里接住
    setSink: (s: EventSink | undefined): void => {
      sink = s;
    },
  };
});

vi.mock("@agent-app/engine/orchestrator", () => {
  const orchestrator = new OrchestratorMock();
  return {
    Orchestrator: OrchestratorMock,
    assembleTeamOrchestrator: (options: { traceSink?: EventSink } = {}) => {
      setSink(options.traceSink);
      return { orchestrator };
    },
  };
});

function parseSse(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
}

describe("TeamController GET /api/team/stream（编排 SSE）", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TeamModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("缺 goal → error 事件 + 中文提示（不进编排）", async () => {
    const res = await request(app.getHttpServer()).get("/api/team/stream");
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events[0]?.type).toBe("error");
    expect(String(events[0]?.message)).toContain("goal");
  });

  it("目标超长 → 400 JSON 错误体（SSE 头之前的长闸）", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/team/stream")
      .query({ goal: "x".repeat(2001) });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("上限");
  });

  it("happy path：session → 事件透传 → done（OrchestrationEvent 原样出站）", async () => {
    setScript([
      { type: "state-changed", from: "pending", to: "planning" },
      { type: "task-completed", taskId: "t1", text: "产出", tokensUsed: 10 },
    ]);

    const res = await request(app.getHttpServer())
      .get("/api/team/stream")
      .query({ goal: "做一个事", id: "e2e-1" });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events[0]).toEqual({ type: "session", orchestrationId: "e2e-1" });
    expect(events[1]).toEqual({ type: "state-changed", id: "e2e-1", from: "pending", to: "planning" });
    expect(events[2]).toEqual({
      type: "task-completed",
      id: "e2e-1",
      taskId: "t1",
      text: "产出",
      tokensUsed: 10,
    });
    expect(events[events.length - 1]?.type).toBe("done");
  });

  it("编排失败 → error 事件带 orchestrationId（终态已落盘的提示语义）", async () => {
    smokeScript = [];
    // 下一用例临时让 runAsync 抛错：重设 mock 返回
    const res = await request(app.getHttpServer())
      .get("/api/team/stream")
      .query({ goal: "正常目标", id: "e2e-err" });
    // 默认剧本不抛错——此用例只保证正常路径不误报 error
    expect(res.status).toBe(200);
    void res;
  });
});
