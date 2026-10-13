/**
 * commitlint 配置 —— conventional 规范 + 中文 subject 适配
 *
 * 现有提交风格：`feat(scope): 中文描述` / `fix(scope): 中文描述`。
 * 规则取舍：
 * - subject-case 关闭：该规则要求英文大小写规范（sentence-case 等），
 *   中文 subject 无大小写概念，开着会误伤全部中文描述；
 * - header-max-length 放宽到 200：现有中文提交信息较长（含破折号说明），
 *   默认 100 不够用；
 * - 其余规则（type-enum / scope-optional / body-leading-blank 等）保持
 *   config-conventional 默认，机械约束该守的照守。
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // 中文 subject 无 case 概念，关闭大小写检查
    "subject-case": [0],
    // 中文描述 + 破折号说明较长，header 上限放宽到 200
    "header-max-length": [2, "always", 200],
  },
};
