/**
 * maidsh 表达 / 黑话 / 印象学习器 —— 迁移自 MaiBot：
 *   · `src/learners/expression_learner.py`（ExpressionLearningBatchGate 并发闸门
 *     + `_learn_from_session_messages` 取窗口 + `learn_style` 提示词）
 *   · `src/learners/expression_utils.py`（JSON 容错解析 + 适用性评估）
 *   · `src/learners/jargon_learner.py` / `jargon_miner.py`
 *
 * 与 MaiBot 的差异（都是 DSH 侧的适配，不是功能削减）：
 *   1. 触发单位：MaiBot 按「群聊消息条数」触发；DSH 里一个会话就是一个对话流，
 *      故按**用户消息条数**（config.learnEvery）触发，且只在用户回合推进计数。
 *   2. 并发闸门：MaiBot 用 asyncio.Lock + 批次门。这里用同样的思路做一个
 *      `running` 标记 + 待学缓冲：学习进行中来的新消息累积，学完立刻再跑一批，
 *      不并发发请求（避免多会话同时学习把模型打满）。
 *   3. 评估：MaiBot 逐条评估；这里批量评估（见 prompts.js 注释）。
 *   4. 存储：写进 maidsh 自己的 SQLite（store.js），不走认知图。
 */

import { learnStylePrompt, evaluateExpressionsPrompt, learnJargonPrompt, impressionPrompt } from './prompts.js'
import { callModel, parseJsonLoose } from './llm.js'
import { addExpression, addJargon, addImpression, logLearning, bumpCounter, setCounter, readCounter, getProfile, upsertProfile } from './store.js'
import {
  classifyRuleBased,
  mergeClassification,
  parseClassification,
  profileUpdatePrompt,
  bucketsToProfileText,
} from './profile.js'

/** 每批最多取多少条消息做学习（MaiBot `_learn_from_session_messages` 同量级）。 */
const MAX_BATCH_MESSAGES = 40
/** 单条消息进提示词前的截断长度，防止一条长贴占满上下文。 */
const MAX_MESSAGE_CHARS = 400
/** 一批最多接受多少条候选（learn_style 提示词要求 ≤10，留余量）。 */
const MAX_CANDIDATES = 12
/**
 * 触发一轮学习所需的最小缓冲条数。
 *
 * 为什么要有这道下限：阈值计数是持久化的，重启后可能一上来就过线，但缓冲
 * （内存里的对话窗口）是空的。拿两三句话去学，既学不出东西又白花一次模型调用。
 */
const MIN_BUFFER_FOR_LEARN = 6

/**
 * 人物画像两次更新之间的最小间隔（毫秒）。
 *
 * 为什么画像要单独节流（其余三项每轮都学）：画像是**账本**，记录「这个人是谁」，
 * 它变化得慢；而每更新一次要一次完整模型调用（当前画像 + 新对话 → 六桶 JSON）。
 * 跟着表达学习一起每 20 条跑一次，等于拿最贵的一次调用去干最不需要频繁干的事。
 *
 * 10 分钟对齐 MaiBot `profile_policy.py` 的刷新节奏（debounce 120s + queue 60s
 * 在一个批次的尺度上，折算下来是分钟级，不是每条消息级）。
 */
const PROFILE_MIN_INTERVAL_MS = 10 * 60 * 1000

/**
 * 画像现在该不该刷新。
 *
 * 除了时间间隔，还有一条**内容**判据：距上次更新不足间隔，但已经攒了
 * `learnEvery * 3` 条新消息时也放行——长时间连续聊天不该因为节流而让画像停在原地。
 *
 * @param {object} db
 * @param {object} cfg
 */
function shouldRefreshProfile(db, cfg) {
  let updatedAt = 0
  try {
    const current = getProfile(db, cfg.profilePersonId || 'local-user')
    updatedAt = current ? Number(current.updatedAt) || 0 : 0
  } catch {
    return true
  }
  if (!updatedAt) return true
  const age = Date.now() - updatedAt
  if (age >= PROFILE_MIN_INTERVAL_MS) return true
  const every = Math.max(1, Math.min(200, Number(cfg.learnEvery) || 20))
  return readCounter(db, 'since_profile') >= every * 3
}

/**
 * 把消息列表渲染成学习提示词用的对话文本。
 *
 * 格式对齐 MaiBot：`[id:N] USER: ...` / `[id:N] SELF: ...`，提示词里明确要求
 * 「不要总结 SELF 的发言」，所以必须把两者分开标出来。
 *
 * @param {Array<{id: number, role: 'user'|'self', text: string}>} messages
 */
