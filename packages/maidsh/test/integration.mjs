/**
 * maidsh 离线集成测试 —— 用真实会话事件形状驱动 apply()。
 *
 * 为什么要有这个文件：宿主里「用户消息 → 学一轮 → 注入」这条链只有等真人说话
 * 才会跑，开发期无法随时验证。这里把 `session/event` 的真实形状（从
 * sessions/*.jsonl.zstd 实测得到，见下方 SOURCE 注释）喂进插件，用替身 ctx
 * 顶掉 webServer / llm，跑通全链路。
 *
 * 跑法：node test/integration.mjs
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// DSH_HOME 必须在 import 插件之前设好 —— store.js / settings.js 在模块顶层读它
const home = mkdtempSync(join(tmpdir(), 'maidsh-it-'))
process.env.DSH_HOME = home

const plugin = await import('../index.js')
const store = await import('../lib/store.js')
const settingsMod = await import('../lib/settings.js')

/**
 * 真实事件形状（实测自 session.v4.jsonl.zstd）：
 *   user/message      { source: { kind: 'user' | 'runtime-context' | 'time-context' | 'skill-catalog', ... },
 *                       content: [{ type: 'text', text }] }
 *   assistant/message { message: { content: [{ type: 'text', text }] } }
 */
function userEvent(text, kind = 'user') {
  return { type: 'user/message', seq: 0, time: Date.now(), data: { source: { kind }, content: [{ type: 'text', text }] } }
}
function assistantEvent(text) {
  return { type: 'assistant/message', seq: 0, time: Date.now(), data: { message: { content: [{ type: 'text', text }] } } }
}

/** 替身 ctx：收集监听器，记录 effect，顶掉 llm / webServer。 */
function makeCtx({ replies }) {
  const listeners = new Map()
  const registered = []
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect: (fn) => { fn() },
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    get: (name) => {
      if (name === 'llm') {
        return {
          resolveCallConfig: async (o) => ({ ...o }),
          prepareCall: async () => ({
            stream: async function* (args) {
              // ⚠️ 替身必须和真宿主一样挑剔，否则测不出真问题：
              // 宿主派发前跑 `assertSupportedHistory()`，里面是
              // `message.content.some(...)`（dsh-llm-pi-ai/lib/index.js:1184）。
              // 这里若宽容地接受字符串，就永远发现不了
              // 「content.some is not a function」——线上已经栽过一次。
              for (const m of args.messages) {
                assert.ok(Array.isArray(m.content), '消息 content 必须是内容块数组（宿主断言要求）: ' + typeof m.content)
                for (const block of m.content) {
                  assert.equal(block.type, 'text', 'text 块必须有 type: text')
                  assert.equal(typeof block.text, 'string', 'text 块必须有字符串 text')
                }
              }
              const prompt = args.messages[0].content.map((b) => b.text).join('\n')
              yield { type: 'text-delta', text: replies(prompt) }
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }),
        }
      }
      if (name === 'webServer') {
        return { register: (route) => { registered.push(route); return () => {} } }
      }
      return undefined
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    __listeners: listeners,
    __registered: registered,
  }
  return ctx
}

/** 按提示词特征回不同内容（模拟真实模型）。 */
function defaultReplies(prompt) {
  if (prompt.includes('人物画像')) {
    return JSON.stringify({
      identity_settings: ['是前端工程师'],
      relationship_settings: [],
      stable_facts: ['在做一个叫 DSH 的项目'],
      interaction_preferences: ['喜欢短回复'],
      recent_interactions: [],
      uncertain_notes: ['最近在忙'],
    })
  }
  if (prompt.includes('suitable')) return '[{"suitable":true,"reason":"日常"}]'
  if (prompt.includes('situation') && prompt.includes('style')) {
    return '[{"situation":"被夸的时候","style":"啊这，也不至于"}]'
  }
  if (prompt.includes('黑话')) return '[{"content":"yyds"}]'
  return '用户在开发一个 DSH 人格插件。'
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

// ── 1. 注册了哪些扩展点 ──────────────────────────────────────────────
test('注册 system-prompt/assemble 与 session/event 监听', () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  assert.equal(typeof ctx.__listeners.get('session/event'), 'function')
  assert.equal(typeof ctx.__listeners.get('system-prompt/assemble'), 'function')
})

test('注册 /maidsh 面板与 /maidsh-api 两条路由', () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const paths = ctx.__registered.map((r) => r.path)
  assert.ok(paths.includes('/maidsh'), '面板路由缺失')
  assert.ok(paths.includes('/maidsh-api'), 'API 路由缺失')
})

