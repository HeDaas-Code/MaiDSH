/**
 * maidsh 文本工具 —— 注入安全相关的单点。
 *
 * 宿主（dsh-agent-loop 的 RuntimeContextProjection）会把 assembly.contexts 拼成
 * 一段运行时上下文文本，并对它做严格的 `{{variable}}` 插值：裸 `{{` 会让该轮
 * 请求整体抛错，会话直接不可用（dsh-memory issue #16 同款事故）。
 *
 * 因此：**库内原文保真，只改注入副本**。这里把「打断裸 `{{`」收成一个函数，
 * 所有注入路径都必须过它。
 */

/**
 * 打断文本里的裸 `{{`，让它不构成模板插值起点。
 *
 * 做法是在两个花括号之间插入一个零宽空格（U+200B），视觉上不可见、不影响模型
 * 理解，但字符串层面不再匹配 `{{`。用零宽字符而不是插入可见字符，是因为人格
 * 文本可能被原样抄进回复，可见的插桩会污染输出。
 *
 * @param {string} text
 * @returns {string}
 */
export function escapePromptBraces(text) {
  const s = String(text ?? '')
  if (!s.includes('{{')) return s
  return s.replace(/\{\{/g, '{\u200b{')
}

/**
 * 单行化：把换行与连续空白压成一个空格（用于把用户文本塞进一行提示词）。
 * @param {string} text
 * @param {number} [max]
 */
export function oneLine(text, max = 400) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

/**
 * 从 content blocks 里抽纯文本（DSH 消息体是 block 数组）。
 * 与 dsh-memory `lib/hooks.js:70 extractText` 同义。
 *
 * @param {Array<{type?: string, text?: string}>} blocks
 */
export function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}
