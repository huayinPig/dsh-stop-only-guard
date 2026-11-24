/**
 * dsh-stop-only-guard — 把「只在思考里走完、正文为空、正常结束」的轮次救回来。
 *
 * 现象（deepseek-flash 偶发）：
 *   一整轮只在 reasoning 通道里输出，最后一个 chunk 是
 *   { "type": "finish", "reason": { "kind": "stop" } }，
 *   assistant/message 的 content 里只有 reasoning 块 —— 没有 text，没有 tool-call。
 *   dsh-agent-loop 的 step() 只看消息里有没有 tool-call，没有就 return { kind: 'completed' }，
 *   于是这一轮被当成正常收尾；turn-stopping 之后 inbox.nextStep 仍为空，循环 break，
 *   用户界面上只看到一条空白回复。
 *
 * 本插件只用公开扩展点（不改 app.asar）：
 *   - agent/assistant-stream  观察每个 attempt 的 start / chunk / end 帧，并累积 reasoning 原文
 *   - agent/turn-stopping     轮次即将关闭时介入（此时 loop 还没 break，steer 还来得及）
 *   - agent.steer(message)    往 inbox.next-step 塞一条消息 → turn() 的第二道判空失效 → 再开一步
 *
 * 判定（四条全中才救，见 classifyAttempt）：
 *   1. finish.reason.kind === 'stop'
 *   2. 内容块里没有 text、也没有 tool-call（只有 reasoning，或除 usage/finish 外完全为空）
 *   3. turn-stopping 的 turn === 该 attempt 的 turn
 *   4. signal 未 aborted
 *
 * 注入文案（见 buildRemedyText）：
 *   拿得到 reasoning 原文时，把节选（默认最多 600 字）一起塞进去，让模型「接着这段」把正文补出来，
 *   而不是凭空重新说一段：
 *     [stop-only-guard] 上一轮你只在思考里走完了、正文是空的。你当时的思考（节选）：
 *     <<<
 *     ……原文……
 *     >>>
 *     请接着这段把正文补出来，不要只思考。
 *   拿不到 reasoning（完全空、或 reasoningExcerptChars = 0）时，退回一句不带节选的默认文案。
 *
 * 安全设计（fail-open 优先）：
 *   1. 默认 enabled: true（装了即生效），可用 config 关掉。
 *   2. 每个监听器内部 try/catch，异常只记日志，绝不打断正常轮次
 *      （agent/turn-stopping 是 serial 派发，监听器抛错会把整轮变成 error，所以这条是硬要求）。
 *   3. signal.aborted 时绝不复活轮次。
 *   4. 每 turn 最多 maxRemediesPerTurn 次，每 agent 最多 maxRemediesPerAgent 次（0 = 不限）。
 *   5. 纯内存状态（WeakMap），不写文件、不发网络请求、零运行时依赖。
 */

import { randomUUID } from 'node:crypto'

export const name = 'dsh-stop-only-guard'

/** 默认配置。上限值的 0 语义是「不限」；reasoningExcerptChars = 0 表示不带节选。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  maxRemediesPerTurn: 3,
  maxRemediesPerAgent: 30,
  log: true,
  reasoningExcerptChars: 600,
  steerText: '[stop-only-guard] 上一轮你只在思考里走完了、正文是空的。请立刻把要说的话写成正文回复，不要只思考。',
})

/** 带节选时文案的固定头尾。 */
const EXCERPT_HEADER = '[stop-only-guard] 上一轮你只在思考里走完了、正文是空的。你当时的思考（节选）：'
const EXCERPT_INSTRUCTION = '请接着这段把正文补出来，不要只思考。'
const ELLIPSIS = '…'

/** attempt 内 reasoning 缓冲的上限，防止异常长的思考把内存撑爆（节选最多也就几百字）。 */
const REASONING_BUFFER_LIMIT = 20000

/**
 * 注入消息 id 的前缀。
 *
 * 用处只有一个：让「这条消息是守卫注入的」在会话事件里自带凭据。
 * Chat 渲染每个节点时外层 div 带 data-chat-node-key="<kind 长度>:<kind><messageId>"，
 * 于是这个前缀会原样出现在 DOM 属性里，dsh-guard-hide 的 client 半身靠它一条 CSS
 * 就把整行藏掉（不靠正文文本匹配，也不会闪）。
 * id 其余部分仍是 UUID，Inbox 仍按 id 去重。
 */
const GUARD_MESSAGE_ID_PREFIX = 'stop-only-guard:'

/** 非负整数；非法值回落到默认值。0 表示不限 / 不带节选。 */
function toLimit(value, fallback) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

/**
 * 合并用户配置与默认值。
 * 只用 value !== undefined 判断：false 是合法的 enabled 值，0 是合法的上限 / 节选值。
 */