// ── 2. 事件过滤：只有真用户输入才算 ──────────────────────────────────
test('runtime-context / time-context / skill-catalog 不计入用户消息', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const fire = ctx.__listeners.get('session/event')
  const session = { id: 'sess-filter' }
  const before = store.readCounter(store.openStore(), 'user_messages')
  fire(session, userEvent('上下文注入', 'runtime-context'))
  fire(session, userEvent('时间注入', 'time-context'))
  fire(session, userEvent('技能目录', 'skill-catalog'))
  const after = store.readCounter(store.openStore(), 'user_messages')
  assert.equal(after, before, '注入类消息不该计入用户消息数')
})

test('relay（子代理/委派）消息不计入用户消息', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const fire = ctx.__listeners.get('session/event')
  const session = { id: 'sess-relay' }
  const before = store.readCounter(store.openStore(), 'user_messages')
  fire(session, { type: 'user/message', data: { source: { kind: 'user', form: 'relay' }, content: [{ type: 'text', text: '转发的' }] } })
  const after = store.readCounter(store.openStore(), 'user_messages')
  assert.equal(after, before, 'relay 消息不该计入')
})

test('真用户消息计入计数并推进心情', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const fire = ctx.__listeners.get('session/event')
  const db = store.openStore()
  const before = store.readCounter(db, 'user_messages')
  fire({ id: 'sess-mood' }, userEvent('笑死我了哈哈哈哈，这也太强了吧'))
  const after = store.readCounter(db, 'user_messages')
  assert.equal(after, before + 1, '真用户消息应 +1')
  const timeline = store.moodTimeline(db, 5)
  assert.ok(timeline.length > 0, '应记下心情')
  assert.equal(timeline[0].mood, 'happy')
})

// ── 3. 注入块 ────────────────────────────────────────────────────────
test('system-prompt/assemble 注入人格块且块名正确', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const assembly = { contexts: [] }
  let called = false
  await assemble(assembly, { agent: { session: { id: 'sess-inject' } } }, () => { called = true })
  assert.ok(called, '必须调用 next()，否则整轮请求挂起')
  const names = assembly.contexts.map((c) => c.name)
  assert.ok(names.includes('maidsh:persona'), '缺人格块: ' + names.join(','))
  assert.ok(names.includes('maidsh:reply-style'), '缺表达风格块')
  const persona = assembly.contexts.find((c) => c.name === 'maidsh:persona')
  assert.ok(persona.text.includes('麦麦'), '人格块应含昵称')
  // 锚点必须压在最后：越靠近生成的内容越不容易被稀释
  assert.equal(names[names.length - 1], 'maidsh:anchor', '风格锚点应排在最后: ' + names.join(','))
  const anchor = assembly.contexts[names.length - 1]
  assert.ok(anchor.text.includes('不要列表'), '锚点应复述排版禁令')
})

test('注入文本不含裸 {{ （否则宿主插值抛错）', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const assembly = { contexts: [] }
  await assemble(assembly, { agent: { session: { id: 'sess-brace' } } }, () => {})
  for (const c of assembly.contexts) {
    assert.ok(!/(^|[^{])\{\{/.test(c.text), `块 ${c.name} 含裸 {{`)
  }
})

test('画像存在时注入 maidsh:profile 块，且块内不含维护备注', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  await plugin.apply(ctx)
  const db = store.openStore(join(home, 'maidsh', 'maidsh.db'))
  const profile = await import('../lib/profile.js')
  store.upsertProfile(db, {
    personId: 'local-user',
    profileText: profile.buildStructuredProfileText({
      personId: 'local-user',
      primaryName: '用户',
      identitySettings: ['是前端工程师'],
      interactionPreferences: ['喜欢短回复'],
    }),
    sourceNote: 'manual',
  })

  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const assembly = { contexts: [] }
  await assemble(assembly, { agent: { session: { id: 'sess-profile' } } }, () => {})
  const block = assembly.contexts.find((c) => c.name === 'maidsh:profile')
  assert.ok(block, '必须注入 maidsh:profile 块')
  assert.ok(block.text.includes('前端工程师'))
  assert.ok(block.text.includes('喜欢短回复'))
  assert.ok(!block.text.includes('维护备注'), '维护备注不得进注入')
  assert.ok(!block.text.includes('{{'), '注入块不得含裸 {{')
})

test('总开关关闭时不注入任何块', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const store2 = settingsMod.createSettingsStore()
  store2.write({ enabled: false })
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const assembly = { contexts: [] }
  await assemble(assembly, { agent: { session: { id: 'sess-off' } } }, () => {})
  assert.equal(assembly.contexts.length, 0, '关闭后不该注入')
  store2.write({ enabled: true })
})

