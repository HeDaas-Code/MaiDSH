/**
 * maidsh 学习用提示词 —— 逐字迁移自 MaiBot `prompts/zh-CN/`。
 *
 * 保留原文的理由：这些提示词决定了「学出来的表达长什么样」。自己重写会让输出
 * 风格漂移（比如开始输出长句总结而不是短口癖），而迁移的目标正是复刻那套观感。
 * 唯一的改动是把 `{{...}}` 转义成普通花括号 —— 宿主 system-prompt 对注入文本做
 * 严格 `{{var}}` 插值，裸 `{{` 会让整轮请求抛错（dsh-memory issue #16 同款教训）。
 * 这里 prompt 不经过 system-prompt，但仍统一用单花括号，避免以后被复用时踩坑。
 */

/**
 * 表达方式学习（MaiBot `learn_style.prompt`）。
 * @param {string} chatStr 已格式化的对话文本
 */
export function learnStylePrompt(chatStr) {
  return `${chatStr}
请从上面这段对话中提取用户的语言风格和说话方式。
1. 只考虑文字，不要考虑表情包和图片
2. 不要总结 SELF 的发言，因为这是你自己的发言，不要重复学习你自己的发言
3. 不要涉及具体的人名，也不要涉及具体名词
4. 思考有没有特殊的梗，一并总结成语言风格
5. 例子仅供参考，请严格根据对话内容总结

请总结成如下格式的规律：当 "AAAAA" 时，可以 "BBBBB"。
- AAAAA 表示某个场景，不超过 20 个字
- BBBBB 表示对应的语言风格、特定句式或表达方式，不超过 20 个字
- 表达方式在 3-5 个左右，不要超过 10 个

输出要求：
请仅输出 JSON 数组，不要输出重复内容。每个元素为一个对象，字段名如下：

[
  {"situation": "对某件事表示十分惊叹", "style": "使用 我嘞个xxxx", "id": "3"},
  {"situation": "表示讽刺的赞同", "style": "使用 对对对", "id": "4"},
  {"situation": "游戏相关夸赞", "style": "使用 这么强！", "id": "5"}
]

字段说明：
- situation：表示"在什么情境下"的简短概括（不超过 20 个字）
- style：表示对应的语言风格或常用表达（不超过 20 个字）
- id：该表达方式对应的来源编号，即上方聊天记录中的 id 数字（例如 [id:3] 对应 "3"），请只输出数字本身

输出 JSON：`
}

/**
 * 表达方式适用性评估（MaiBot `expression_evaluation.prompt`，批量化）。
 *
 * 为什么批量：MaiBot 是逐条评估（一条一请求）。在 DSH 里学习是后台任务，
 * 逐条会把一轮学习放大成 N 次请求；改成一次给出候选列表、一次判定，
 * 判定标准与原文一致，只是把 criteria 摊平成一段。
 *
 * @param {Array<{situation: string, style: string}>} candidates
 */
export function evaluateExpressionsPrompt(candidates) {
  const list = candidates
    .map((c, i) => `${i + 1}. 使用条件或使用情景：${c.situation}\n   表达方式或言语风格：${c.style}`)
    .join('\n')
  return `请评估以下表达方式或语言风格以及使用条件或使用情景是否合适。

评估标准：
- 是否是真实可复用的语言风格，而不是一次性的具体内容
- 是否包含具体人名、具体事件细节、具体名词（包含则不合适）
- 是否只是事实知识而非表达方式（是则不合适）
- 是否过于通用、放之四海皆准而没有特色（是则不合适）

待评估列表：
${list}

请仅输出 JSON 数组，元素与输入顺序一一对应：
[{"suitable": true, "reason": "简短理由"}]

请严格按照 JSON 格式输出，不要包含其他内容。`
}

/**
 * 黑话学习（MaiBot `learn_jargon.prompt`）。
 * @param {string} chatStr
 */
export function learnJargonPrompt(chatStr) {
  return `${chatStr}
请从上面这段聊天内容中提取"可能是黑话"的候选项（黑话/俚语/网络缩写/口头禅）。

提取规则：
- 必须为对话中真实出现过的短词或短语
- 必须是你无法理解含义、或者需要当前聊天圈内语境才能理解的词语
- 不要选择含义清晰的普通词语
- 排除：人名、@、表情包/图片中的内容、纯标点、常规功能词（如的、了、呢、啊等）
- 每个词条长度建议 2-8 个字符（不强制），尽量短小
- 请尽量提取所有可能的黑话，最多 30 个
- 只从 USER 来源中提取，不学习机器人的发言、分析、推理或工具调用，不从表情包/图片内容中提取

黑话必须为以下几种类型：
- 由字母构成的，汉语拼音首字母的简写词，例如：nb、yyds、xswl
- 英文词语的缩写，用英文字母概括一个词汇或含义，例如：CPU、GPU、API
- 中文词语的缩写，用几个汉字概括一个词汇或含义，例如：社死、内卷
- 群聊内部反复使用、但脱离上下文不容易理解的短词或短语

输出要求：
请仅输出 JSON 数组，不要输出重复内容。每个元素为一个对象，字段名如下：

[
  {"content": "词条", "id": "12"},
  {"content": "词条2", "id": "5"}
]

字段说明：
- content：黑话候选词条的原文
- id：该黑话对应的来源编号，即上方聊天记录中 [id:3] 的 id 数字，请只输出数字本身

输出 JSON：`
}

/**
 * 聊天印象（MaiBot `heuristic_memory_impression.prompt`）。
 * @param {string} chatIdentity 会话标识描述
 * @param {string} messageWindow 最近消息
 */
export function impressionPrompt(chatIdentity, messageWindow) {
  return `你要为长期记忆自然拉起生成"当前聊天印象"。

请根据当前聊天流信息和最近消息，概括这段对话此刻的整体印象。它不是关键词列表，而是用于语义召回相近记忆的一段自然语言描述。

要求：
1. 聚焦当前正在讨论的话题、氛围、互动关系、被提及的人或旧事件。
2. 如果只是寒暄或没有稳定主题，也要如实说明"当前主要是轻松寒暄/短暂接话"等。
3. 不要添加最近消息中没有依据的新事实。
4. 不要输出 JSON、编号列表或解释说明，只输出一段简洁中文。

当前聊天流：
${chatIdentity}

最近消息：
${messageWindow}`
}
