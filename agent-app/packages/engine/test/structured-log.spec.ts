// structured-log.spec.ts —— B2 结构化日志测试：json 模式（pino / 结构化轨迹）与
// 默认 text 模式的逐字节兼容。
//
// 截获手法（沿用项目 vi.spyOn 惯例，扩展到 std 流）：
// - console.*：vi.spyOn(console, "log"|"warn")，与 memory-factory.spec.ts 同款；
// - stderr / stdout：vi.spyOn(process.stderr|stdout, "write")。
//   stdout 有个 pino 特有的坑：pino() 无显式目标时默认绑 fd 1 的 SonicBoom（绕开
//   process.stdout.write，截获不到）；但 pino 检测到 stdout 被「动过」（write 被换掉，
//   即 spyOn 安装的 mock）时会改绑 process.stdout 对象本身——所以 json 用例必须
//   先装截获、再触发 getEngineLogger() 首次创建 pino 实例，写就会走可截获的 write。
// env 注入：AGENT_* 开关全走 loadEnv() → process.env 优先于 .env 文件，直接设
// 进程环境变量即可（hardening.spec.ts 同款 save/restore 惯例）。默认态用例显式设
// "text"，压过任何 .env 里可能存在的值，保证断言确定性。
import { afterEach, describe, expect, it, vi } from "vitest";
import { consoleLogger, getEngineLogger, setEngineLogger, type EngineLogger } from "../src/logger.js";
import { trace } from "../src/trace.js";

const ORIGINAL_FORMAT = process.env.AGENT_LOG_FORMAT;
const ORIGINAL_LEVEL = process.env.AGENT_LOG_LEVEL;
const ORIGINAL_TRACE = process.env.AGENT_TRACE;

/** 恢复一个环境变量到测试前的值（原来没设就删掉） */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** 把 std 流截获到的 calls 转成字符串行（chunk 可能是 string，统一 String()） */
function captured(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
  // 回到「env 决定默认实现」态（consoleLogger 语义 = 默认实现，见 logger.ts 头注）
  setEngineLogger(consoleLogger);
  restoreEnv("AGENT_LOG_FORMAT", ORIGINAL_FORMAT);
  restoreEnv("AGENT_LOG_LEVEL", ORIGINAL_LEVEL);
  restoreEnv("AGENT_TRACE", ORIGINAL_TRACE);
});

describe("logger · json 模式（AGENT_LOG_FORMAT=json → pino 适配器）", () => {
  it("info → stdout 上的 JSON 行：可 JSON.parse，level=30（pino 数字级别）、msg 原样、行尾换行", () => {
    // 先装截获再首次建 pino（原因见文件头注释），否则绑 SonicBoom 截不到
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.AGENT_LOG_FORMAT = "json";
    getEngineLogger().info("hello 结构化");
    const line = captured(out).find((l) => l.includes("hello 结构化"));
    expect(line).toBeDefined();
    const parsed = JSON.parse((line ?? "").trim());
    expect(parsed.level).toBe(30);
    expect(parsed.msg).toBe("hello 结构化");
    expect(line?.endsWith("\n")).toBe(true);
  });

  it("warn → level=40 的 JSON 行", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.AGENT_LOG_FORMAT = "json";
    getEngineLogger().warn("配置已安全降级");
    const line = captured(out).find((l) => l.includes("配置已安全降级"));
    expect(line).toBeDefined();
    const parsed = JSON.parse((line ?? "").trim());
    expect(parsed.level).toBe(40);
    expect(parsed.msg).toBe("配置已安全降级");
  });

  it("AGENT_LOG_LEVEL=warn：低于门槛的 info 被滤掉，warn 照常输出", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.AGENT_LOG_FORMAT = "json";
    process.env.AGENT_LOG_LEVEL = "warn";
    const log = getEngineLogger();
    log.info("不应出现的低级别信息");
    log.warn("该出现的警告");
    expect(captured(out).some((l) => l.includes("不应出现的低级别信息"))).toBe(false);
    expect(
      captured(out).some((l) => {
        try {
          return JSON.parse(l.trim()).msg === "该出现的警告";
        } catch {
          return false;
        }
      }),
    ).toBe(true);
  });

  it("非法 AGENT_LOG_LEVEL=verbose → 回退 info 不抛错，输出照常", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.env.AGENT_LOG_FORMAT = "json";
    process.env.AGENT_LOG_LEVEL = "verbose";
    expect(() => getEngineLogger().info("级别回退测试")).not.toThrow();
    const line = captured(out).find((l) => l.includes("级别回退测试"));
    expect(line).toBeDefined();
    expect(JSON.parse((line ?? "").trim()).msg).toBe("级别回退测试");
  });

  it("显式 setEngineLogger 的注入优先于 env 开关：json 模式下仍走注入实现", () => {
    process.env.AGENT_LOG_FORMAT = "json";
    const calls: string[] = [];
    const custom: EngineLogger = {
      info: (m) => calls.push(m),
      warn: (m) => calls.push(m),
    };
    setEngineLogger(custom);
    getEngineLogger().info("注入优先");
    expect(calls).toEqual(["注入优先"]);
  });
});