export function renderChat(messages) {
  return messages
    .map((m) => `[id:${m.id}] ${m.role === 'self' ? 'SELF' : 'USER'}: ${String(m.text || '').slice(0, MAX_MESSAGE_CHARS)}`)
    .join('\n')
}

/**
 * 从一批对话里学表达方式。
 *
 * @param {object} ctx cordis 上下文
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{id: number, role: 'user'|'self', text: string}>} messages
 * @param {{session?: string, maxTokens?: number}} [opts]
 * @returns {Promise<{learned: number, rejected: number, candidates: number}>}
 */
export async function learnExpressions(ctx, db, messages, opts = {}) {
  const usable = messages.filter((m) => String(m.text || '').trim()).slice(-MAX_BATCH_MESSAGES)
  if (usable.length === 0) return { learned: 0, rejected: 0, candidates: 0 }

  const chat = renderChat(usable)
  const raw = await callModel(ctx, learnStylePrompt(chat), { maxTokens: opts.maxTokens || 1200 })
  let parsed
  try {
    parsed = parseJsonLoose(raw, 'array')
  } catch (error) {
    logLearning(db, { kind: 'learn', ok: false, detail: '表达学习解析失败: ' + (error && error.message) })
    return { learned: 0, rejected: 0, candidates: 0 }
  }
  if (!Array.isArray(parsed)) return { learned: 0, rejected: 0, candidates: 0 }

  const candidates = parsed
    .map((x) => ({
      situation: String((x && x.situation) || '').trim().slice(0, 60),
      style: String((x && x.style) || '').trim().slice(0, 60),
    }))
    .filter((c) => c.situation && c.style)
    .slice(0, MAX_CANDIDATES)

  if (candidates.length === 0) return { learned: 0, rejected: 0, candidates: 0 }

  // 适用性评估（MaiBot expression_evaluation.prompt 的批量化）。评估失败时
  // **fail-open**：宁可学进一条不那么完美的口癖，也不要因为一次评估请求失败
  // 就把整批学习丢掉 —— 学到的坏口癖用户能在 WebUI 里删，学不到东西则无声无息。
  let verdicts = null
  try {
    const evalRaw = await callModel(ctx, evaluateExpressionsPrompt(candidates), { maxTokens: 800 })
    const arr = parseJsonLoose(evalRaw, 'array')
    if (Array.isArray(arr)) verdicts = arr
  } catch {
    verdicts = null
  }

  let learned = 0
  let rejected = 0
  candidates.forEach((c, i) => {
    const v = verdicts && verdicts[i]
    if (v && v.suitable === false) {
      rejected += 1
      return
    }
    const isNew = addExpression(db, {
      situation: c.situation,
      style: c.style,
      sourceText: chat.slice(0, 500),
      session: opts.session || '',
    })
    if (isNew) learned += 1
  })

  if (learned > 0) bumpCounter(db, 'learned_new', learned)
  logLearning(db, {
    kind: 'learn',
    ok: true,
    detail: `候选 ${candidates.length}，新增 ${learned}，评估拒绝 ${rejected}${verdicts ? '' : '（评估请求失败，已放行）'}`,
  })
  return { learned, rejected, candidates: candidates.length }
}

/**
 * 从一批对话里学黑话。
 *
 * @returns {Promise<{learned: number, candidates: number}>}
 */
export async function learnJargon(ctx, db, messages, opts = {}) {
  const usable = messages.filter((m) => m.role === 'user' && String(m.text || '').trim()).slice(-MAX_BATCH_MESSAGES)
  if (usable.length === 0) return { learned: 0, candidates: 0 }

  const raw = await callModel(ctx, learnJargonPrompt(renderChat(usable)), { maxTokens: 800 })
  let parsed
  try {
    parsed = parseJsonLoose(raw, 'array')
  } catch (error) {
    logLearning(db, { kind: 'jargon', ok: false, detail: '黑话学习解析失败: ' + (error && error.message) })
    return { learned: 0, candidates: 0 }
  }
  if (!Array.isArray(parsed)) return { learned: 0, candidates: 0 }

  const terms = parsed
    .map((x) => String((x && (x.content || x.term)) || '').trim())
    // 过滤掉明显不是黑话的：纯标点、单个字、超长
    .filter((t) => t.length >= 2 && t.length <= 12 && /[\p{L}\p{N}]/u.test(t))
    .slice(0, 30)

  let learned = 0
  for (const term of new Set(terms)) {
    if (addJargon(db, { term, session: opts.session || '' })) learned += 1
  }
  logLearning(db, { kind: 'jargon', ok: true, detail: `候选 ${terms.length}，新增 ${learned}` })
  return { learned, candidates: terms.length }
}

