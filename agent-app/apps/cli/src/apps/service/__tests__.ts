// apps/service/__tests__.ts —— Supervisor 硬规则离线自测（纯函数断言，无网络、无模型）
// 运行：pnpm test:service
// 为什么单独立文件：硬规则是客服系统的生死线，「转人工四条触发各实测一例」
// 是 service.md 上线检查清单第 1 条；本脚本只测纯函数，断言行为完全确定。
// 单仓化改造：supervisor 产品核心上移 @agent-app/engine/service，这里经包子路径导入。
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  checkHardRules,
  HIGH_RISK_KEYWORDS,
  HUMAN_REQUEST_KEYWORDS,
  isUnresolvedSignal,
  matchAnyKeyword,
} from "@agent-app/engine/service";
import type { RouteDecision } from "@agent-app/engine/service";

/** 便利断言：判定必须是转人工 */
function assertHuman(decision: RouteDecision | null, reasonIncludes: string): void {
  assert.ok(decision !== null, "硬规则应命中（返回非 null）");
  assert.equal(decision.target, "human");
  assert.ok(
    decision.reason.includes(reasonIncludes),
    `reason 应包含「${reasonIncludes}」，实际：「${decision.reason}」`,
  );
}

// ---------- 1. 硬规则 1：用户明确要求转人工 ----------
async function testHumanRequest(): Promise<void> {
  assertHuman(checkHardRules({ lastUserMessage: "别说了，转人工", unresolvedRounds: 0 }), "转人工");
  assertHuman(checkHardRules({ lastUserMessage: "听不懂吗？换个人", unresolvedRounds: 0 }), "换个人");
  // 正常业务话术不该误伤
  assert.equal(
    checkHardRules({ lastUserMessage: "帮我查下订单 A-1024", unresolvedRounds: 0 }),
    null,
    "正常订单咨询不该触发转人工",
  );
}

// ---------- 2. 硬规则 2：高危业务白名单 ----------
async function testHighRisk(): Promise<void> {
  assertHuman(checkHardRules({ lastUserMessage: "我要投诉你们", unresolvedRounds: 0 }), "投诉");
  assertHuman(checkHardRules({ lastUserMessage: "这个退款争议我不认可", unresolvedRounds: 0 }), "退款争议");
  assertHuman(checkHardRules({ lastUserMessage: "处理不好我要找律师", unresolvedRounds: 0 }), "律师");
  // 普通退款咨询不算高危，应交给 refund 工人
  assert.equal(
    checkHardRules({ lastUserMessage: "退款怎么申请", unresolvedRounds: 0 }),
    null,
    "普通退款咨询不算高危，留给模型分类",
  );
}

// ---------- 3. 硬规则 3：连续两轮未解决 ----------
async function testUnresolvedCounter(): Promise<void> {
  // 0 轮、1 轮：还给 AI 机会
  assert.equal(checkHardRules({ lastUserMessage: "到底怎么办啊", unresolvedRounds: 0 }), null);
  assert.equal(checkHardRules({ lastUserMessage: "到底怎么办啊", unresolvedRounds: 1 }), null, "1 轮未解决先不转");
  // 满 2 轮：必须转，第三轮再转用户耐心就见底了
  assertHuman(checkHardRules({ lastUserMessage: "我问的不是这个", unresolvedRounds: 2 }), "未解决");
  // 计数规则优先级最高：与关键词同时命中时，reason 说明轮数
  assertHuman(checkHardRules({ lastUserMessage: "转人工", unresolvedRounds: 3 }), "未解决");
}

// ---------- 4. 追问未解决信号（计数原料） ----------
async function testUnresolvedSignals(): Promise<void> {
  assert.equal(isUnresolvedSignal("我问的不是这个"), true);
  assert.equal(isUnresolvedSignal("还是不行，到底怎么办"), true);
  assert.equal(isUnresolvedSignal("答非所问"), true);
  assert.equal(isUnresolvedSignal("帮我查下订单"), false);
  assert.equal(isUnresolvedSignal("退货政策是什么"), false);
}

// ---------- 5. 关键词匹配基本功 ----------
async function testKeywordMatch(): Promise<void> {
  assert.equal(matchAnyKeyword("我要投诉", HIGH_RISK_KEYWORDS), "投诉");
  assert.equal(matchAnyKeyword("找真人聊聊", HUMAN_REQUEST_KEYWORDS), "找真人");
  assert.equal(matchAnyKeyword("今天天气不错", HIGH_RISK_KEYWORDS), null);
  assert.equal(matchAnyKeyword("", HUMAN_REQUEST_KEYWORDS), null, "空消息不误触发");
}

/** 全部自测项：逐项跑，失败记录并最终以非零码退出（同 selftest 的骨架） */
async function runServiceTests(): Promise<void> {
  const tests: [name: string, fn: () => Promise<void>][] = [
    ["硬规则 1 · 明确要求转人工", testHumanRequest],
    ["硬规则 2 · 高危业务白名单", testHighRisk],
    ["硬规则 3 · 连续两轮未解决", testUnresolvedCounter],
    ["追问未解决信号 isUnresolvedSignal", testUnresolvedSignals],
    ["关键词匹配 matchAnyKeyword", testKeywordMatch],
  ];

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}`);
      console.error(`      ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failed > 0) {
    console.error(`客服硬规则自测未通过：${failed}/${tests.length} 项失败`);
    process.exitCode = 1;
  } else {
    console.log(`客服硬规则自测全部通过（${tests.length}/${tests.length}），未发起任何网络请求。`);
  }
}

// 直接运行（pnpm test:service）时自动执行
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runServiceTests();
}
