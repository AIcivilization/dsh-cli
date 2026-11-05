// lib/usage.js — 每个对话的使用情况，给界面的指示灯看
//
// 只放内存：灯只关心"现在有没有在跑、这次对话用了多少"，重启后归零也没关系。
// 转到后台的任务靠任务目录判断还在不在跑，所以不会一直亮着。

import { jobState } from './jobs.js'

const sessions = new Map()

function entry(sessionId) {
  const key = String(sessionId)
  if (!sessions.has(key)) sessions.set(key, { active: new Map(), calls: 0, usage: {}, counted: new Set(), last: null })
  return sessions.get(key)
}

/** 开始一次调用。返回的 id 交给 endCall */
export function beginCall(sessionId, { target, tool }) {
  if (!sessionId) return null
  const item = entry(sessionId)
  const id = Symbol('call')
  item.active.set(id, { target, tool: tool ?? null, startedAt: Date.now() })
  return id
}

function addUsage(item, result) {
  if (!result?.usage || !result.job || item.counted.has(result.job)) return
  item.counted.add(result.job)
  for (const [key, value] of Object.entries(result.usage)) {
    if (typeof value === 'number') item.usage[key] = (item.usage[key] ?? 0) + value
  }
}

/** 记下结果：被拒绝的不算一次调用；转后台的继续算在跑 */
export function endCall(sessionId, id, result) {
  if (!sessionId || !id) return
  const item = entry(sessionId)
  const call = item.active.get(id)
  item.active.delete(id)
  if (!call || result?.state === 'refused') return
  item.calls += 1
  if (result?.state === 'running' && result.job) {
    item.active.set(`job:${result.job}`, { ...call, job: result.job })
    return
  }
  addUsage(item, result)
  item.last = { target: call.target, tool: call.tool, at: Date.now(), ok: result?.ok ?? false, state: result?.state ?? 'error' }
}

/** cli_job 查到结果时，把后台任务的用量补上 */
export function noteJobResult(sessionId, result) {
  if (!sessionId || !result?.job) return
  const item = entry(sessionId)
  addUsage(item, result)
  if (result.state !== 'running') {
    const call = item.active.get(`job:${result.job}`)
    if (call) {
      item.active.delete(`job:${result.job}`)
      item.last = { target: call.target, tool: call.tool, at: Date.now(), ok: result.ok ?? false, state: result.state }
    }
  }
}

export function ownsJob(sessionId, job) {
  return sessions.get(String(sessionId))?.active.has(`job:${job}`) ?? false
}

/** 界面要的快照。顺带清掉已经结束的后台任务 */
export async function usageOf(sessionId, env = process.env) {
  const item = sessions.get(String(sessionId))
  if (!item) return { running: [], calls: 0, usage: {}, last: null }
  for (const [key, call] of [...item.active]) {
    if (!call.job) continue
    const state = await jobState(call.job, env).catch(() => 'lost')
    if (state === 'running') continue
    item.active.delete(key)
    item.last = { target: call.target, tool: call.tool, at: Date.now(), ok: state === 'exited', state: state === 'exited' ? 'done' : state }
  }
  return {
    running: [...item.active.values()].map(({ target, tool, startedAt, job }) => ({ target, tool, startedAt, ...(job ? { job } : {}) })),
    calls: item.calls,
    usage: item.usage,
    last: item.last,
  }
}

/** 测试用 */
export function _resetUsage() {
  sessions.clear()
}
