/**
 * 人物画像 —— 迁移自 MaiBot `src/A_memorix/core/utils/profile_text.py`
 * 与 `person_profile_service.py` 的画像构建/分桶逻辑。
 *
 * 为什么需要它：表达方式学的是「怎么说」，人物画像记的是「对谁说、这人是谁」。
 * 少了后者，学到的口癖没有作用对象，回复会像在对着空气聊天。
 *
 * 与「聊天印象」（lib/learner.js 的 impression）的分工：
 *   - 印象：一段自由文本，只描述**最近这段对话**在聊什么，用完即弃。
 *   - 画像：七段固定结构，跨会话累积，描述**这个人**（身份/关系/偏好/雷点）。
 *   印象是流水，画像是账本。
 *
 * 固定七段（顺序即注入顺序，勿改）：
 *   身份设定 / 关系设定 / 稳定了解 / 相处偏好 / 近期互动 / 不确定信息 / 维护备注
 */

/** 画像的完整段落（存储与编辑器用）。 */
export const PROFILE_SECTION_TITLES = [
  '身份设定',
  '关系设定',
  '稳定了解',
  '相处偏好',
  '近期互动',
  '不确定信息',
  '维护备注',
]

/** 实际注入到提示词的段落（维护备注不进提示词，那是给人看的）。 */
export const PROFILE_INJECTION_SECTION_TITLES = [
  '身份设定',
  '关系设定',
  '稳定了解',
  '相处偏好',
  '近期互动',
]

export const PROFILE_REQUIRED_PREFIX = '# 人物画像'
export const PROFILE_EMPTY_ITEM = '- 暂无'
export const PROFILE_MAINTENANCE_NOTE = '- 自动画像仅供内部参考；若与当前对话冲突，以当前对话为准。'

/** 六个证据桶的键（LLM 输出与规则回退共用）。 */
export const PROFILE_BUCKETS = [
  'identity_settings',
  'relationship_settings',
  'stable_facts',
  'interaction_preferences',
  'recent_interactions',
  'uncertain_notes',
]

/** 桶键 → 段落标题。 */
export const BUCKET_TO_SECTION = {
  identity_settings: '身份设定',
  relationship_settings: '关系设定',
  stable_facts: '稳定了解',
  interaction_preferences: '相处偏好',
  recent_interactions: '近期互动',
  uncertain_notes: '不确定信息',
}

/** 规范化单条画像要点。原文保留可编辑性：只补一个 `- ` 前缀。 */
export function cleanBullet(value) {
  let text = String(value ?? '').trim()
  if (!text) return ''
  while (text.startsWith('-')) text = text.slice(1).trim()
  if (!text) return ''
  return '- ' + text
}

/** 去重并裁剪要点列表。 */
export function dedupeBullets(values, limit) {
  const bullets = []
  const seen = new Set()
  for (const value of values || []) {
    const bullet = cleanBullet(value)
    if (!bullet || bullet === PROFILE_EMPTY_ITEM) continue
    const key = bullet.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    bullets.push(bullet)
    if (bullets.length >= Math.max(1, Number(limit) || 1)) break
  }
  return bullets
}

/** 段落是否为空（只有 `- 暂无` 也算空）。 */
export function sectionIsEmpty(lines) {
  const items = (lines || []).map((line) => String(line ?? '').trim())
  if (items.length === 0) return true
  return items.every((item) => !item || item === PROFILE_EMPTY_ITEM)
}

/**
 * 构建固定格式的画像文本。
 * @returns {string} 七段完整画像
 */
export function buildStructuredProfileText({
  personId = '',
  primaryName = '',
  aliases = [],
  identitySettings = [],
  relationshipSettings = [],
  stableFacts = [],
  interactionPreferences = [],
  recentInteractions = [],
  uncertainNotes = [],
} = {}) {
  const aliasText = (aliases || [])
    .map((item) => String(item ?? '').trim())
    .filter(Boolean)
    .join('、')

  const sections = {
    身份设定: dedupeBullets(identitySettings, 4),
    关系设定: dedupeBullets(relationshipSettings, 4),
    稳定了解: dedupeBullets(stableFacts, 6),
    相处偏好: dedupeBullets(interactionPreferences, 5),
    近期互动: dedupeBullets(recentInteractions, 3),
    不确定信息: dedupeBullets(uncertainNotes, 3),
    维护备注: [PROFILE_MAINTENANCE_NOTE],
  }

  const lines = [
    PROFILE_REQUIRED_PREFIX,
    `人物ID: ${String(personId || '').trim()}`,
    `主称呼: ${String(primaryName || '').trim()}`,
    `别名: ${aliasText}`,
  ]
  for (const title of PROFILE_SECTION_TITLES) {
    lines.push('', `## ${title}`)
    const sectionLines = sections[title] || []
    lines.push(...(sectionLines.length > 0 ? sectionLines : [PROFILE_EMPTY_ITEM]))
  }
  return lines.join('\n').trim()
}

