/**
 * maidsh 设定读写 —— 「必须设定项」的唯一真源。
 *
 * 存放位置：$DSH_HOME/maidsh/settings.json（与数据库同目录，便于整体备份/迁移）。
 * 为什么用 JSON 文件而不是只走 cordis config：
 *   cordis 的 `config` 是**部署期**配置（写进 cordis.patch.yml，改完要重载插件）；
 *   而人格设定是**运行期**要随手调的东西（换个昵称、把概率从 0 调成 0.2）。
 *   所以：cordis config 只放路径这类基础设施项，人格设定走可热写的 JSON，
 *   由 client.js 的设定面板通过 webServer API 读写，宿主侧每轮重新读取。
 *
 * 读路径带缓存失效（按 mtime），避免每次 assemble 都读盘。
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveDshHome } from './store.js'
import {
  DEFAULT_PERSONALITY,
  DEFAULT_BEHAVIOR_STYLE,
  DEFAULT_REPLY_STYLE,
  DEFAULT_MULTIPLE_REPLY_STYLE,
  DEFAULT_NICKNAME,
  DEFAULT_ALIASES,
} from './defaults.js'

/** 设定文件路径。 */
export function settingsPath() {
  return join(resolveDshHome(), 'maidsh', 'settings.json')
}

/**
 * 完整默认设定。
 *
 * 人格三项与备用风格全部来自 MaiBot `PersonalityConfig`；开关类是本插件新增
 * （MaiBot 里这些散落在多个配置类里，这里收平成一屏）。
 */
export function defaultSettings() {
  return {
    // ── 人格（MaiBot PersonalityConfig）──
    nickname: DEFAULT_NICKNAME,
    aliases: [...DEFAULT_ALIASES],
    personality: DEFAULT_PERSONALITY,
    behaviorStyle: DEFAULT_BEHAVIOR_STYLE,
    replyStyle: DEFAULT_REPLY_STYLE,
    multipleReplyStyle: [...DEFAULT_MULTIPLE_REPLY_STYLE],
    /** 临时风格注入概率（MaiBot multiple_probability，0 表示不随机切换）。 */
    multipleProbability: 0,

    // ── 总开关 ──
    /** 人格注入总开关。关掉 = 完全回到 DSH 原生行为。 */
    enabled: true,
    /** 注入人格（personality/behaviorStyle）。 */
    injectPersona: true,
    /** 注入表达风格（replyStyle + 备用风格抽签）。 */
    injectReplyStyle: true,
    /** 注入学到的表达方式（expression_habits_block 等价物）。 */
    injectExpressions: true,
    /** 注入心情状态。 */
    injectMood: true,
    /** 注入聊天印象。 */
    injectImpression: true,
    /** 注入黑话表（让模型看得懂用户的黑话）。 */
    injectJargon: true,
    /** 注入人物画像（迁移自 MaiBot person_profile，描述「这个人是谁」）。 */
    injectProfile: true,

    // ── 学习 ──
    /** 学习总开关。 */
    learning: true,
    /** 学表达方式。 */
    learnExpressions: true,
    /** 学黑话。 */
    learnJargon: true,
    /** 生成聊天印象。 */
    learnImpression: true,
    /** 更新人物画像（七段结构化，跨会话累积）。 */
    learnProfile: true,
    /** 每多少条用户消息触发一轮学习（MaiBot 按消息数触发的等价物）。 */
    learnEvery: 20,
    /** 学习请求的 maxTokens。 */
    learnMaxTokens: 1200,

    // ── 注入预算 ──
    /** 注入多少条表达方式。 */
    expressionLimit: 8,
    /** 注入多少条黑话。 */
    jargonLimit: 12,
    /** 注入多少条印象。 */
    impressionLimit: 2,
    /** 人物画像的「近期互动」段落注入几条（MaiBot recent_limit 默认 2）。 */
    profileRecentLimit: 2,
    /** 画像主体 id。DSH 是单用户桌面场景，默认固定一个。 */
    profilePersonId: 'local-user',
    /** 画像里对这个人的主称呼。 */
    profilePrimaryName: '用户',
  }
}

