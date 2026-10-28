/**
 * maidsh — DSH 插件设定页（Client 半边）。
 *
 * 以 dsh.client bundle 格式加载（与 dsh-meme / dsh-ssh 同款）：注册
 * `settings.section`「人格」页，承载**必须设定项**（要求二）。
 *
 * 为什么必须项放这里而不是独立 WebUI：这些是「改了就立刻改变说话观感」的开关，
 * 用户会想在最顺手的地方调 —— DSH 设置页就是那个地方。独立 WebUI（/maidsh）
 * 只放**看的东西**：表达库、黑话表、心情时间线、学习日志、统计。
 *
 * 数据走宿主 HTTP API（/maidsh-api，静态、重启不丢）。
 * 注册 id 必须等于 loader entry 名（maidsh），否则 ModuleLoader 报
 * "loaded without registering maidsh"。
 */
window.__ModuleLoader__.load({
  id: 'maidsh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const API = '/maidsh-api'

    const CSS = [
      '.ms-panel{display:flex;flex-direction:column;gap:16px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.ms-panel .ms-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em;margin:2px 0 -6px}',
      '.ms-panel .ms-field{display:flex;flex-direction:column;gap:6px}',
      '.ms-panel .ms-field > label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ms-panel .ms-hint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.8;line-height:1.5}',
      '.ms-panel input[type=text],.ms-panel input[type=number],.ms-panel select,.ms-panel textarea{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none;transition:border-color .12s ease;font-family:inherit}',
      '.ms-panel input[type=text]:focus,.ms-panel input[type=number]:focus,.ms-panel textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.ms-panel textarea{resize:vertical;line-height:1.6}',
      '.ms-panel button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;transition:border-color .12s ease,background .12s ease}',
      '.ms-panel button:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.ms-panel button:disabled{opacity:.5;cursor:default}',
      '.ms-panel button.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.ms-panel .ms-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.ms-panel .ms-toggles{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}',
      '.ms-panel .ms-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}',
      '.ms-panel .ms-switch{position:relative;width:34px;height:19px;border-radius:999px;background:var(--dsw-alias-border-l1);transition:background .15s ease;flex:none}',
      '.ms-panel .ms-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .15s ease}',
      '.ms-panel .ms-switch.on{background:var(--dsw-alias-brand-primary)}',
      '.ms-panel .ms-switch.on::after{transform:translateX(15px)}',
      '.ms-panel .ms-saved{font-size:12px;color:var(--dsw-alias-brand-primary)}',
      '.ms-panel .ms-err{font-size:12px;color:#e5484d}',
      '.ms-panel .ms-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-1)}',
      '.ms-panel a{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.ms-panel a:hover{text-decoration:underline}',
    ].join('\n')

    const TOGGLES = [
      ['enabled', '总开关', '关掉即完全回到 DSH 原生行为'],
      ['injectPersona', '注入人格', '名字 / 性格 / 行为风格'],
      ['injectReplyStyle', '注入表达风格', '口语化要求 + 备用风格抽签'],
      ['injectExpressions', '注入学到的口癖', '「当 A 时可以用 B」清单'],
      ['injectMood', '注入心情', '按关键词推进的情绪状态'],
      ['injectImpression', '注入聊天印象', '最近对话的自然语言概括'],
      ['injectJargon', '注入黑话表', '让模型看得懂圈内说法'],
      ['injectProfile', '注入人物画像', '这人是谁：身份/关系/偏好/雷点'],
      ['chatThinkingChain', '对话思维链', '对话先判断再动手（仿 maibot planner），其他场景照旧原生链'],
    ]

    const LEARN_TOGGLES = [
      ['learning', '启用学习', '后台从真实对话里学，不阻塞回复'],
      ['learnExpressions', '学表达方式', 'MaiBot learn_style'],
      ['learnJargon', '学黑话', 'MaiBot learn_jargon'],
      ['learnImpression', '生成聊天印象', 'MaiBot heuristic_memory_impression'],
      ['learnProfile', '更新人物画像', '七段结构化画像，跨会话累积'],
    ]

    /** 统一的后端调用。 */
    async function api(body, method) {
      const res = await fetch(API, method === 'GET' ? { method: 'GET' } : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const data = await res.json().catch(() => ({ ok: false, error: '响应不是 JSON' }))
      if (!data || data.ok === false) throw new Error((data && data.error) || '请求失败')
      return data
    }

    function Switch({ on, onChange }) {
      return React.createElement('span', {
        className: 'ms-switch' + (on ? ' on' : ''),
        onClick: () => onChange(!on),
      })
    }

    function Field({ label, hint, children }) {
      return React.createElement('div', { className: 'ms-field' },
        React.createElement('label', null, label),
        children,
        hint ? React.createElement('div', { className: 'ms-hint' }, hint) : null,
      )
    }

    function MaidshPanel() {
      const [s, setS] = React.useState(null)
      const [defaults, setDefaults] = React.useState(null)
      const [error, setError] = React.useState('')
      const [saved, setSaved] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        api(null, 'GET')
          .then((d) => { setS(d.settings); setDefaults(d.defaults) })
          .catch((e) => setError(e.message))
      }, [])

      const set = (patch) => { setS((prev) => ({ ...prev, ...patch })); setSaved(false) }

      async function save() {
        setBusy(true)
        setError('')
        try {
          const d = await api({ op: 'saveSettings', patch: s })
          setS(d.settings)
          setSaved(true)
          setTimeout(() => setSaved(false), 2500)
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }

      async function reset() {
        if (!window.confirm('恢复全部人格设定为默认值？已学到的口癖和黑话不会被删除。')) return
        setBusy(true)
        try {
          const d = await api({ op: 'resetSettings' })
          setS(d.settings)
          setSaved(true)
          setTimeout(() => setSaved(false), 2500)
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }

      if (!s) {
        return React.createElement('div', { className: 'ms-panel' },
          React.createElement('style', null, CSS),
          React.createElement('div', { className: 'ms-hint' }, error || '加载中…'),
        )
      }

      return React.createElement('div', { className: 'ms-panel' },
        React.createElement('style', null, CSS),

        React.createElement('div', { className: 'ms-hint' },
          '这里改的是「她是谁、怎么说话」。想看她学到了什么，去 ',
          React.createElement('a', { href: '/maidsh', target: '_blank', rel: 'noreferrer' }, '人格面板 /maidsh'),
          '。',
        ),

        React.createElement('div', { className: 'ms-title' }, '身份'),
        React.createElement('div', { className: 'ms-row' },
          React.createElement(Field, { label: '昵称' },
            React.createElement('input', {
              type: 'text', value: s.nickname, style: { width: 180 },
              onChange: (e) => set({ nickname: e.target.value }),
            }),
          ),
          React.createElement(Field, { label: '别名（逗号分隔）' },
            React.createElement('input', {
              type: 'text', value: (s.aliases || []).join('，'), style: { width: 260 },
              onChange: (e) => set({ aliases: e.target.value.split(/[,，\s]+/).filter(Boolean) }),
            }),
          ),
        ),

        React.createElement('div', { className: 'ms-title' }, '人格'),
        React.createElement(Field, {
          label: '人格设定',
          hint: '她是谁、什么性格。默认值来自 MaiBot 的 PersonalityConfig。',
        }, React.createElement('textarea', {
          rows: 3, value: s.personality,
          onChange: (e) => set({ personality: e.target.value }),
        })),
        React.createElement(Field, {
          label: '行为风格',
          hint: '什么时候参与、怎么观察局面、什么时候不说话。',
        }, React.createElement('textarea', {
          rows: 3, value: s.behaviorStyle,
          onChange: (e) => set({ behaviorStyle: e.target.value }),
        })),

        React.createElement('div', { className: 'ms-title' }, '表达'),
        React.createElement(Field, {
          label: '表达风格',
          hint: '平时说话的样子。注入后会压过模型默认的「助手腔」。',
        }, React.createElement('textarea', {
          rows: 3, value: s.replyStyle,
          onChange: (e) => set({ replyStyle: e.target.value }),
        })),
        React.createElement(Field, {
          label: '备用表达风格（每行一条）',
          hint: '按下面的概率临时抽一条注入，只影响一轮回复。',
        }, React.createElement('textarea', {
          rows: 4,
          value: (s.multipleReplyStyle || []).join('\n'),
          onChange: (e) => set({ multipleReplyStyle: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }),
        })),
        React.createElement(Field, {
          label: '临时风格注入概率：' + Math.round((s.multipleProbability || 0) * 100) + '%',
          hint: '0% 表示永远不随机切换。',
        }, React.createElement('input', {
          type: 'range', min: 0, max: 1, step: 0.05, value: s.multipleProbability,
          onChange: (e) => set({ multipleProbability: Number(e.target.value) }),
        })),

        React.createElement('div', { className: 'ms-title' }, '注入开关'),
        React.createElement('div', { className: 'ms-card' },
          React.createElement('div', { className: 'ms-toggles' },
            TOGGLES.map(([key, label, hint]) =>
              React.createElement('div', { key, className: 'ms-toggle', onClick: () => set({ [key]: !s[key] }) },
                React.createElement(Switch, { on: !!s[key], onChange: (v) => set({ [key]: v }) }),
                React.createElement('div', null,
                  React.createElement('div', null, label),
                  React.createElement('div', { className: 'ms-hint' }, hint),
                ),
              ),
            ),
          ),
        ),

        React.createElement('div', { className: 'ms-title' }, '对话思维链'),
        React.createElement('div', { className: 'ms-card' },
          React.createElement(Field, {
            label: '思维链提示词',
            hint: '只在对话回合的第一步注入；工具步骤、子 agent 不套这层。默认文案迁移自 MaiBot maisaka planner（先判断局面、再决定动不动手）。',
          }, React.createElement('textarea', {
            rows: 6, value: s.chatThinkingPrompt,
            onChange: (e) => set({ chatThinkingPrompt: e.target.value }),
          })),
          React.createElement('div', { className: 'ms-row' },
            React.createElement(Field, {
              label: '连续沉默几轮后提醒',
              hint: '连着这么多轮都结束回合没说话，下一轮开场追加一句「别已读不回」。0 = 不提醒。',
            }, React.createElement('input', {
              type: 'number', min: 0, max: 50, value: s.chatWaitReminderAfter, style: { width: 90 },
              onChange: (e) => set({ chatWaitReminderAfter: Number(e.target.value) }),
            })),
          ),
        ),

        React.createElement('div', { className: 'ms-title' }, '学习'),
        React.createElement('div', { className: 'ms-card' },
          React.createElement('div', { className: 'ms-toggles' },
            LEARN_TOGGLES.map(([key, label, hint]) =>
              React.createElement('div', { key, className: 'ms-toggle', onClick: () => set({ [key]: !s[key] }) },
                React.createElement(Switch, { on: !!s[key], onChange: (v) => set({ [key]: v }) }),
                React.createElement('div', null,
                  React.createElement('div', null, label),
                  React.createElement('div', { className: 'ms-hint' }, hint),
                ),
              ),
            ),
          ),
          React.createElement('div', { className: 'ms-row' },
            React.createElement(Field, {
              label: '每多少条用户消息学一轮',
              hint: 'MaiBot 按消息数触发学习的等价物。计数落库，重启不清零；缓冲不足 6 条时先攒着不学。',
            }, React.createElement('input', {
              type: 'number', min: 1, max: 200, value: s.learnEvery, style: { width: 100 },
              onChange: (e) => set({ learnEvery: Number(e.target.value) }),
            })),
            React.createElement(Field, { label: '学习请求 maxTokens' },
              React.createElement('input', {
                type: 'number', min: 200, max: 8000, step: 100, value: s.learnMaxTokens, style: { width: 120 },
                onChange: (e) => set({ learnMaxTokens: Number(e.target.value) }),
              }),
            ),
          ),
        ),

        React.createElement('div', { className: 'ms-title' }, '注入预算'),
        React.createElement('div', { className: 'ms-row' },
          React.createElement(Field, { label: '口癖条数' },
            React.createElement('input', {
              type: 'number', min: 1, max: 30, value: s.expressionLimit, style: { width: 90 },
              onChange: (e) => set({ expressionLimit: Number(e.target.value) }),
            }),
          ),
          React.createElement(Field, { label: '黑话条数' },
            React.createElement('input', {
              type: 'number', min: 1, max: 60, value: s.jargonLimit, style: { width: 90 },
              onChange: (e) => set({ jargonLimit: Number(e.target.value) }),
            }),
          ),
          React.createElement(Field, { label: '印象条数' },
            React.createElement('input', {
              type: 'number', min: 0, max: 10, value: s.impressionLimit, style: { width: 90 },
              onChange: (e) => set({ impressionLimit: Number(e.target.value) }),
            }),
          ),
          React.createElement(Field, { label: '画像近期互动条数' },
            React.createElement('input', {
              type: 'number', min: 0, max: 6, value: s.profileRecentLimit, style: { width: 90 },
              onChange: (e) => set({ profileRecentLimit: Number(e.target.value) }),
            }),
          ),
        ),

        React.createElement('div', { className: 'ms-title' }, '人物画像'),
        React.createElement('div', { className: 'ms-hint' },
          '画像记录「这个人是谁」（身份/关系/偏好/雷点），跨会话累积；聊天印象只记「最近在聊什么」。画像正文在 /maidsh 面板里编辑。'),
        React.createElement('div', { className: 'ms-row' },
          React.createElement(Field, { label: '画像主体 ID', hint: 'DSH 是单用户场景，一般不用改。' },
            React.createElement('input', {
              type: 'text', value: s.profilePersonId, style: { width: 160 },
              onChange: (e) => set({ profilePersonId: e.target.value }),
            }),
          ),
          React.createElement(Field, { label: '主称呼', hint: '写进画像头部的称呼。' },
            React.createElement('input', {
              type: 'text', value: s.profilePrimaryName, style: { width: 140 },
              onChange: (e) => set({ profilePrimaryName: e.target.value }),
            }),
          ),
        ),

        React.createElement('div', { className: 'ms-row' },
          React.createElement('button', { className: 'primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存'),
          React.createElement('button', { onClick: reset, disabled: busy }, '恢复默认'),
          saved ? React.createElement('span', { className: 'ms-saved' }, '已保存') : null,
          error ? React.createElement('span', { className: 'ms-err' }, error) : null,
        ),
        React.createElement('div', { className: 'ms-hint' },
          '保存后下一轮对话立即生效（宿主每轮重新读取设定，不需要重启）。',
        ),
      )
    }

    const inject = ['slots', 'workspaces']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'maidsh', order: 26, label: '人格' },
        () => React.createElement(MaidshPanel, null),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { api, TOGGLES, LEARN_TOGGLES }
    return module.exports
  },
})