test('注入块每个 step 都 push（同一回合两次装配块数一致）', async () => {
  // 先塞几条表达方式，让「加权抽签」这条路真的被走到 —— 空库时这个用例
  // 测不出抽签是否稳定，等于没测。
  const db0 = store.openStore()
  store.clearTable(db0, 'expressions')
  for (let i = 0; i < 10; i += 1) {
    store.addExpression(db0, { situation: '情境' + i, style: '句式' + i, sourceText: 'x' })
  }
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const a1 = { contexts: [] }
  const a2 = { contexts: [] }
  const host = { agent: { session: { id: 'sess-stable' } } }
  await assemble(a1, host, () => {})
  await assemble(a2, host, () => {})
  assert.equal(a1.contexts.length, a2.contexts.length, '同回合两次装配块数必须一致')
  assert.deepEqual(a1.contexts.map((c) => c.text), a2.contexts.map((c) => c.text), '同回合注入文本必须逐字节稳定')
  store.clearTable(db0, 'expressions')
})

// ── 4. 学习链路 ──────────────────────────────────────────────────────
test('攒够阈值后自动学一轮：表达 / 黑话 / 印象都入库', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const fire = ctx.__listeners.get('session/event')
  const s = settingsMod.createSettingsStore()
  s.write({ learnEvery: 3 })
  const db = store.openStore()
  const expBefore = store.topExpressions(db, 100).length
  const jBefore = store.listJargon(db, 100).length

  fire({ id: 'sess-learn' }, userEvent('你也太强了吧'))
  fire({ id: 'sess-learn' }, assistantEvent('还好吧'))
  fire({ id: 'sess-learn' }, userEvent('yyds 真的'))
  fire({ id: 'sess-learn' }, assistantEvent('这词你也用'))
  fire({ id: 'sess-learn' }, userEvent('绷不住了哈哈哈哈'))
  fire({ id: 'sess-learn' }, assistantEvent('笑死'))
  fire({ id: 'sess-learn' }, userEvent('今天又被拉去开会'))
  fire({ id: 'sess-learn' }, assistantEvent('烦'))
  fire({ id: 'sess-learn' }, userEvent('先不聊了，我去写代码'))
  fire({ id: 'sess-learn' }, assistantEvent('行'))
  // 学习是后台异步（故意不 await），等它跑完
  await new Promise((r) => setTimeout(r, 500))

  assert.ok(store.topExpressions(db, 100).length > expBefore, '应学到表达方式')
  assert.ok(store.listJargon(db, 100).length > jBefore, '应学到黑话')
  assert.ok(store.listImpressions(db, 10).length > 0, '应生成印象')
  s.write({ learnEvery: 20 })
})

test('模型调用失败时不抛进会话（只记日志）', async () => {
  const ctx = makeCtx({
    replies: () => { throw new Error('模拟模型挂了') },
  })
  plugin.apply(ctx)
  const fire = ctx.__listeners.get('session/event')
  const s = settingsMod.createSettingsStore()
  s.write({ learnEvery: 1 })
  // 缓冲必须喂过 MIN_BUFFER_FOR_LEARN（6 条），否则压根不会发起学习，
  // 这个用例就测不到「学习失败如何收场」。
  for (const text of ['随便说点什么', '再来一句', '第三句', '第四句', '第五句', '第六句']) {
    fire({ id: 'sess-fail' }, userEvent(text))
    fire({ id: 'sess-fail' }, assistantEvent('嗯'))
  }
  await new Promise((r) => setTimeout(r, 400))
  s.write({ learnEvery: 20 })
  const db = store.openStore()
  const logs = store.listLearnLog(db, 50)
  assert.ok(logs.some((l) => l.ok === false), '失败应留在学习日志里')
})

