// datasource.spec.ts —— 外部数据源插件（provider plugin pattern）的离线单测：
// registry 的登记/解析/isConfigured 过滤三件事 + ops 四个单端点工具 execute 的
// 六条路径（成功 / 业务码失败 / HTTP 401 / HTTP 500 / 缺 token / 超时）+ 第 5 个
// 组合工具 ops_agent_daily_matrix（agentCompare 列表 → 逐代理商 dailyDetails×2
// → 合并稀疏矩阵）。全程零网络——global fetch 用 vi.stubGlobal 换成桩，env 用
// vi.stubEnv 注入（loadEnv 对 ENV_KEYS 里的 key 是「进程环境变量优先」，恰好覆盖真实 .env）。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import type { AgentTool } from "../src/types.js";
import { registerBuiltInDataSources, registerDataSource, resolveDataSourceTools } from "../src/datasource/registry.js";
import type { DataSourceProvider } from "../src/datasource/types.js";
import { opsProvider, OPS_MISSING_TOKEN_MESSAGE } from "../src/datasource/index.js";

/** 测试专用 base 地址（进程 env 优先，真实 .env 不受影响也不被依赖） */
const TEST_BASE = "http://ops-test.local:8080";

/** 假 fetch 桩：记录调用参数，按需回放 Response 形状的最小投影 */
const fetchMock = vi.fn();

/** 统一的 execute 调用封装：数据源工具必有 execute（契约），这里只是收窄类型 */
async function runTool(t: AgentTool, input: unknown): Promise<unknown> {
  if (t.execute === undefined) throw new Error("unreachable：数据源工具必有 execute");
  return await t.execute(input, { toolCallId: "call_test", messages: [] });
}

/** 按名取工具（ops 的 createTools 顺序不进断言，名字才是契约） */
function toolByName(name: string, token?: string): AgentTool {
  const found = opsProvider.createTools({ token }).find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`unreachable：应存在工具 ${name}`);
  return found.tool;
}

/** 200 + CommonResult 壳的最小 Response 投影（res.ok / status / json 够用） */
function okResult(data: unknown, code = 0): Response {
  return { ok: true, status: 200, json: async () => ({ code, message: "ok", data }) } as Response;
}

/** 指定状态码的失败 Response 投影 */
function httpError(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as Response;
}