/** 从可编辑画像文本解析出各段。 */
export function parseProfileSections(profileText) {
  const sections = {}
  let currentTitle = ''
  for (const rawLine of String(profileText || '').split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    const stripped = line.trim()
    if (stripped.startsWith('## ')) {
      const title = stripped.slice(3).trim()
      currentTitle = PROFILE_SECTION_TITLES.includes(title) ? title : ''
      if (currentTitle && !sections[currentTitle]) sections[currentTitle] = []
      continue
    }
    // 空行不进段落：MaiBot 原文会把 "" 也收进数组（靠 section_is_empty 兜住），
    // 这里直接丢弃——面板要按行编辑，空行混进去会让编辑器多出空条目。
    if (currentTitle && stripped) {
      if (!sections[currentTitle]) sections[currentTitle] = []
      sections[currentTitle].push(stripped)
    }
  }
  return sections
}

/** 文本是否符合结构化画像协议。 */
export function isStructuredProfileText(profileText) {
  const text = String(profileText || '').trim()
  if (!text.startsWith(PROFILE_REQUIRED_PREFIX)) return false
  const sections = parseProfileSections(text)
  return PROFILE_SECTION_TITLES.every((title) => title in sections)
}

/** 替换单个段落，保留其余文本（面板编辑器用）。 */
export function replaceProfileSection(profileText, title, newLines) {
  const cleanTitle = String(title || '').trim()
  if (!PROFILE_SECTION_TITLES.includes(cleanTitle)) {
    throw new Error('不支持的人物画像段落: ' + cleanTitle)
  }
  const lines = String(profileText || '').split('\n')
  const out = []
  let index = 0
  let replaced = false
  const replacement = dedupeBullets(newLines, 20)
  if (replacement.length === 0) replacement.push(PROFILE_EMPTY_ITEM)

  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === `## ${cleanTitle}`) {
      out.push(line)
      out.push(...replacement)
      replaced = true
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith('## ')) index += 1
      continue
    }
    out.push(line)
    index += 1
  }

  if (!replaced) {
    if (out.length > 0 && out[out.length - 1].trim()) out.push('')
    out.push(`## ${cleanTitle}`)
    out.push(...replacement)
  }
  return out.join('\n').trim()
}

/**
 * 文本是不是「按画像协议写的」—— 只要出现了 `# 人物画像` 开头，
 * 或任何一个已知 `## 段落名`，就按协议处理。
 *
 * 为什么不复用 isStructuredProfileText：那个要求**七段齐全**。用户在面板里
 * 手删一段（很常见，比如不想要「不确定信息」）后，它就不再是「结构化」，
 * 注入会静默退化成整篇原样吐出 —— 连「维护备注」一起泄漏给模型。
 * 这里放宽到「认得出一段就算协议文本」，让白名单过滤始终生效。
 */
function looksLikeProfileProtocol(text) {
  if (String(text || '').trim().startsWith(PROFILE_REQUIRED_PREFIX)) return true
  return PROFILE_SECTION_TITLES.some((title) => String(text || '').includes('## ' + title))
}

/**
 * 从完整画像构建紧凑注入文本。
 * 只取前五段，「维护备注」不注入；「近期互动」按 recentLimit 裁剪。
 */
export function buildProfileInjectionText(profileText, { recentLimit = 2 } = {}) {
  const text = String(profileText || '').trim()
  if (!text) return ''
  // 完全自由散文（没有画像协议痕迹）就原样注入；否则一律走白名单过滤
  if (!looksLikeProfileProtocol(text)) return text

  const sections = parseProfileSections(text)
  const selected = []
  for (const title of PROFILE_INJECTION_SECTION_TITLES) {
    let lines = sections[title] || []
    if (title === '近期互动') lines = lines.slice(0, Math.max(0, Number(recentLimit) || 0))
    if (sectionIsEmpty(lines)) continue
    selected.push(`## ${title}`, ...lines, '')
  }
  return selected.join('\n').trim()
}

