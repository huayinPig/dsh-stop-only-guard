/**
 * dsh-stop-only-guard 自检脚本（纯离线，不碰 profile 文件）。
 * 运行：node selftest.mjs
 * 依赖：只依赖 node:assert / node:url，不引入任何第三方包。
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const mod = await import(new URL('./index.js', import.meta.url).href)

let passed = 0
const failures = []
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok  ' + name)
  } catch (error) {
    failures.push(name + ' :: ' + (error && error.message ? error.message : String(error)))
    console.log('  FAIL ' + name + ' :: ' + (error && error.message ? error.message : String(error)))
  }
}

function makeCtx() {
  const handlers = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)) },
    on(name, cb) {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(cb)
      return () => {}
    },
  }
  const emit = (name, payload) => {
    for (const cb of handlers.get(name) ?? []) cb(payload)
  }
  return { ctx, handlers, warnings, emit }
}

function makeAgent() {
  const steers = []
  return {
    steers,
    steer(message) {
      steers.push(message)
    },
  }
}

const chunk = (c) => ({ type: 'chunk', chunk: c })
const startFrame = (turn, step) => ({ type: 'start', turn, step })
const endFrame = (kind = 'committed') => ({ type: 'end', outcome: { kind } })

/** 回放一个 attempt：chunks 是 StreamChunk 列表。 */
function playAttempt(emit, agent, { turn = 1, step = 1, chunks = [], outcome = 'committed' }) {
  emit('agent/assistant-stream', { agent, frame: startFrame(turn, step) })
  for (const c of chunks) emit('agent/assistant-stream', { agent, frame: chunk(c) })
  emit('agent/assistant-stream', { agent, frame: endFrame(outcome) })
}

const reasoningOnly = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: '让我想想' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: '让我想想' } },
  { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const textOnly = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '答案是 42' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '答案是 42' } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const toolDeltaOnly = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'c1', name: 'read', argumentsDelta: '{}' },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const textDeltaNoBlockStart = [
  { type: 'text-delta', index: 0, text: '正文' },
  { type: 'finish', reason: { kind: 'stop' } },
]
const finishOnlyEmpty = [{ type: 'finish', reason: { kind: 'stop' } }]
const maxTokens = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'finish', reason: { kind: 'max-tokens' } },
]

function boot(config) {
  const { ctx, handlers, warnings, emit } = makeCtx()
  mod.apply(ctx, config)
  return { handlers, warnings, emit }
}

// ---------------------------------------------------------------- 判定表
ok('classifyAttempt: stop + 只有 reasoning → suspected', () => {
  assert.equal(mod.classifyAttempt({ finishKind: 'stop', hasText: false, hasToolCall: false }).suspected, true)
})
ok('classifyAttempt: stop + 有 text → 放行', () => {
  assert.equal(mod.classifyAttempt({ finishKind: 'stop', hasText: true, hasToolCall: false }).suspected, false)
})
ok('classifyAttempt: stop + 有 tool-call → 放行', () => {
  assert.equal(mod.classifyAttempt({ finishKind: 'stop', hasText: false, hasToolCall: true }).suspected, false)
})
ok('classifyAttempt: tool-calls → 放行', () => {
  assert.equal(mod.classifyAttempt({ finishKind: 'tool-calls', hasText: false, hasToolCall: false }).suspected, false)
})
ok('classifyAttempt: max-tokens → 放行', () => {
  assert.equal(mod.classifyAttempt({ finishKind: 'max-tokens' }).suspected, false)
})
ok('classifyAttempt: 无 finish（null）→ 放行', () => {
  assert.equal(mod.classifyAttempt({ finishKind: null }).suspected, false)
})

// ---------------------------------------------------------------- 主路径
ok('[1] 只思考 + stop → 注入一条合法 UserMessage', () => {
  const { emit } = boot({ enabled: true })
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 7, step: 3, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent, turn: 7, signal: { aborted: false } })
  assert.equal(agent.steers.length, 1)
  const m = agent.steers[0]
  assert.equal(m.role, 'user')
  assert.deepEqual(m.source, { kind: 'user' })
  assert.equal(typeof m.id, 'string')
  assert.ok(m.id.length > 8)
  assert.equal(m.content.length, 1)
  assert.equal(m.content[0].type, 'text')
  assert.match(m.content[0].text, /\[stop-only-guard\]/)
})

