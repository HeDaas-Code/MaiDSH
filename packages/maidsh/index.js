/**
 * maidsh — 让 DSH 的回复带上人格设定的拟人感。
 *
 * 迁移自 MaiBot（https://github.com/MaiM-with-u/MaiBot）的以下机制：
 *   · 人格三段式（personality / behavior_style / reply_style / 备用风格 + 注入概率）
 *     ← `src/config/official_configs.py:148 PersonalityConfig`
 *   · 表达方式学习（从对话里提取「当 A 时，可以 B」，再评估适用性）
 *     ← `src/learners/expression_learner.py` + `prompts/zh-CN/learn_style.prompt`
 *   · 黑话学习 ← `src/learners/jargon_learner.py` + `learn_jargon.prompt`
 *   · 聊天印象 ← `prompts/zh-CN/heuristic_memory_impression.prompt`
 *   · 回复注入的块结构（expression_habits_block / reply_style 占位）
 *     ← `prompts/zh-CN/retro_private_replyer.prompt`
 *
 * 复用的 DSH 能力（要求一：不重复造轮子）：
 *   · 系统提示词注入 → `system-prompt/assemble` waterfall（宿主既有扩展点）
 *   · 对话事件 → `session/event`（宿主既有事件流）
 *   · 模型调用 → `ctx.get('llm')` + `ctx.agentDefaultModel`（宿主既有 LLM 服务）
 *   · HTTP 面 → `webServer.register`（宿主既有 web 服务，不再自己起端口）
 *   · 长期事实记忆 → 交给已装的 `@furongjun1999/dsh-memory`（灵枢），本插件只管
 *     表达/黑话/心情/印象这类人格专用记忆
 *
 * 分工（要求二）：
 *   · 必须设定项（人格、风格、开关、学习参数）→ DSH 插件设定页（client.js 的
 *     `settings.section`「人格」）
 *   · 面板与仪表盘（表达库、黑话表、心情时间线、学习日志、统计）→ 独立 WebUI
 *     `/maidsh`（本文件用 webServer 提供，自包含单页，无构建链）
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { openStore, databasePath, resolveDshHome, stats, topExpressions, listJargon, moodTimeline, listImpressions, listLearnLog, bumpCounter, readCounter, addExpression, addJargon, deleteExpression, deleteJargon, clearTable, recordMood, latestMood, getProfile, upsertProfile, listProfiles, deleteProfile, profileHistory } from './lib/store.js'
import { createSettingsStore, defaultSettings, settingsPath } from './lib/settings.js'
import { createLearner, learnExpressions, learnJargon, learnImpression, learnProfile } from './lib/learner.js'
import { buildSections } from './lib/prompt.js'
import { advanceMood } from './lib/mood.js'
import { extractText, oneLine } from './lib/text.js'

export const name = 'maidsh'
export const inject = ['webServer', 'agentDefaultModel']

const here = dirname(fileURLToPath(import.meta.url))

/** 独立 WebUI 的路由前缀。 */
const PANEL_ROUTE = '/maidsh'
/** JSON API 的路由前缀。 */
const API_ROUTE = '/maidsh-api'

/** 从宿主 session 对象里取会话标识（与 dsh-memory `sessionIdOf` 同义）。 */
function sessionIdOf(raw) {
  const s = raw
  const v = s?.id ?? s?.sessionId
  return typeof v === 'string' ? v.trim() : ''
}

/** 委派/中继消息判据（另一个 agent 发给本 agent 的消息，不算用户输入）。 */
function isRelayedMessage(source) {
  return Boolean(source && typeof source === 'object' && source.form === 'relay')
}

/** 只允许本机回环访问管理 API。 */
function denyNonLoopback(req, res) {
  const remote = req.socket && req.socket.remoteAddress
  const ok = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!ok) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('仅允许本机访问')
  }
  return !ok
}

