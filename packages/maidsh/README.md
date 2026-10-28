# maidsh

让 DSH 的回复带上**人格设定的拟人感**。机制迁移自 [MaiBot](https://github.com/MaiM-with-u/MaiBot)（麦麦）—— 不是套一层「请扮演某角色」的提示词，而是把 MaiBot 那套**从真实对话里学表达习惯**的闭环搬过来：

```
真实对话 ──▶ 学表达方式 / 学黑话 / 生成聊天印象 ──▶ 落库
   ▲                                                    │
   └──────── 下一轮回复时注入系统提示词 ◀────────────────┘
```

所以用得越久，说话越像「这个用户身边的人」，而不是越用越像客服。

---

## 装了什么

| 位置 | 内容 | 为什么在这 |
|---|---|---|
| **DSH 设置页 → 人格** | 昵称、别名、人格设定、行为风格、表达风格、备用风格、8 个注入开关、5 个学习开关、学习参数、注入预算、画像主体 | **必须设定项**。改完下一轮就生效，用户会想在最顺手的地方调 |
| **`/maidsh` 独立面板** | 统计卡片、表达库、黑话表、心情时间线、聊天印象、**人物画像（可编辑 + 历史版本）**、学习日志、手动投喂、清空 | 面板和仪表盘 —— 看的东西，不该挤在设置页里 |

数据落在 `~/.dsh/maidsh/`：`maidsh.db`（SQLite，学到的东西）+ `settings.json`（人格设定）。

---

## 复用了 DSH 的什么

要求一：能复用的直接复用，不重复造轮子。

| 需要的能力 | 复用的宿主能力 | 而不是 |
|---|---|---|
| 注入系统提示词 | `system-prompt/assemble` waterfall | 改 DSH 源码 / 拼假消息 |
| 感知对话 | `session/event`（`user/message` / `assistant/message`） | 轮询会话文件 |
| 调模型学习 | `ctx.get('llm')` + `ctx.agentDefaultModel.currentSelection()` | 自己接 HTTP 打 provider |
| HTTP 面板与 API | `webServer.register` | 自己起端口 |
| 长期事实记忆 | 已装的 `@furongjun1999/dsh-memory`（灵枢） | 另造一套记忆库 |

**和灵枢的分工**：灵枢管「事实与认知」（谁、什么事、什么关系），maidsh 只管「怎么说话」（表达方式、黑话、心情、印象）。两者互补，不抢地盘。

---

## 从 MaiBot 迁移了什么

| maidsh 模块 | MaiBot 来源 |
|---|---|
| `lib/defaults.js` 人格默认值 | `src/config/official_configs.py:148 PersonalityConfig` |
| `lib/prompts.js` `learnStylePrompt` | `prompts/zh-CN/learn_style.prompt` |
| `lib/prompts.js` `evaluateExpressionsPrompt` | `prompts/zh-CN/expression_evaluation.prompt`（逐条评估 → 批量） |
| `lib/prompts.js` `learnJargonPrompt` | `prompts/zh-CN/learn_jargon.prompt` |
| `lib/prompts.js` `impressionPrompt` | `prompts/zh-CN/heuristic_memory_impression.prompt` |
| `lib/learner.js` 触发与并发闸门 | `src/learners/expression_learner.py`（`ExpressionLearningBatchGate`） |
| `lib/learner.js` JSON 容错解析 | `src/learners/expression_utils.py` |
| `lib/prompt.js` 表达习惯块格式 | `src/chat/replyer/maisaka_expression_selector.py:177`（`- 当"X"时，可以用"Y"来表达。`） |
| 备用风格抽签 | `PersonalityConfig.multiple_probability` |
| `lib/profile.js` 七段人物画像 | `src/A_memorix/core/utils/profile_text.py` + `person_profile_service.py` + `storage/metadata_profile.py` |
| `lib/mood.js` 心情状态机 | **MaiBot 没有**（`heart_flow` 只有计时，无情绪），本插件自建 |

### 人物画像 vs 聊天印象

两个都从对话里长出来，但分工不同，别混：

| | 聊天印象 | 人物画像 |
|---|---|---|
| 回答什么 | 最近这段在聊什么 | **这个人是谁** |
| 生命周期 | 流水，用完即弃 | 账本，跨会话累积 |
| 结构 | 一段自然语言 | 七段（身份/关系/稳定了解/相处偏好/近期互动/不确定信息/维护备注） |
| 注入 | 整段 | 前五段，「维护备注」永不注入，「近期互动」按条数裁剪 |

MaiBot 的画像从「证据池」重建（向量召回 + 关系边 + 记忆特征）；maidsh 没有证据池，改成**增量合并**：把当前画像和新对话一起交给模型，让它输出合并后的六桶。规则分桶（关键词）始终作为 LLM 不可用时的回退，所以模型挂了画像照样能长，只是粗一些。

好感度 / 亲密度**没有迁移** —— MaiBot 本身没有这个概念（全仓 grep `favorab`/`affection`/`intimacy`/`好感` 零命中），不是漏做。

### 有意做的简化

- **召回用关键词 + 加权抽签而非向量**：MaiBot 的 `expression_vector_index.py` 有 3199 行做向量 + BM25 混合召回。在单用户、表达库通常几百条的量级下，加权抽签（`store.sampleExpressions`，等价于 MaiBot `weighted_sampling.py`）已经足够，省掉 embedding 依赖和一份索引。**注入的不是固定排行榜**——每次都重新抽，否则聊久了来来回回就那几句。
- **按用户消息条数触发学习**：MaiBot 按群聊消息条数；DSH 里一个会话就是一条对话流，按用户消息计数更贴合。计数**落库**（`counters.since_learn`），重启不清零。
- **评估批量化**：MaiBot 逐条评估每个候选，这里一次请求评一批，省 token。
- **画像刷新单独节流**：画像是账本，变化慢且一次要一整轮模型调用，所以 10 分钟内不重复刷新（攒够 `learnEvery × 3` 条新消息才提前放行）。

### 几处刻意的「反简化」（踩过坑才加上的）

- **学习阈值持久化**：原先计数在内存变量里，DSH 常被随手重启，于是「聊够 20 条」永远攒不满，学习一次都不触发。
- **缓冲下限 `MIN_BUFFER_FOR_LEARN = 6`**：计数过线但缓冲是空的（刚重启），拿两句话去学只会学到噪声。
- **心情判据分强弱词**：疑问词（`为什么`/`？`）权重 0.35，单靠它们凑不到 `MOOD_MIN_SCORE = 1.0`，正经提问不会再被判成「困惑」。
- **风格锚点压最末**：系统提示词越长，越靠前的内容在生成时越被稀释。末尾一条极短复述（`maidsh:anchor`）专治「一展开就回到助手腔」。

---

## 人格默认值

直接采用 MaiBot 的出厂人格（`PersonalityConfig` 原文）：

- **人格**：是女大学生，现在正在上网聊天。一般不包容且善良，但有时候有点一反常态，表现出锐利攻击性。善于用人类的角度思考问题，聊天比较日常。
- **行为风格**：……（同上，加一句「不会没话题硬找话题，具有足够的自主性」）
- **表达风格**：你的风格平淡简短，可以参考贴吧的回复风格。不滥用比喻或者生硬句子。视情况省略主语或者进行倒装，风格较为随意。
- **备用风格** 5 条，默认注入概率 0%（不随机切换）。

全部可在设置页改。**渲染时会自动剥掉行为风格里与人格重复的前缀**，避免同一句话每轮注入两遍。

---

## 注入的提示词块

每轮装配出这些块（块名可用于排查）：

| 块名 | 内容 | 开关 |
|---|---|---|
| `maidsh:persona` | 名字 + 人格 + 行为风格 + 「你是你自己，不是助手」 | `injectPersona` |
| `maidsh:thinking-chain` | 对话思维链（先判断再动手），**仅本回合第一步注入** | `chatThinkingChain` |
| `maidsh:reply-style` | 表达风格 + 口语化要求 +（可选）本轮备用风格 | `injectReplyStyle` |
| `maidsh:expression-habits` | 学到的「当 A 时可以用 B」清单 | `injectExpressions` |
| `maidsh:mood` | 当前情绪（三档强度，不暴露精确值） | `injectMood` |
| `maidsh:impression` | 最近对话的自然语言印象 | `injectImpression` |
| `maidsh:jargon` | 用户常用的圈内说法 | `injectJargon` |
| `maidsh:profile` | 人物画像前五段（维护备注不注入） | `injectProfile` |
| `maidsh:anchor` | 极短风格复述，**永远排最后** | `injectReplyStyle` |

`maidsh:anchor` 排在最末是有意的：系统提示词越长，越靠前的内容在生成时越被稀释。前面的人格块隔着黑话、心情、画像，等真正落笔时权重已经掉下去了——技术长答尤其明显，一展开就回到「助手腔」。末尾这条只复述三条最容易破的规则（你是本人、不排版、有脾气），成本约 60 token。

`maidsh:profile` 放在锚点之前：它是背景信息，越靠近回复指令越容易被模型当成立即要执行的事。

### 对话思维链（`chatThinkingChain`）

迁移自 MaiBot `prompts/zh-CN/maisaka_chat.prompt` 的 planner 流程：**收到消息先在心里过一遍（什么意思、什么态度、要不要接、怎么接），再决定动手**，而不是一上来就码字。这是「像人聊天」和「客服应答」的分界——人收到消息先想再开口。

只在**对话回合的第一步**注入（`buildSections` 里靠 `thinkingCtx.isFirstStep = step===1` 判定）。工具步骤、子 agent 是「已经动起来之后的执行」，套这层只会干扰它们的推理，所以一直走 DSH 原生链——正好对上「其他时候走正常思维链」的要求。`step` 在每次 `system-prompt/assemble` 自增、`turn/end` 归零。

它真正的内核不是「多说」，是「可以不说话」：判断这步没什么可做的就直接结束回合。为了治「把计划憋成正文」（用一大段话表达「我不打算回复」），块末常挂一条收口提示 `chatNoReplyHint`：不想说就结束，别用一段话表达不想说。连续 `chatWaitReminderAfter` 轮都结束回合没开口，下一轮第一步追加 `chatWaitReminder` 提醒别已读不回——不然「可以不说话」会退化成永远不说话。

两条**宿主契约**（踩过坑，写进代码注释了）：

1. **每个 step 都要 push**，内容相同也要 push。宿主按渲染文本去重 —— 跳过 push 反而会让文本「变了一次又变回来」，多拍两份快照（每份 ~250 token）。
2. 注入文本必须打断裸 `{{`（换 `{\u200b{`），否则宿主严格插值会抛错，该轮请求整体失败。

---

## 安装

本插件是**本地包**，装进 profile 即可（`dsh plugin add` 需要 pnpm，本机没有）：

```bash
P=~/.dsh/profiles/web
cp -r packages/maidsh "$P/node_modules/maidsh"
# 在 $P/package.json 的 dsh.profile.bundles 末尾加 "maidsh"
```

开发时用软链更省事（改完只需重启 DSH，不用再拷）：

```bash
ln -sfn /root/projects/MaiDSH/packages/maidsh "$P/node_modules/maidsh"
```

bundle 自带的 `cordis.patch.yml` 会让 loader 自动 insert 一条 entry（`id: maidsh`）。装完刷新 Web UI。

**依赖**：Node ≥ 22.13（用 `node:sqlite`，无需额外依赖）。前置插件（dsh-memory 等）与本插件互不依赖，但共存效果更好。

---

## 开发

```bash
node test/integration.mjs    # 34 个用例：事件过滤 / 注入块 / 思维链 / 学习链路 / 持久化
```

测试用**真实会话事件的形状**（从 `sessions/*.jsonl.zstd` 实测：`user/message` 的 `source.kind` 有 `user` / `runtime-context` / `time-context` / `skill-catalog` 四种，只有 `user` 才算用户输入）驱动 `apply()`，替身 ctx 顶掉 webServer 与 llm。

## 目录

```
packages/maidsh/
├── index.js          插件入口：事件监听、提示词注入、HTTP 路由
├── client.js         DSH 设置页「人格」（必须设定项）
├── webui/index.html  独立面板 /maidsh（自包含单页，无构建链）
├── lib/
│   ├── defaults.js   人格默认值 + 心情词典
│   ├── settings.js   settings.json 读写与类型纠偏
│   ├── store.js      SQLite 存储层（6 张表）
│   ├── prompts.js    MaiBot 提示词（迁移）
│   ├── learner.js    学习调度：缓冲、阈值、并发闸门
│   ├── llm.js        LLM 调用薄封装 + JSON 容错解析
│   ├── mood.js       心情状态机（关键词 → 强度 → 半衰期衰减）
│   ├── prompt.js     注入块渲染
│   └── text.js       花括号转义、取文本、单行化
└── test/integration.mjs
```