ok('[2] 两次命中 id 不同（inbox 按 id 去重）', () => {
  const { emit } = boot({ enabled: true })
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  playAttempt(emit, agent, { turn: 2, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent, turn: 2, signal: { aborted: false } })
  assert.equal(agent.steers.length, 2)
  assert.notEqual(agent.steers[0].id, agent.steers[1].id)
})

// ---------------------------------------------------------------- 不该救
ok('[3] 有正文 → 不救', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: textOnly })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(agent.steers.length, 0)
})

ok('[4] 只有 tool-call-delta（没有 block-start）→ 不救', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, {
    turn: 1,
    step: 1,
    chunks: [
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'read', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(agent.steers.length, 0)
})

ok('[5] 只有 text-delta（没有 block-start）→ 不救', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: textDeltaNoBlockStart })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(agent.steers.length, 0)
})

ok('[6] tool-calls → 不救', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: toolDeltaOnly })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(agent.steers.length, 0)
})

ok('[7] max-tokens → 不救', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: maxTokens })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(agent.steers.length, 0)
})

ok('[8] signal.aborted → 绝不复活', () => {
  const { emit, warnings } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: true } })
  assert.equal(agent.steers.length, 0)
  assert.ok(warnings.some((w) => w.includes('signal.aborted')))
})

ok('[9] turn 不一致 → 不救', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent, turn: 2, signal: { aborted: false } })
  assert.equal(agent.steers.length, 0)
})

ok('[10] outcome=abandoned → 不救', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningOnly, outcome: 'abandoned' })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(agent.steers.length, 0)
})

ok('[11] 除 finish 外零内容块 → 救', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 4, step: 2, chunks: finishOnlyEmpty })
  emit('agent/turn-stopping', { agent, turn: 4, signal: { aborted: false } })
  assert.equal(agent.steers.length, 1)
})

// ---------------------------------------------------------------- 上限
ok('[12] maxRemediesPerTurn=3：同一 turn 连 5 次只救 3 次', () => {
  const { emit } = boot({ maxRemediesPerTurn: 3 })
  const agent = makeAgent()
  for (let i = 0; i < 5; i += 1) {
    playAttempt(emit, agent, { turn: 9, step: i + 1, chunks: reasoningOnly })
    emit('agent/turn-stopping', { agent, turn: 9, signal: { aborted: false } })
  }
  assert.equal(agent.steers.length, 3)
})

ok('[13] maxRemediesPerAgent=2：跨 turn 只救 2 次', () => {
  const { emit } = boot({ maxRemediesPerAgent: 2 })
  const agent = makeAgent()
  for (let t = 1; t <= 4; t += 1) {
    playAttempt(emit, agent, { turn: t, step: 1, chunks: reasoningOnly })
    emit('agent/turn-stopping', { agent, turn: t, signal: { aborted: false } })
  }
  assert.equal(agent.steers.length, 2)
})

ok('[14] 0 = 不限', () => {
  const { emit } = boot({ maxRemediesPerTurn: 0, maxRemediesPerAgent: 0 })
  const agent = makeAgent()
  for (let i = 0; i < 6; i += 1) {
    playAttempt(emit, agent, { turn: 1, step: i + 1, chunks: reasoningOnly })
    emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  }
  assert.equal(agent.steers.length, 6)
})

ok('[15] 默认值就是 3 次', () => {
  const { emit } = boot(undefined)
  const agent = makeAgent()
  for (let i = 0; i < 6; i += 1) {
    playAttempt(emit, agent, { turn: 1, step: i + 1, chunks: reasoningOnly })
    emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  }
  assert.equal(agent.steers.length, 3)
})

// ---------------------------------------------------------------- fail-open
ok('[16] enabled:false → 不注册任何监听器', () => {
  const { handlers } = boot({ enabled: false })
  assert.equal(handlers.size, 0)
})

ok('[17] steer 抛错 → 不冒泡，后续轮次仍正常处理', () => {
  const { emit, warnings } = boot({})
  const bad = {
    steer() {
      throw new Error('boom')
    },
  }
  playAttempt(emit, bad, { turn: 1, step: 1, chunks: reasoningOnly })
  assert.doesNotThrow(() => emit('agent/turn-stopping', { agent: bad, turn: 1, signal: { aborted: false } }))
  assert.ok(warnings.some((w) => w.includes('turn-stopping 监听异常')))
  const good = makeAgent()
  playAttempt(emit, good, { turn: 2, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent: good, turn: 2, signal: { aborted: false } })
  assert.equal(good.steers.length, 1)
})