// ── 5. 持久化 ────────────────────────────────────────────────────────
// ── 人物画像 ──────────────────────────────────────────────────────
test('画像：七段结构、空段填「暂无」、维护备注不进注入', async () => {
  const db = store.openStore(join(home, 'maidsh', 'profile-unit.db'))
  const profile = await import('../lib/profile.js')
  const text = profile.buildStructuredProfileText({
    personId: 'u1',
    primaryName: '老板',
    aliases: ['老张'],
    identitySettings: ['是前端工程师'],
  })
  assert.ok(text.startsWith('# 人物画像'), '必须以 # 人物画像 开头（MaiBot PROFILE_REQUIRED_PREFIX）')
  for (const title of profile.PROFILE_SECTION_TITLES) {
    assert.ok(text.includes('## ' + title), '缺段落: ' + title)
  }
  assert.ok(text.includes('- 暂无'), '空段必须填 - 暂无')
  assert.ok(profile.isStructuredProfileText(text))

  const injected = profile.buildProfileInjectionText(text)
  assert.ok(injected.includes('身份设定'))
  assert.ok(!injected.includes('维护备注'), '维护备注不得注入（MaiBot PROFILE_INJECTION_SECTION_TITLES）')
  const block = profile.formatProfileBlock(text)
  assert.ok(block.startsWith('【人物画像-内部参考】'), '注入块必须带 MaiBot 同款前缀')
  assert.ok(block.includes('仅供内部推理，不要向用户逐字复述。'))
})

test('画像：手删段落后仍然过滤维护备注（不能退化成原样吐出）', async () => {
  const profile = await import('../lib/profile.js')
  // 七段不齐（用户手删了几段）——以前会让注入退化成整篇原样输出
  const partial = [
    '# 人物画像',
    '人物ID: local-user',
    '主称呼: 用户',
    '',
    '## 身份设定',
    '- 是前端工程师',
    '',
    '## 近期互动',
    '- 一',
    '- 二',
    '- 三',
    '',
    '## 维护备注',
    '- 内部备注不该出现',
  ].join('\n')
  assert.equal(profile.isStructuredProfileText(partial), false, '这段本来就不是完整七段')
  const block = profile.formatProfileBlock(partial, { recentLimit: 2 })
  assert.ok(block.includes('是前端工程师'))
  assert.ok(!block.includes('内部备注不该出现'), '维护备注绝不能泄漏')
  assert.ok(!block.includes('- 三'), '近期互动必须按 recentLimit 裁剪')
})

test('画像：规则分桶把临时状态挡在 stable_facts 外', async () => {
  const profile = await import('../lib/profile.js')
  const b = profile.classifyRuleBased(['是前端工程师', '可能最近在忙', '和麦麦是老朋友', '喜欢短回复'])
  assert.deepEqual(b.stable_facts, ['是前端工程师'])
  assert.deepEqual(b.relationship_settings, ['和麦麦是老朋友'])
  assert.deepEqual(b.interaction_preferences, ['喜欢短回复'])
  assert.ok(b.uncertain_notes.includes('可能最近在忙'), '「可能」类必须进 uncertain_notes')
})

test('画像：模型返回六桶 → 落库并递增版本', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  await plugin.apply(ctx)
  // 独立库文件：别的用例已经在 maidsh.db 里跑过自动学习，会污染版本号
  const db = store.openStore(join(home, 'maidsh', 'version.db'))
  const { learnProfile } = await import('../lib/learner.js')

  const messages = [{ id: 1, role: 'user', text: '我是前端工程师，在做 DSH' }]
  const r1 = await learnProfile(ctx, db, messages, { personId: 'local-user', primaryName: '用户' })
  assert.equal(r1.updated, true)
  assert.equal(r1.version, 1)

  const p = store.getProfile(db, 'local-user')
  assert.ok(p, '画像必须落库')
  assert.ok(p.profileText.includes('是前端工程师'))
  assert.ok(p.profileText.includes('喜欢短回复'))

  // 同一批证据再学一遍：内容没变 → 不推进版本（版本号表示画像变了几次）
  const r2 = await learnProfile(ctx, db, messages, { personId: 'local-user', primaryName: '用户' })
  assert.equal(r2.version, 1, '内容未变时版本号不应递增')

  // 换个证据 → 版本递增，旧版进历史
  const ctx2 = makeCtx({
    replies: () => JSON.stringify({
      identity_settings: ['是前端工程师'],
      relationship_settings: [],
      stable_facts: ['养了一只叫豆豆的猫'],
      interaction_preferences: [],
      recent_interactions: [],
      uncertain_notes: [],
    }),
  })
  const r3 = await learnProfile(ctx2, db, [{ id: 1, role: 'user', text: '我家猫叫豆豆' }], { personId: 'local-user' })
  assert.equal(r3.version, 2, '内容变化时版本必须递增')
  assert.ok(store.getProfile(db, 'local-user').profileText.includes('豆豆'))
  assert.equal(store.profileHistory(db, 'local-user').length, 1, '旧版必须进历史')
})