/** 读请求体（上限 1MB）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 回 JSON。 */
function json(res, payload, code = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文
 */
export function apply(ctx) {
  const db = openStore()
  const settings = createSettingsStore()
  const learner = createLearner(ctx, db, () => settings.read())

  /**
   * 会话级运行态。
   *   · mood: 当前心情（只在用户回合推进，注入时只读 —— 保证同一回合内注入文本
   *     逐字节稳定，不触发宿主追加新快照）
   *   · tempStyle: 本轮抽中的备用风格（同样只在用户回合抽一次）
   */
  const sessions = new Map()
  function sessionState(sid) {
    const key = sid || '__default__'
    let st = sessions.get(key)
    if (!st) {
      // 进程重启后内存态是空的 —— 心情要从库里续上，否则每次重启都「失忆」成平静，
      // 而库里明明还躺着刚才的情绪。
      let restored = null
      try {
        const last = latestMood(db, sid)
        if (last) restored = { mood: last.mood, intensity: last.intensity, createdAt: last.createdAt }
      } catch { /* 读库失败就当没有 */ }
      st = { mood: restored, tempStyle: '', turn: 0 }
      sessions.set(key, st)
    }
    return st
  }

  // ── 会话事件：推进心情、喂学习缓冲、计数 ────────────────────────────────
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return
      const sid = sessionIdOf(session)

      if (event.type === 'user/message') {
        const source = event.data && event.data.source
        // 只记真实用户输入：插件注入/系统上下文/委派消息都不算
        if (isRelayedMessage(source)) return
        if (source && source.kind && source.kind !== 'user') return
        const text = extractText(event.data && event.data.content)
        if (!text) return

        const cfg = settings.read()
        if (!cfg.enabled) return

        const st = sessionState(sid)
        st.turn += 1
        bumpCounter(db, 'user_messages', 1)

        // 心情推进（只在用户回合算，保证回合内稳定）
        const prev = st.mood
        const next = advanceMood(prev, text)
        st.mood = { mood: next.mood, intensity: next.intensity, createdAt: next.createdAt }
        if (next.changed) {
          recordMood(db, { session: sid, mood: next.mood, intensity: next.intensity, reason: oneLine(text, 80) })
        }

        // 备用风格抽签（MaiBot multiple_probability）：一轮只抽一次
        st.tempStyle = ''
        const pool = Array.isArray(cfg.multipleReplyStyle) ? cfg.multipleReplyStyle : []
        if (pool.length > 0 && cfg.multipleProbability > 0 && Math.random() < cfg.multipleProbability) {
          st.tempStyle = pool[Math.floor(Math.random() * pool.length)] || ''
        }

        // 喂学习缓冲（达阈值后后台学一轮，不阻塞本回合）
        learner.onUserMessage(sid, text)
        return
      }

      if (event.type === 'assistant/message') {
        const text = extractText(event.data && event.data.message && event.data.message.content)
        if (text) learner.onAssistantMessage(text)
      }
    } catch (error) {
      // 事件处理绝不能把错误冒泡进会话流
      try {
        ctx.logger.warn('maidsh: 会话事件处理失败: ' + ((error && error.message) || String(error)))
      } catch { /* logger 不可用时静默 */ }
    }
  }), 'maidsh: session/event 监听')

  // ── 系统提示词注入 ────────────────────────────────────────────────────
  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, hostCtx, next) => {
    try {
      const cfg = settings.read()
      if (cfg.enabled && assembly && Array.isArray(assembly.contexts)) {
        const sid = sessionIdOf(hostCtx && hostCtx.agent && hostCtx.agent.session)
        const st = sessionState(sid)
        const expressions = cfg.injectExpressions ? topExpressions(db, cfg.expressionLimit) : []
        const jargon = cfg.injectJargon ? listJargon(db, cfg.jargonLimit) : []
        const impressions = cfg.injectImpression && cfg.impressionLimit > 0 ? listImpressions(db, cfg.impressionLimit) : []
        const mood = cfg.injectMood ? st.mood : null
        // 画像按 personId 取（DSH 单用户，默认 local-user）；读失败不能拖垮注入
        let profileText = ''
        if (cfg.injectProfile) {
          try {
            const profile = getProfile(db, cfg.profilePersonId)
            profileText = profile ? profile.profileText : ''
          } catch { profileText = '' }
        }
        const sections = buildSections({ cfg, temporaryStyle: st.tempStyle, expressions, jargon, impressions, mood, profileText })
        for (const section of sections) assembly.contexts.push(section)
      }
    } catch (error) {
      // 注入失败不阻塞模型请求（与 dsh-memory issue #128 同规：不静默）
      try {
        ctx.logger.warn('maidsh: 人格注入失败（已跳过本轮）: ' + ((error && error.message) || String(error)))
      } catch { /* 静默 */ }
    }
    return next()
  }), 'maidsh: system-prompt/assemble 注入')

  // ── HTTP 面：独立 WebUI + 管理 API ─────────────────────────────────────
  const webServer = ctx.get('webServer')
  if (webServer && typeof webServer.register === 'function') {
    // 独立 WebUI（自包含单页，无构建链）
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: PANEL_ROUTE,
      handler(req, res) {
        if (denyNonLoopback(req, res)) return
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        }
        try {
          const html = readFileSync(join(here, 'webui', 'index.html'))
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(html)
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('WebUI 缺失: ' + ((error && error.message) || String(error)))
        }
      },
    }), 'maidsh: /maidsh 独立面板')

    // 管理 API
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: API_ROUTE,
      handler: (req, res) => {
        void handleApi(req, res, { ctx, db, settings, learner, sessions })
      },
    }), 'maidsh: /maidsh-api 管理接口')
  } else {
    try {
      ctx.logger.warn('maidsh: webServer 不可用，独立 WebUI 未挂载（人格注入仍生效）')
    } catch { /* 静默 */ }
  }

  try {
    ctx.logger.info('maidsh: 人格注入已启用，数据库 ' + databasePath() + '，设定 ' + settingsPath() + '，面板 ' + PANEL_ROUTE)
  } catch { /* 静默 */ }
}

