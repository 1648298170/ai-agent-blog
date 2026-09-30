// tool-approval.spec.ts —— 审批登记簿 + 工具包壳的纯单测（零网络、零 Nest 装配）
// 覆盖：env 名单解析（默认值 / 逗号分隔 / 置空）、approval 事件字段、拒绝 → 结构化拒绝值、
// 允许 → 原工具透传、超时自动拒绝（50ms 真实短超时）、过期后迟到裁决 → false、
// sessionId 不匹配 → false、非名单工具原对象直传（不包壳）。
// 红队加固轮 H10：三类裁决结果（允许/拒绝/超时）落审计日志的 JSONL 断言。
// 前置说明：默认值用例依赖 agent-app/.env 里没有 AGENT_CONFIRM_*（当前如此）——
// 进程环境变量优先于 .env，其余用例全部显式设 env，不受 .env 影响。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "@agent-app/shared";
import { createDemoTools } from "@agent-app/engine/tools";
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  ToolApprovalRegistry,
  readConfirmTimeoutMs,
  readConfirmToolNames,
  wrapToolsWithApproval,
} from "./tool-approval.js";

describe("工具审批 env 解析", () => {
  beforeEach(() => {
    delete process.env.AGENT_CONFIRM_TOOLS;
    delete process.env.AGENT_CONFIRM_TIMEOUT_MS;
  });
  afterEach(() => {
    delete process.env.AGENT_CONFIRM_TOOLS;
    delete process.env.AGENT_CONFIRM_TIMEOUT_MS;
  });

  it("AGENT_CONFIRM_TOOLS 未配置 → 默认名单 createTicket（开箱即用）", () => {
    expect(readConfirmToolNames()).toEqual(new Set(["createTicket"]));
  });

  it("AGENT_CONFIRM_TOOLS 逗号分隔：去空白、跳过空段", () => {
    process.env.AGENT_CONFIRM_TOOLS = "createTicket, escalateToHuman , getOrderStatus";
    expect(readConfirmToolNames()).toEqual(
      new Set(["createTicket", "escalateToHuman", "getOrderStatus"]),
    );
  });

  it("AGENT_CONFIRM_TOOLS 显式置空（或全是空白段）→ 空名单 = 关闭审批", () => {
    process.env.AGENT_CONFIRM_TOOLS = "";
    expect(readConfirmToolNames().size).toBe(0);
    process.env.AGENT_CONFIRM_TOOLS = " , , ";
    expect(readConfirmToolNames().size).toBe(0);
  });

  it("AGENT_CONFIRM_TIMEOUT_MS：合法毫秒数生效；缺省/非法/非正 → 默认 60000", () => {
    expect(readConfirmTimeoutMs()).toBe(DEFAULT_CONFIRM_TIMEOUT_MS);
    expect(DEFAULT_CONFIRM_TIMEOUT_MS).toBe(60000);
    process.env.AGENT_CONFIRM_TIMEOUT_MS = "50";
    expect(readConfirmTimeoutMs()).toBe(50);
    process.env.AGENT_CONFIRM_TIMEOUT_MS = "abc";
    expect(readConfirmTimeoutMs()).toBe(DEFAULT_CONFIRM_TIMEOUT_MS);
    process.env.AGENT_CONFIRM_TIMEOUT_MS = "0";
    expect(readConfirmTimeoutMs()).toBe(DEFAULT_CONFIRM_TIMEOUT_MS);
    process.env.AGENT_CONFIRM_TIMEOUT_MS = "-5";
    expect(readConfirmTimeoutMs()).toBe(DEFAULT_CONFIRM_TIMEOUT_MS);
  });
});