/**
 * 生成一段「当前聊天印象」。
 *
 * @returns {Promise<string>} 生成的印象文本（失败返回空串）
 */
export async function learnImpression(ctx, db, messages, opts = {}) {
  const usable = messages.filter((m) => String(m.text || '').trim()).slice(-MAX_BATCH_MESSAGES)
  if (usable.length === 0) return ''
  const window = renderChat(usable)
  const identity = opts.chatIdentity || 'DSH 当前会话（与用户的单对单对话）'
  try {
    const text = await callModel(ctx, impressionPrompt(identity, window), { maxTokens: 400 })
    const trimmed = String(text || '').trim()
    if (!trimmed) return ''
    addImpression(db, { text: trimmed, session: opts.session || '' })
    logLearning(db, { kind: 'impression', ok: true, detail: trimmed.slice(0, 200) })
    return trimmed
  } catch (error) {
    logLearning(db, { kind: 'impression', ok: false, detail: '印象生成失败: ' + (error && error.message) })
    return ''
  }
}

/**
 * 更新人物画像。
 *
 * 与印象的区别：印象只描述「这段在聊什么」，用完即弃；画像跨会话累积，
 * 描述「这个人是谁」（身份 / 关系 / 偏好 / 雷点），每轮增量合并。
 *
 * 两条路径（对齐 MaiBot `_classify_profile_evidence`）：
 *   · LLM 分桶成功 → 用 LLM 结果（有值就用，没值的桶回退规则结果）
 *   · LLM 失败/输出不可解析 → 全用规则分桶，画像照样能长，只是粗一些
 *
 * @returns {Promise<{updated: boolean, version?: number}>}
 */
export async function learnProfile(ctx, db, messages, opts = {}) {
  const personId = String(opts.personId || 'local-user').trim()
  const usable = messages.filter((m) => String(m.text || '').trim()).slice(-MAX_BATCH_MESSAGES)
  if (usable.length === 0) return { updated: false }

  const chat = renderChat(usable)
  const existing = getProfile(db, personId)
  const primaryName = String(opts.primaryName || '用户').trim()
  const aliases = Array.isArray(opts.aliases) ? opts.aliases : []

  // 规则分桶永远先算 —— 它是 LLM 不可用时的稳定回退
  const fallback = classifyRuleBased(usable.map((m) => m.text))

  let buckets = fallback
  try {
    const raw = await callModel(
      ctx,
      profileUpdatePrompt({
        personId,
        primaryName,
        aliases,
        currentProfile: existing ? existing.profileText : '',
        chatText: chat,
      }),
      { maxTokens: opts.maxTokens || 1200 },
    )
    const parsed = parseClassification(raw)
    if (Object.keys(parsed).length > 0) {
      buckets = mergeClassification(fallback, parsed)
    }
  } catch (error) {
    // 模型挂了不是错误路径，是降级路径：规则分桶已经算好，画像照样更新
    logLearning(db, { kind: 'profile', ok: true, detail: '画像 LLM 分桶失败，已用规则回退: ' + ((error && error.message) || String(error)) })
  }

  // 全空说明这批对话没有任何可入画像的内容（比如纯闲聊）——不要拿空画像覆盖已有的
  const hasContent = Object.values(buckets).some((list) => list && list.length > 0)
  if (!hasContent) {
    logLearning(db, { kind: 'profile', ok: true, detail: '本批无可入画像内容，保持不变' })
    return { updated: false }
  }

  const profileText = bucketsToProfileText({ personId, primaryName, aliases, buckets })
  const result = upsertProfile(db, { personId, profileText, aliases, sourceNote: 'auto' })
  logLearning(db, {
    kind: 'profile',
    ok: true,
    detail: `画像 v${result.version}${result.isNew ? '（首次建立）' : ''}：${profileText.replace(/\n/g, ' ').slice(0, 160)}`,
  })
  return { updated: true, version: result.version }
}

/**
 * 学习调度器：把「消息累积 → 达阈值 → 后台学一轮」这套节流逻辑收在一处。
 *
 * 并发策略（对齐 MaiBot 的 ExpressionLearningBatchGate）：
 *   · 同一时刻只有一轮学习在跑（`running` 标记）
 *   · 学习期间来的消息继续进缓冲，跑完后若又够了阈值就再跑一轮
 *   · 不排队、不重试 —— 学习是尽力而为的后台增强，失败不阻塞对话
 */
