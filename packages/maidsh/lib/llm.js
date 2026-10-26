/**
 * maidsh 的模型调用薄封装 —— 复用 DSH 已有的 LLM 服务，不自己接 HTTP。
 *
 * 复用的能力（要求一：能复用的直接复用）：
 *   · `ctx.get('llm')`：DSH 的统一 LLM 服务（provider 路由、鉴权、重试都在里面）
 *   · `ctx.agentDefaultModel.currentSelection()`：当前会话默认模型
 *   · `llm.resolveCallConfig()` + `llm.prepareCall()`：与宿主同一套调用准备流程
 *     （必须先 materialize 默认配置，否则 stream 时报
 *     "prepared LLM call config changed before adapter dispatch" —— dsh-meme 踩过）
 *
 * 因此本模块只负责「拼消息、收文本、容错解析」，不做 provider 适配。
 */

/**
 * 调一次模型，收集纯文本输出。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} prompt 用户消息
 * @param {{maxTokens?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<string>} 正文文本（不含 reasoning）
 */
export async function callModel(ctx, prompt, opts = {}) {
  const llm = ctx.get('llm')
  if (!llm) throw new Error('LLM 服务不可用')
  const sel = ctx.agentDefaultModel && typeof ctx.agentDefaultModel.currentSelection === 'function'
    ? ctx.agentDefaultModel.currentSelection()
    : null
  const provider = sel && sel.provider
  const model = sel && sel.model
  if (!provider || !model) throw new Error('未配置默认模型')

  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : 1024
  const base = await llm.resolveCallConfig({ provider, model, maxTokens })
  const prepared = await llm.prepareCall(base)
  let out = ''
  let reason = ''
  for await (const chunk of prepared.stream({ ...base, messages: [{ role: 'user', content: prompt }] })) {
    if (chunk.type === 'text-delta') out += chunk.text
    else if (chunk.type === 'reasoning-delta') reason += chunk.text
    else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
      const failure = chunk.reason.failure
      throw new Error('模型调用失败: ' + ((failure && failure.message) || JSON.stringify(failure)))
    }
  }
  // 思考型模型有时把内容全写在 reasoning 里、正文为空 —— 正文空时退回 reasoning。
  return out.trim() ? out : reason
}

/**
 * 从模型输出里抠出第一个 JSON 值（数组或对象）。
 *
 * 为什么不用 JSON.parse 直接吃：模型常带 ```json 围栏或前后解释，MaiBot 的
 * `expression_utils.py` 也是同样的容错思路（先剥围栏、再找最外层括号）。
 *
 * @param {string} text
 * @param {'array'|'object'} kind
 * @returns {any}
 */
export function parseJsonLoose(text, kind = 'array') {
  const raw = String(text || '')
  const [open, close] = kind === 'array' ? ['[', ']'] : ['{', '}']
  // 先去掉 markdown 代码围栏
  const unfenced = raw.replace(/```(?:json)?/gi, '')
  let start = unfenced.indexOf(open)
  while (start !== -1) {
    // 从最外层括号往前找匹配的闭合（括号计数，忽略字符串内的括号）
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < unfenced.length; i += 1) {
      const ch = unfenced[i]
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === open) depth += 1
      else if (ch === close) {
        depth -= 1
        if (depth === 0) {
          try {
            return JSON.parse(unfenced.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
    start = unfenced.indexOf(open, start + 1)
  }
  throw new Error('模型未返回有效 JSON')
}
