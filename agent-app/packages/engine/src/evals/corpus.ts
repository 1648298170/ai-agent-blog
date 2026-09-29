// corpus.ts —— 检索评测语料库（Tier 2）：10 篇主题互斥的中文客服政策文档 + 50 条查询
//
// ── 为什么语料本身就是质量门禁 ────────────────────────────────────────────
// 检索评估评的是「embedding + 余弦检索能不能把对的事找出来」，但结论只在
// 语料靠谱时成立：十篇文档主题互相咬住（退货退款 vs 售后保修、配送时效 vs
// 配送范围运费），查询混排直问 / 间接转述 / 邻接对抗三种难度——recall@3
// 才能如实暴露「主题边界糊了」的退化。改语料 = 改标准答案 = 升版
// （EVAL_DATASET_VERSION，常量在 dataset.ts）。
//
// ── 为什么是 TS 固定夹具而不是外部 JSON ──────────────────────────────────
// 与 dataset.ts 同款三条理由：类型即护栏（expectedDocId 填错 docId，
// vitest 的数据集完整性测试当场标红）、版本化随代码走、零 IO 确定性。
//
// ── 查询分布口径 ─────────────────────────────────────────────────────────
// 每篇文档至少 4 条查询（共 50 条，rtv-01..rtv-50），三种难度混排：
//   直问（policy 名字直接出现）、间接转述（说症状不说政策名，
//   如「买完不想要了怎么办」→ 退货退款政策）、邻接对抗（查询里出现
//   别的主题词但仍应命中本主题，如「用优惠券买的订单退款后券会返还吗」
//   → 优惠券使用规则，而不是退货退款政策）。
import type { RetrievalEvalCase } from "./types.js";

/** 一篇评测语料文档：docId 全库唯一、title 给人看、text 是政策正文 */
export interface EvalCorpusDoc {
  docId: string;
  title: string;
  text: string;
}

/**
 * 固定评测语料库：恰好 10 篇，主题两两互斥（见每篇 title）。
 * 每篇 300~600 字的政策式行文，默认切块参数（maxLen 500）下每篇 1~2 块。
 */
