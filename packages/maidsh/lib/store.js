/**
 * maidsh 存储层 —— 人格专用轻量记忆。
 *
 * 为什么自建 SQLite 而不是全塞进灵枢（@furongjun1999/dsh-memory）：
 *   灵枢的记忆真源是 md_cg 认知图（Python 后端），面向「通用认知 / 长期事实」，
 *   写入需要 MDCG_TOKEN，且召回按语义/时间衰减排序。人格需要的不是事实，而是
 *   「说话习惯」这类高频、短小、可枚举、要按情境精确取用的条目 —— 用认知图存
 *   会让每条口癖都变成一次图写入，成本和噪声都不划算。
 *   故：**事实类记忆交给灵枢**（本插件不重复实现），**表达/黑话/心情/印象自建**，
 *   两者互补，不重叠。
 *
 * 存储位置：$DSH_HOME/maidsh/maidsh.db（默认 ~/.dsh/maidsh/maidsh.db）。
 * 用 node:sqlite（Node 22+ 内置，dsh-meme 同款），零外部依赖。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 解析 DSH 主目录：优先 DSH_HOME（宿主注入），退回 ~/.dsh。 */
export function resolveDshHome() {
  const fromEnv = String(process.env.DSH_HOME || '').trim()
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

/** 数据库文件路径。 */
export function databasePath() {
  return join(resolveDshHome(), 'maidsh', 'maidsh.db')
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 表达方式：从对话里学到的「当 A 时，可以 B」
CREATE TABLE IF NOT EXISTS expressions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  situation   TEXT NOT NULL,
  style       TEXT NOT NULL,
  source_text TEXT NOT NULL DEFAULT '',
  hits        INTEGER NOT NULL DEFAULT 0,
  weight      REAL NOT NULL DEFAULT 1.0,
  session     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expr_style ON expressions(style);

-- 黑话：圈内才看得懂的短词
CREATE TABLE IF NOT EXISTS jargon (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  term       TEXT NOT NULL,
  meaning    TEXT NOT NULL DEFAULT '',
  hits       INTEGER NOT NULL DEFAULT 1,
  session    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jargon_term ON jargon(term);

-- 心情时间线
CREATE TABLE IF NOT EXISTS mood (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session    TEXT NOT NULL DEFAULT '',
  mood       TEXT NOT NULL,
  intensity  REAL NOT NULL DEFAULT 1.0,
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mood_created ON mood(created_at DESC);

-- 聊天印象（一段自然语言概括，供召回参考）
CREATE TABLE IF NOT EXISTS impressions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session    TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_impression_created ON impressions(created_at DESC);

-- 学习日志（每次学习一轮记一行，便于在 WebUI 里追「为什么没学到东西」）
CREATE TABLE IF NOT EXISTS learn_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 1,
  detail     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_created ON learn_log(created_at DESC);

-- 计数器（累计统计）
CREATE TABLE IF NOT EXISTS counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- 人物画像：跨会话累积的「这个人是谁」（迁移自 MaiBot person_profile_snapshots）
-- 与 impressions 的区别：impressions 是流水（最近这段聊了什么），这里是账本
-- （身份/关系/偏好/雷点），按 person_id 唯一，版本号随每次刷新递增。
CREATE TABLE IF NOT EXISTS person_profile (
  person_id    TEXT PRIMARY KEY,
  profile_text TEXT NOT NULL DEFAULT '',
  version      INTEGER NOT NULL DEFAULT 1,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  source_note  TEXT NOT NULL DEFAULT '',
  updated_at   INTEGER NOT NULL
);

-- 画像历史快照：面板里看「画像怎么长出来的」，保留最近 N 版
CREATE TABLE IF NOT EXISTS person_profile_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id    TEXT NOT NULL,
  version      INTEGER NOT NULL,
  profile_text TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_hist ON person_profile_history(person_id, version DESC);
`

/**
 * 打开（并按需初始化）数据库。
 * @param {string} [file] 数据库路径；省略则用默认路径。
 * @returns {DatabaseSync}
 */
export function openStore(file) {
  const target = file || databasePath()
  if (target !== ':memory:') {
    mkdirSync(join(target, '..'), { recursive: true })
  }
  const db = new DatabaseSync(target)
  db.exec(SCHEMA)
  return db
}

const now = () => Date.now()

/** 计数器自增并返回新值。 */
export function bumpCounter(db, key, by = 1) {
  db.prepare(
    'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + excluded.value',
  ).run(key, by)
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(key)
  return row ? Number(row.value) : 0
}

/** 读单个计数器。 */
export function readCounter(db, key) {
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(key)
  return row ? Number(row.value) : 0
}

/**
 * 写入一条表达方式。已存在同 style 时提升权重而不是插入重复行。
 * @returns {boolean} 是否为新条目
 */
export function addExpression(db, { situation, style, sourceText = '', session = '' }) {
  const s = String(situation || '').trim()
  const t = String(style || '').trim()
  if (!s || !t) return false
  const exists = db.prepare('SELECT id FROM expressions WHERE style = ?').get(t)
  if (exists) {
    db.prepare('UPDATE expressions SET weight = weight + 0.5, hits = hits + 1 WHERE id = ?').run(exists.id)
    return false
  }
  db.prepare(
    'INSERT INTO expressions (situation, style, source_text, session, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(s, t, String(sourceText || '').slice(0, 500), String(session || ''), now())
  return true
}

/** 按权重取前 N 条表达方式（供注入）。 */
export function topExpressions(db, limit = 8) {
  return db
    .prepare('SELECT id, situation, style, weight, hits FROM expressions ORDER BY weight DESC, hits DESC, id DESC LIMIT ?')
    .all(Math.max(1, Math.min(50, Number(limit) || 8)))
    .map((r) => ({ id: Number(r.id), situation: String(r.situation), style: String(r.style), weight: Number(r.weight), hits: Number(r.hits) }))
}

/** 标记表达方式被用过一次。 */
export function touchExpressions(db, ids) {
  if (!ids || ids.length === 0) return
  const stmt = db.prepare('UPDATE expressions SET hits = hits + 1, last_used_at = ? WHERE id = ?')
  const t = now()
  for (const id of ids) stmt.run(t, Number(id))
}

/** 写入黑话（已存在则 hits+1）。 */
export function addJargon(db, { term, meaning = '', session = '' }) {
  const t = String(term || '').trim()
  if (!t) return false
  const exists = db.prepare('SELECT id FROM jargon WHERE term = ?').get(t)
  if (exists) {
    db.prepare('UPDATE jargon SET hits = hits + 1 WHERE id = ?').run(exists.id)
    return false
  }
  db.prepare('INSERT INTO jargon (term, meaning, session, created_at) VALUES (?, ?, ?, ?)').run(
    t,
    String(meaning || '').slice(0, 200),
    String(session || ''),
    now(),
  )
  return true
}

/** 取黑话列表。 */
export function listJargon(db, limit = 30) {
  return db
    .prepare('SELECT id, term, meaning, hits, created_at FROM jargon ORDER BY hits DESC, id DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Number(limit) || 30)))
    .map((r) => ({ id: Number(r.id), term: String(r.term), meaning: String(r.meaning), hits: Number(r.hits), createdAt: Number(r.created_at) }))
}

/** 记录一次心情变化。 */
export function recordMood(db, { session = '', mood, intensity = 1, reason = '' }) {
  if (!mood) return
  db.prepare('INSERT INTO mood (session, mood, intensity, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(
    String(session || ''),
    String(mood),
    Number(intensity) || 1,
    String(reason || '').slice(0, 200),
    now(),
  )
}

/** 取最近一条心情。 */
export function latestMood(db, session = '') {
  const row = session
    ? db.prepare('SELECT mood, intensity, created_at FROM mood WHERE session = ? ORDER BY id DESC LIMIT 1').get(String(session))
    : db.prepare('SELECT mood, intensity, created_at FROM mood ORDER BY id DESC LIMIT 1').get()
  if (!row) return null
  return { mood: String(row.mood), intensity: Number(row.intensity), createdAt: Number(row.created_at) }
}

/** 心情时间线。 */
export function moodTimeline(db, limit = 50) {
  return db
    .prepare('SELECT id, mood, intensity, reason, created_at FROM mood ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, Number(limit) || 50)))
    .map((r) => ({ id: Number(r.id), mood: String(r.mood), intensity: Number(r.intensity), reason: String(r.reason), createdAt: Number(r.created_at) }))
}

/** 写一条聊天印象。 */
export function addImpression(db, { session = '', text }) {
  const t = String(text || '').trim()
  if (!t) return false
  db.prepare('INSERT INTO impressions (session, text, created_at) VALUES (?, ?, ?)').run(String(session || ''), t.slice(0, 1000), now())
  return true
}

/** 取最近印象。 */
export function listImpressions(db, limit = 10) {
  return db
    .prepare('SELECT id, text, created_at FROM impressions ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(100, Number(limit) || 10)))
    .map((r) => ({ id: Number(r.id), text: String(r.text), createdAt: Number(r.created_at) }))
}

/** 写学习日志。 */
export function logLearning(db, { kind, ok = true, detail = '' }) {
  db.prepare('INSERT INTO learn_log (kind, ok, detail, created_at) VALUES (?, ?, ?, ?)').run(
    String(kind || ''),
    ok ? 1 : 0,
    String(detail || '').slice(0, 1000),
    now(),
  )
}

/** 取学习日志。 */
export function listLearnLog(db, limit = 50) {
  return db
    .prepare('SELECT id, kind, ok, detail, created_at FROM learn_log ORDER BY id DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Number(limit) || 50)))
    .map((r) => ({ id: Number(r.id), kind: String(r.kind), ok: Number(r.ok) === 1, detail: String(r.detail), createdAt: Number(r.created_at) }))
}

/** 统计总览（WebUI 仪表盘用）。 */
export function stats(db) {
  const one = (sql) => {
    const row = db.prepare(sql).get()
    return row ? Number(Object.values(row)[0]) : 0
  }
  return {
    expressions: one('SELECT COUNT(*) FROM expressions'),
    jargon: one('SELECT COUNT(*) FROM jargon'),
    moods: one('SELECT COUNT(*) FROM mood'),
    impressions: one('SELECT COUNT(*) FROM impressions'),
    profiles: one('SELECT COUNT(*) FROM person_profile'),
    learnRuns: one("SELECT COUNT(*) FROM learn_log WHERE kind = 'learn'"),
    userMessages: readCounter(db, 'user_messages'),
    learnedNew: readCounter(db, 'learned_new'),
  }
}

/** 删除一条表达方式。 */
export function deleteExpression(db, id) {
  db.prepare('DELETE FROM expressions WHERE id = ?').run(Number(id))
}

/** 删除一条黑话。 */
export function deleteJargon(db, id) {
  db.prepare('DELETE FROM jargon WHERE id = ?').run(Number(id))
}

/** 清空某张表。 */
export function clearTable(db, table) {
  const allowed = new Set(['expressions', 'jargon', 'mood', 'impressions', 'learn_log', 'person_profile', 'person_profile_history'])
  if (!allowed.has(table)) throw new Error('不允许清空的表: ' + table)
  db.exec('DELETE FROM ' + table)
}

// ────────────────────────────────────────────────────────────────
// 人物画像
// ────────────────────────────────────────────────────────────────

/** 画像历史保留版本数。再多也没人看，且会把库撑大。 */
const PROFILE_HISTORY_KEEP = 20

/** 读一个人物画像。没有则返回 null。 */
export function getProfile(db, personId) {
  const pid = String(personId || '').trim()
  if (!pid) return null
  const row = db
    .prepare('SELECT person_id, profile_text, version, aliases_json, source_note, updated_at FROM person_profile WHERE person_id = ?')
    .get(pid)
  if (!row) return null
  let aliases = []
  try {
    const parsed = JSON.parse(String(row.aliases_json || '[]'))
    if (Array.isArray(parsed)) aliases = parsed.map((x) => String(x ?? '')).filter(Boolean)
  } catch {
    aliases = []
  }
  return {
    personId: String(row.person_id),
    profileText: String(row.profile_text),
    version: Number(row.version),
    aliases,
    sourceNote: String(row.source_note),
    updatedAt: Number(row.updated_at),
  }
}

/**
 * 写入画像（自动递增版本，并把旧版塞进历史）。
 * @returns {{version:number, isNew:boolean}}
 */
export function upsertProfile(db, { personId, profileText, aliases = [], sourceNote = '' }) {
  const pid = String(personId || '').trim()
  if (!pid) throw new Error('personId 不能为空')
  const text = String(profileText || '')
  const existing = db.prepare('SELECT version, profile_text FROM person_profile WHERE person_id = ?').get(pid)
  const ts = now()

  // 内容一字未改就不推进版本号 —— 版本号表示「画像第几次变化」，
  // 而不是「跑了几轮学习」。否则面板上会堆出一串内容完全相同的版本。
  if (existing && String(existing.profile_text) === text) {
    return { version: Number(existing.version), isNew: false, changed: false }
  }

  const version = existing ? Number(existing.version) + 1 : 1

  if (existing) {
    // 旧版进历史
    db.prepare('INSERT INTO person_profile_history (person_id, version, profile_text, created_at) VALUES (?, ?, ?, ?)').run(
      pid,
      Number(existing.version),
      String(existing.profile_text),
      ts,
    )
    // 裁剪历史，只留最近 N 版
    db.prepare(
      `DELETE FROM person_profile_history
       WHERE person_id = ? AND id NOT IN (
         SELECT id FROM person_profile_history WHERE person_id = ? ORDER BY version DESC LIMIT ?
       )`,
    ).run(pid, pid, PROFILE_HISTORY_KEEP)
  }

  db.prepare(
    `INSERT INTO person_profile (person_id, profile_text, version, aliases_json, source_note, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(person_id) DO UPDATE SET
       profile_text = excluded.profile_text,
       version = excluded.version,
       aliases_json = excluded.aliases_json,
       source_note = excluded.source_note,
       updated_at = excluded.updated_at`,
  ).run(pid, text, version, JSON.stringify((aliases || []).map(String)), String(sourceNote || '').slice(0, 200), ts)

  return { version, isNew: !existing, changed: true }
}

/** 列出所有画像（面板用）。 */
export function listProfiles(db, limit = 50) {
  return db
    .prepare('SELECT person_id, version, updated_at, profile_text FROM person_profile ORDER BY updated_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Number(limit) || 50)))
    .map((r) => ({
      personId: String(r.person_id),
      version: Number(r.version),
      updatedAt: Number(r.updated_at),
      profileText: String(r.profile_text),
    }))
}

/** 删除画像及其历史。 */
export function deleteProfile(db, personId) {
  const pid = String(personId || '').trim()
  if (!pid) return
  db.prepare('DELETE FROM person_profile WHERE person_id = ?').run(pid)
  db.prepare('DELETE FROM person_profile_history WHERE person_id = ?').run(pid)
}

/** 画像历史。 */
export function profileHistory(db, personId, limit = 10) {
  return db
    .prepare('SELECT version, profile_text, created_at FROM person_profile_history WHERE person_id = ? ORDER BY version DESC LIMIT ?')
    .all(String(personId || ''), Math.max(1, Math.min(50, Number(limit) || 10)))
    .map((r) => ({ version: Number(r.version), profileText: String(r.profile_text), createdAt: Number(r.created_at) }))
}