describe("ToolApprovalRegistry + wrapToolsWithApproval（审批包壳）", () => {
  const tools = createDemoTools();
  const INPUT = { subject: "退款", description: "订单 A-1024 未送达" };

  /** 装一套最小审批环境：真工具表 + 包壳 + 事件收集器 */
  function setup(gated: ReadonlySet<string>, timeoutMs = 5000) {
    const registry = new ToolApprovalRegistry();
    const events: ChatStreamEvent[] = [];
    const wrapped = wrapToolsWithApproval(tools, gated, {
      sessionId: "s_test",
      registry,
      emit: (event) => events.push(event),
      timeoutMs,
    });
    return { registry, events, wrapped };
  }

  /** 从工具表拿必带 execute 的工具（demo 工具全都有，拿不到说明装配坏了） */
  function mustExecute(name: keyof ReturnType<typeof createDemoTools>) {
    const execute = tools[name].execute;
    if (execute === undefined) throw new Error(`unreachable：demo 工具 ${name} 必有 execute`);
    return execute;
  }

  afterEach(() => {
    delete process.env.AGENT_CONFIRM_TOOLS;
    delete process.env.AGENT_CONFIRM_TIMEOUT_MS;
  });

  it("包壳后 execute 挂起并同步发出 approval 事件（字段逐一对齐）；拒绝 → 结构化拒绝值", async () => {
    const { registry, events, wrapped } = setup(new Set(["createTicket"]));
    const execute = wrapped.createTicket.execute;
    if (execute === undefined) throw new Error("unreachable：包壳工具必有 execute");

    const pending = execute(INPUT, { toolCallId: "call_1", messages: [] });

    // approval 事件在挂起之前同步发出：前端看到卡片时 BFF 已可接受裁决
    expect(events).toHaveLength(1);
    const approval = events[0];
    if (approval.type !== "approval") throw new Error("unreachable：首事件必须是 approval");
    expect(approval.sessionId).toBe("s_test");
    expect(approval.toolName).toBe("createTicket");
    expect(approval.input).toEqual(INPUT);
    expect(approval.approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // 用户点「拒绝」→ execute 落定为结构化拒绝值（模型可见，可礼貌收尾）
    expect(registry.resolveApproval({ sessionId: "s_test", approvalId: approval.approvalId, approved: false })).toBe(true);
    await expect(pending).resolves.toEqual({ denied: true, reason: "用户拒绝执行该工具" });
  });

  it("允许 → 原工具透传执行：拿到真实建单结果（TK- 工单号）", async () => {
    const { registry, events, wrapped } = setup(new Set(["createTicket"]));
    const execute = wrapped.createTicket.execute;
    if (execute === undefined) throw new Error("unreachable：包壳工具必有 execute");

    const pending = execute(INPUT, { toolCallId: "call_2", messages: [] });
    const approval = events[0];
    if (approval.type !== "approval") throw new Error("unreachable");
    registry.resolveApproval({ sessionId: "s_test", approvalId: approval.approvalId, approved: true });

    const output = await pending;
    expect(output).toMatchObject({ subject: "退款", description: INPUT.description, status: "已创建" });
    const ticket = output as { ticketId: string };
    expect(ticket.ticketId).toMatch(/^TK-\d{8}-\d{4}$/);
  });

  it("超时自动拒绝（timeoutMs=50）：不裁决 → 50ms 后拒绝值落定，pending 条目清理", async () => {
    const { registry, events, wrapped } = setup(new Set(["createTicket"]), 50);
    const execute = wrapped.createTicket.execute;
    if (execute === undefined) throw new Error("unreachable：包壳工具必有 execute");

    const startedAt = Date.now();
    // 不回填裁决：等超时自己拒绝
    await expect(execute(INPUT, { toolCallId: "call_3", messages: [] })).resolves.toEqual({
      denied: true,
      reason: "用户拒绝执行该工具",
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45); // 确实等了超时窗口（留误差余量）

    // 条目已清理：迟到的裁决按「未知」处理
    const approval = events[0];
    if (approval.type !== "approval") throw new Error("unreachable");
    expect(
      registry.resolveApproval({ sessionId: "s_test", approvalId: approval.approvalId, approved: true }),
    ).toBe(false);
  });

  it("未知 approvalId / sessionId 不匹配 / 二次裁决 → 一律 false（不误唤醒）", async () => {
    const { registry, events, wrapped } = setup(new Set(["createTicket"]));
    const execute = wrapped.createTicket.execute;
    if (execute === undefined) throw new Error("unreachable：包壳工具必有 execute");
    const pending = execute(INPUT, { toolCallId: "call_4", messages: [] });
    const approval = events[0];
    if (approval.type !== "approval") throw new Error("unreachable");

    // 未知 id
    expect(
      registry.resolveApproval({ sessionId: "s_test", approvalId: "00000000-0000-4000-8000-000000000000", approved: true }),
    ).toBe(false);
    // 会话不符：按未知处理（不泄露别的会话里有没有挂起审批）
    expect(
      registry.resolveApproval({ sessionId: "s_别的会话", approvalId: approval.approvalId, approved: true }),
    ).toBe(false);
    // 正确裁决成功，且只能成功一次
    expect(
      registry.resolveApproval({ sessionId: "s_test", approvalId: approval.approvalId, approved: true }),
    ).toBe(true);
    expect(
      registry.resolveApproval({ sessionId: "s_test", approvalId: approval.approvalId, approved: false }),
    ).toBe(false);
    await expect(pending).resolves.toMatchObject({ status: "已创建" }); // 第一次裁决（允许）生效
  });

  it("非名单工具绝不包壳：原对象直传（toBe 同一引用）；包壳工具保留 description", () => {
    const { wrapped } = setup(new Set(["createTicket"]));
    expect(wrapped.getOrderStatus).toBe(tools.getOrderStatus);
    expect(wrapped.escalateToHuman).toBe(tools.escalateToHuman);
    // 名单外的工具直接可用，无审批事件
    const execute = mustExecute("getOrderStatus");
    expect(wrapped.getOrderStatus.execute).toBe(execute);
    // 包壳工具对模型可见的描述 / 入参 schema 原样保留
    expect(wrapped.createTicket.description).toBe(tools.createTicket.description);
  });

  it("名单包含不存在的工具名：无害（没有可包的工具）", () => {
    const { wrapped } = setup(new Set(["noSuchTool"]));
    expect(wrapped.createTicket).toBe(tools.createTicket);
    expect(wrapped.getOrderStatus).toBe(tools.getOrderStatus);
  });
});

// ══ 红队加固轮 H10：审批裁决落审计日志 ═══════════════════════════════════════
describe("审批审计（approval.granted / approval.denied / approval.timeout）", () => {
  const tools = createDemoTools();
  const INPUT = { subject: "退款", description: "订单 A-1024 未送达" };
  const tempDirs: string[] = [];
  let auditPath: string;
  let originalAuditLog: string | undefined;

  /** 读当前审计文件里的全部 JSONL 条目 */
  function readAudit(): Array<Record<string, unknown>> {
    try {
      return readFileSync(auditPath, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    } catch {
      return []; // 文件还没写出来：视为空
    }
  }

  beforeEach(() => {
    // 审计路径指到本套件专属临时文件（覆盖 vitest.config 的默认临时路径）
    const dir = mkdtempSync(join(tmpdir(), "agent-app-approval-audit-"));
    tempDirs.push(dir);
    auditPath = join(dir, "audit.log");
    originalAuditLog = process.env.AGENT_AUDIT_LOG;
    process.env.AGENT_AUDIT_LOG = auditPath;
  });

  afterEach(() => {
    if (originalAuditLog === undefined) delete process.env.AGENT_AUDIT_LOG;
    else process.env.AGENT_AUDIT_LOG = originalAuditLog;
  });

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("用户允许 → approval.granted 一行（approvalId/sessionId/toolName 对齐）", async () => {
    const registry = new ToolApprovalRegistry();
    const events: ChatStreamEvent[] = [];
    const wrapped = wrapToolsWithApproval(tools, new Set(["createTicket"]), {
      sessionId: "s_audit",
      registry,
      emit: (event) => events.push(event),
      timeoutMs: 5000,
    });
    const execute = wrapped.createTicket.execute;
    if (execute === undefined) throw new Error("unreachable：包壳工具必有 execute");

    const pending = execute(INPUT, { toolCallId: "call_audit_1", messages: [] });
    const approval = events[0];
    if (approval.type !== "approval") throw new Error("unreachable");
    registry.resolveApproval({ sessionId: "s_audit", approvalId: approval.approvalId, approved: true });
    await pending;

    const granted = readAudit().filter((entry) => entry.event === "approval.granted");
    expect(granted.length).toBe(1);
    expect(granted[0].approvalId).toBe(approval.approvalId);
    expect(granted[0].sessionId).toBe("s_audit");
    expect(granted[0].toolName).toBe("createTicket");
  });

  it("用户拒绝 → approval.denied 一行", async () => {
    const registry = new ToolApprovalRegistry();
    const events: ChatStreamEvent[] = [];
    const wrapped = wrapToolsWithApproval(tools, new Set(["createTicket"]), {
      sessionId: "s_audit",
      registry,
      emit: (event) => events.push(event),
      timeoutMs: 5000,
    });
    const execute = wrapped.createTicket.execute;
    if (execute === undefined) throw new Error("unreachable");
    const pending = execute(INPUT, { toolCallId: "call_audit_2", messages: [] });
    const approval = events[0];
    if (approval.type !== "approval") throw new Error("unreachable");
    registry.resolveApproval({ sessionId: "s_audit", approvalId: approval.approvalId, approved: false });
    await expect(pending).resolves.toEqual({ denied: true, reason: "用户拒绝执行该工具" });

    const denied = readAudit().filter((entry) => entry.event === "approval.denied");
    expect(denied.length).toBe(1);
    expect(denied[0].toolName).toBe("createTicket");
  });

  it("超时未裁决 → approval.timeout 一行（不产生 granted/denied——超时是独立裁决源）", async () => {
    const registry = new ToolApprovalRegistry();
    const events: ChatStreamEvent[] = [];
    const wrapped = wrapToolsWithApproval(tools, new Set(["createTicket"]), {
      sessionId: "s_audit",
      registry,
      emit: (event) => events.push(event),
      timeoutMs: 50,
    });
    const execute = wrapped.createTicket.execute;
    if (execute === undefined) throw new Error("unreachable");

    await expect(execute(INPUT, { toolCallId: "call_audit_3", messages: [] })).resolves.toEqual({
      denied: true,
      reason: "用户拒绝执行该工具",
    });

    const entries = readAudit();
    const timeouts = entries.filter((entry) => entry.event === "approval.timeout");
    expect(timeouts.length).toBe(1);
    expect(timeouts[0].toolName).toBe("createTicket");
    // 超时路径不经 resolveApproval，不该有 granted/denied 记账
    expect(entries.filter((entry) => entry.event === "approval.granted" || entry.event === "approval.denied")).toHaveLength(0);
  });
});
