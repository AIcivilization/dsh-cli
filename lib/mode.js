// lib/mode.js — 对话开关：打开后，这个对话的活交给选中的工具来跑（做法照 dsh-vps lib/vps-mode.js）
//
// 只改界面不够：模型不知道这件事，会照常自己干。所以：
// 所以绑定工具类时，绑定变化后的第一步往对话里追加一条消息告诉模型。只在变化时发，不每轮花 token。
// 绑定 agent 时是直通，消息不经过模型（lib/direct.js）。
// 都按对话生效：另一个窗口没开开关，完全不受影响。

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from './config.js'

export const PLUGIN = 'dsh-cli'
// DSH 会话格式 v4 要求消息来源写成 plugin:<插件名>，写错整轮对话会失败（dsh-vps 实测）
export const SOURCE_KIND = `plugin:${PLUGIN}`
const MARK_BOUND = '[dsh-cli] 已绑定 '
const MARK_OFF = '[dsh-cli] 已关闭'

const bindings = new Map()
const fileOf = (env) => join(dataDir(env), 'bindings.json')

/** 进程启动时读进内存：工具拦截是同步的，只能看这份 */
export async function loadBindings(env = process.env) {
  bindings.clear()
  try {
    const saved = JSON.parse(await readFile(fileOf(env), 'utf8'))
    for (const [sessionId, binding] of Object.entries(saved)) bindings.set(sessionId, binding)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export function bindingOf(sessionId) {
  return sessionId ? bindings.get(String(sessionId)) ?? null : null
}

/** binding 为空表示关闭。先写文件再改内存：写失败时界面和实际状态不会不一致 */
export async function setBinding(sessionId, binding, env = process.env) {
  if (!sessionId) throw new Error('缺少对话编号')
  const next = new Map(bindings)
  if (binding) next.set(String(sessionId), binding)
  else next.delete(String(sessionId))
  await mkdir(dataDir(env), { recursive: true, mode: 0o700 })
  const tmp = `${fileOf(env)}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(Object.fromEntries(next)), { mode: 0o600 })
  await rename(tmp, fileOf(env))
  if (binding) bindings.set(String(sessionId), binding)
  else bindings.delete(String(sessionId))
}

function ours(source) {
  return source?.kind === SOURCE_KIND
}

/** 这个对话最近一次说明是什么：目标 id、'off'，或者从没发过（null） */
export function lastAnnouncement(session) {
  const seq = Number(session?.seq)
  if (!Number.isSafeInteger(seq) || typeof session?.eventAt !== 'function') return null
  for (let i = seq - 1; i >= 0; i -= 1) {
    const event = session.eventAt(i)
    if (event?.type !== 'user/message' || !ours(event.data?.source)) continue
    const text = event.data.source.sections?.[0]?.text ?? event.data?.content?.[0]?.text ?? ''
    if (text.startsWith(MARK_OFF)) return 'off'
    if (text.startsWith(MARK_BOUND)) return text.slice(MARK_BOUND.length).split(/\s/)[0] || null
  }
  return null
}

/** 该发什么：目标 id、'off'，或者 null（不用发） */
export function planAnnouncement(current, last) {
  if (current) return current === last ? null : current
  return last && last !== 'off' ? 'off' : null
}

export function boundText(binding) {
  return [
    `${MARK_BOUND}${binding.target}`,
    `用户在对话头部打开了 dsh-cli 开关：这个对话里的图片、视频、音频、音乐需求，都用 ${binding.label} 来做（cli_run，target 可以省略），不要找别的工具。其他事照常处理。`,
    '生成类调用会花用户的额度，先说明要生成什么。先读 skill dsh-cli，里面有必须遵守的规则。',
  ].join('\n')
}

export const OFF_TEXT = `${MARK_OFF}\n用户关掉了 dsh-cli 开关：这个对话不再绑定任何工具，由你自己判断怎么做。`

async function userMessage(text) {
  const content = [{ type: 'text', text }]
  const source = { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: 'dsh-cli-mode', text }] }
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    if (typeof createUserMessage === 'function') return createUserMessage({ content, source })
  } catch {
    // 链接安装时取不到这个包，按同样的形状自己拼
  }
  return Object.freeze({ content, source, role: 'user', id: randomUUID() })
}

/** 每一步开始前看绑定有没有变，变了就补一条说明 */
export function registerMode(ctx, deps = {}) {
  const warn = deps.warn ?? (() => {})
  const announced = new Map() // 进程重启后为空，第一步从会话历史找回来，不会重复发
  return ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    try {
      const session = payload?.agent?.session
      const sessionId = String(session?.id ?? '')
      if (!sessionId) return decision
      // 只有工具类才需要告诉模型。agent 是直通，模型根本不参与（lib/direct.js）
      const stored = bindingOf(sessionId)
      const binding = stored?.kind === 'agent' ? null : stored
      const last = announced.has(sessionId) ? announced.get(sessionId) : lastAnnouncement(session)
      const plan = planAnnouncement(binding?.target ?? null, last)
      if (!plan) {
        announced.set(sessionId, last)
        return decision
      }
      announced.set(sessionId, plan)
      const message = await userMessage(plan === 'off' ? OFF_TEXT : boundText(binding))
      return { ...decision, messages: [...(decision.messages ?? []), message] }
    } catch (error) {
      warn('开关说明没发出去', error)
      return decision
    }
  }, { prepend: true })
}
