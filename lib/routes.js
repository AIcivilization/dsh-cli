// lib/routes.js — 界面调 host 的接口
//
// 挂在 connection.fetch（/api 通道）：DSH 自己做 Host/Origin 围栏和登录校验（做法照 dsh-vps）。

import { extrasStatus } from './extras.js'
import { jobAction, listAction, statusAction } from './actions.js'
import { bindingOf, setBinding } from './mode.js'
import { getTarget, loadTargets } from './targets.js'
import { noteJobResult, ownsJob, usageOf } from './usage.js'

export const API_PATH = '/api/dsh-cli'
const STATUS_TTL_MS = 60_000

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export function createActions(deps = {}) {
  const env = deps.env ?? process.env
  const statusCache = new Map()
  const statusOf = async (sessionId) => ({ binding: bindingOf(sessionId), ...(await usageOf(sessionId, env)) })

  return {
    /** 指示灯每隔几秒问一次：只读内存和任务目录，很轻 */
    status: ({ sessionId }) => statusOf(sessionId),

    /** 设置页用：可以叠在桥上的插件 */
    extras: () => ({ extras: extrasStatus() }),

    /** 只查装没装，几十家也很快 */
    targets: async () => {
      const { targets } = await listAction({ env, quick: true })
      // 普通程序是给 dsh 和流程用的，不进面板
      return { targets: targets.filter((t) => t.kind !== 'command').map(({ target, kind, label, capabilities, installed }) => ({ target, kind, label, capabilities, installed })) }
    },

    /** 选中某一家、或者它已经打开时才查登录状态，要启动进程。同一家 1 分钟内用缓存 */
    targetStatus: async ({ target, force }) => {
      const cached = statusCache.get(target)
      if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status
      const status = await statusAction({ target, env })
      statusCache.set(target, { at: Date.now(), status })
      return status
    },

    bind: async ({ sessionId, target }) => {
      if (!sessionId) throw new Error('缺少对话编号')
      if (!target) {
        await setBinding(sessionId, null, env)
        return statusOf(sessionId)
      }
      const found = getTarget(await loadTargets(env), target)
      await setBinding(sessionId, { target: found.id, kind: found.kind, label: found.label }, env)
      return statusOf(sessionId)
    },

    /** 只能停这个对话自己的后台任务 */
    stop: async ({ sessionId, job }) => {
      if (!ownsJob(sessionId, job)) throw new Error('这不是这个对话的后台任务')
      noteJobResult(sessionId, await jobAction({ job, action: 'stop', env }))
      return statusOf(sessionId)
    },
  }
}

export function createHandler(deps = {}) {
  const actions = createActions(deps)
  return async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      return json({ ok: false, error: '请求格式不对' }, 400)
    }
    const action = Object.hasOwn(actions, body?.action) ? actions[body.action] : null
    if (!action) return json({ ok: false, error: '没有这个操作' }, 404)
    try {
      return json({ ok: true, ...(await action(body)) })
    } catch (error) {
      return json({ ok: false, error: error.message })
    }
  }
}

export function registerRoutes(fetchApi, deps = {}) {
  return fetchApi.register({ path: API_PATH, methods: ['POST'], requestBody: 'buffered', fetch: createHandler(deps) })
}
