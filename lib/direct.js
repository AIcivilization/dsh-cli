// lib/direct.js — 直通：开关指定 agent 时，消息直接交给 CLI，不经过 dsh 的模型
//
// 做法：注册一条自己的模型通道 dsh-cli，再用 agent/request 把这个对话的请求改到这条通道。
// 通道收到请求后运行 CLI，把回复当作模型回复返回。这样用户消息、回复、轮次都走 DSH 的正常流程，
// 界面和记录不用特殊处理，也没有任何真实模型请求，dsh 的 token 就是 0。
//
// 两个坑：
//   1. 改过的通道会写进会话的请求头，下一次请求的初始值就是它。所以关掉开关时必须还原成
//      用户原来的模型，原来的模型要存盘，DSH 重启后也要能还原。
//   2. 这条通道只能响应对话主循环的请求。自动生成标题这类后台调用如果也走到这里，不能启动 CLI，
//      所以每次由 agent/request 放行一次，通道用掉就作废。

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runAction } from './actions.js'
import { dataDir } from './config.js'
import { capText } from './jobs.js'
import { bindingOf } from './mode.js'
import { beginCall, endCall } from './usage.js'

export const ROUTE = 'dsh-cli'
const CONTEXT_WINDOW = 1_000_000 // 用量恒为 0，给大窗口，避免触发压缩

// —— 存盘：每个对话原来的模型、各家 CLI 的会话号 ——
const state = new Map()
const fileOf = (env) => join(dataDir(env), 'direct.json')

