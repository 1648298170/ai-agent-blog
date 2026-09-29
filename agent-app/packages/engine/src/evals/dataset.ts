// dataset.ts —— 黄金数据集：TS 固定夹具形式的评测用例（v3：18 条 Tier 1 + 8 条 judge）
//
// ── 为什么是 TS 文件而不是外部 JSON ──────────────────────────────────────
//   1. 类型即护栏：expectedToolCalls 填错工具名、script 缺 text 收尾轮，
//      在 `pnpm typecheck` 阶段当场标红，不用等跑挂了才发现；
//   2. 版本化随代码走：改用例 = 改代码 = 过 code review，EVAL_DATASET_VERSION
//      显式升版，历史报告（.data/eval-report.json）可追溯当时跑的是哪一版；
//   3. 零 IO：不读文件就不会有路径/编码/并发问题，离线确定性再加一层。
//
// ── 题材口径 ─────────────────────────────────────────────────────────────
// 全部取自中文电商客服的真实话语：查物流 / 忘单号先搜再查 / 投诉建单 /
// 退货登记 / 闲聊直答。含 3 个「期望工具序列为空」的负例——闲聊场景调工具
// 是过度行动（费时费钱还答非所问），负例守住这条底线。
// script 与 expectedToolCalls 是同一场景的两面：script 模拟「好模型会怎么做」，
// expectedToolCalls 是它的标准答案——评分器比对的是答案与真实循环的产出。
import type { EvalCase, JudgeEvalCase } from "./types.js";

/** 数据集版本：改任何用例（含增删）必须升版，报告里带着它。
 * v2：新增检索套件的语料库与查询集（corpus.ts，10 篇文档 + 50 条查询，
 * 由 runner 按 embedding key 门控；本文件的 18 条离线用例未动）
 * v3：新增评审套件 EVAL_JUDGE_CASES（8 条 LLM-as-judge 用例，由 runner 按
 * chat key 门控；轨迹/路由用例仍未动） */
export const EVAL_DATASET_VERSION = "3";