test('画像：模型明确给空数组时，不被关键词规则塞回去', async () => {
  const profile = await import('../lib/profile.js')
  const fallback = profile.classifyRuleBased(['我家猫叫豆豆'])  // 规则会因「叫」字判成关系
  assert.deepEqual(fallback.relationship_settings, ['我家猫叫豆豆'])
  const merged = profile.mergeClassification(fallback, {
    identity_settings: [],
    relationship_settings: [],   // 模型明确判断：不是关系
    stable_facts: ['养了一只叫豆豆的猫'],
    interaction_preferences: [],
    recent_interactions: [],
    uncertain_notes: [],
  })
  assert.deepEqual(merged.relationship_settings, [], '模型说空就是空')
  assert.deepEqual(merged.stable_facts, ['养了一只叫豆豆的猫'])
})

test('画像：模型挂了用规则回退，画像照样能长', async () => {
  const ctx = makeCtx({ replies: () => { throw new Error('model down') } })
  await plugin.apply(ctx)
  const db = store.openStore(join(home, 'maidsh', 'fallback.db'))
  const { learnProfile } = await import('../lib/learner.js')
  const r = await learnProfile(ctx, db, [{ id: 1, role: 'user', text: '我是前端工程师' }], { personId: 'p2' })
  assert.equal(r.updated, true, '模型失败也必须更新画像')
  assert.ok(store.getProfile(db, 'p2').profileText.includes('是前端工程师'))
})

test('画像：全空结果不覆盖已有画像', async () => {
  const ctx = makeCtx({ replies: () => JSON.stringify({ identity_settings: [], relationship_settings: [], stable_facts: [], interaction_preferences: [], recent_interactions: [], uncertain_notes: [] }) })
  await plugin.apply(ctx)
  const db = store.openStore(join(home, 'maidsh', 'empty.db'))
  const { learnProfile } = await import('../lib/learner.js')
  store.upsertProfile(db, { personId: 'p3', profileText: '# 人物画像\n人物ID: p3', sourceNote: 'manual' })
  const before = store.getProfile(db, 'p3').version
  const r = await learnProfile(ctx, db, [{ id: 1, role: 'user', text: '嗯' }], { personId: 'p3' })
  assert.equal(r.updated, false)
  assert.equal(store.getProfile(db, 'p3').version, before, '空结果不能推进版本号')
})

test('设定落盘后可被新 store 读回', () => {
  const a = settingsMod.createSettingsStore()
  a.write({ nickname: '测试昵称' })
  const b = settingsMod.createSettingsStore()
  assert.equal(b.read().nickname, '测试昵称')
  a.write({ nickname: '麦麦' })
})

test('心情跨进程重启能续上（sessionState 从库里恢复）', async () => {
  const db = store.openStore()
  store.recordMood(db, { session: 'sess-restart', mood: 'angry', intensity: 3, reason: '气死' })
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const assembly = { contexts: [] }
  await assemble(assembly, { agent: { session: { id: 'sess-restart' } } }, () => {})
  const mood = assembly.contexts.find((c) => c.name === 'maidsh:mood')
  assert.ok(mood, '重启后应能从库里恢复心情并注入')
  assert.ok(mood.text.includes('恼'), '恢复的应是 angry: ' + mood.text)
})

// ── 心情判据（弱词/强词）────────────────────────────────────────────
test('心情：普通提问里的疑问词不再被判成「困惑」', async () => {
  const moodMod = await import('../lib/mood.js')
  // 这句曾把「为什么」「？」当强词命中，导致正经提问被注入困惑语气
  assert.equal(moodMod.detectMood('为什么刚刚这几句对话感觉没有起作用？'), null)
  assert.equal(moodMod.detectMood('把规则补强加厚，能优化的优化'), null)
  assert.equal(moodMod.detectMood('？？？'), null, '光秃秃的问号不足以判情绪')
})

test('心情：强词仍然能判出情绪，强度按得分走', async () => {
  const moodMod = await import('../lib/mood.js')
  const happy = moodMod.detectMood('哈哈哈笑死我了')
  assert.equal(happy.mood, 'happy')
  assert.ok(happy.score >= 2, '多个强词应累加得分: ' + happy.score)
  const angry = moodMod.detectMood('好烦啊，这破玩意又崩了')
  assert.equal(angry.mood, 'angry')
  const next = moodMod.advanceMood({ mood: 'happy', intensity: 2, createdAt: Date.now() - 60 * 60 * 1000 }, '今天天气不错')
  assert.notEqual(next.mood, 'calm', '读不出情绪时应沿用旧心情并衰减，而不是清成平静')
})