ok('[18] 异常 payload 不崩', () => {
  const { emit } = boot({})
  assert.doesNotThrow(() => emit('agent/assistant-stream', undefined))
  assert.doesNotThrow(() => emit('agent/assistant-stream', { agent: {}, frame: { type: 'chunk' } }))
  assert.doesNotThrow(() => emit('agent/turn-stopping', { agent: {}, turn: 1, signal: { aborted: false } }))
  assert.doesNotThrow(() => emit('agent/turn-stopping', {}))
})

ok('[19] 多 agent 状态隔离（上限各自算）', () => {
  const { emit } = boot({ maxRemediesPerAgent: 1 })
  const a = makeAgent()
  const b = makeAgent()
  playAttempt(emit, a, { turn: 1, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent: a, turn: 1, signal: { aborted: false } })
  playAttempt(emit, b, { turn: 1, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent: b, turn: 1, signal: { aborted: false } })
  assert.equal(a.steers.length, 1)
  assert.equal(b.steers.length, 1)
})

ok('[20] 命中一次后接下来的正常轮次不再干预', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  playAttempt(emit, agent, { turn: 2, step: 1, chunks: textOnly })
  emit('agent/turn-stopping', { agent, turn: 2, signal: { aborted: false } })
  assert.equal(agent.steers.length, 1)
})

ok('[21] pending 只消费一次（重复 turn-stopping 不会二次注入）', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(agent.steers.length, 1)
})

ok('[22] 日志里有命中记录', () => {
  const { emit, warnings } = boot({ log: true })
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 12, step: 3, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent, turn: 12, signal: { aborted: false } })
  assert.ok(warnings.some((w) => w.startsWith('[stop-only-guard] turn 12 step 3 命中')))
})

ok('[23] log:false 不写日志', () => {
  const { emit, warnings } = boot({ log: false })
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningOnly })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(warnings.length, 0)
})

// ---------------------------------------------------------------- 带思考节选（0.2.0）
function reasoningWith(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

ok('[24] 有 reasoning 原文 → 注入文案带 <<< 节选 >>> 和「接着这段」', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningWith('主人问的是文件路径，我应该先确认盘符，再列出目录。') })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(agent.steers.length, 1)
  const text = agent.steers[0].content[0].text
  assert.ok(text.includes('你当时的思考（节选）：'), 'missing header')
  assert.ok(text.includes('\n<<<\n'), 'missing <<<')
  assert.ok(text.includes('\n>>>\n'), 'missing >>>')
  assert.ok(text.includes('主人问的是文件路径，我应该先确认盘符，再列出目录。'), 'missing reasoning body')
  assert.ok(text.trimEnd().endsWith('请接着这段把正文补出来，不要只思考。'), 'missing instruction')
  assert.match(text, /^\[stop-only-guard\]/)
})

ok('[25] 超过 600 字 → 截断到 600 字 + 「…」', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  const long = '甲'.repeat(700)
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningWith(long) })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  const text = agent.steers[0].content[0].text
  const body = text.split('\n<<<\n')[1].split('\n>>>\n')[0]
  assert.equal(body.length, 601, 'expected 600 chars + ellipsis, got ' + body.length)
  assert.ok(body.endsWith('…'))
  assert.equal(body, '甲'.repeat(600) + '…')
})

ok('[26] reasoningExcerptChars 可调（100）', () => {
  const { emit } = boot({ reasoningExcerptChars: 100 })
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningWith('乙'.repeat(500)) })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  const body = agent.steers[0].content[0].text.split('\n<<<\n')[1].split('\n>>>\n')[0]
  assert.equal(body, '乙'.repeat(100) + '…')
})

ok('[27] reasoningExcerptChars=0 → 不带节选，退回默认一句', () => {
  const { emit } = boot({ reasoningExcerptChars: 0 })
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningWith('我本来要说这段') })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  const text = agent.steers[0].content[0].text
  assert.equal(text, '[stop-only-guard] 上一轮你只在思考里走完了、正文是空的。请立刻把要说的话写成正文回复，不要只思考。')
  assert.ok(!text.includes('<<<'))
})

ok('[28] 完全拿不到 reasoning（只有 finish）→ 退回默认一句', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: finishOnlyEmpty })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  const text = agent.steers[0].content[0].text
  assert.equal(text, '[stop-only-guard] 上一轮你只在思考里走完了、正文是空的。请立刻把要说的话写成正文回复，不要只思考。')
})