export const EVAL_CORPUS: EvalCorpusDoc[] = [
  {
    docId: "return-refund",
    title: "退货退款政策",
    text: "退货退款政策说明：除定制商品、生鲜食品、贴身衣物以及商品页明确标注不支持退货的商品外，平台所有商品自签收之日起七天内支持无理由退货，退货时商品需保持吊牌完整、配件齐全且不影响二次销售。申请退货请在订单详情页点击申请售后，选择退货退款并填写原因，客服将在一到两个工作日内完成审核；审核通过后按页面提供的退货地址寄回商品，质量问题产生的退货运费由平台承担，个人原因产生的运费由买家承担。仓库签收并验收合格后，退款将在三个工作日内原路退回您的支付账户，银行卡支付的到账时间以银行为准。退款金额为商品实际支付金额，下单时使用的优惠券将按优惠券规则退回或作废，随单赠品需一并退回。想确认某件商品能不能退，可在商品详情页查看退货标识或咨询在线客服。",
  },
  {
    docId: "shipping-eta",
    title: "物流配送时效",
    text: "物流配送时效说明：普通订单在您完成支付后二十四小时内发货，大促期间订单量激增，发货时间可能延长至四十八小时，发货后会通过短信和站内消息通知您。发货后的配送时效因收货地区而异：同城订单一般当日达或次日达，省内及周边地区一般一到两天送达，全国主要城市之间一般两到三天送达，部分偏远地区配送时间相对较长。您可以在订单详情页实时查看物流轨迹，了解包裹当前所在位置和预计送达时间。如遇雨雪天气、交通管制或节假日快递高峰，配送时效可能会有所延长，请以物流轨迹里的最新时间为准。如果您对收货时间有较高要求，下单前可以联系客服确认预计送达日期，也可以留意商品页面的限时达标识。包裹显示已签收但实际未收到、或物流长时间没有更新时，请及时联系客服核实处理。",
  },
  {
    docId: "payment-invoice",
    title: "支付方式与发票",
    text: "支付方式与发票说明：平台目前支持支付宝、微信支付、各大银行储蓄卡和信用卡，以及花呗分期、信用卡分期等付款方式，您可以在结算页面自由选择。支付过程中如遇扣款成功但订单未生成的情况，款项一般会在一到三个工作日内自动退回原支付账户，请勿重复支付。发票方面：平台默认提供电子发票，在订单完成后您可以通过订单详情页申请开票并填写发票抬头，支持个人抬头和企业抬头，企业抬头需要填写纳税人识别号。电子发票一般在申请后二十四小时内发送到您预留的邮箱，具有与纸质发票同等的法律效力，可以直接用于单位报销。如需换开纸质发票或修改发票信息，请在开票前联系客服处理。发票金额以订单实际支付金额为准，优惠券抵扣的部分不开具发票。",
  },
  {
    docId: "membership-tier",
    title: "会员权益等级",
    text: "会员权益等级说明：平台会员体系分为普通会员、白银会员、黄金会员和铂金会员四个等级，等级由近一年的成长值决定，成长值通过购物消费、评价晒单、完善资料等方式积累，每消费一元积累一点成长值。不同等级享受不同权益：白银会员享受购物返积分和专属客服通道；黄金会员在此基础上享受每月一张免邮券、生日当月专属优惠以及部分商品的会员价；铂金会员进一步享受大牌折扣活动优先购、新品试用和专属客户经理服务。会员等级每个季度评估一次，达到升级门槛自动升级、权益即时生效；近一年成长值下降的，等级也会相应下调。会员积分可以在积分商城兑换优惠券、礼品和品牌周边，积分自到账之日起一年内有效，过期自动清零，请留意在有效期内及时使用，避免过期浪费。",
  },
  {
    docId: "account-security",
    title: "账号与密码安全",
    text: "账号与密码安全说明：为保障您的账户安全，建议设置八位以上、包含字母和数字组合的登录密码，避免使用生日、手机号等容易被猜到的信息。您可以在账户设置的安全中心修改登录密码，修改时需要通过手机验证码验证身份。忘记密码时可以在登录页点击忘记密码，通过绑定的手机号或邮箱找回。更换手机号后请及时在账户设置中更新绑定信息，避免收不到验证码导致无法登录。发现账号在异地登录或收到异常操作提醒时，请立即修改密码并联系客服冻结账户。平台工作人员绝不会以任何理由向您索要短信验证码和支付密码，请勿将验证码告知任何人，包括自称客服的来电。定期在登录设备管理中清理不常用的登录设备，可以有效降低账号被盗的风险。遇到任何账户安全问题，都可以随时联系客服协助处理。",
  },
  {
    docId: "coupon-rules",
    title: "优惠券使用规则",
    text: "优惠券使用规则说明：平台优惠券分为满减券、折扣券和包邮券三种类型，可以通过每日领券中心、参与平台活动、会员权益发放和店铺关注赠送等途径获取。满减券需要订单金额满足使用门槛才能抵扣，折扣券按比例折让且一般设有最高优惠上限，包邮券可以免除一单运费。大多数优惠券不支持叠加使用，一单只能使用一张，具体以券面说明为准。下单时系统会自动选取符合条件的最优优惠券，您也可以在结算页手动切换。使用优惠券支付的订单如发生退货退款，订单实付金额会全额原路退回，优惠券在有效期内会自动退回账户，已过有效期的优惠券不予退回，请留意每张券的有效期。部分优惠券仅限指定品类或指定商品使用，结算前请确认所选商品在优惠券的适用范围内，避免下单后无法抵扣。",
  },
  {
    docId: "delivery-coverage",
    title: "配送范围与运费",
    text: "配送范围与运费说明：平台商品默认配送至中国大陆大部分地区，覆盖全国主要城市和区县，目前暂不配送港澳台地区及海外地址，大件商品、冷链商品可能有额外的配送范围限制，以商品详情页说明为准。运费标准：单笔订单实付金额满九十九元包邮，不满九十九元收取基础运费八元；新疆、西藏、青海、内蒙古等偏远地区需加收偏远地区附加费，具体金额以下单页面显示为准。您可以在结算页面确认收货地址是否可以配送以及该订单的运费金额，收货地址超出配送范围时，系统会提示您修改地址或取消订单。偏远地区订单的配送周期相对更长，且部分促销活动商品可能不参与偏远地区配送，下单前请仔细阅读商品页的配送说明，合理选择收货地址，确保商品能够顺利送达。",
  },
  {
    docId: "warranty-service",
    title: "售后保修政策",
    text: "售后保修政策说明：平台所售数码家电类商品按照国家三包规定提供售后服务，整机自签收之日起保修一年，主要部件保修两年，电池、数据线等易损耗部件保修半年，具体保修期限以商品详情页和保修卡标注为准。商品在保修期内出现非人为的性能故障，可以在线申请售后维修服务：选择售后类型为维修并描述故障情况，审核通过后按页面提示寄回商品或前往线下服务网点检测。属于质量问题的一律免费维修，维修期间产生的双向运费由平台承担；经检测属于人为损坏、进水、私自拆解或不可抗力造成的故障，不在免费保修范围内，可以选择付费维修。维修周期一般为七到十五个工作日，同一故障在保修期内重复出现的可申请换新。手机、电脑等商品建议优先前往官方授权服务网点检测，享有的保修权益一致。",
  },
  {
    docId: "gift-card-balance",
    title: "礼品卡与余额",
    text: "礼品卡与余额说明：平台礼品卡分为电子礼品卡和实体购物卡两种，面值有五十元、一百元、两百元、五百元和一千元可选，可以自用也可以赠送亲友。购买电子礼品卡后，将收到的卡密在账户设置的礼品卡页面输入即可充值到账，充值成功后金额进入账户余额，账户余额长期有效。使用余额支付时在结算页面选择余额支付即可，余额不足以支付订单时可以组合支付，差额部分用其他付款方式补齐。您可以在账户资产页面随时查询余额和消费明细。账户余额不支持提现和转账，礼品卡卡密请妥善保管、遗失不补。使用余额支付的订单发生退货时，退款金额优先退回账户余额。单张礼品卡单次充值限额五千元，超出限额请分多次操作。礼品卡相关的其他问题，可以随时联系在线客服咨询办理。",
  },
  {
    docId: "price-protection",
    title: "商品价格保护",
    text: "商品价格保护说明：为保障您的购物体验，平台提供价格保护服务：您下单后七天内，如果所购商品发生降价，可以申请补退差价。申请价保请在订单详情页点击申请价格保护，系统会自动比对面价并计算差价，审核通过后差价将原路退回您的支付账户，一般一到三个工作日内到账。价保比价以您下单时实际支付的商品价款为准，优惠券、红包、满减等促销优惠金额不计入比价范围。以下情形不支持价保：秒杀和限时抢购活动商品、百亿补贴频道商品、以及已申请过价保的订单。商品缺货下架后恢复销售的价格变动同样可以申请价保，请在时限内提交。如果买贵了觉得不划算，先别急着退货，试试一键价保，差价退回更省心。每笔订单的价保申请机会为一次，请在价格稳定后提交。",
  },
];