function resolveConfig(input) {
  const out = { ...DEFAULTS }
  if (input != null && typeof input === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      if (input[key] !== undefined) out[key] = input[key]
    }
  }
  out.enabled = out.enabled !== false && out.enabled !== 0
  out.log = out.log !== false && out.log !== 0
  out.maxRemediesPerTurn = toLimit(out.maxRemediesPerTurn, DEFAULTS.maxRemediesPerTurn)
  out.maxRemediesPerAgent = toLimit(out.maxRemediesPerAgent, DEFAULTS.maxRemediesPerAgent)
  out.reasoningExcerptChars = toLimit(out.reasoningExcerptChars, DEFAULTS.reasoningExcerptChars)
  if (typeof out.steerText !== 'string' || out.steerText.trim() === '') out.steerText = DEFAULTS.steerText
  return out
}

/**
 * 判定一个已 committed 的 attempt 是不是「只思考、没正文、没工具、正常结束」。
 * @param {{ finishKind?: (string|null), hasText?: boolean, hasToolCall?: boolean }} attempt
 * @returns {{ suspected: boolean, reason: string, detail: string }}
 */
export function classifyAttempt(attempt) {
  const finishKind = attempt?.finishKind ?? null
  const hasText = attempt?.hasText === true
  const hasToolCall = attempt?.hasToolCall === true
  if (finishKind !== 'stop') return { suspected: false, reason: '', detail: '' }
  if (hasText || hasToolCall) return { suspected: false, reason: '', detail: '' }
  return {
    suspected: true,
    reason: 'stop-only',
    detail: 'finish=stop，内容块只有 reasoning 或为空（无 text、无 tool-call）',
  }
}

/**
 * 生成注入文案：有 reasoning 原文时带节选，否则退回默认那句。
 * @param {object} config 已 resolve 或原始 config 均可
 * @param {string} reasoning 该 attempt 累积下来的 reasoning 原文
 * @returns {string}
 */
export function buildRemedyText(config, reasoning) {
  const cfg = config != null && typeof config === 'object' ? config : {}
  const fallback =
    typeof cfg.steerText === 'string' && cfg.steerText.trim() !== '' ? cfg.steerText : DEFAULTS.steerText
  const limit = toLimit(cfg.reasoningExcerptChars, DEFAULTS.reasoningExcerptChars)
  if (limit <= 0) return fallback
  const full = typeof reasoning === 'string' ? reasoning.trim() : ''
  if (full === '') return fallback
  const excerpt = full.length > limit ? full.slice(0, limit) + ELLIPSIS : full
  return EXCERPT_HEADER + '\n<<<\n' + excerpt + '\n>>>\n' + EXCERPT_INSTRUCTION
}

/**
 * 构造一条符合 dsh-llm UserMessage 形状的补救消息。
 * 形状依据：MessageBase { id, content, source } + UserMessage { role: 'user' }。
 * Inbox 以 message.id 去重，所以每条都必须有唯一 id。
 * source 必须是 { kind: 'user' }：这是实测唯一能正常进入会话的 kind。
 */
