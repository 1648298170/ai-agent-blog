// pii-mask-detectors.spec.ts —— 识别器可插拔扩展点（BACKLOG：guardrails 工业化第一批）：
// 默认三类回归（与 maskPii 同口径）+ 自定义识别器扩展（不改引擎）+ 空清单行为。
// 铁律：maskPii / countMasked 的公共签名与默认行为不变——可插拔只加出口不改现状。
import { describe, expect, it } from "vitest";
import {
  countMasked,
  createPiiMasker,
  DEFAULT_PII_DETECTORS,
  maskPii,
  type PiiDetector,
} from "../src/guardrails/pii-mask.js";

describe("默认识别器回归（与 maskPii 历史行为同口径）", () => {
  it("三类 PII 各自打码（保留头尾）", () => {
    expect(maskPii("手机号13812345678")).toBe("手机号138****5678");
    expect(maskPii("证件110101199003078516")).toBe("证件1101************16");
    expect(maskPii("卡号6222020200112233")).toBe("卡号6222********2233");
  });

  it("countMasked 与打码同口径", () => {
    expect(countMasked("手机号13812345678和证件110101199003078516")).toBe(2);
    expect(countMasked("无PII文本")).toBe(0);
  });
});

describe("自定义识别器（扩展新 PII 类型 = 追加识别器对象）", () => {
  /** 示例扩展：邮箱识别器（内置三类之外的新 PII 类型） */
  const EMAIL_DETECTORS: PiiDetector[] = [
    ...DEFAULT_PII_DETECTORS,
    {
      name: "email",
      pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
      mask: (match) => {
        const [user, domain] = match.split("@");
        return `${user!.slice(0, 2)}***@${domain}`;
      },
    },
  ];

  it("createPiiMasker：邮箱被自定义识别器打码", () => {
    const { mask, count } = createPiiMasker(EMAIL_DETECTORS);
    expect(mask("联系 zhangsan@example.com")).toBe("联系 zh***@example.com");
    expect(count("无邮箱文本")).toBe(0);
  });

  it("默认 maskPii 不受自定义识别器影响（出口签名不变，行为隔离）", () => {
    expect(maskPii("联系 zhangsan@example.com")).toBe("联系 zhangsan@example.com");
    expect(countMasked("联系 zhangsan@example.com")).toBe(0);
  });

  it("顺序语义保留：识别器数组序 = 执行序（先到的先打码）", () => {
    // 自定义「全数字打码器」放在身份证之后：身份证已打成 *，数字打码器不再命中
    const detectors: PiiDetector[] = [
      ...DEFAULT_PII_DETECTORS,
      { name: "any-digit", pattern: /\d{6,}/, mask: (m) => `#`.repeat(m.length) },
    ];
    const { mask, count } = createPiiMasker(detectors);
    const out = mask("证件110101199003078516");
    expect(out.startsWith("证件1101")).toBe(true); // 身份证口径先执行
    expect(count("证件110101199003078516")).toBeGreaterThanOrEqual(1);
  });

  it("空识别器清单 → 原样返回（显式关闭脱敏的出口）", () => {
    const { mask, count } = createPiiMasker([]);
    expect(mask("手机号13812345678")).toBe("手机号13812345678");
    expect(count("任意文本")).toBe(0);
  });
});
