// lib/index.js — 插件入口（挂载方式照 dsh-vps lib/index.js）
//
//   - tools 是硬依赖，没有它这个插件没有意义
//   - skills 是可选服务，经 ctx.inject 延迟注册：没声明就读 ctx.skills 会抛异常
//   - 任何一处注册失败只降级，绝不阻断插件加载，但一定要写进日志

import { readFile } from 'node:fs/promises'
import { loadUserConfig } from './config.js'
import { makeGuard } from './guard.js'
import { pruneJobs } from './jobs.js'
import { loadDirectState, registerDirectAdapter, registerDirectHook } from './direct.js'
import { loadBindings, registerMode } from './mode.js'
import { registerRoutes } from './routes.js'
import { registerTools } from './tools.js'

export const name = 'dsh-cli'
export const inject = ['tools']

const SKILL_NAME = 'dsh-cli'

// 插件市场会热挂载一份、profile 又加载一份，第二份注册时会撞车，让它让路
const RUNNING = Symbol.for('dsh-cli.running')
export function _resetInstanceGuard() {
  delete globalThis[RUNNING]
}

function warn(ctx, message, error) {
  const text = `[dsh-cli] ${message}${error ? `：${error.message ?? error}` : ''}`
  if (ctx?.logger?.warn) ctx.logger.warn(text)
  else console.warn(text)
}

export async function registerSkill(skillCtx) {
  const content = await readFile(new URL('./skills/dsh-cli.md', import.meta.url), 'utf8')
  // source 漏了的话，注册成功、模型一读就报错（dsh-vps 实测）
  return skillCtx.skills.register({
    name: SKILL_NAME,
    source: 'runtime',
    description: '调用用户本机已登录的 AI 工具（MiniMax 出视频、Qoder 写代码）时读它，里面有必须遵守的规则',
    whenToUse: '用户要出视频、出图、生成语音或音乐，提到 MiniMax、Qoder，或要把任务委托给别的 AI 工具；用 cli_run 之前',
    content,
    invocation: { modelInvocable: true, userInvocable: false },
  })
}

/** 工具注册成功后才拦 bash：否则模型什么路都没有 */
async function registerGuard(ctx, env) {
  if (typeof ctx.tools?.guard !== 'function') return
  let enabled = true
  await loadUserConfig(env)
    .then((config) => { enabled = config.guard !== false })
    .catch((error) => warn(ctx, '读取配置失败，bash 拦截保持开启', error))
  ctx.tools.guard(makeGuard(() => enabled))
}

export function apply(ctx, config = {}) {
  const running = globalThis[RUNNING]
  if (running && !running.released) {
    warn(ctx, '同一个 DSH 里已经有一份本插件在运行，这一份不再重复注册')
    return
  }
  const instance = { released: false }
  globalThis[RUNNING] = instance
  const release = () => {
    instance.released = true
    if (globalThis[RUNNING] === instance) delete globalThis[RUNNING]
  }
  try {
    ctx.effect?.(() => release, 'dsh-cli: single instance')
  } catch {
    // 老版本 cordis 没有 effect
  }
  try {
    ctx.on?.('dispose', release)
  } catch {
    // 没有 dispose 事件的宿主：靠上面的 effect；都没有就等重启
  }

  const deps = { env: process.env, ...config }

  loadBindings(deps.env).catch((error) => warn(ctx, '读取对话开关失败', error))
  loadDirectState(deps.env).catch((error) => warn(ctx, '读取直通状态失败', error))
  registerTools(ctx, deps)
    .then(() => registerGuard(ctx, deps.env))
    .catch((error) => warn(ctx, '工具注册失败', error))
  pruneJobs(deps.env).catch((error) => warn(ctx, '清理旧任务失败', error))

  if (typeof ctx.inject !== 'function') return
  ctx.inject(['skills'], (skillCtx) => {
    registerSkill(skillCtx).catch((error) => warn(ctx, 'skill 注册失败', error))
  })
  ctx.inject(['agents'], (agentCtx) => {
    try {
      registerMode(agentCtx, { warn: (message, error) => warn(ctx, message, error) })
      registerDirectHook(agentCtx, { env: deps.env })
    } catch (error) {
      warn(ctx, '对话开关注册失败', error)
    }
  })
  ctx.inject(['llm'], (llmCtx) => {
    const llm = llmCtx.llm ?? llmCtx.get?.('llm')
    if (typeof llm?.registerAdapter !== 'function') {
      warn(ctx, 'DSH 没有提供 llm 服务，直通不可用')
      return
    }
    try {
      registerDirectAdapter(llm, { env: deps.env, ctx, openApp: deps.openApp })
    } catch (error) {
      warn(ctx, '直通通道注册失败', error)
    }
  })
  ctx.inject(['connection'], (connCtx) => {
    const fetchApi = connCtx.connection?.fetch ?? connCtx.get?.('connection')?.fetch
    if (typeof fetchApi?.register !== 'function') {
      warn(ctx, 'DSH 没有提供 connection.fetch，对话头部的开关不可用')
      return
    }
    try {
      const dispose = registerRoutes(fetchApi, deps)
      connCtx.effect?.(() => dispose, 'dsh-cli: routes')
    } catch (error) {
      warn(ctx, '界面接口注册失败（工具不受影响）', error)
    }
  })
}