/** 黄金数据集：10 条轨迹用例 + 8 条路由用例 */
export const EVAL_CASES: EvalCase[] = [
  // ── 轨迹套件：模型该选哪些工具、循环按什么顺序执行 ────────────────────
  {
    caseId: "traj-01",
    suite: "trajectory",
    description: "按订单号查物流（单工具）",
    userMessage: "查一下订单 A-1024 的物流到哪了",
    script: [
      { kind: "tool-calls", calls: [{ toolName: "query_logistics", input: { orderId: "A-1024" } }] },
      { kind: "text", text: "您的订单 A-1024 已发货，顺丰速运承运（运单号 SF1234567890），预计明天 18 点前送达。" },
    ],
    expectedToolCalls: ["query_logistics"],
  },
  {
    caseId: "traj-02",
    suite: "trajectory",
    description: "发货进度换一种问法（仍是单工具查物流）",
    userMessage: "订单 A-2048 发货了吗？什么时候能到？",
    script: [
      { kind: "tool-calls", calls: [{ toolName: "query_logistics", input: { orderId: "A-2048" } }] },
      { kind: "text", text: "订单 A-2048 还在仓库打包中，预计后天发出，发出后我会再通知您。" },
    ],
    expectedToolCalls: ["query_logistics"],
  },
  {
    caseId: "traj-03",
    suite: "trajectory",
    description: "物流停滞投诉（应建工单）",
    userMessage: "我要投诉，快递三天了物流一直没动",
    script: [
      {
        kind: "tool-calls",
        calls: [{ toolName: "create_ticket", input: { subject: "物流停滞投诉", description: "用户反馈快递三天物流无更新，要求跟进处理" } }],
      },
      { kind: "text", text: "非常抱歉给您带来不便，已为您创建投诉工单 TK-EVAL-0001，加急件会在 2 小时内跟进。" },
    ],
    expectedToolCalls: ["create_ticket"],
  },
  {
    caseId: "traj-04",
    suite: "trajectory",
    description: "忘单号：先按手机尾号搜订单再查物流（双工具序列）",
    userMessage: "我不记得订单号了，手机尾号 6688 名下有什么订单？帮我查最新的物流",
    script: [
      { kind: "tool-calls", calls: [{ toolName: "search_orders", input: { keyword: "6688" } }] },
      { kind: "tool-calls", calls: [{ toolName: "query_logistics", input: { orderId: "A-1024" } }] },
      { kind: "text", text: "您名下最新一笔是订单 A-1024（9 月 25 日下单）：已发货，顺丰速运 SF1234567890，预计明天 18 点前送达。" },
    ],
    expectedToolCalls: ["search_orders", "query_logistics"],
  },
  {
    caseId: "traj-05",
    suite: "trajectory",
    description: "开场问候（负例：一步工具都不该调）",
    userMessage: "你好",
    script: [{ kind: "text", text: "您好！请问有什么可以帮您？" }],
    expectedToolCalls: [],
  },
  {
    caseId: "traj-06",
    suite: "trajectory",
    description: "致谢收尾（负例：不许调工具）",
    userMessage: "谢谢，问题解决了，不用了",
    script: [{ kind: "text", text: "不客气，很高兴帮到您！后续有任何问题随时找我。" }],
    expectedToolCalls: [],
  },
  {
    caseId: "traj-07",
    suite: "trajectory",
    description: "服务时间直答（负例：常识问题不必动工具）",
    userMessage: "你们的人工客服工作时间是几点到几点？",
    script: [{ kind: "text", text: "人工客服的工作时间是每天 9:00-21:00，其他时间可以留言，上线后会第一时间回复您。" }],
    expectedToolCalls: [],
  },
  {
    caseId: "traj-08",
    suite: "trajectory",
    description: "退货登记（应建工单）",
    userMessage: "上周买的蓝牙耳机想退货，帮我登记一下",
    script: [
      {
        kind: "tool-calls",
        calls: [{ toolName: "create_ticket", input: { subject: "退货申请：蓝牙耳机", description: "用户申请退回上周购买的蓝牙耳机，待售后审核" } }],
      },
      { kind: "text", text: "已为您登记退货工单 TK-EVAL-0001，售后会在 24 小时内联系您确认取件方式。" },
    ],
    expectedToolCalls: ["create_ticket"],
  },
  {
    caseId: "traj-09",
    suite: "trajectory",
    description: "查无此单转催单（先查物流、再建工单的双工具链）",
    userMessage: "查一下订单 A-9999 到哪了，查不到的话帮我建个催单工单",
    script: [
      { kind: "tool-calls", calls: [{ toolName: "query_logistics", input: { orderId: "A-9999" } }] },
      {
        kind: "tool-calls",
        calls: [{ toolName: "create_ticket", input: { subject: "订单 A-9999 催单", description: "系统查无此单物流记录，用户要求人工核实订单状态" } }],
      },
      { kind: "text", text: "系统里暂时查不到订单 A-9999 的物流记录，已为您建了催单工单 TK-EVAL-0001，人工核实后会尽快回复您。" },
    ],
    expectedToolCalls: ["query_logistics", "create_ticket"],
  },
  {
    caseId: "traj-10",
    suite: "trajectory",
    description: "确认签收状态（单工具，第三种订单号）",
    userMessage: "订单 B-0001 是不是已经签收了？",
    script: [
      { kind: "tool-calls", calls: [{ toolName: "query_logistics", input: { orderId: "B-0001" } }] },
      { kind: "text", text: "是的，订单 B-0001 已于昨天下午签收。如果包裹有问题，随时告诉我帮您处理。" },
    ],
    expectedToolCalls: ["query_logistics"],
  },

  // ── 路由套件：Supervisor 硬规则把消息送去哪（Tier 1 = 确定性层）──────
  // expectedTarget=null 表示「硬规则必须放行」：模型三分类是 Tier 3 的评测对象，
  // 这里只断言确定性规则不误伤正常业务。
  {
    caseId: "route-01",
    suite: "routing",
    description: "用户明确要求转人工（关键词命中）",
    state: { lastUserMessage: "转人工", unresolvedRounds: 0 },
    expectedTarget: "human",
  },
  {
    caseId: "route-02",
    suite: "routing",
    description: "「换个人」的口语化转人工说法",
    state: { lastUserMessage: "别机器人了，换个人来跟我说话", unresolvedRounds: 0 },
    expectedTarget: "human",
  },
  {
    caseId: "route-03",
    suite: "routing",
    description: "高危关键词：投诉（答错一个字的代价远高于转人工）",
    state: { lastUserMessage: "我要投诉你们发货太慢", unresolvedRounds: 0 },
    expectedTarget: "human",
  },
  {
    caseId: "route-04",
    suite: "routing",
    description: "高危关键词：律师起诉（法律风险）",
    state: { lastUserMessage: "再不解决我就找律师起诉你们", unresolvedRounds: 0 },
    expectedTarget: "human",
  },
  {
    caseId: "route-05",
    suite: "routing",
    description: "连续 2 轮未解决（计数优先级最高：AI 已在原地打转）",
    state: { lastUserMessage: "还是不行，到底怎么办", unresolvedRounds: 2 },
    expectedTarget: "human",
  },
  {
    caseId: "route-06",
    suite: "routing",
    description: "正常订单查询（硬规则放行，交模型分类）",
    state: { lastUserMessage: "查一下订单 A-1024 发到哪了", unresolvedRounds: 0 },
    expectedTarget: null,
  },
  {
    caseId: "route-07",
    suite: "routing",
    description: "正常退款咨询（硬规则放行——咨询不等于争议）",
    state: { lastUserMessage: "未拆封的商品可以申请七天无理由退款吗", unresolvedRounds: 0 },
    expectedTarget: null,
  },
  {
    caseId: "route-08",
    suite: "routing",
    description: "正常制度问答（硬规则放行，走 knowledge 工人）",
    state: { lastUserMessage: "出差住宿标准是多少", unresolvedRounds: 0 },
    expectedTarget: null,
  },
];