export async function loadDirectState(env = process.env) {
  state.clear()
  try {
    const saved = JSON.parse(await readFile(fileOf(env), 'utf8'))
    for (const [sessionId, value] of Object.entries(saved)) state.set(sessionId, value)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export const directStateOf = (sessionId) => state.get(String(sessionId)) ?? {}

async function patchState(sessionId, patch, env) {
  state.set(String(sessionId), { ...directStateOf(sessionId), ...patch })
  await mkdir(dataDir(env), { recursive: true, mode: 0o700 })
  const tmp = `${fileOf(env)}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(Object.fromEntries(state)), { mode: 0o600 })
  await rename(tmp, fileOf(env))
}

// —— 放行：只给对话主循环这一次请求用 ——
const armed = new Map()
const claimed = new Map()

const isDirect = (binding) => binding?.kind === 'agent'

/** 改写每次请求的通道。开关开着就转到 dsh-cli；关了就还原 */
export function registerDirectHook(ctx, deps = {}) {
  const env = deps.env ?? process.env
  // 这一步新领取的消息才是用户这次说的。只看"最后一条回复之后"不够：
  // 之前失败的轮次没有回复，那些旧消息会被一起转给 CLI（实测踩过）
  const stopClaims = ctx.on('agent/pre-step', async (payload, next) => {
    const sessionId = payload?.agent?.session?.id ? String(payload.agent.session.id) : ''
    if (sessionId && isDirect(bindingOf(sessionId))) {
      claimed.set(sessionId, new Set((payload.messages ?? []).map((m) => m.id).filter(Boolean)))
    }
    return next()
  })
  const stopRequests = ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    const session = payload?.agent?.session
    const sessionId = session?.id ? String(session.id) : ''
    if (!sessionId) return config
    const binding = bindingOf(sessionId)
    if (isDirect(binding)) {
      if (config.provider && config.provider !== ROUTE) {
        const { provider, model, reasoningEffort, maxTokens } = config
        const origin = {
          provider,
          model,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        }
        await patchState(sessionId, { origin }, env)
      }
      armed.set(sessionId, { agent: payload.agent, cwd: session.header?.cwd ?? session.meta?.cwd })
      return { provider: ROUTE, model: binding.target }
    }
    if (config.provider === ROUTE) return directStateOf(sessionId).origin ?? config
    return config
  })
  return () => {
    stopClaims?.()
    stopRequests?.()
  }
}

/**
 * 这一轮用户说的话：最后一条模型回复之后、来源是用户的消息。
 * only 是这一步新领取的消息 id，给了就只取这些。
 */
export function lastUserInput(messages = [], only = null) {
  const texts = []
  let hasAttachment = false
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'assistant') break
    if (message.role !== 'user' || (message.source?.kind && message.source.kind !== 'user')) continue
    if (only && !only.has(message.id)) continue
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
    if (blocks.some((b) => b.type !== 'text')) hasAttachment = true
    if (text) texts.unshift(text)
  }
  return { text: texts.join('\n\n'), hasAttachment }
}

export function formatReply(label, result) {
  const parts = []
  if (result.state === 'refused') {
    parts.push(result.hint)
  } else if (result.state !== 'done') {
    parts.push(`${label} 没有结束（${result.state}）。${result.hint ?? ''}`.trim())
  } else if (result.ok) {
    parts.push(result.reply || `${label} 结束了，但没有回复内容。`)
  } else {
    parts.push(`**${label} 没有完成。**`)
    if (result.hint) parts.push(result.hint)
    if (result.reply) parts.push(result.reply)
    if (result.stderr) parts.push(result.stderr)
  }
  if (result.files?.length) parts.push(`生成的文件：\n${result.files.map((f) => `- ${f}`).join('\n')}`)
  if (result.output_path) parts.push(`完整输出：${result.output_path}`)
  if (result.usage?.credits !== undefined) parts.push(`*${label} 用量：${Math.round(result.usage.credits * 1000) / 1000} credits*`)
  return parts.filter(Boolean).join('\n\n')
}

const textChunks = (text) => [
  ...(text
    ? [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text },
        { type: 'block-end', index: 0, block: { type: 'text', text } },
      ]
    : []),
  { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** 接口形状照 dsh-llm 的 LlmAdapter。链接安装时取不到基类，所以自己写全 */
export class DirectAdapter {
  constructor(deps = {}) {
    this.deps = deps
  }

  providerInfo(provider) {
    return { id: provider, name: 'dsh-cli' }
  }

  /** 不重试：CLI 可能已经改了文件，重跑不是幂等的 */
  providerRetryPolicy() {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [], backoff: { initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 } }
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  /** 不进模型选择器：这条通道只由开关使用 */
  listModels() {
    return Promise.resolve([])
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: CONTEXT_WINDOW } })
  }

  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) }
  }

  async *stream(options) {
    yield* textChunks(await this.answer(options))
  }

  async answer(options) {
    const { env = process.env, ctx, openApp } = this.deps
    const sessionId = options.sessionId ? String(options.sessionId) : ''
    const pass = armed.get(sessionId)
    armed.delete(sessionId)
    if (!pass) {
      // 不是对话主循环的请求（比如自动生成标题），绝不启动 CLI
      return isDirect(bindingOf(sessionId)) ? '' : '开关已经关闭，但这个对话还没有可用的模型。请在输入框下方选择模型。'
    }
    const target = options.model
    const binding = bindingOf(sessionId)
    const label = binding?.label ?? target
    const only = claimed.get(sessionId)
    claimed.delete(sessionId)
    const { text, hasAttachment } = lastUserInput(options.messages, only?.size ? only : null)
    if (!text) return hasAttachment ? `${label} 直通目前只转交文字，这条消息没有文字。` : `没有可以转交给 ${label} 的内容。`

    const cliSessions = directStateOf(sessionId).cliSessions ?? {}
    const previous = cliSessions[target]
    const call = beginCall(sessionId, { target })
    let result = null
    try {
      result = await runAction({
        target,
        prompt: text,
        session: previous,
        cwd: previous ? undefined : pass.cwd,
        waitUntilDone: true,
        ctx,
        env,
        signal: options.signal,
        openApp,
        agent: pass.agent,
      })
    } catch (error) {
      // 会话可能已经失效（目录没了、被清理了）。下一条重新开始，不要一直卡在这里
      if (previous) {
        const { [target]: _dropped, ...rest } = cliSessions
        await patchState(sessionId, { cliSessions: rest }, env)
      }
      return `**${label} 没有启动。**\n\n${error.message}${previous ? '\n\n再发一次会开一个新的会话，它不记得之前的内容。' : ''}`
    } finally {
      endCall(sessionId, call, result ?? { state: 'error', ok: false })
    }
    if (result.ok && result.session && result.session !== previous) {
      await patchState(sessionId, { cliSessions: { ...cliSessions, [target]: result.session } }, env)
    }
    const note = hasAttachment ? `\n\n*${label} 直通目前只转交文字，这条消息的附件没有传过去。*` : ''
    return capText(formatReply(label, result)).text + note
  }
}

export function registerDirectAdapter(llm, deps = {}) {
  return llm.registerAdapter([ROUTE], new DirectAdapter(deps))
}

/** 测试用 */
export function _resetDirect() {
  state.clear()
  armed.clear()
  claimed.clear()
}
