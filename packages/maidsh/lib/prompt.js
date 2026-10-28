/**
 * maidsh 系统提示词装配 —— 把人格/风格/表达习惯/心情拼成注入块。
 *
 * 迁移来源：
 *   · 人格三段式与 `reply_style` 占位 ← MaiBot `retro_private_replyer.prompt`
 *     （`{extra_info_block}{expression_habits_block}` … `{reply_style}`）
 *   · `expression_habits_block` 的行格式 ← MaiBot
 *     `src/chat/replyer/maisaka_expression_selector.py:177 _build_expression_habits_block`
 *     （`- 当"X"时，可以用"Y"来表达。`，首行 `你可以视情况自由使用以下句式：`）
 *   · 备用风格抽签 ← MaiBot `PersonalityConfig.multiple_probability`
 *
 * ⚠️ 两条宿主契约（踩过坑，别改）：
 *   1. **每个 step 都要 push**，哪怕内容逐字节相同。宿主把 assembly.contexts 渲染成
 *      一份运行时上下文快照，只有渲染文本**变了**才 append 一条 user/message。
 *      内容不变时照旧 push → 零开销；跳过 push → 文本变了 → 反而追加一份「少了本块」
 *      的快照，下一步再加回来又追加一份（每份 ~250 tok）。所以「要不要补」交还宿主。
 *   2. 注入文本必须打断裸 `{{` —— 宿主对 context 文本做严格 `{{var}}` 插值，裸 `{{`
 *      会让该轮请求整体抛错。只改注入副本，库内原文保真。
 */

import { MOOD_LABELS } from './defaults.js'
import { escapePromptBraces } from './text.js'
import { formatProfileBlock } from './profile.js'

/**
 * 渲染人格块。
 * @param {object} cfg 归一化后的设定
 */
export function renderPersona(cfg) {
  const lines = []
  // 别名里若含昵称本身，去掉——否则渲染成「你叫「麦麦」（别人也可能叫你：麦麦、…）」。
  const aliasList = (Array.isArray(cfg.aliases) ? cfg.aliases : [])
    .map((a) => String(a).trim())
    .filter((a) => a && a !== cfg.nickname)
  lines.push(`你叫「${cfg.nickname}」${aliasList.length > 0 ? `（别人也可能叫你：${aliasList.join('、')}）` : ''}。`)
  if (cfg.personality) lines.push(`你的人格：${cfg.personality}`)
  // MaiBot 的 behavior_style 默认值以 personality 原文为前缀再追加一句。
  // 两段都注入会把同一长句说两遍（每轮白烧 ~60 tok），故剥掉重复前缀只留增量。
  const behavior = typeof cfg.behaviorStyle === 'string' ? cfg.behaviorStyle.trim() : ''
  if (behavior) {
    const base = typeof cfg.personality === 'string' ? cfg.personality.trim() : ''
    const incremental = base && behavior.startsWith(base) ? behavior.slice(base.length).trim() : behavior
    if (incremental) lines.push(`你的行为风格：${incremental}`)
  }
  lines.push('你就是你自己，不是"助手"、不是"AI 工具"。说话时不要自称助手，不要解释自己在扮演谁。')
  lines.push('你有自己的判断和脾气：可以不同意、可以吐槽、可以拒绝，不用什么都顺着说，也不用刻意讨好。')
  lines.push('不要提"设定""扮演""人格""AI"这类词，就当自己是本人，说话带着自己的立场和偏好。')
  return lines.join('\n')
}

/**
 * 渲染表达风格块。
 *
 * 这一段是「拟人感」真正的落点，所以写得比别处都重。三条经验（都是踩出来的）：
 *
 *   ① **留了逃生口就等于没有规则。** 早先那句「只有用户明确要方案/代码/长文时
 *      才展开」，结果是：用户一问技术问题，模型就自认为拿到了许可，列表加粗
 *      全上，然后「人格感」当场消失。现在逃生口只作用于**长度**，排版禁令
 *      写成无条件的——「哪怕内容很长也不许」。
 *   ② **禁令要给出可扫的符号。** 「不要用列表」太抽象，模型不一定认为自己在
 *      用列表。补一条自检，点名 `-`、`*`、`#`、`1.`、`**`、`---` 这些**字符**，
 *      发送前扫一遍就行。
 *   ③ **要禁止的是具体句式，不是抽象品质。** 「不要啰嗦」没用；
 *      「不要写"我帮你看看"」有用。所以开场白、过渡语、复述都点名。
 *
 * @param {object} cfg
 * @param {string} [temporaryStyle] 本轮抽中的备用风格（没有则空）
 */