/** 把画像包成给模型的注入块（MaiBot format_persona_profile_block 同款措辞）。 */
export function formatProfileBlock(profileText, opts) {
  const inner = buildProfileInjectionText(profileText, opts)
  if (!inner) return ''
  return `【人物画像-内部参考】\n${inner}\n仅供内部推理，不要向用户逐字复述。`
}

// ────────────────────────────────────────────────────────────────
// 分桶：LLM 分类 + 规则回退（MaiBot person_profile_service.py 同款）
// ────────────────────────────────────────────────────────────────

/** 看起来是「不确定/临时」的内容 —— 绝不能进 stable_facts。 */
export function looksUncertainOrTemporary(text) {
  const content = String(text || '').trim()
  if (!content) return false
  const markers = [
    '可能', '似乎', '好像', '大概', '也许', '疑似', '暂时',
    '今天', '现在', '刚刚', '最近', '计划', '打算',
    '玩笑', '自嘲', '临时',
  ]
  return markers.some((marker) => content.includes(marker))
}

/** 按关键词猜桶（LLM 不可用时的稳定回退）。 */
export function guessBucket(text) {
  const content = String(text || '').trim()
  if (!content) return 'stable_facts'
  if (looksUncertainOrTemporary(content)) return 'uncertain_notes'
  if (['身份', '职业', '工作', '学生', '老师', '作者', '画师', '设定', '角色', '来自'].some((t) => content.includes(t))) {
    return 'identity_settings'
  }
  if (['关系', '朋友', '同事', '群友', '主人', '搭档', '称呼', '叫', '认识'].some((t) => content.includes(t))) {
    return 'relationship_settings'
  }
  if (['喜欢', '讨厌', '偏好', '习惯', '不喜欢', '希望', '雷点', '介意', '更愿意'].some((t) => content.includes(t))) {
    return 'interaction_preferences'
  }
  return 'stable_facts'
}

/** 空桶结构。 */
export function emptyBuckets() {
  const buckets = {}
  for (const key of PROFILE_BUCKETS) buckets[key] = []
  return buckets
}

/**
 * 一条文本够不够格进画像。
 *
 * MaiBot 有上游的证据抽取（A_memorix 向量召回 + 记忆特征）先把废话滤掉，
 * maidsh 没有那一层，规则分桶会把「嗯」「好」「666」直接塞进 stable_facts
 * ——那样画像很快就变成一坨垃圾。这里补一道等价的前置过滤。
 */
const PROFILE_MIN_CHARS = 4
const PROFILE_NOISE = new Set([
  '嗯', '哦', '噢', '啊', '哈', '嘿', '唉', '诶', '欸', '呃', '额', '呀', '哇',
  '好的', '好啊', '好吧', '行', '可以', '收到', '谢谢', '多谢', '辛苦了',
  '你好', '您好', '在吗', '在么', '早上好', '晚上好', '晚安', '早安',
  '哈哈', '哈哈哈', 'hhhh', 'hhh', '笑死', '确实', '是的', '对的', '没错',
  '不知道', '随便', '都行', '再说吧', '算了', '没事', '没有', '有道理',
])

export function isProfileWorthy(text) {
  const content = String(text ?? '').trim()
  if (!content) return false
  // 只按「去掉标点空白后」的长度判断，避免「好的。」这种带标点蒙混过关
  const core = content.replace(/[\s\p{P}\p{S}]/gu, '')
  if (core.length < PROFILE_MIN_CHARS) return false
  if (PROFILE_NOISE.has(core.toLowerCase())) return false
  // 纯重复字符（「哈哈哈哈」「1111」）没有信息量
  if (/^(.)\1+$/u.test(core)) return false
  return true
}

/** 规则分桶：把一串证据文本按关键词归类。 */
export function classifyRuleBased(evidence) {
  const buckets = emptyBuckets()
  for (const item of evidence || []) {
    const text = String(item ?? '').trim()
    if (!isProfileWorthy(text)) continue
    buckets[guessBucket(text)].push(text)
  }
  return buckets
}

/**
 * 合并 LLM 结果与规则回退。
 *
 * 判据是「这个键**在不在** LLM 的输出里」，不是「它的值空不空」：
 *   · LLM 给了这个键（哪怕是空数组）→ 以 LLM 为准，空就是空
 *   · LLM 没给这个键 → 用规则结果兜住
 *
 * 早先写成「LLM 值为空就用规则」是错的：模型判断「这句不该进关系设定」，
 * 结果被关键词规则又塞了回去（「我家猫叫豆豆」因为带个「叫」字被判成关系）。
 * 模型的明确判断优先于关键词猜测。
 */
