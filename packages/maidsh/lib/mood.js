/**
 * maidsh 心情状态机 —— MaiBot 的心流系统（`src/chat/heart_flow/`）只提供了
 * 会话级运行实例管理与计时（`heartFC_utils.py` 里只有 CycleDetail），
 * 并没有可直接迁移的情绪状态机。故这里自建一个**轻量**版本：
 *
 *   · 输入：每条用户消息的文本 + 上一轮状态
 *   · 判据：关键词命中（MOOD_KEYWORDS）—— 逐条过 LLM 太贵太慢，不值得
 *   · 衰减：情绪强度按半衰期向「平静」回落（MOOD_HALF_LIFE_MS）
 *
 * 输出直接进系统提示词，让模型知道自己「此刻什么情绪」，这是拟人感里最便宜的一环。
 */

import {
  MOOD_KEYWORDS,
  MOOD_WEAK_KEYWORDS,
  MOOD_WEAK_WEIGHT,
  MOOD_MIN_SCORE,
  MOOD_HALF_LIFE_MS,
} from './defaults.js'

/** 心情强度上限。 */
const MAX_INTENSITY = 5

/**
 * 一个关键词的权重。
 * @param {string} word
 */
function weightOf(word) {
  return MOOD_WEAK_KEYWORDS.has(word) ? MOOD_WEAK_WEIGHT : 1
}

/**
 * 从文本里判一个心情。
 *
 * 与早先版本的区别（2026-10-26 修误报）：判据从「命中**个数**」改成
 * 「命中**加权得分**，且得分必须过 MOOD_MIN_SCORE」。这样疑问词（弱词）
 * 单独或成对出现传不出情绪，只有强词或密集弱词才算数。
 *
 * 返回 null 表示「这句话读不出情绪」，调用方应当**沿用旧心情并衰减**，
 * 而不是重置成平静——一句普普通通的提问不该把上一轮的情绪抹掉。
 *
 * @param {string} text 用户消息原文
 * @returns {{mood: string, hits: number, score: number, matched: string[]} | null}
 */
export function detectMood(text) {
  const raw = String(text || '')
  if (!raw.trim()) return null
  const lower = raw.toLowerCase()
  let best = null
  let bestScore = 0
  let bestHits = 0
  let bestMatched = []
  for (const [mood, words] of Object.entries(MOOD_KEYWORDS)) {
    let score = 0
    let hits = 0
    const matched = []
    for (const w of words) {
      if (lower.includes(w.toLowerCase())) {
        score += weightOf(w)
        hits += 1
        matched.push(w)
      }
    }
    if (score > bestScore) {
      bestScore = score
      bestHits = hits
      best = mood
      bestMatched = matched
    }
  }
  if (!best || bestScore < MOOD_MIN_SCORE) return null
  return { mood: best, hits: bestHits, score: bestScore, matched: bestMatched }
}

/**
 * 计算衰减后的强度。
 * @param {number} intensity 上次强度
 * @param {number} at 上次时间戳
 * @param {number} nowTs 现在
 */
export function decayIntensity(intensity, at, nowTs) {
  const age = Math.max(0, nowTs - at)
  if (age <= 0) return intensity
  const factor = Math.pow(0.5, age / MOOD_HALF_LIFE_MS)
  return intensity * factor
}

/**
 * 推进状态机：给一条新消息，返回新的心情状态。
 *
 * 规则：
 *   - 读不出情绪（或只命中了弱词）→ 沿用旧心情但衰减；衰减到 < 0.3 视为回到 calm
 *   - 命中且与旧心情相同 → 强度按得分增量累加（同一情绪被反复触发会更浓）
 *   - 命中且与旧心情不同 → 强度重置为本次得分（至少 1）
 *
 * 注意「读不出情绪」**不等于**「平静」：一句普通提问不会把上一轮的情绪清掉，
 * 只是让它随时间变淡。这是刻意的——情绪该有惯性。
 *
 * @param {{mood: string, intensity: number, createdAt: number} | null} prev
 * @param {string} text
 * @param {number} [nowTs]
 * @returns {{mood: string, intensity: number, createdAt: number, changed: boolean}}
 */
export function advanceMood(prev, text, nowTs = Date.now()) {
  const hit = detectMood(text)
  if (!hit) {
    if (!prev) return { mood: 'calm', intensity: 0, createdAt: nowTs, changed: false }
    const decayed = decayIntensity(prev.intensity, prev.createdAt, nowTs)
    if (decayed < 0.3) {
      return { mood: 'calm', intensity: 0, createdAt: nowTs, changed: prev.mood !== 'calm' }
    }
    return { mood: prev.mood, intensity: decayed, createdAt: nowTs, changed: false }
  }
  if (prev && prev.mood === hit.mood) {
    const decayed = decayIntensity(prev.intensity, prev.createdAt, nowTs)
    // 半量累加：连续同情绪会变浓，但比旧版「每轮 +1」慢一些，不容易冲顶。
    const next = Math.min(MAX_INTENSITY, decayed + Math.max(0.5, hit.score * 0.5))
    return { mood: hit.mood, intensity: next, createdAt: nowTs, changed: false }
  }
  return {
    mood: hit.mood,
    intensity: Math.min(MAX_INTENSITY, Math.max(1, hit.score)),
    createdAt: nowTs,
    changed: true,
  }
}