beforeEach(() => {
  vi.stubEnv("OPS_BASE_URL", TEST_BASE);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("registry：登记 / 解析 / isConfigured 过滤", () => {
  it("登记假 provider（isConfigured=true）→ resolve 拿到其工具，且请求级 token 透传到 createTools", async () => {
    let configured = true;
    const fake: DataSourceProvider = {
      name: "fake",
      description: "测试用假数据源",
      isConfigured: () => configured,
      createTools: (context) => [
        {
          name: "fake_echo_token",
          tool: tool({
            description: "回显 token 的假工具",
            inputSchema: z.object({}),
            execute: async () => ({ gotToken: context.token ?? "" }),
          }),
        },
      ],
    };
    registerDataSource(fake);

    const resolved = resolveDataSourceTools({ token: "tok-registry" });
    const fakeTool = resolved.find((entry) => entry.name === "fake_echo_token");
    expect(fakeTool).toBeDefined();

    const output = await runTool(fakeTool!.tool, {});
    expect(output).toEqual({ gotToken: "tok-registry" });

    configured = false; // 同一 provider 翻转开关：立即被 resolve 过滤
    expect(
      resolveDataSourceTools({ token: "tok-registry" }).some((entry) => entry.name === "fake_echo_token"),
    ).toBe(false);
  });

  it("registerBuiltInDataSources 幂等：调两次也只登记一份 ops（7 个工具名各出现一次）", () => {
    registerBuiltInDataSources();
    registerBuiltInDataSources();

    const names = resolveDataSourceTools({ token: "tok-once" }).map((entry) => entry.name);
    const opsNames = names.filter((name) => name.startsWith("ops_"));
    expect(opsNames.sort()).toEqual([
      "ops_agent_compare",
      "ops_agent_daily_matrix",
      "ops_agent_search",
      "ops_daily_details",
      "ops_order_statistics",
      "ops_tenant_search",
      "ops_tenant_top",
    ]);
  });

  it("ops isConfigured：OPS_BASE_URL 非空为 true，空白/缺失为 false", () => {
    expect(opsProvider.isConfigured()).toBe(true); // beforeEach 已注入 TEST_BASE
    vi.stubEnv("OPS_BASE_URL", "");
    expect(opsProvider.isConfigured()).toBe(false);
    vi.stubEnv("OPS_BASE_URL", "   ");
    expect(opsProvider.isConfigured()).toBe(false);
  });
});

describe("ops 工具 execute：六条路径（fetch 全桩，零网络）", () => {
  it("成功：200 + code=0 → 返回 data 本体；URL 平铺 query、默认裸令牌头、可选参数缺省不进 query", async () => {
    const rows = [{ tenantId: 1001, name: "商圈A站", data: 8888.5 }];
    fetchMock.mockResolvedValue(okResult(rows));

    const output = await runTool(toolByName("ops_tenant_top", "tok-1"), { agentId: 7, dateTime: "2026-09" });
    expect(output).toEqual(rows);
    // 冒烟探明 SPA 拦截器发裸 token（无 Bearer 前缀），默认口径与之一致
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_BASE}/markDashboard/tenantTop?agentId=7&dateTime=2026-09`,
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "tok-1" },
      }),
    );

    // 可选参数缺省：URL 不带 query（后端走默认值）
    fetchMock.mockResolvedValue(okResult([]));
    await runTool(toolByName("ops_agent_compare", "tok-1"), {});
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${TEST_BASE}/markDashboard/agentCompare`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("令牌方案可配：OPS_TOKEN_SCHEME=Bearer → 头值带 Bearer 前缀", async () => {
    vi.stubEnv("OPS_TOKEN_SCHEME", "Bearer");
    fetchMock.mockResolvedValue(okResult([]));

    await runTool(toolByName("ops_tenant_top", "tok-b"), {});
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${TEST_BASE}/markDashboard/tenantTop`,
      expect.objectContaining({ headers: { Authorization: "Bearer tok-b" } }),
    );
  });

  it("业务失败：HTTP 200 但 code=500 → 中文错误（含 code 与后端 message）；code=401 → 认证特化话术", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 500, message: "代理商不存在", data: null }),
    } as Response);

    await expect(runTool(toolByName("ops_order_statistics", "tok-1"), { agentId: 9 })).rejects.toThrow(
      /ops 业务失败：code=500.*代理商不存在/s,
    );

    // 冒烟探明的真实认证形态：HTTP 200 + code=401（"Not logged in yet or token has expired"）
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 401, message: "Not logged in yet or token has expired" }),
    } as Response);
    await expect(runTool(toolByName("ops_tenant_top", "tok-expired"), {})).rejects.toThrow(
      /ops 认证失败（code=401）.*Not logged in yet or token has expired.*🔑/s,
    );
  });

  it("HTTP 401 → 中文认证错误（指向 🔑 入口）；HTTP 500 → 中文状态码错误", async () => {
    fetchMock.mockResolvedValue(httpError(401));
    await expect(runTool(toolByName("ops_tenant_top", "tok-bad"), {})).rejects.toThrow(
      /ops 认证失败（HTTP 401）.*🔑/s,
    );

    fetchMock.mockResolvedValue(httpError(502));
    await expect(runTool(toolByName("ops_tenant_top", "tok-bad"), {})).rejects.toThrow(
      /ops 接口返回 HTTP 502/,
    );
  });

  it("缺 token → 不发请求，直接抛「未填写 ops token」（模型可转述的指引）", async () => {
    await expect(runTool(toolByName("ops_daily_details", undefined), { type: 2 })).rejects.toThrow(
      OPS_MISSING_TOKEN_MESSAGE,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("超时：AbortSignal.timeout 触发 → 中文超时错误（含毫秒数与 OPS_TIMEOUT_MS 提示）", async () => {
    vi.stubEnv("OPS_TIMEOUT_MS", "20");
    fetchMock.mockImplementation(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            // 与 AbortSignal.timeout 真实行为同款：DOMException + name=TimeoutError
            reject(new DOMException("The operation timed out", "TimeoutError"));
          });
        }),
    );

    await expect(runTool(toolByName("ops_tenant_top", "tok-slow"), {})).rejects.toThrow(
      /ops 请求超时（20ms）.*OPS_TIMEOUT_MS/s,
    );
  });

  it("令牌头名可配：OPS_TOKEN_HEADER=X-Token → 头名换、裸值方案保留；token 永不进错误消息", async () => {
    vi.stubEnv("OPS_TOKEN_HEADER", "X-Token");
    fetchMock.mockResolvedValue(httpError(404));

    await expect(runTool(toolByName("ops_tenant_top", "tok-secret"), {})).rejects.toThrow(
      /ops 接口返回 HTTP 404/,
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${TEST_BASE}/markDashboard/tenantTop`,
      expect.objectContaining({ headers: { "X-Token": "tok-secret" } }),
    );
  });
});

describe("ops_agent_daily_matrix 组合工具：代理商列表 → 逐家每日明细×2 → 合并稀疏矩阵", () => {
  /**
   * 路由式 fetch 桩：按 URL 内容分流（真实编排里两次端点的 URL 各不相同，
   * 逐 URL if 分派比 mockResolvedValueOnce 队列更能表达「路由」语义且不怕并发乱序）。
   * 数据设定：3 家代理商（A/B/C）；A 两天全量、B 只有 09/03（稀疏/缺口天）、
   * C 的 type=1 网络失败（fetch 直接抛 → callOps 归一成中文网络错误）而 type=2 正常——
   * C 应带着「半份真实数据」落进 errors。
   */
  function routeMatrixCalls(): void {
    const agents = [
      { agentId: 1, agentName: "代理商A", orderFlowAmount: 220, orderNum: 5, averageOrderAmount: 44, onlineDeviceNum: 10, onlineDeviceRate: 90 },
      { agentId: 2, agentName: "代理商B", orderFlowAmount: 50, orderNum: 4, averageOrderAmount: 12.5, onlineDeviceNum: 5, onlineDeviceRate: 80 },
      { agentId: 3, agentName: "代理商C", orderFlowAmount: 60, orderNum: 6, averageOrderAmount: 10, onlineDeviceNum: 6, onlineDeviceRate: 70 },
    ];
    fetchMock.mockImplementation((url: unknown) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith("/agentCompare")) {
        return Promise.resolve(okResult(agents));
      }
      if (u.pathname.endsWith("/dailyDetails")) {
        const type = u.searchParams.get("type") ?? "1";
        const agentId = u.searchParams.get("agentId");
        if (agentId === "1") {
          const rows =
            type === "1"
              ? [{ dateTime: "09/01", data: 100 }, { dateTime: "09/02", data: 120 }]
              : [{ dateTime: "09/01", data: 2 }, { dateTime: "09/02", data: 3 }];
          return Promise.resolve(okResult(rows));
        }
        if (agentId === "2") {
          const rows = type === "1" ? [{ dateTime: "09/03", data: 50 }] : [{ dateTime: "09/03", data: 4 }];
          return Promise.resolve(okResult(rows));
        }
        // C：type=1 网络层失败、type=2 正常 → 单代理失败不炸整矩阵
        if (type === "1") return Promise.reject(new Error("connect ECONNREFUSED"));
        return Promise.resolve(okResult([{ dateTime: "09/02", data: 6 }]));
      }
      return Promise.reject(new Error(`unrouted url: ${String(url)}`));
    });
  }

  it("全流程：month/agentCount/days 并集升序；稀疏字典只有有数据的天；C 失败进 errors（中文+80字截断）；返回值即工具观察结果", async () => {
    routeMatrixCalls();

    const output = await runTool(toolByName("ops_agent_daily_matrix", "tok-m"), { dateTime: "2026-09" });
    expect(output).toEqual({
      month: "2026-09",
      agentCount: 3,
      days: ["09/01", "09/02", "09/03"],
      agents: [
        { agentId: 1, agentName: "代理商A", orderNum: { "09/01": 2, "09/02": 3 }, amount: { "09/01": 100, "09/02": 120 } },
        { agentId: 2, agentName: "代理商B", orderNum: { "09/03": 4 }, amount: { "09/03": 50 } },
        { agentId: 3, agentName: "代理商C", orderNum: { "09/02": 6 }, amount: {} },
      ],
      errors: [{ agentId: 3, agentName: "代理商C", message: expect.stringMatching(/^ops 网络请求失败/) }],
    });

    // 编排请求总数：1×agentCompare + 3 家×2 种 dailyDetails = 7 次
    expect(fetchMock).toHaveBeenCalledTimes(7);

    // 错误消息截断纪律：≤80 字 + 截断省略号（含完整 URL 的网络错误天然超长）
    const matrix = output as { errors: { message: string }[] };
    expect(matrix.errors[0]!.message.length).toBeLessThanOrEqual(81);
  });

  it("编排顺序：先 agentCompare 拿全量列表，再逐家带 agentId+dateTime 发每日请求（type=1/2 各一次）", async () => {
    routeMatrixCalls();

    await runTool(toolByName("ops_agent_daily_matrix", "tok-m"), { dateTime: "2026-09" });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe(`${TEST_BASE}/markDashboard/agentCompare?dateTime=2026-09`);
    expect(urls).toContain(`${TEST_BASE}/markDashboard/dailyDetails?type=1&agentId=1&dateTime=2026-09`);
    expect(urls).toContain(`${TEST_BASE}/markDashboard/dailyDetails?type=2&agentId=3&dateTime=2026-09`);
  });

  it("agentCompare 本身失败 → 整个工具抛中文错误（拿不到列表就没有矩阵，与兄弟工具同礼遇）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ code: 500, message: "查询月份不合法", data: null }),
    } as Response);

    await expect(
      runTool(toolByName("ops_agent_daily_matrix", "tok-m"), { dateTime: "2026-13" }),
    ).rejects.toThrow(/ops 业务失败：code=500.*查询月份不合法/s);
  });

  it("缺 token → 一个请求都不发，直接抛「未填写 ops token」（组合工具与单端点共用 callOps 闸门）", async () => {
    await expect(
      runTool(toolByName("ops_agent_daily_matrix", undefined), { dateTime: "2026-09" }),
    ).rejects.toThrow(OPS_MISSING_TOKEN_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ops 名册工具：名字 → ID 的桥（ops_agent_search / ops_tenant_search）", () => {
  it("agent_search：名字平铺进 query（pageNum/pageSize 写死），命中时原样透传分页数据", async () => {
    const page = {
      records: [{ id: 42, outletsName: "广东深圳", agentType: 2, deviceTotal: 30, tenantNum: 12, orderNum: 999 }],
      total: 1,
      size: 10,
      current: 1,
    };
    fetchMock.mockResolvedValue(okResult(page));

    const output = await runTool(toolByName("ops_agent_search", "tok-1"), { name: "广东深圳" });
    expect(output).toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_BASE}/platform/agent/page?name=${encodeURIComponent("广东深圳")}&pageNum=1&pageSize=10`,
      expect.objectContaining({ method: "GET", headers: { Authorization: "tok-1" } }),
    );
  });

  it("tenant_search：tenantName 平铺 + agentId→outletsId 转换（上游字段名不同，转换在 provider 内）", async () => {
    const page = {
      records: [{ id: 7, tenantName: "广东深圳店", agentName: "广东深圳", orderNum: 88, orderAmountNum: 1234.5 }],
      total: 1,
      size: 10,
      current: 1,
    };
    fetchMock.mockResolvedValue(okResult(page));

    const output = await runTool(toolByName("ops_tenant_search", "tok-1"), {
      tenantName: "广东深圳店",
      agentId: 42,
    });
    expect(output).toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_BASE}/platform/tenant/pageTenant?tenantName=${encodeURIComponent("广东深圳店")}&outletsId=42&pageNum=1&pageSize=10`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("空名册诚实化：records 为空 → 带中文提示（防模型编造 ID），不再原样透传空壳", async () => {
    fetchMock.mockResolvedValue(okResult({ records: [], total: 0, size: 10, current: 1 }));

    const output = await runTool(toolByName("ops_agent_search", "tok-1"), { name: "不存在的代理" });
    expect(output).toMatchObject({ records: [], total: 0 });
    expect(output).toHaveProperty("提示");
    expect(String((output as Record<string, unknown>)["提示"])).toContain("不要编造 ID");
  });

  it("缺 token → 不发请求直接抛中文指引（名册与经营工具共用 callOps 闸门）", async () => {
    await expect(
      runTool(toolByName("ops_tenant_search", undefined), { tenantName: "广东深圳店" }),
    ).rejects.toThrow(OPS_MISSING_TOKEN_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("名册搜索词清洗：类型词尾巴自动剥离重查（2026-10 真机实测「广东深圳代理商」不命中）", () => {
  /** 按 name 参数分流的上游桩：「广东深圳代理商」不命中、「广东深圳」命中两家 */
  function routeNameSearch(): void {
    fetchMock.mockImplementation((url: unknown) => {
      const name = new URL(String(url)).searchParams.get("name") ?? "";
      if (name === "广东深圳") {
        return Promise.resolve(
          okResult({
            records: [
              { id: 42, outletsName: "广东深圳", orderNum: 999 },
              { id: 43, outletsName: "广东深圳分公司", orderNum: 100 },
            ],
            total: 2,
            size: 10,
            current: 1,
          }),
        );
      }
      return Promise.resolve(okResult({ records: [], total: 0, size: 10, current: 1 }));
    });
  }

  it("带类型词不命中 → 自动剥词重查命中，结果附「说明」交代自动修正痕迹", async () => {
    routeNameSearch();

    const output = (await runTool(toolByName("ops_agent_search", "tok-1"), { name: "广东深圳代理商" })) as {
      records: unknown[];
      说明?: string;
    };
    expect(output.records).toHaveLength(2);
    expect(output["说明"]).toContain("「广东深圳」"); // 交代按剥词后的关键词命中

    // 两次请求：原词失败 → 剥词「广东深圳」重查
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(`name=${encodeURIComponent("广东深圳代理商")}`);
    expect(urls[1]).toContain(`name=${encodeURIComponent("广东深圳")}`);
  });

  it("干净名字直接命中 → 只发一次请求，结果原样透传（无说明字段）", async () => {
    routeNameSearch();

    const output = await runTool(toolByName("ops_agent_search", "tok-1"), { name: "广东深圳" });
    expect(output).not.toHaveProperty("说明");
    expect((output as { records: unknown[] }).records).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("剥词后仍不命中 → 诚实空壳 + 提示引导模型换更短关键词（两次尝试都写进提示）", async () => {
    fetchMock.mockResolvedValue(okResult({ records: [], total: 0, size: 10, current: 1 }));

    const output = (await runTool(toolByName("ops_agent_search", "tok-1"), { name: "某某代理商" })) as {
      提示?: string;
    };
    expect(output["提示"]).toContain("不要编造 ID");
    expect(output["提示"]).toContain("更短的关键词");
    expect(fetchMock).toHaveBeenCalledTimes(2); // 原词 + 剥词各一次
  });
});

describe("order_statistics 单对象空结果诚实化（data=null 与全零是两种不同的「空」）", () => {
  it("上游 data=null → 只返回 dateTime+提示（明确告知「没返回任何统计数据」，模型不再猜原因）", async () => {
    fetchMock.mockResolvedValue(okResult(null)); // 上游该月 data 为空

    const output = (await runTool(toolByName("ops_order_statistics", "tok-1"), { dateTime: "2026-09" })) as {
      提示?: string;
    };
    expect(output["提示"]).toContain("没有返回任何统计数据");
    expect(output["提示"]).toContain("不要猜测原因");
    expect(output).not.toHaveProperty("orderNum"); // 不存在伪零对象
  });

  it("全零对象 → 原字段保留 + 提示区分「数据就是 0」与「查询失败」", async () => {
    const zeroStats = {
      orderFlowAmount: 0,
      orderNum: 0,
      soldOrderNum: 0,
      refundOrderNum: 0,
      refundOrderAmount: 0,
      averageOrderAmount: 0,
      onlineDeviceNum: 0,
      onlineDeviceRate: 0,
    };
    fetchMock.mockResolvedValue(okResult(zeroStats));

    const output = (await runTool(toolByName("ops_order_statistics", "tok-1"), { dateTime: "2026-09" })) as {
      refundOrderNum?: number;
      提示?: string;
    };
    expect(output["refundOrderNum"]).toBe(0); // 原对象字段保留（上游确认的 0）
    expect(output["提示"]).toContain("全 0");
    expect(output["提示"]).toContain("不是查询失败");
  });

  it("字段级 null：部分指标上游未返回 → 剔除该字段 + 提示列出（0 保留——合法业务值不与 null 混淆）", async () => {
    const partial = {
      orderFlowAmount: 1200.5,
      orderNum: 30,
      soldOrderNum: 0, // 合法的 0：真没有买断，必须保留
      refundOrderNum: null, // 上游没算出来：剔除
      refundOrderAmount: null,
      averageOrderAmount: 40.02,
      onlineDeviceNum: 12,
      onlineDeviceRate: 88.8,
    };
    fetchMock.mockResolvedValue(okResult(partial));

    const output = (await runTool(toolByName("ops_order_statistics", "tok-1"), { dateTime: "2026-09" })) as Record<string, unknown>;
    expect(output["orderFlowAmount"]).toBe(1200.5); // 正常字段保留
    expect(output["soldOrderNum"]).toBe(0); // 0 ≠ null：合法业务值不剔除
    expect(output).not.toHaveProperty("refundOrderNum"); // null 字段剔除，防模型把 null 当 0
    expect(String(output["提示"])).toContain("refundOrderNum");
    expect(String(output["提示"])).toContain("不要当成 0");
  });

  it("混合形态：null 字段 + 其余全 0 → 一段提示同时说清「缺失」与「全 0 不是查询失败」", async () => {
    const mixed = {
      orderFlowAmount: 0,
      orderNum: 0,
      refundOrderNum: null,
      onlineDeviceRate: 0,
    };
    fetchMock.mockResolvedValue(okResult(mixed));

    const output = (await runTool(toolByName("ops_order_statistics", "tok-1"), { dateTime: "2026-09" })) as Record<string, unknown>;
    expect(output["orderFlowAmount"]).toBe(0); // 幸存的全 0 字段保留
    expect(output).not.toHaveProperty("refundOrderNum");
    const note = String(output["提示"]);
    expect(note).toContain("refundOrderNum"); // 缺失字段点名
    expect(note).toContain("全 0"); // 幸存字段全 0 的说明
  });

  it("有真实数据 → 原样透传（不附加任何提示字段）", async () => {
    const stats = { orderFlowAmount: 1200.5, orderNum: 30, refundOrderNum: 3, onlineDeviceRate: 88.8 };
    fetchMock.mockResolvedValue(okResult(stats));

    const output = await runTool(toolByName("ops_order_statistics", "tok-1"), { agentId: 42, dateTime: "2026-09" });
    expect(output).toEqual(stats); // 引用相等级透传，无提示混入
  });
});

describe("ops 工具 dateTime 必填 + 空结果诚实化（年份幻觉修复）", () => {
  it("schema 必填：缺 dateTime 失败、月份格式错失败、合法格式通过（SDK 层强制模型产出合法月份）", () => {
    const t = toolByName("ops_daily_details", "tok-1");
    // inputSchema 的静态类型是 ai 的 FlexibleSchema 联合——先收窄到 zod 才有 safeParse
    const schema = t.inputSchema;
    if (!(schema instanceof z.ZodType)) throw new Error("ops 工具的 inputSchema 应为 zod schema");
    expect(schema.safeParse({ type: 1 }).success).toBe(false); // 缺 dateTime：模型必须产出月份
    expect(schema.safeParse({ type: 1, dateTime: "2026-9" }).success).toBe(false); // 格式错（须补零）
    expect(schema.safeParse({ type: 1, dateTime: "2026-08" }).success).toBe(true);
    expect(schema.safeParse({ type: 1, dateTime: "2022-09" }).success).toBe(false); // 越界年份（红队实测的幻觉值）被窗口拒绝
    expect(schema.safeParse({ type: 1, dateTime: "2026-09" }).success).toBe(true); // 当前月通过
  });

  it("空结果诚实化：上游空数组 → 输出带「无数据」提示字段，防伪零陈述", async () => {
    fetchMock.mockResolvedValueOnce(okResult([])); // 上游该月空数据
    const output = await runTool(toolByName("ops_tenant_top", "tok-1"), {
      agentId: 7,
      dateTime: "2026-08",
    });
    expect(output).toHaveProperty("提示");
    expect(String((output as Record<string, unknown>)["提示"])).toContain("没有任何数据记录");
    expect(output).toMatchObject({ data: [] });
  });
});