/**
 * 检索查询集：50 条（rtv-01..rtv-50），每篇文档至少 4 条覆盖。
 * expectedDocId 必须是 EVAL_CORPUS 里的 docId（完整性由测试兜底）。
 */
export const EVAL_QUERIES: RetrievalEvalCase[] = [
  // ── 退货退款政策（5 条）──────────────────────────────────────────────
  { caseId: "rtv-01", suite: "retrieval", description: "直问退货退款流程", query: "退货退款的具体流程是什么", expectedDocId: "return-refund" },
  { caseId: "rtv-02", suite: "retrieval", description: "直问七天无理由", query: "七天无理由退货怎么申请", expectedDocId: "return-refund" },
  { caseId: "rtv-03", suite: "retrieval", description: "间接：说症状不说政策名", query: "买完不想要了怎么办", expectedDocId: "return-refund" },
  { caseId: "rtv-04", suite: "retrieval", description: "间接：未拆封想退钱", query: "收到的货还没拆封，想退掉把钱退回来", expectedDocId: "return-refund" },
  { caseId: "rtv-05", suite: "retrieval", description: "间接：到账时间", query: "申请退款后钱多久能到账", expectedDocId: "return-refund" },

  // ── 物流配送时效（5 条）──────────────────────────────────────────────
  { caseId: "rtv-06", suite: "retrieval", description: "直问发货时间", query: "下单后一般多久能发货", expectedDocId: "shipping-eta" },
  { caseId: "rtv-07", suite: "retrieval", description: "直问配送时效", query: "快递一般几天能送到", expectedDocId: "shipping-eta" },
  { caseId: "rtv-08", suite: "retrieval", description: "政策名直查", query: "物流配送时效是怎么规定的", expectedDocId: "shipping-eta" },
  { caseId: "rtv-09", suite: "retrieval", description: "间接：同城当日达", query: "同城下单当天能送到吗", expectedDocId: "shipping-eta" },
  { caseId: "rtv-10", suite: "retrieval", description: "间接：节假日变慢", query: "国庆期间快递会不会变慢", expectedDocId: "shipping-eta" },

  // ── 支付方式与发票（5 条）────────────────────────────────────────────
  { caseId: "rtv-11", suite: "retrieval", description: "直问支付方式", query: "平台支持哪些付款方式", expectedDocId: "payment-invoice" },
  { caseId: "rtv-12", suite: "retrieval", description: "直问开票", query: "订单怎么申请开发票", expectedDocId: "payment-invoice" },
  { caseId: "rtv-13", suite: "retrieval", description: "企业抬头税号", query: "能开公司抬头的发票吗", expectedDocId: "payment-invoice" },
  { caseId: "rtv-14", suite: "retrieval", description: "间接：报销凭证", query: "报销需要的电子发票在哪里开", expectedDocId: "payment-invoice" },
  { caseId: "rtv-15", suite: "retrieval", description: "分期付款", query: "花呗可以分期付款吗", expectedDocId: "payment-invoice" },

  // ── 会员权益等级（5 条）──────────────────────────────────────────────
  { caseId: "rtv-16", suite: "retrieval", description: "直问等级划分", query: "会员等级是怎么划分的", expectedDocId: "membership-tier" },
  { caseId: "rtv-17", suite: "retrieval", description: "直问黄金权益", query: "黄金会员有什么专属权益", expectedDocId: "membership-tier" },
  { caseId: "rtv-18", suite: "retrieval", description: "间接：积分用途", query: "购物积分能用来干什么", expectedDocId: "membership-tier" },
  { caseId: "rtv-19", suite: "retrieval", description: "间接：生日优惠", query: "生日当月买东西有优惠吗", expectedDocId: "membership-tier" },
  { caseId: "rtv-20", suite: "retrieval", description: "等级下调", query: "会员等级会降级吗", expectedDocId: "membership-tier" },

  // ── 账号与密码安全（5 条）────────────────────────────────────────────
  { caseId: "rtv-21", suite: "retrieval", description: "直问改密码", query: "怎么修改自己的登录密码", expectedDocId: "account-security" },
  { caseId: "rtv-22", suite: "retrieval", description: "间接：找回密码", query: "密码忘了怎么找回来", expectedDocId: "account-security" },
  { caseId: "rtv-23", suite: "retrieval", description: "账号被盗", query: "账号好像被盗了怎么办", expectedDocId: "account-security" },
  { caseId: "rtv-24", suite: "retrieval", description: "换绑手机", query: "换了手机号怎么改绑定", expectedDocId: "account-security" },
  { caseId: "rtv-25", suite: "retrieval", description: "验证码安全", query: "客服要我提供短信验证码安全吗", expectedDocId: "account-security" },

  // ── 优惠券使用规则（5 条，含邻接对抗）────────────────────────────────
  { caseId: "rtv-26", suite: "retrieval", description: "直问使用规则", query: "优惠券的使用规则是什么", expectedDocId: "coupon-rules" },
  { caseId: "rtv-27", suite: "retrieval", description: "叠加问题", query: "满减券和折扣券能叠加使用吗", expectedDocId: "coupon-rules" },
  { caseId: "rtv-28", suite: "retrieval", description: "间接：去哪领券", query: "在哪里可以领到优惠券", expectedDocId: "coupon-rules" },
  { caseId: "rtv-29", suite: "retrieval", description: "有效期", query: "优惠券过了有效期还能用吗", expectedDocId: "coupon-rules" },
  { caseId: "rtv-30", suite: "retrieval", description: "邻接对抗：提到退款但问的是券", query: "用优惠券买的订单退款后券会返还吗", expectedDocId: "coupon-rules" },

  // ── 配送范围与运费（5 条）────────────────────────────────────────────
  { caseId: "rtv-31", suite: "retrieval", description: "直问配送范围", query: "你们配送范围都覆盖哪些地区", expectedDocId: "delivery-coverage" },
  { caseId: "rtv-32", suite: "retrieval", description: "直问运费包邮", query: "运费是怎么算的，多少钱包邮", expectedDocId: "delivery-coverage" },
  { caseId: "rtv-33", suite: "retrieval", description: "间接：偏远地址能不能送", query: "新疆的地址可以发货吗", expectedDocId: "delivery-coverage" },
  { caseId: "rtv-34", suite: "retrieval", description: "间接：免邮办法", query: "怎么才能免掉邮费", expectedDocId: "delivery-coverage" },
  { caseId: "rtv-35", suite: "retrieval", description: "偏远附加费", query: "内蒙古发货要加收费用吗", expectedDocId: "delivery-coverage" },

  // ── 售后保修政策（5 条）──────────────────────────────────────────────
  { caseId: "rtv-36", suite: "retrieval", description: "直问保修期", query: "商品的保修期是多久", expectedDocId: "warranty-service" },
  { caseId: "rtv-37", suite: "retrieval", description: "申请维修", query: "耳机坏了怎么申请售后维修", expectedDocId: "warranty-service" },
  { caseId: "rtv-38", suite: "retrieval", description: "三包内容", query: "三包服务具体包括哪些内容", expectedDocId: "warranty-service" },
  { caseId: "rtv-39", suite: "retrieval", description: "间接：过保边缘的故障", query: "手机用了一年出现故障维修要钱吗", expectedDocId: "warranty-service" },
  { caseId: "rtv-40", suite: "retrieval", description: "人为损坏是否免费", query: "自己摔坏的屏幕在保修期内能免费修吗", expectedDocId: "warranty-service" },

  // ── 礼品卡与余额（5 条）──────────────────────────────────────────────
  { caseId: "rtv-41", suite: "retrieval", description: "直问充值", query: "礼品卡怎么充值到账户", expectedDocId: "gift-card-balance" },
  { caseId: "rtv-42", suite: "retrieval", description: "余额查询", query: "购物卡的余额在哪里查询", expectedDocId: "gift-card-balance" },
  { caseId: "rtv-43", suite: "retrieval", description: "间接：卡密未到账", query: "卡密输入后没有到账怎么办", expectedDocId: "gift-card-balance" },
  { caseId: "rtv-44", suite: "retrieval", description: "间接：送礼场景", query: "想给朋友买张电子购物卡当礼物", expectedDocId: "gift-card-balance" },
  { caseId: "rtv-45", suite: "retrieval", description: "余额提现", query: "账户里的余额可以提现出来吗", expectedDocId: "gift-card-balance" },

  // ── 商品价格保护（5 条）──────────────────────────────────────────────
  { caseId: "rtv-46", suite: "retrieval", description: "直问价保申请", query: "价格保护怎么申请", expectedDocId: "price-protection" },
  { caseId: "rtv-47", suite: "retrieval", description: "降价补差", query: "刚买的商品就降价了能退差价吗", expectedDocId: "price-protection" },
  { caseId: "rtv-48", suite: "retrieval", description: "间接：买贵了", query: "买贵了有什么补救办法", expectedDocId: "price-protection" },
  { caseId: "rtv-49", suite: "retrieval", description: "价保时限", query: "价保的申请时限是几天", expectedDocId: "price-protection" },
  { caseId: "rtv-50", suite: "retrieval", description: "差价到账", query: "价保的差价多久退回到账", expectedDocId: "price-protection" },
];