/** 把任意输入规整成合法设定（类型纠偏 + 范围夹紧），未知键丢弃。 */
export function normalizeSettings(input) {
  const d = defaultSettings()
  const raw = input && typeof input === 'object' ? input : {}
  const str = (v, fb, max = 2000) => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s ? s.slice(0, max) : fb
  }
  const bool = (v, fb) => (typeof v === 'boolean' ? v : fb)
  const num = (v, fb, min, max) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return fb
    return Math.max(min, Math.min(max, n))
  }
  const strList = (v, fb, maxItems = 12, maxLen = 300) =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === 'string' ? x.trim().slice(0, maxLen) : '')).filter(Boolean).slice(0, maxItems)
      : [...fb]

  return {
    nickname: str(raw.nickname, d.nickname, 40),
    aliases: strList(raw.aliases, d.aliases, 12, 40),
    personality: str(raw.personality, d.personality, 2000),
    behaviorStyle: str(raw.behaviorStyle, d.behaviorStyle, 2000),
    replyStyle: str(raw.replyStyle, d.replyStyle, 2000),
    multipleReplyStyle: strList(raw.multipleReplyStyle, d.multipleReplyStyle, 12, 300),
    multipleProbability: num(raw.multipleProbability, d.multipleProbability, 0, 1),

    enabled: bool(raw.enabled, d.enabled),
    injectPersona: bool(raw.injectPersona, d.injectPersona),
    injectReplyStyle: bool(raw.injectReplyStyle, d.injectReplyStyle),
    injectExpressions: bool(raw.injectExpressions, d.injectExpressions),
    injectMood: bool(raw.injectMood, d.injectMood),
    injectImpression: bool(raw.injectImpression, d.injectImpression),
    injectJargon: bool(raw.injectJargon, d.injectJargon),
    injectProfile: bool(raw.injectProfile, d.injectProfile),

    learning: bool(raw.learning, d.learning),
    learnExpressions: bool(raw.learnExpressions, d.learnExpressions),
    learnJargon: bool(raw.learnJargon, d.learnJargon),
    learnImpression: bool(raw.learnImpression, d.learnImpression),
    learnProfile: bool(raw.learnProfile, d.learnProfile),
    learnEvery: Math.floor(num(raw.learnEvery, d.learnEvery, 1, 200)),
    learnMaxTokens: Math.floor(num(raw.learnMaxTokens, d.learnMaxTokens, 200, 8000)),

    expressionLimit: Math.floor(num(raw.expressionLimit, d.expressionLimit, 1, 30)),
    jargonLimit: Math.floor(num(raw.jargonLimit, d.jargonLimit, 1, 60)),
    impressionLimit: Math.floor(num(raw.impressionLimit, d.impressionLimit, 0, 10)),
    profileRecentLimit: Math.floor(num(raw.profileRecentLimit, d.profileRecentLimit, 0, 6)),
    profilePersonId: str(raw.profilePersonId, d.profilePersonId, 80),
    profilePrimaryName: str(raw.profilePrimaryName, d.profilePrimaryName, 40),
  }
}

/**
 * 创建一个带 mtime 缓存的设定读取器。
 * @returns {{read: () => object, write: (patch: object) => object}}
 */
export function createSettingsStore() {
  let cache = null
  let cacheMtime = -1

  function read() {
    const file = settingsPath()
    let mtime = -1
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      // 文件还不存在 —— 返回默认值，不落盘（首次写入时才创建）
      cache = normalizeSettings(defaultSettings())
      cacheMtime = -1
      return cache
    }
    if (cache && mtime === cacheMtime) return cache
    try {
      cache = normalizeSettings(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      // 文件坏了就当默认值，不抛 —— 人格设定坏掉不能把对话也弄坏
      cache = normalizeSettings(defaultSettings())
    }
    cacheMtime = mtime
    return cache
  }

  function write(patch) {
    const next = normalizeSettings({ ...read(), ...(patch && typeof patch === 'object' ? patch : {}) })
    const file = settingsPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
    cache = next
    try {
      cacheMtime = statSync(file).mtimeMs
    } catch {
      cacheMtime = -1
    }
    return next
  }

  return { read, write }
}
