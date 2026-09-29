// preference.memory.ts —— 长期记忆（用户偏好）的内存实现
// 对应教程《记忆 TS 版》PG 的 user_preferences 长表：(userId, key) 复合主键，
// 「用户改口」就是覆盖一行的事。
//
// ── 数据形状：两层 Map（用户 → 偏好表）─────────────────────────────────
//   Map<userId, Map<key, value>>
//     └─ "u_001" → { "回复风格": "简洁", "所属团队": "后端组" }
//     └─ "u_002" → { "称呼": "X总" }
// 外层按用户隔离（张三的偏好绝不能漏给李四），内层就是一张 KV 表。
//
// ── 在整条链路里的位置 ──────────────────────────────────────────────────
//   会话开始：all(userId) 读出全部 → 注入 system prompt（"已知该用户偏好：…"）
//   对话过程：模型从用户话里提炼出"喜欢简洁" → 抽取器调 set() 落库
//   「改口」：用户说"以后详细点" → 同 key 再 set → 覆盖旧值（PG 版即 upsert）
//
// 轻量护栏：偏好是提炼后的事实，天然短——key/value 先 trim 再限长，超长截断、空白丢弃，
// 防止脏数据把注入 system prompt 的偏好区撑爆（教程坑 5「偏好表膨胀」的前置防御）。
import type { PreferenceStore } from "./types.js";

/** 偏好条目的长度上限：正常抽取结果远短于此，超长多半是脏数据 */
const MAX_KEY_LEN = 50;
const MAX_VALUE_LEN = 500;

export class InMemoryPreferenceStore implements PreferenceStore {
  private readonly users = new Map<string, Map<string, string>>();

  async get(userId: string, key: string): Promise<string | null> {
    return this.users.get(userId)?.get(key) ?? null;
  }

  async set(userId: string, key: string, value: string): Promise<void> {
    // 护栏三连：trim 掉纯空白 → 截断到上限 → 空值直接丢弃（写入即垃圾，不如不收）
    const safeKey = key.trim().slice(0, MAX_KEY_LEN);
    const safeValue = value.trim().slice(0, MAX_VALUE_LEN);
    if (!safeKey || !safeValue) return; // 空 key / 空白值不入库，写入即垃圾
    // 两层 Map 的"没有就建"惯用法：内层表挂到外层，再往表里写一条
    const prefs = this.users.get(userId) ?? new Map<string, string>();
    prefs.set(safeKey, safeValue);
    this.users.set(userId, prefs);
  }

  async all(userId: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const [key, value] of this.users.get(userId) ?? []) {
      result[key] = value;
    }
    return result;
  }
}