export function buildSteerMessage(text) {
  return {
    id: GUARD_MESSAGE_ID_PREFIX + randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** 每个 agent 的运行时状态；WeakMap 保证 agent 被回收时不泄漏。 */
const states = new WeakMap()

function stateOf(agent) {
  let s = states.get(agent)
  if (s === undefined) {
    s = {
      /** 进行中的 attempt 统计；null 表示没有。 */
      attempt: null,
      /** 最近一次 committed 的命中判定（只保留最后一个）；null 表示无。 */
      pending: null,
      /** turn -> 已补救次数。 */
      remedies: new Map(),
      /** 本 agent 生命周期内的补救总次数。 */
      total: 0,
      stats: { attempts: 0, suspected: 0, steered: 0, skipped: 0, errors: 0 },
    }
    states.set(agent, s)
  }
  return s
}

/** 只读统计快照，供诊断 / 测试用。 */
export function statsOf(agent) {
  const s = states.get(agent)
  if (s === undefined) return null
  return { ...s.stats, total: s.total }
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  if (!cfg.enabled) return

  const warn = (message) => {
    try {
      ctx?.logger?.warn?.(message)
    } catch {
      /* 日志失败绝不影响主流程 */
    }
  }

  // ---------- 1. 观察流式 attempt（顺带累积 reasoning 原文） ----------
  ctx.on('agent/assistant-stream', (payload) => {
    const agent = payload?.agent
    if (agent == null) return
    let s
    try {
      const frame = payload?.frame
      if (frame == null) return
      s = stateOf(agent)

      if (frame.type === 'start') {
        s.attempt = {
          turn: frame.turn,
          step: frame.step,
          hasText: false,
          hasToolCall: false,
          finishKind: null,
          reasoning: '',
        }
        s.pending = null
        return
      }

      const attempt = s.attempt
      if (attempt === null) return

      if (frame.type === 'chunk') {
        const chunk = frame.chunk
        const kind = chunk?.type
        // StreamChunk 共七种：block-start / text-delta / reasoning-delta /
        // tool-call-delta / block-end / usage / finish。
        if (kind === 'block-start') {
          if (chunk.blockType === 'text') attempt.hasText = true
          else if (chunk.blockType === 'tool-call') attempt.hasToolCall = true
          return
        }
        if (kind === 'text-delta') {
          attempt.hasText = true
          return
        }
        if (kind === 'tool-call-delta') {
          attempt.hasToolCall = true
          return
        }
        if (kind === 'reasoning-delta') {
          // 累积思考原文：注入时要把这段带回去，模型才知道自己本来要说什么。
          if (attempt.reasoning.length < REASONING_BUFFER_LIMIT) {
            attempt.reasoning += typeof chunk.text === 'string' ? chunk.text : ''
            if (attempt.reasoning.length > REASONING_BUFFER_LIMIT) {
              attempt.reasoning = attempt.reasoning.slice(0, REASONING_BUFFER_LIMIT)
            }
          }
          return
        }
        if (kind === 'block-end') {
          // 兜底：某些适配器可能不发 reasoning-delta，只在 block-end 里给完整块。
          const block = chunk.block
          if (
            block?.type === 'reasoning' &&
            attempt.reasoning.trim() === '' &&
            typeof block.text === 'string'
          ) {
            attempt.reasoning = block.text.slice(0, REASONING_BUFFER_LIMIT)
          }
          return
        }
        if (kind === 'finish') {
          attempt.finishKind = chunk.reason?.kind ?? null
          return
        }
        return
      }

      if (frame.type === 'end') {
        s.attempt = null
        s.stats.attempts += 1
        // 只有正常提交才可能是「静默完成」；abandoned 交给 DSH 自己的错误路径。
        if (frame.outcome?.kind !== 'committed') return
        const verdict = classifyAttempt(attempt)
        if (!verdict.suspected) return
        // 只保留最后一个被判为 stop-only 的 attempt 的 reasoning。
        s.pending = {
          turn: attempt.turn,
          step: attempt.step,
          reason: verdict.reason,
          detail: verdict.detail,
          reasoning: attempt.reasoning,
        }
      }
    } catch (error) {
      try {
        if (s !== undefined) s.stats.errors += 1
      } catch {
        /* ignore */
      }
      warn('[stop-only-guard] assistant-stream 监听异常：' + String(error))
    }
  })

  // ---------- 2. 轮次即将关闭时介入 ----------
  ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload?.agent
    if (agent == null) return
    let s
    try {
      s = stateOf(agent)
      const pending = s.pending
      // 无论救不救，都先消费掉 pending，避免陈旧状态留到下一轮。
      s.pending = null
      if (pending == null) return

      // 用户主动中断时绝不复活轮次。
      if (payload?.signal?.aborted === true) {
        if (cfg.log) warn('[stop-only-guard] turn ' + pending.turn + ' 已中断（signal.aborted），不介入。')
        return
      }
      // 只处理同一个 turn。
      if (pending.turn !== payload?.turn) return

      s.stats.suspected += 1
      const used = s.remedies.get(pending.turn) ?? 0

      if (cfg.maxRemediesPerTurn > 0 && used >= cfg.maxRemediesPerTurn) {
        s.stats.skipped += 1
        if (cfg.log) {
          warn(
            '[stop-only-guard] turn ' + pending.turn + ' 本 turn 已补救 ' + used +
              ' 次，达到 maxRemediesPerTurn=' + cfg.maxRemediesPerTurn + '，放行。',
          )
        }
        return
      }
      if (cfg.maxRemediesPerAgent > 0 && s.total >= cfg.maxRemediesPerAgent) {
        s.stats.skipped += 1
        if (cfg.log) {
          warn(
            '[stop-only-guard] 本 agent 已补救 ' + s.total +
              ' 次，达到 maxRemediesPerAgent=' + cfg.maxRemediesPerAgent + '，放行。',
          )
        }
        return
      }
      if (typeof agent.steer !== 'function') {
        s.stats.skipped += 1
        warn('[stop-only-guard] 该 agent 没有 steer() 接口，无法补救，放行。')
        return
      }

      // 有 reasoning 原文就带上节选，否则退回默认那句。
      const text = buildRemedyText(cfg, pending.reasoning)
      const withExcerpt = text !== cfg.steerText

      // 关键：steer 往 inbox.next-step 塞消息，turn() 里第二道判空（inbox.nextStep.length === 0）
      // 就不再 break，于是同一个 turn 会再开一步，模型被迫把正文写出来。
      agent.steer(buildSteerMessage(text))

      s.remedies.set(pending.turn, used + 1)
      s.total += 1
      s.stats.steered += 1
      if (cfg.log) {
        warn(
          '[stop-only-guard] turn ' + pending.turn + ' step ' + pending.step +
            ' 命中（' + pending.reason + '：' + pending.detail +
            '），已注入第 ' + s.total + ' 次补救（本 turn 第 ' + (used + 1) +
            ' 次，' + (withExcerpt ? '带思考节选' : '无思考节选') + '，文案 ' + text.length + ' 字）。',
        )
      }
    } catch (error) {
      try {
        if (s !== undefined) s.stats.errors += 1
      } catch {
        /* ignore */
      }
      warn('[stop-only-guard] turn-stopping 监听异常：' + String(error))
    }
  })
}