// ── 表达注入：加权抽签 ────────────────────────────────────────────────
test('表达注入用加权抽签，不是固定排行榜', async () => {
  const db = store.openStore()
  store.clearTable(db, 'expressions')
  for (let i = 0; i < 12; i += 1) {
    store.addExpression(db, { situation: '场景' + i, style: '句式' + i, sourceText: 'x' })
  }
  // 给第 0 条高权重，其余为默认
  const rows = store.topExpressions(db, 100)
  const hot = rows[rows.length - 1]
  for (let i = 0; i < 10; i += 1) store.addExpression(db, { situation: hot.situation, style: hot.style, sourceText: 'x' })

  // 两次抽签应不同（固定排行榜会完全一致）
  const a = store.sampleExpressions(db, 4).map((e) => e.style).join(',')
  const b = store.sampleExpressions(db, 4).map((e) => e.style).join(',')
  assert.notEqual(a, b, '抽签结果不该每次相同: ' + a)

  // 权重映射到 [1,5]：最高不超过最低的 5 倍
  const w = store.computeSamplingWeights(store.topExpressions(db, 100))
  assert.ok(Math.max(...w) <= 5 && Math.min(...w) >= 1, '权重应落在 [1,5]: ' + w.join(','))

  // 高权重的句式在多次抽签里出现率应显著更高
  let hotCount = 0
  for (let i = 0; i < 200; i += 1) {
    if (store.sampleExpressions(db, 3).some((e) => e.style === hot.style)) hotCount += 1
  }
  assert.ok(hotCount > 60, '高权重句式应更常被抽中，实际 ' + hotCount + '/200')
  store.clearTable(db, 'expressions')
})

test('学习阈值计数落库，重启不归零', async () => {
  const db = store.openStore()
  store.setCounter(db, 'since_learn', 7)
  const reopened = store.openStore()
  assert.equal(store.readCounter(reopened, 'since_learn'), 7, '计数应持久化（内存变量重启即丢）')
  store.setCounter(db, 'since_learn', 0)
})

test('学习步骤互相隔离：一步失败不连坐其余步骤', async () => {
  // 只有「表达」那一步的提示词让它抛；其余照常返回。
  // 这条用例是为了守住一个真实事故：原先 runOnce 拿一个大 try 罩住四步，
  // 表达学习一抛，黑话/印象/画像全被跳过，四个子系统一起零产出。
  const ctx = makeCtx({
    replies: (prompt) => {
      if (prompt.includes('situation') && prompt.includes('style')) throw new Error('表达这步坏了')
      return defaultReplies(prompt)
    },
  })
  plugin.apply(ctx)
  const fire = ctx.__listeners.get('session/event')
  const s = settingsMod.createSettingsStore()
  s.write({ learnEvery: 1, learnProfile: false })
  const db = store.openStore()
  store.clearTable(db, 'expressions')
  store.clearTable(db, 'jargon')
  const jBefore = store.listJargon(db, 100).length

  for (const text of ['今天写了半天代码', '又报错了', '哎', '继续弄', '快了', '搞定']) {
    fire({ id: 'sess-isolate' }, userEvent(text))
    fire({ id: 'sess-isolate' }, assistantEvent('嗯'))
  }
  await new Promise((r) => setTimeout(r, 500))
  s.write({ learnEvery: 20, learnProfile: true })

  const logs = store.listLearnLog(db, 50)
  const errs = logs.filter((l) => l.ok === false)
  assert.ok(errs.some((l) => l.detail.includes('表达学习失败')), '失败条目应点名是哪一步: ' + JSON.stringify(errs))
  assert.equal(store.topExpressions(db, 100).length, 0, '表达那步确实失败了，不该有产出')
  assert.ok(store.listJargon(db, 100).length > jBefore, '黑话那步不该被表达的失败连坐')
  store.clearTable(db, 'jargon')
})