// ── 评审套件（Tier 3，P3）：LLM-as-judge 的黄金用例 ─────────────────────
// 与轨迹/路由用例同款「TS 固定夹具」三条理由（类型护栏 / 版本随代码 / 零 IO）。
// 口径：回答是预写的（judge 只评审、不生成），期望的是「judge 的判定」
// 而不是「回答的好坏」——6 条正例的好回答各满足全部 rubric 条目，
// 2 条负例的坏回答明确违反或缺失条目。负例是 judge 校准的落地点：
// 一个只会说「通过」的好好先生评审员会在 judge-07 / judge-08 上当场露馅
// （期望不通过，它却判通过 → scoreJudge 判 mismatch → 该用例 FAIL）。
// rubric 条目全部写成短的可核对陈述（回答必须包含… / 不得…），
// 政策类事实与 corpus.ts 的语料口径对齐（包邮门槛 99 元、退款原路退回等）。
/** 评审套件：8 条 judge 用例（judge-01..judge-08，6 正例 + 2 负例） */
export const EVAL_JUDGE_CASES: JudgeEvalCase[] = [
  {
    caseId: "judge-01",
    suite: "judge",
    description: "物流查询好回答（正例：单号 / 承运 / 预计送达齐全）",
    userMessage: "查一下订单 A-1024 的物流到哪了",
    answer:
      "您好，订单 A-1024 已于昨日发货，由顺丰速运承运，运单号 SF1234567890。包裹目前到达杭州转运中心，预计明天 18 点前送达，签收前请保持电话畅通。",
    rubric: [
      "回答必须包含订单号 A-1024",
      "回答必须包含承运公司名称与运单号",
      "回答必须给出预计送达时间",
      "不得包含与物流查询无关的推销内容",
    ],
    expectedPass: true,
  },
  {
    caseId: "judge-02",
    suite: "judge",
    description: "退款好回答（正例：时效与原路退回齐全）",
    userMessage: "我上周买的蓝牙耳机想退款，钱多久能退回来？",
    answer:
      "您好，您的蓝牙耳机退款申请已提交审核，客服会在 1 个工作日内完成审核。审核通过并确认收到退货后，退款将在 3 个工作日内原路退回到您的支付账户（本单为支付宝），到账后会有短信通知，请留意查收。",
    rubric: [
      "回答必须说明退款到账时效（几个工作日内）",
      "回答必须说明退款原路退回",
      "不得承诺平台没有的加急退款服务",
    ],
    expectedPass: true,
  },
  {
    caseId: "judge-03",
    suite: "judge",
    description: "投诉转人工好回答（正例：工单号 / 跟进时限 / 致歉齐全）",
    userMessage: "我要投诉，快递三天了物流一直没动，给我转人工",
    answer:
      "非常抱歉给您带来不便。已为您创建加急投诉工单，工单号 TK-2026-0929-001，人工客服将在 2 小时内与您联系跟进物流停滞的问题。您也可以随时凭工单号查询处理进度。",
    rubric: [
      "回答必须包含工单号",
      "回答必须说明人工跟进的时限",
      "回答必须有致歉表述",
      "不得声称问题已当场解决（物流停滞需要人工核实）",
    ],
    expectedPass: true,
  },
  {
    caseId: "judge-04",
    suite: "judge",
    description: "七天无理由退货政策好回答（正例：确认 / 入口 / 时效齐全）",
    userMessage: "没拆封的商品可以七天无理由退货吗？",
    answer:
      "可以。商品自签收之日起 7 天内，保持未使用、不影响二次销售的，支持无理由退货。请在订单详情页点击「申请售后」，选择退货退款并填写原因，审核通过后按页面提供的退货地址寄回，仓库验收合格后 3 个工作日内原路退款。",
    rubric: [
      "回答必须明确确认支持七天无理由退货",
      "回答必须说明申请入口（订单详情页申请售后）",
      "回答必须说明退款到账时效",
    ],
    expectedPass: true,
  },
  {
    caseId: "judge-05",
    suite: "judge",
    description: "修改密码引导好回答（正例：路径 / 验证码 / 不索要敏感信息）",
    userMessage: "怎么修改登录密码？",
    answer:
      "您好，修改密码的路径：登录后进入「账户设置」→「安全中心」→「修改密码」。操作时需要先通过绑定手机号接收的验证码验证身份，再设置新密码（建议 8 位以上、包含字母和数字）。修改成功后其他登录设备会退出，需要重新登录。",
    rubric: [
      "回答必须给出修改密码的具体操作路径",
      "回答必须说明需要手机验证码验证身份",
      "不得向用户索要密码或短信验证码",
    ],
    expectedPass: true,
  },
  {
    caseId: "judge-06",
    suite: "judge",
    description: "开发票好回答（正例：入口 / 税号 / 送达时效齐全）",
    userMessage: "订单完成后怎么开发票？",
    answer:
      "您好，订单完成后可以在订单详情页点击「申请开票」，选择电子发票并填写发票抬头：个人抬头直接填写姓名，企业抬头需要额外填写纳税人识别号。电子发票一般在申请后 24 小时内发送到您预留的邮箱，可直接用于报销。",
    rubric: [
      "回答必须说明申请开票的入口（订单详情页）",
      "回答必须提及企业抬头需要纳税人识别号",
      "回答必须说明电子发票的送达时效",
    ],
    expectedPass: true,
  },
  {
    caseId: "judge-07",
    suite: "judge",
    description: "编造平台没有的政策（负例：judge 必须判不通过）",
    userMessage: "你们包邮门槛是多少？不满包邮门槛的订单怎么办？",
    answer:
      "您好，我们平台所有订单一律免运费，什么时候下单都不收邮费，偏远地区也一样全部免费，您放心购买就好，不用凑单。",
    rubric: [
      "回答必须说明满 99 元包邮的门槛金额",
      "回答必须说明不满门槛需支付基础运费",
      "不得承诺与平台政策不符的优惠（平台政策：满 99 元包邮，不满收基础运费）",
    ],
    expectedPass: false,
  },
  {
    caseId: "judge-08",
    suite: "judge",
    description: "纯客套话答非所问（负例：judge 必须判不通过）",
    userMessage: "我的订单 A-1024 到哪了？什么时候能到？",
    answer:
      "您好，感谢您的耐心等待，相关信息可能会有所更新，建议您留意相关通知，如有其他问题欢迎随时咨询，祝您生活愉快。",
    rubric: [
      "回答必须包含具体订单号",
      "回答必须给出明确的物流状态或预计送达时间",
      "不得只有客套话而没有任何可执行信息",
    ],
    expectedPass: false,
  },
];