ok('[29] 只有 block-end（没有 reasoning-delta）→ 用块里的 text 兜底', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, {
    turn: 1,
    step: 1,
    chunks: [
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: '块里的完整思考' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.ok(agent.steers[0].content[0].text.includes('块里的完整思考'))
})

ok('[30] reasoning 只有空白 → 退回默认一句', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningWith('   \n\t  ') })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  const text = agent.steers[0].content[0].text
  assert.ok(!text.includes('<<<'))
  assert.equal(text, '[stop-only-guard] 上一轮你只在思考里走完了、正文是空的。请立刻把要说的话写成正文回复，不要只思考。')
})

ok('[31] 多段 reasoning-delta 会拼起来，换行保留', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  playAttempt(emit, agent, {
    turn: 1,
    step: 1,
    chunks: [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: '第一行' },
      { type: 'reasoning-delta', index: 0, text: '\n第二行：' },
      { type: 'reasoning-delta', index: 0, text: '结论' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  const body = agent.steers[0].content[0].text.split('\n<<<\n')[1].split('\n>>>\n')[0]
  assert.equal(body, '第一行\n第二行：结论')
})

ok('[32] 自定义 steerText 只影响「拿不到 reasoning」时的兜底', () => {
  const withReasoning = boot({ steerText: '自定义短句' })
  const a1 = makeAgent()
  playAttempt(withReasoning.emit, a1, { turn: 1, step: 1, chunks: reasoningWith('有原文') })
  withReasoning.emit('agent/turn-stopping', { agent: a1, turn: 1, signal: { aborted: false } })
  assert.ok(a1.steers[0].content[0].text.includes('<<<'))
  assert.ok(a1.steers[0].content[0].text.includes('有原文'))

  const noReasoning = boot({ steerText: '自定义短句' })
  const a2 = makeAgent()
  playAttempt(noReasoning.emit, a2, { turn: 1, step: 1, chunks: finishOnlyEmpty })
  noReasoning.emit('agent/turn-stopping', { agent: a2, turn: 1, signal: { aborted: false } })
  assert.equal(a2.steers[0].content[0].text, '自定义短句')
})

ok('[33] buildRemedyText 直接调用：有原文 / 无原文 / 0 节选', () => {
  assert.match(mod.buildRemedyText({}, '想说的话'), /<<<\n想说的话\n>>>/)
  assert.equal(
    mod.buildRemedyText({}, ''),
    '[stop-only-guard] 上一轮你只在思考里走完了、正文是空的。请立刻把要说的话写成正文回复，不要只思考。',
  )
  assert.ok(!mod.buildRemedyText({ reasoningExcerptChars: 0 }, '想说的话').includes('<<<'))
  assert.ok(!mod.buildRemedyText({}, undefined).includes('<<<'))
})

ok('[34] 只保留最后一个 stop-only attempt 的 reasoning', () => {
  const { emit } = boot({})
  const agent = makeAgent()
  // 第一步命中（旧 reasoning），被救后第二步又命中（新 reasoning）：turn-stopping 只看新的。
  playAttempt(emit, agent, { turn: 1, step: 1, chunks: reasoningWith('旧的思考内容') })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  playAttempt(emit, agent, { turn: 1, step: 2, chunks: reasoningWith('新的思考内容') })
  emit('agent/turn-stopping', { agent, turn: 1, signal: { aborted: false } })
  assert.equal(agent.steers.length, 2)
  assert.ok(agent.steers[0].content[0].text.includes('旧的思考内容'))
  assert.ok(agent.steers[1].content[0].text.includes('新的思考内容'))
  assert.ok(!agent.steers[1].content[0].text.includes('旧的思考内容'))
})

ok('[35] 命中日志写明带不带节选', () => {
  const a = boot({})
  const ag1 = makeAgent()
  playAttempt(a.emit, ag1, { turn: 1, step: 1, chunks: reasoningWith('有原文') })
  a.emit('agent/turn-stopping', { agent: ag1, turn: 1, signal: { aborted: false } })
  assert.ok(a.warnings.some((w) => w.includes('带思考节选')))

  const b = boot({})
  const ag2 = makeAgent()
  playAttempt(b.emit, ag2, { turn: 1, step: 1, chunks: finishOnlyEmpty })
  b.emit('agent/turn-stopping', { agent: ag2, turn: 1, signal: { aborted: false } })
  assert.ok(b.warnings.some((w) => w.includes('无思考节选')))
})

console.log('')
if (failures.length === 0) {
  console.log('VERDICT: OK — ' + passed + ' 项断言全部通过')
  process.exit(0)
}
console.log('VERDICT: FAIL — ' + failures.length + ' 项失败')
for (const f of failures) console.log('  - ' + f)
process.exit(1)