// ── 跑 ──────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
// ── 面板与 API（不依赖宿主重启，直接驱动注册进来的 handler）────────────
/** 造一个最小 req/res，喂给 webServer.register 的 handler。 */
function callRoute(route, { method = 'GET', url = route.path, body = null } = {}) {
  const u = new URL('http://127.0.0.1' + url)
  // readBody 走的是 req.on('data'/'end')，所以假 req 得能发事件
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return req
    },
    destroy() {},
  }
  // 异步派发，等 handler 把监听器挂上再发数据
  setImmediate(() => {
    if (body) for (const fn of listeners.get('data') || []) fn(Buffer.from(JSON.stringify(body)))
    for (const fn of listeners.get('end') || []) fn()
  })
  let status = 0
  let payload = ''
  let done = false
  const res = {
    setHeader: () => {},
    writeHead(code) { status = code },
    end(chunk) { if (chunk) payload += String(chunk); done = true },
  }
  // API 路由的 handler 是 `void handleApi(...)`，不等 promise —— 只能等 res.end 被调用
  const settle = (async () => {
    await route.handler(req, res)
    for (let i = 0; i < 200 && !done; i++) await new Promise((r) => setTimeout(r, 5))
  })()
  return settle.then(() => ({
    status,
    text: payload,
    json() { return JSON.parse(payload) },
  }))
}

test('面板路由 /maidsh 返回自包含单页，含人物画像分区', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  await plugin.apply(ctx)
  const route = ctx.__registered.find((r) => r.path === '/maidsh')
  assert.ok(route, '必须注册 /maidsh')
  const r = await callRoute(route)
  assert.equal(r.status, 200)
  assert.ok(r.text.includes('<html'), '必须是完整 HTML')
  assert.ok(r.text.includes('id="profile-text"'), '面板必须有人物画像编辑框')
  assert.ok(r.text.includes('id="btn-profile-save"'), '面板必须有保存按钮')
  assert.ok(!/src="https?:/.test(r.text), '自包含单页不应引外部脚本')
})

test('API：GET view=profile 返回画像与历史，POST 可保存/删除', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  await plugin.apply(ctx)
  const apiRoute = ctx.__registered.find((r) => r.path === '/maidsh-api')
  assert.ok(apiRoute, '必须注册 /maidsh-api')

  // 先塞一份画像
  const db = store.openStore(join(home, 'maidsh', 'maidsh.db'))
  store.upsertProfile(db, {
    personId: 'local-user',
    profileText: '# 人物画像\n人物ID: local-user\n主称呼: 用户\n\n## 身份设定\n- 是前端工程师\n',
    sourceNote: 'manual',
  })

  const got = await callRoute(apiRoute, { url: '/maidsh-api?view=profile' })
  assert.equal(got.status, 200)
  const data = got.json()
  assert.equal(data.ok, true)
  assert.ok(Array.isArray(data.profiles), 'profiles 必须是数组')
  assert.ok(data.profile && data.profile.profileText.includes('前端工程师'), '必须返回画像正文')
  assert.ok(Array.isArray(data.profileHistory), 'profileHistory 必须是数组')
  assert.ok(Number(data.stats.profiles) >= 1, 'stats 必须带 profiles 计数')

  // 保存（面板传 text，API 文档写 profileText —— 两个都得认）
  const saved = await callRoute(apiRoute, {
    method: 'POST',
    body: { op: 'saveProfileText', text: '# 人物画像\n人物ID: local-user\n\n## 身份设定\n- 改过了\n' },
  })
  assert.equal(saved.json().ok, true)
  assert.ok(saved.json().profile.profileText.includes('改过了'))

  // 删除（不传 personId 时回退到设定里的 personId，不能删空字符串）
  const del = await callRoute(apiRoute, { method: 'POST', body: { op: 'deleteProfile' } })
  assert.equal(del.json().ok, true)
  assert.equal(store.getProfile(db, 'local-user'), null, '不传 personId 也必须删掉设定里的那个')
})

test('非回环来源拒绝访问面板（避免局域网里被读到画像）', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  await plugin.apply(ctx)
  const route = ctx.__registered.find((r) => r.path === '/maidsh')
  const u = new URL('http://10.0.0.5' + route.path)
  let status = 0
  const res = { setHeader: () => {}, writeHead: (c) => { status = c }, end: () => {} }
  await route.handler({ method: 'GET', url: route.path, headers: { host: '10.0.0.5:3080' }, socket: { remoteAddress: '10.0.0.5' } }, res)
  assert.ok(status === 403 || status === 404, '非回环来源必须被拒，实际: ' + status)
})

// ── 对话思维链 ─────────────────────────────────────────────────────
test('思维链关闭时：任何 step 都不注入 thinking-chain 块', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const s = settingsMod.createSettingsStore()
  s.write({ chatThinkingChain: false })
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const a1 = { contexts: [] }
  await assemble(a1, { agent: { session: { id: 'sess-think-off' } } }, () => {})
  const names = a1.contexts.map((c) => c.name)
  assert.ok(!names.includes('maidsh:thinking-chain'), '关掉不该有思维链块: ' + names.join(','))
})