describe("logger · 默认（text）模式：consoleLogger 行为逐字节不变", () => {
  it("info 原样走 console.log：单参数、原字符串、无时间戳无前缀", () => {
    process.env.AGENT_LOG_FORMAT = "text"; // 显式 text 压过任何 .env 值，保证确定性
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    getEngineLogger().info("纯文本信息");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]).toEqual(["纯文本信息"]);
  });

  it("warn 原样走 console.warn", () => {
    process.env.AGENT_LOG_FORMAT = "text";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    getEngineLogger().warn("纯文本警告");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]).toEqual(["纯文本警告"]);
  });

  it("setEngineLogger(consoleLogger) 后回到「env 决定」态：text 下与默认完全一致", () => {
    setEngineLogger(consoleLogger);
    process.env.AGENT_LOG_FORMAT = "text";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    getEngineLogger().info("复位后的信息");
    expect(logSpy.mock.calls[0]).toEqual(["复位后的信息"]);
  });
});

describe("trace · json 模式：结构化轨迹行", () => {
  it("开轨迹后输出 {time(ISO), icon, event} 的 JSON 行到 stderr", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.AGENT_LOG_FORMAT = "json";
    process.env.AGENT_TRACE = "1";
    trace("▶", "思考 step 1 → 调用模型");
    const line = captured(err).find((l) => l.includes("思考 step 1"));
    expect(line).toBeDefined();
    const trimmed = (line ?? "").trim();
    const parsed = JSON.parse(trimmed);
    expect(parsed.icon).toBe("▶");
    expect(parsed.event).toBe("思考 step 1 → 调用模型");
    expect(Number.isNaN(Date.parse(parsed.time))).toBe(false); // 合法 ISO 时间
    expect(line?.startsWith('{"time":"')).toBe(true); // 字段序：time 打头（采集侧时间轴友好）
  });
});

describe("trace · 默认（text）模式：逐字节兼容", () => {
  it("AGENT_LOG_FORMAT=text + 开轨迹 → `${icon} ${message}\\n` 原样输出", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.AGENT_LOG_FORMAT = "text";
    process.env.AGENT_TRACE = "1";
    trace("▶", "思考 step 1 → 调用模型");
    expect(captured(err).some((l) => l === "▶ 思考 step 1 → 调用模型\n")).toBe(true);
  });

  it("轨迹开关关闭 → 一字节都不写 stderr（json 模式同样静默）", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.env.AGENT_LOG_FORMAT = "json";
    delete process.env.AGENT_TRACE;
    trace("▶", "不该出现");
    expect(err.mock.calls.length).toBe(0);
  });
});