export function createLearner(ctx, db, getConfig) {
  /** 待学消息缓冲（滚动窗口）。 */
  let buffer = []
  let running = false
  /** 已分配的消息自增 id（用于提示词里的 [id:N]）。 */
  let nextId = 1

  function push(role, text) {
    const body = String(text || '').trim()
    if (!body) return
    buffer.push({ id: nextId, role, text: body })
    nextId += 1
    // 只保留最近 N 条，防止长时间运行把内存吃满
    if (buffer.length > MAX_BATCH_MESSAGES * 3) {
      buffer = buffer.slice(-MAX_BATCH_MESSAGES * 3)
    }
  }

  async function runOnce(session) {
    if (running) return
    const cfg = getConfig()
    if (!cfg.enabled || !cfg.learning) return
    running = true
    const batch = buffer.slice(-MAX_BATCH_MESSAGES)
    try {
      if (cfg.learnExpressions) {
        await learnExpressions(ctx, db, batch, { session, maxTokens: cfg.learnMaxTokens })
      }
      if (cfg.learnJargon) {
        await learnJargon(ctx, db, batch, { session })
      }
      if (cfg.learnImpression) {
        await learnImpression(ctx, db, batch, { session })
      }
      if (cfg.learnProfile && shouldRefreshProfile(db, cfg)) {
        const res = await learnProfile(ctx, db, batch, {
          session,
          personId: cfg.profilePersonId || 'local-user',
          primaryName: cfg.profilePrimaryName || '用户',
          aliases: cfg.aliases,
          maxTokens: cfg.learnMaxTokens,
        })
        // 只有真写了才清计数；模型没给出有效六桶时不推进节流窗口，
        // 下一轮还能再试（否则一次失败要等 10 分钟）。
        if (res && res.updated) {
          try { setCounter(db, 'since_profile', 0) } catch { /* 记账失败不影响学习 */ }
        }
      }
    } catch (error) {
      // 后台学习失败只记日志，不向会话抛（否则会把失败冒泡成对话错误）
      try {
        ctx.logger.warn('maidsh: 学习失败: ' + ((error && error.message) || String(error)))
      } catch { /* logger 不可用时静默 */ }
      logLearning(db, { kind: 'learn', ok: false, detail: String((error && error.message) || error) })
    } finally {
      running = false
      // 学完清零**持久化**的计数（旧版清的是内存变量，重启即归零，导致
      // 断断续续聊天永远攒不到阈值——2026-10-26 修）。
      try { setCounter(db, 'since_learn', 0) } catch { /* 记账失败不影响学习 */ }
    }
  }

  return {
    /**
     * 记一条用户消息；够了阈值就触发一轮学习（不等待）。
     *
     * 阈值走**持久化**计数（`since_learn`），不走来内存变量。原因：内存计数在
     * DSH 重启后归零，而 DSH 常被随手重启，于是「聊够 20 条」这件事永远攒不满，
     * 学习一次都不触发——这是「感觉没起作用」的头号原因。
     *
     * 另加一道下限：缓冲里至少要有 MIN_BUFFER_FOR_LEARN 条才值得花一次模型调用。
     * 刚重启时缓冲是空的，即便计数过线也先攒着，避免拿两句话去学。
     */
    onUserMessage(session, text) {
      push('user', text)
      let since = 0
      try {
        since = bumpCounter(db, 'since_learn', 1)
        bumpCounter(db, 'since_profile', 1)
      } catch { since = 0 }
      const cfg = getConfig()
      const every = Math.max(1, Math.min(200, Number(cfg.learnEvery) || 20))
      if (!cfg.enabled || !cfg.learning) return
      if (since < every) return
      if (buffer.length < MIN_BUFFER_FOR_LEARN) return
      // 故意不 await：学习是后台任务，不能拖慢对话回合
      void runOnce(session)
    },
    /** 记一条自己的回复（供学习时区分 SELF，避免学自己）。 */
    onAssistantMessage(text) {
      push('self', text)
    },
    /** 手动触发一轮学习（WebUI / 工具用）。 */
    async forceLearn(session) {
      await runOnce(session)
      return true
    },
    /** 当前缓冲条数（调试用）。 */
    get bufferSize() {
      return buffer.length
    },
    /** 学习是否在进行中。 */
    get isRunning() {
      return running
    },
  }
}