export function renderReplyStyle(cfg, temporaryStyle) {
  const lines = []
  if (cfg.replyStyle) lines.push(cfg.replyStyle)
  if (temporaryStyle) lines.push(`本轮额外要求：${temporaryStyle}`)
  lines.push(
    '【怎么说】像人在手机上打字：可以短、可以不完整、可以只有几个字或一个符号。省略主语、倒装、语气词、半截话都正常，不用把话说圆。',
    '默认一两句话。只有用户明确要方案、代码或长文时才展开；其余场合越短越像人。',
    '【排版禁令，无条件】不要用列表、编号、标题、加粗、分隔线，哪怕内容再长也不许。要分点就用大白话连着说，"一个是…另一个是…"这样。',
    '不要写"首先/其次/最后/总结一下/综上所述"，不要复述用户说过的话。',
    '不要开场白和过渡语（"好的"、"我帮你看看"、"让我想想"、"简单来说"），直接给内容。',
    '不要多余内容：前后缀、冒号、引号、括号补充说明、表情的文字说明，都不要。',
    '【发送前自检】扫一遍你写的东西：出现 `- `、`* `、`# `、`1. `、`**`、`---` 中任何一个，就说明你在排版，删掉重写成大白话。',
  )
  return lines.join('\n')
}

/**
 * 渲染「表达习惯」块（MaiBot expression_habits_block 等价物）。
 * @param {Array<{situation: string, style: string}>} expressions
 */
export function renderExpressionHabits(expressions) {
  if (!Array.isArray(expressions) || expressions.length === 0) return ''
  const lines = expressions.map((e) => `- 当"${e.situation}"时，可以用"${e.style}"来表达。`)
  return '你可以视情况自由使用以下句式（不必每条都用，也不要生硬套用）：\n' + lines.join('\n')
}

/**
 * 渲染心情块。
 * @param {{mood: string, intensity: number} | null} state
 */
export function renderMood(state) {
  if (!state || !state.mood || state.mood === 'calm') return ''
  const label = MOOD_LABELS[state.mood] || state.mood
  // 强度分三档给模型一个模糊的量感，而不是精确小数（精确值会让文本每步都变）。
  const degree = state.intensity >= 2.5 ? '很明显' : state.intensity >= 1.2 ? '有一些' : '稍微'
  return `你此刻的情绪：${label}（${degree}）。让这点情绪自然渗进语气里，但不要直接说出来（别说"我现在很开心"这种话）。`
}

/**
 * 渲染印象块。
 * @param {Array<{text: string}>} impressions
 */
export function renderImpressions(impressions) {
  if (!Array.isArray(impressions) || impressions.length === 0) return ''
  const lines = impressions.map((i) => `- ${i.text}`)
  return '你对最近这些对话的印象（可作背景，不必主动提起）：\n' + lines.join('\n')
}

/**
 * 渲染人物画像块。
 *
 * 直接复用 profile.js 的 formatProfileBlock —— 它已经做了「七段裁剪成五段、
 * 近期互动只留 N 条、维护备注不注入」这些事，这里不要再实现一遍。
 *
 * @param {string} profileText 完整画像文本
 * @param {number} recentLimit 「近期互动」保留几条
 */
export function renderProfile(profileText, recentLimit = 2) {
  const text = String(profileText || '').trim()
  if (!text) return ''
  return formatProfileBlock(text, { recentLimit })
}

/**
 * 渲染黑话块。
 * @param {Array<{term: string, meaning: string}>} jargon
 */
export function renderJargon(jargon) {
  if (!Array.isArray(jargon) || jargon.length === 0) return ''
  const lines = jargon.map((j) => (j.meaning ? `- ${j.term}：${j.meaning}` : `- ${j.term}`))
  return '用户常用的圈内说法（你应当看得懂，但不必刻意使用）：\n' + lines.join('\n')
}

/**
 * 渲染「临门一脚」风格锚点 —— 放在所有块的**最末位**。
 *
 * 为什么值得多花这 60 来个 token：系统提示词是一长串，越靠前的内容在生成时
 * 越容易被稀释。前面的人格块与风格块隔着黑话、心情、画像，等到真正落笔时
 * 权重已经掉下去了——技术长答尤其明显，一展开就回到「助手腔」。
 *
 * 所以末尾放一条极短、可扫的复述。它不复述全部规则，只留三条最容易破的。
 *
 * @param {object} cfg
 */