export function mergeClassification(fallback, llmResult) {
  const buckets = emptyBuckets()
  for (const key of PROFILE_BUCKETS) {
    const llmProvided = !!llmResult && Object.prototype.hasOwnProperty.call(llmResult, key)
    const source = llmProvided ? llmResult[key] : (fallback && fallback[key]) || []
    for (const value of Array.isArray(source) ? source : []) {
      const text = String(value ?? '').trim()
      // LLM 也可能吐废话（尤其模型偷懒时），同一道过滤走两遍
      if (text && isProfileWorthy(text)) buckets[key].push(text)
    }
  }
  return buckets
}

/** 解析 LLM 分类输出（JSON 对象，六个键）。 */
export function parseClassification(raw) {
  const text = String(raw || '').trim()
  if (!text) return {}
  let payload
  try {
    // 复用 llm.js 的宽松解析（会剥 ```json 围栏）
    payload = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''))
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return {}
    try {
      payload = JSON.parse(text.slice(start, end + 1))
    } catch {
      return {}
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {}

  const parsed = {}
  for (const key of PROFILE_BUCKETS) {
    const values = payload[key]
    if (!Array.isArray(values)) continue
    parsed[key] = values.map((item) => String(item ?? '').trim()).filter(Boolean)
  }
  return parsed
}

/**
 * 画像更新提示词。
 *
 * 与 MaiBot 的差异：MaiBot 从「证据池」重建画像（向量召回 + 关系边 + 记忆特征），
 * 这里没有证据池，改成**增量合并** —— 把当前画像和新对话一起给模型，让它输出
 * 合并后的六桶。好处是无需维护证据索引；代价是画像质量依赖上一版，故要求模型
 * 「保留仍然成立的条目」。
 */
export function profileUpdatePrompt({ personId, primaryName, aliases, currentProfile, chatText }) {
  return (
    '你在维护一份关于用户的人物画像。只根据给出的证据整理，不要编造。\n' +
    `人物ID: ${personId}\n` +
    `主称呼: ${primaryName}\n` +
    `别名: ${JSON.stringify(aliases || [])}\n\n` +
    `当前画像（可能为空；其中仍然成立的条目要保留）：\n${currentProfile || '（空）'}\n\n` +
    `新证据（最近的对话，[id:N] 是消息编号，USER 是用户说的，SELF 是麦麦说的）：\n${chatText}\n\n` +
    '分类定义：\n' +
    '- identity_settings: 稳定身份、角色、长期自我描述、重要背景。\n' +
    '- relationship_settings: 与麦麦、同事、朋友、组织、作品角色等长期关系或称呼关系。\n' +
    '- stable_facts: 长期稳定、证据明确的人物事实。\n' +
    '- interaction_preferences: 互动偏好、雷点、沟通习惯、喜欢/讨厌的相处方式。\n' +
    '- recent_interactions: 最近发生、对当前聊天有帮助但不应上升为长期事实的内容。\n' +
    '- uncertain_notes: 证据不足、推测、玩笑、自嘲、临时状态或疑似偏好。\n\n' +
    '要求：\n' +
    '1. 每条内容必须是简短中文陈述句。\n' +
    '2. 不要输出证据编号、hash 或置信度。\n' +
    '3. 临时状态、计划、可能、似乎、玩笑类内容不能归入 stable_facts。\n' +
    '4. 与当前画像冲突时以新证据为准；已被否定的旧条目要删掉。\n' +
    '5. 只输出 JSON 对象，键为上述六类，值为字符串数组。\n' +
    '6. 没有内容的类给空数组。'
  )
}

/** 由六桶构建完整画像文本（供 store 落盘）。 */
export function bucketsToProfileText({ personId, primaryName, aliases, buckets }) {
  return buildStructuredProfileText({
    personId,
    primaryName,
    aliases,
    identitySettings: buckets.identity_settings,
    relationshipSettings: buckets.relationship_settings,
    stableFacts: buckets.stable_facts,
    interactionPreferences: buckets.interaction_preferences,
    recentInteractions: buckets.recent_interactions,
    uncertainNotes: buckets.uncertain_notes,
  })
}