/**
 * 管理 API 路由分发。
 *
 * 设计成「一个入口 + op 分发」而不是十几条路由：面板只需要一个 base，加接口
 * 不用改 webServer 注册；也避免宿主路由表被插件撑爆。
 */
async function handleApi(req, res, deps) {
  if (denyNonLoopback(req, res)) return
  const url = new URL(req.url || '/', 'http://localhost')

  // 跨站请求防护：管理面只接受同源/无 Origin 的请求
  const origin = req.headers.origin
  if (origin) {
    try {
      const host = new URL(origin).host
      if (host !== req.headers.host) {
        json(res, { ok: false, error: '跨站请求被拒绝' }, 403)
        return
      }
    } catch {
      json(res, { ok: false, error: '跨站请求被拒绝' }, 403)
      return
    }
  }

  const { ctx, db, settings, learner } = deps

  // GET：读全部面板数据
  if (req.method === 'GET') {
    try {
      const view = url.searchParams.get('view') || 'all'
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 50))
      const payload = { ok: true, settings: settings.read(), defaults: defaultSettings(), stats: stats(db) }
      if (view === 'all' || view === 'expressions') payload.expressions = topExpressions(db, limit)
      if (view === 'all' || view === 'jargon') payload.jargon = listJargon(db, limit)
      if (view === 'all' || view === 'mood') payload.mood = moodTimeline(db, limit)
      if (view === 'all' || view === 'impressions') payload.impressions = listImpressions(db, limit)
      if (view === 'all' || view === 'log') payload.log = listLearnLog(db, limit)
      if (view === 'all' || view === 'profile') {
        payload.profiles = listProfiles(db, 20)
        // 默认取设定里那个 personId 的完整画像（面板主体）
        const pid = String(url.searchParams.get('personId') || settings.read().profilePersonId || 'local-user')
        payload.profile = getProfile(db, pid)
        payload.profileHistory = payload.profile ? profileHistory(db, pid, 10) : []
      }
      json(res, payload)
    } catch (error) {
      json(res, { ok: false, error: (error && error.message) || String(error) }, 500)
    }
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }

  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    json(res, { ok: false, error: '无效的 JSON 请求体' }, 400)
    return
  }

  try {
    const op = String(body.op || '')
    switch (op) {
      // ── 设定 ──
      case 'saveSettings': {
        const next = settings.write(body.patch || {})
        json(res, { ok: true, settings: next })
        break
      }
      case 'resetSettings': {
        const next = settings.write(defaultSettings())
        json(res, { ok: true, settings: next })
        break
      }

      // ── 表达库 ──
      case 'addExpression': {
        const isNew = addExpression(db, {
          situation: String(body.situation || ''),
          style: String(body.style || ''),
          sourceText: '（手动添加）',
        })
        json(res, { ok: true, added: isNew, expressions: topExpressions(db, 500) })
        break
      }
      case 'deleteExpression': {
        deleteExpression(db, body.id)
        json(res, { ok: true })
        break
      }

      // ── 黑话 ──
      case 'addJargon': {
        const isNew = addJargon(db, { term: String(body.term || ''), meaning: String(body.meaning || '') })
        json(res, { ok: true, added: isNew })
        break
      }
      case 'deleteJargon': {
        deleteJargon(db, body.id)
        json(res, { ok: true })
        break
      }

      // ── 学习 ──
      case 'forceLearn': {
        await learner.forceLearn(String(body.session || ''))
        json(res, { ok: true })
        break
      }
      case 'learnFromText': {
        // 面板里贴一段文本直接学（不必等真实对话累积）
        const text = String(body.text || '').trim()
        if (!text) throw new Error('缺少文本')
        const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
        const messages = lines.map((line, i) => ({ id: i + 1, role: 'user', text: line }))
        const result = await learnExpressions(ctx, db, messages, { maxTokens: settings.read().learnMaxTokens })
        json(res, { ok: true, ...result })
        break
      }
      case 'makeImpression': {
        const text = String(body.text || '').trim()
        if (!text) throw new Error('缺少文本')
        const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
        const messages = lines.map((line, i) => ({ id: i + 1, role: 'user', text: line }))
        const made = await learnImpression(ctx, db, messages, {})
        json(res, { ok: true, impression: made })
        break
      }
      case 'learnJargonFromText': {
        const text = String(body.text || '').trim()
        if (!text) throw new Error('缺少文本')
        const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
        const messages = lines.map((line, i) => ({ id: i + 1, role: 'user', text: line }))
        const result = await learnJargon(ctx, db, messages, {})
        json(res, { ok: true, ...result })
        break
      }

      // ── 人物画像 ──
      case 'updateProfileFromText': {
        const text = String(body.text || '').trim()
        if (!text) throw new Error('缺少文本')
        const cfg = settings.read()
        const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean)
        const messages = lines.map((line, i) => ({ id: i + 1, role: 'user', text: line }))
        const result = await learnProfile(ctx, db, messages, {
          personId: String(body.personId || cfg.profilePersonId || 'local-user'),
          primaryName: cfg.profilePrimaryName,
          aliases: cfg.aliases,
          maxTokens: cfg.learnMaxTokens,
        })
        json(res, { ok: true, ...result, profile: getProfile(db, String(body.personId || cfg.profilePersonId || 'local-user')) })
        break
      }
      case 'saveProfileText': {
        // 面板里手工编辑画像正文（MaiBot 的 manual override 等价物）
        const pid = String(body.personId || settings.read().profilePersonId || 'local-user')
        // 面板传 text，API 文档里叫 profileText —— 两个都收，别让人踩这个坑
        const text = String(body.profileText || body.text || '')
        if (!text.trim()) throw new Error('画像不能为空')
        const result = upsertProfile(db, { personId: pid, profileText: text, sourceNote: 'manual' })
        json(res, { ok: true, ...result, profile: getProfile(db, pid) })
        break
      }
      case 'deleteProfile': {
        // 必须回退到设定里的 personId，否则面板不传 personId 时这里会删掉空字符串
        deleteProfile(db, String(body.personId || settings.read().profilePersonId || 'local-user'))
        json(res, { ok: true })
        break
      }

      // ── 清理 ──
      case 'clearTable': {
        clearTable(db, String(body.table || ''))
        json(res, { ok: true })
        break
      }

      default:
        json(res, { ok: false, error: '未知 op: ' + op }, 400)
    }
  } catch (error) {
    json(res, { ok: false, error: (error && error.message) || String(error) }, 400)
  }
}

export { defaultSettings }