export function renderAnchor(cfg) {
  const name = cfg && cfg.nickname ? String(cfg.nickname).trim() : ''
  const lines = [
    name ? `（临门提醒：你是${name}，不是助手。）` : '（临门提醒：你是你自己，不是助手。）',
    '像人在手机上打字：短、口语、能省就省。不要列表、编号、标题、加粗、分隔线。',
    '有脾气就带出来，不用一直客气；不知道就说不知道，别硬圆。',
  ]
  return lines.join('\n')
}

/**
 * 对话思维链块 —— 迁移自 MaiBot maisaka planner 的「先判断再动手」。
 *
 * 只在该回合的**第一步**注入（isFirstStep 为真），因为思维链的意义就是「开场先想，
 * 想完再动」；工具步骤、子 agent 都是「已经动起来之后的执行」，套这层反而干扰。
 *
 * 连续多轮结束回合不说话时（silentStreak 达阈值）追加一句别已读不回；没话说则
 * 追加「不想说就结束回合，别用一段话表达不想说」——治「计划憋成正文」。
 *
 * @param {object} cfg
 * @param {{isFirstStep?: boolean, silentStreak?: number}} [ctx]
 * @returns {string}
 */
export function renderThinkingChain(cfg, ctx) {
  if (!cfg || cfg.chatThinkingChain !== true) return ''
  if (!ctx || ctx.isFirstStep === false) return ''
  const body = typeof cfg.chatThinkingPrompt === 'string' ? cfg.chatThinkingPrompt.trim() : ''
  if (!body) return ''

  const lines = [body]
  const after = Number(cfg.chatWaitReminderAfter) || 0
  const streak = Number(ctx.silentStreak) || 0
  if (after > 0 && streak >= after && cfg.chatWaitReminder) {
    lines.push('', String(cfg.chatWaitReminder).trim())
  }
  if (cfg.chatNoReplyHint) {
    lines.push('', String(cfg.chatNoReplyHint).trim())
  }
  return lines.join('\n')
}

/**
 * 组装全部注入块。
 *
 * @param {object} params
 * @param {object} params.cfg 归一化设定
 * @param {string} [params.temporaryStyle]
 * @param {Array} [params.expressions]
 * @param {Array} [params.jargon]
 * @param {Array} [params.impressions]
 * @param {object|null} [params.mood]
 * @param {string} [params.profileText] 完整人物画像文本
 * @param {{isFirstStep?: boolean, silentStreak?: number}} [params.thinkingCtx] 对话思维链上下文
 * @returns {Array<{name: string, text: string}>} 待 push 的块
 */
export function buildSections({ cfg, temporaryStyle, expressions, jargon, impressions, mood, profileText, thinkingCtx }) {
  const sections = []
  // 显式判否而不是 `!cfg.enabled`：设定里缺字段时应默认「开启」，
  // 否则一次写入漏字段就让整个插件静默失效。
  if (cfg.enabled === false) return sections

  if (cfg.injectPersona) {
    const text = renderPersona(cfg)
    if (text) sections.push({ name: 'maidsh:persona', text })
  }
  // 思维链紧跟人格：它是「本轮怎么想」的框架，应排在风格/背景之前先定调。
  if (cfg.chatThinkingChain === true) {
    const text = renderThinkingChain(cfg, thinkingCtx)
    if (text) sections.push({ name: 'maidsh:thinking-chain', text })
  }
  if (cfg.injectReplyStyle) {
    const text = renderReplyStyle(cfg, temporaryStyle)
    if (text) sections.push({ name: 'maidsh:reply-style', text })
  }
  if (cfg.injectExpressions) {
    const text = renderExpressionHabits(expressions)
    if (text) sections.push({ name: 'maidsh:expression-habits', text })
  }
  if (cfg.injectMood) {
    const text = renderMood(mood)
    if (text) sections.push({ name: 'maidsh:mood', text })
  }
  if (cfg.injectImpression) {
    const text = renderImpressions(impressions)
    if (text) sections.push({ name: 'maidsh:impression', text })
  }
  if (cfg.injectJargon) {
    const text = renderJargon(jargon)
    if (text) sections.push({ name: 'maidsh:jargon', text })
  }
  if (cfg.injectProfile) {
    // 画像放最后：它是背景信息，越靠近回复指令越容易被当成立即要执行的事。
    const text = renderProfile(profileText, cfg.profileRecentLimit)
    if (text) sections.push({ name: 'maidsh:profile', text })
  }
  if (cfg.injectReplyStyle) {
    // 锚点必须排在最末，理由见 renderAnchor。
    const text = renderAnchor(cfg)
    if (text) sections.push({ name: 'maidsh:anchor', text })
  }

  // 统一做 `{{` 转义（宿主严格插值），且只改注入副本。
  return sections.map((s) => ({ name: s.name, text: escapePromptBraces(s.text) }))
}