test('思维链开启：仅本回合第一步注入，第二步（工具后）不再注入', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const s = settingsMod.createSettingsStore()
  s.write({ chatThinkingChain: true })
  const fire = ctx.__listeners.get('session/event')
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const session = { id: 'sess-think-on' }
  fire(session, userEvent('在吗'))
  const step1 = { contexts: [] }
  await assemble(step1, { agent: { session } }, () => {})
  const step2 = { contexts: [] }
  await assemble(step2, { agent: { session } }, () => {})
  const namesOf = (a) => a.contexts.map((c) => c.name)
  assert.ok(namesOf(step1).includes('maidsh:thinking-chain'), '第一步应有思维链: ' + namesOf(step1).join(','))
  assert.ok(!namesOf(step2).includes('maidsh:thinking-chain'), '第二步不该有思维链: ' + namesOf(step2).join(','))
  // 思维链紧跟人格之后
  assert.equal(namesOf(step1)[1], 'maidsh:thinking-chain', '思维链应排在人格块之后: ' + namesOf(step1).join(','))
})

test('思维链进入下一回合（新的用户消息）后重新注入', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const s = settingsMod.createSettingsStore()
  s.write({ chatThinkingChain: true })
  const fire = ctx.__listeners.get('session/event')
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const session = { id: 'sess-think-turn' }
  fire(session, userEvent('第一句'))
  await assemble({ contexts: [] }, { agent: { session } }, () => {})
  await assemble({ contexts: [] }, { agent: { session } }, () => {}) // 第二动，无思维链
  fire(session, userEvent('第二句'))
  const a = { contexts: [] }
  await assemble(a, { agent: { session } }, () => {})
  assert.ok(a.contexts.map((c) => c.name).includes('maidsh:thinking-chain'), '新回合第一步应重新注入')
})

test('连续沉默达阈值后：下回合第一步注入提醒语', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const s = settingsMod.createSettingsStore()
  s.write({ chatThinkingChain: true, chatWaitReminderAfter: 1, chatWaitReminder: '别已读不回啦' })
  const fire = ctx.__listeners.get('session/event')
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const session = { id: 'sess-think-silent' }
  // 第一回合：用户说话，攒够两步却始终没开口 → 静默一轮
  fire(session, userEvent('喂'))
  await assemble({ contexts: [] }, { agent: { session } }, () => {})
  await assemble({ contexts: [] }, { agent: { session } }, () => {})
  fire(session, { type: 'turn/end', seq: 0, time: Date.now(), data: {} })
  // 第二回合第一步应带提醒
  fire(session, userEvent('还在吗'))
  const a = { contexts: [] }
  await assemble(a, { agent: { session } }, () => {})
  const block = a.contexts.find((c) => c.name === 'maidsh:thinking-chain')
  assert.ok(block, '应有思维链块')
  assert.ok(block.text.includes('别已读不回啦'), '应带沉默提醒: ' + block.text)
})

test('开过口则沉默计数清零，不误报提醒', async () => {
  const ctx = makeCtx({ replies: defaultReplies })
  plugin.apply(ctx)
  const s = settingsMod.createSettingsStore()
  s.write({ chatThinkingChain: true, chatWaitReminderAfter: 1, chatWaitReminder: '别已读不回啦' })
  const fire = ctx.__listeners.get('session/event')
  const assemble = ctx.__listeners.get('system-prompt/assemble')
  const session = { id: 'sess-think-spoke' }
  fire(session, userEvent('喂'))
  await assemble({ contexts: [] }, { agent: { session } }, () => {})
  fire(session, assistantEvent('在呢'))
  fire(session, { type: 'turn/end', seq: 0, time: Date.now(), data: {} })
  fire(session, userEvent('好的'))
  const a = { contexts: [] }
  await assemble(a, { agent: { session } }, () => {})
  const block = a.contexts.find((c) => c.name === 'maidsh:thinking-chain')
  assert.ok(block, '应有思维链块')
  assert.ok(!block.text.includes('别已读不回啦'), '开过口就不该提醒: ' + block.text)
})

for (const t of tests) {
  try {
    await t.fn()
    console.log('  ✓ ' + t.name)
    pass += 1
  } catch (error) {
    console.log('  ✗ ' + t.name)
    console.log('      ' + ((error && error.message) || String(error)))
    fail += 1
  }
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

