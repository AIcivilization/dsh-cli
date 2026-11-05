// lib/actions.js — 3 个工具背后的逻辑，不依赖 DSH，方便测试

export { registerTargets } from './targets.js'

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { askUser, isReadOnlyTool, summarizeArgs } from './approval.js'
import { findCommand, homeOf } from './config.js'
import {
  capText, createJob, exitCodeOf, jobDir, jobsRoot, jobState, listFiles, loadSession, readCapped, readMeta,
  saveSession, startJob, stopJob, updateMeta, waitForJob,
} from './jobs.js'
import { checkToolName, fill, getTarget, loadTargets, parseAgentOutput } from './targets.js'

const DEFAULT_WAIT_SECONDS = { agent: 120, tools: 60 }
const MAX_WAIT_SECONDS = 600
const UNTIL_DONE_SECONDS = 24 * 3600
const QUICK_WAIT_MS = 60_000
const NOISE = /UNDICI-EHPA|--trace-warnings/
const AGENT_OUTPUT_LIMIT = 4 * 1024 * 1024 // agent 的 JSON 要整段解析，不能按头尾截断后再读

/** 默认用 macOS 的 open 在后台启动，不抢焦点 */
function defaultOpenApp(appPath, env) {
  if (process.platform !== 'darwin') {
    return Promise.reject(new Error('自动启动目前只支持 macOS。请让用户手动打开应用。'))
  }
  return new Promise((done, fail) => {
    execFile('/usr/bin/open', ['-g', '-a', appPath], { env }, (error) => (error ? fail(new Error(`启动 ${appPath} 失败：${error.message}`)) : done()))
  })
}

const childEnv = (target, env) => ({ ...env, ...(target.env ?? {}) })

/** 拿到目标的可执行文件；tools 类型需要时会启动应用 */
async function resolveCommand(target, { env, signal, openApp }) {
  const merged = childEnv(target, env)
  if (target.ensureReady) return target.ensureReady({ env: merged, signal, openApp })
  const path = await findCommand(target.command, merged)
  if (!path) throw new Error(target.installHint ?? `没找到命令 ${target.command}。请让用户先安装。`)
  // Blender 靠自身路径找资源，通过符号链接启动会起不来（实测）
  return target.realpath ? realpath(path) : path
}

// 同一个 exclusive 的调用排队。有些工具共用本地数据库，同时跑会出错
const queues = new Map()

function acquire(key) {
  const previous = queues.get(key) ?? Promise.resolve()
  let release
  const mine = new Promise((resolve) => { release = resolve })
  queues.set(key, previous.then(() => mine))
  return previous.then(() => release)
}

/** 工作目录太大时，accept_edits 等于放开整个目录，所以根目录和家目录直接拒绝 */
async function checkCwd(cwd, env) {
  if (!isAbsolute(cwd)) throw new Error(`cwd 必须是绝对路径：${cwd}`)
  const full = resolve(cwd)
  if (full === '/' || full === resolve(homeOf(env))) {
    throw new Error(`cwd 不能是根目录或家目录（${full}）：范围太大。请指定具体的项目目录。`)
  }
  const info = await stat(full).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`cwd 不存在或不是目录：${full}`)
  return full
}

/** 把结束的任务整理成模型能读的结果 */
async function describeJob(id, env, targets) {
  const meta = await readMeta(id, env)
  const dir = jobDir(id, env)
  const state = await jobState(id, env)
  const base = { job: id, target: meta.target, kind: meta.kind }
  if (meta.session) base.session = meta.session

  if (state === 'running') {
    return { ...base, state, hint: `还在运行。稍后用 cli_job 查询：job=${id}。` }
  }
  if (state === 'stopped') return { ...base, state, hint: '任务已被终止。' }
  if (state === 'lost') return { ...base, state, hint: '任务异常中断（可能是电脑重启或进程被杀），没有结果。' }

  const exitCode = await exitCodeOf(id, env)
  const err = await readCapped(join(dir, 'stderr'))
  const stderr = err.text.split('\n').filter((line) => line.trim() && !NOISE.test(line)).join('\n')
  const target = targets[meta.target]
  const result = { ...base, state: 'done', exitCode }
  if (stderr) result.stderr = stderr

  if (meta.kind === 'agent') {
    const full = await readCapped(join(dir, 'stdout'), AGENT_OUTPUT_LIMIT, AGENT_OUTPUT_LIMIT)
    const parsed = target
      ? parseAgentOutput(target, full.text, exitCode)
      : { ok: exitCode === 0, reply: full.text.trim() }
    const reply = capText(parsed.reply)
    result.ok = parsed.ok
    result.reply = reply.text
    if (reply.truncated || full.truncated) result.output_path = join(dir, 'stdout')
    if (parsed.session) result.session = parsed.session
    if (parsed.usage) result.usage = parsed.usage
    if (parsed.hint) result.hint = parsed.hint
    if (result.session && meta.cwd && result.ok) {
      await saveSession(result.session, { target: meta.target, cwd: meta.cwd }, env).catch(() => {})
    }
    if (meta.scanFiles) {
      const files = await listFiles(meta.cwd)
      if (files.length) result.files = files
    }
    return result
  }

  const out = await readCapped(join(dir, 'stdout'))
  if (out.truncated) result.output_path = join(dir, 'stdout')
  result.ok = exitCode === 0 && !hasErrorCode(out.text)
  result.output = out.text.trim()
  return result
}

/** MiniMax 的业务结果里 code 非 0 表示失败 */
function hasErrorCode(text) {
  try {
    const data = JSON.parse(text)
    return typeof data?.code === 'number' && data.code !== 0
  } catch {
    return false
  }
}

async function runAndReport({ id, dir, file, args, cwd, background, timeoutSeconds, waitUntilDone, exclusive, kind, env, signal, targets }) {
  if (exclusive) {
    const release = await acquire(exclusive)
    try {
      signal?.throwIfAborted()
      await startJob({ id, dir, file, args, cwd, env })
    } catch (error) {
      release()
      throw error
    }
    // 转到后台的任务也要占着，直到真正结束
    waitForJob(id, { timeoutMs: UNTIL_DONE_SECONDS * 1000, env }).catch(() => {}).finally(release)
  } else {
    await startJob({ id, dir, file, args, cwd, env })
  }
  if (background) return describeJob(id, env, targets)
  // 直通时用户就在等这个回复，没有模型可以回头查，所以等到结束或者用户取消
  const limit = waitUntilDone ? UNTIL_DONE_SECONDS : Math.min(Number(timeoutSeconds) || DEFAULT_WAIT_SECONDS[kind], MAX_WAIT_SECONDS)
  await waitForJob(id, { timeoutMs: limit * 1000, signal, env })
  return describeJob(id, env, targets)
}

async function runAgent({ target, prompt, session, cwd, model, background, timeoutSeconds, waitUntilDone, ctx, env, signal, openApp, agent, callId, targets }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(`${target.id} 是 agent 类型，必须传 prompt`)

  let workdir = cwd ? await checkCwd(cwd, env) : null
  let scanFiles = !workdir
  if (session) {
    const saved = await loadSession(session, env)
    if (!saved) throw new Error(`不认识这个会话：${session}。只能继续由 cli_run 开始的会话。`)
    if (saved.target !== target.id) throw new Error(`会话 ${session} 属于 ${saved.target}，不是 ${target.id}。`)
    if (workdir && workdir !== saved.cwd) throw new Error(`会话 ${session} 的工作目录是 ${saved.cwd}，继续时不能换目录。`)
    workdir = await checkCwd(saved.cwd, env)
    scanFiles = workdir.startsWith(jobsRoot(env))
  }

  const permission = target.permission
  // 完全跳过权限由用户在配置里开启，开了也每次确认。模型没有参数能改它
  if (permission && target.bypassValues?.includes(permission)) {
    const reason = `让 ${target.label} 以跳过权限模式运行（${permission}），目录：${workdir ?? '任务目录'}。任务：${prompt.slice(0, 120)}`
    const answer = await askUser(ctx, { tool: 'cli_run', reason, agent, callId, signal })
    if (!answer.allowed) return { target: target.id, kind: 'agent', state: 'refused', ok: false, hint: answer.hint }
  }

  const file = await resolveCommand(target, { env, signal, openApp })
  const merged = childEnv(target, env)
  const newSession = session ? null : (target.newSession ? randomUUID() : null)
  const { id, dir } = await createJob({ target: target.id, kind: 'agent' }, env)

  if (!workdir) {
    workdir = join(dir, 'work')
    await mkdir(workdir, { recursive: true, mode: 0o700 })
  }
  const sessionId = session ?? newSession
  const args = [
    ...(permission && target.permissionArgs ? fill(target.permissionArgs, { permission }) : []),
    ...(session && target.resume ? fill(target.resume, { session }) : []),
    ...(newSession ? fill(target.newSession, { session: newSession }) : []),
    // run 放最后：里面可能有 -- 分隔符，后面只能是提示词
    ...fill(target.run, { prompt, model: model ?? target.model ?? '' }),
  ]
  await updateMeta(id, { cwd: workdir, scanFiles, ...(sessionId ? { session: sessionId } : {}) }, env)
  return runAndReport({ id, dir, file, args, cwd: workdir, background, timeoutSeconds, waitUntilDone, exclusive: target.exclusive, kind: 'agent', env: merged, signal, targets })
}

async function runTool({ target, tool, args, background, timeoutSeconds, ctx, env, signal, openApp, agent, callId, targets }) {
  checkToolName(tool)
  const params = args ?? {}
  if (typeof params !== 'object' || Array.isArray(params)) throw new Error('args 必须是 JSON 对象')

  const special = target.special?.[tool]
  const needsConfirm = special ? special.confirm : !isReadOnlyTool(tool)
  if (needsConfirm && target.confirm !== false) {
    const reason = `${target.label} · ${tool} · ${summarizeArgs(params)}`
    const answer = await askUser(ctx, { tool: 'cli_run', reason, agent, callId, signal })
    if (!answer.allowed) return { target: target.id, kind: 'tools', tool, state: 'refused', ok: false, hint: answer.hint }
  }

  const file = await resolveCommand(target, { env, signal, openApp })
  const merged = childEnv(target, env)
  const { id, dir } = await createJob({ target: target.id, kind: 'tools', tool }, env)
  let cliArgs
  if (special) {
    cliArgs = special.args(params)
  } else {
    const argsFile = join(dir, 'args.json')
    await writeFile(argsFile, JSON.stringify(params), { mode: 0o600 })
    cliArgs = target.call(tool, argsFile)
  }
  return runAndReport({ id, dir, file, args: cliArgs, cwd: dir, background, timeoutSeconds, kind: 'tools', env: merged, signal, targets })
}

/** 普通程序：参数按数组传，不经过 shell */
async function runCommand({ target, args, cwd, background, timeoutSeconds, waitUntilDone, env, signal, openApp, targets }) {
  const argv = args?.argv
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
    throw new Error(`${target.id} 是普通程序，args.argv 必须是字符串数组`)
  }
  const workdir = cwd ? await checkCwd(cwd, env) : null
  const file = await resolveCommand(target, { env, signal, openApp })
  const { id, dir } = await createJob({ target: target.id, kind: 'command' }, env)
  return runAndReport({ id, dir, file, args: argv, cwd: workdir ?? dir, background, timeoutSeconds, waitUntilDone, exclusive: target.exclusive, kind: 'tools', env: childEnv(target, env), signal, targets })
}

/** cli_run */
export async function runAction({ target: targetId, prompt, session, cwd, model, tool, args, background, timeoutSeconds, waitUntilDone, ctx, env, signal, openApp = defaultOpenApp, agent, callId }) {
  const targets = await loadTargets(env)
  const target = getTarget(targets, targetId)
  const shared = { target, background: background === true, timeoutSeconds, waitUntilDone: waitUntilDone === true, ctx, env, signal, openApp, agent, callId, targets }
  if (target.kind === 'agent') return runAgent({ ...shared, prompt, session, cwd, model })
  if (target.kind === 'command') return runCommand({ ...shared, args, cwd })
  if (!tool) throw new Error(`${target.id} 是 tools 类型，必须传 tool。先用 cli_list 搜索有哪些工具。`)
  return runTool({ ...shared, tool, args })
}

/** 跑一条只读命令并等结果（cli_list 用） */
async function runQuick(target, cliArgs, { env, signal, openApp }) {
  const file = await resolveCommand(target, { env, signal, openApp })
  const merged = childEnv(target, env)
  const { id, dir } = await createJob({ target: target.id, kind: 'tools', tool: 'list' }, env)
  await startJob({ id, dir, file, args: cliArgs, cwd: dir, env: merged })
  await waitForJob(id, { timeoutMs: QUICK_WAIT_MS, signal, env })
  const state = await jobState(id, env)
  const out = await readCapped(join(dir, 'stdout'), 20_000, 20_000)
  if (state !== 'exited' || (await exitCodeOf(id, env)) !== 0) {
    const err = await readCapped(join(dir, 'stderr'))
    const detail = err.text.split('\n').filter((l) => l.trim() && !NOISE.test(l)).join(' ')
    throw new Error(`${target.label} 查询失败：${detail || state}`)
  }
  return out.text.trim()
}

async function probe(target, path, env, signal) {
  if (target.status && (path || target.ensureReady)) return target.status.call(target, { path, env, signal })
  return { ready: Boolean(path), ...(path ? {} : { hint: target.installHint ?? `没找到命令 ${target.command}。请让用户先安装。` }) }
}

/** 查一家现在能不能用（要启动进程，慢一些） */
export async function statusAction({ target: targetId, env, signal }) {
  const target = getTarget(await loadTargets(env), targetId)
  const merged = childEnv(target, env)
  const status = await probe(target, await findCommand(target.command, merged), merged, signal)
  return { target: target.id, ready: status.ready, ...(status.hint ? { hint: status.hint } : {}) }
}

/** cli_list */
export async function listAction({ target: targetId, keyword, tool, capability, quick, env, signal, openApp = defaultOpenApp }) {
  const targets = await loadTargets(env)
  if (!targetId) {
    const matching = Object.values(targets).filter((t) => !capability || (t.capabilities ?? []).includes(capability))
    // 几十家时不能一家一家等，并行探测
    const rows = await Promise.all(matching.map(async (target) => {
      const merged = childEnv(target, env)
      const path = await findCommand(target.command, merged)
      const base = {
        target: target.id,
        kind: target.kind,
        label: target.label,
        capabilities: target.capabilities ?? [],
        description: target.description,
        ...(target.kind === 'agent' && target.permission ? { permission: target.permission } : {}),
      }
      if (quick) {
        // 打开面板时用：只查装没装。登录状态要启动进程，选中时才查
        const installed = Boolean(path) || (target.ensureReady ? (await target.status.call(target, { path, env: merged, signal })).installed !== false : false)
        return { ...base, installed }
      }
      const status = await probe(target, path, merged, signal)
      return { ...base, installed: Boolean(path) || status.installed === true, ready: status.ready, ...(status.hint ? { hint: status.hint } : {}) }
    }))
    return { targets: rows }
  }
  const target = getTarget(targets, targetId)
  if (target.kind !== 'tools') {
    throw new Error(`${target.id} 是 agent 类型，没有工具清单。直接用 cli_run 传 prompt。`)
  }
  if (tool) {
    checkToolName(tool)
    if (target.special?.[tool]) {
      return { target: target.id, tool, detail: tool === 'get_asset_url' ? '参数：node_id（字符串）。返回短期有效的下载地址。' : '参数：file_path（本地路径）、mime_type（可选）、video_reference（可选布尔值）。上传后返回临时公开链接，需要用户确认。' }
    }
    return { target: target.id, tool, detail: await runQuick(target, target.inspect(tool), { env, signal, openApp }) }
  }
  return {
    target: target.id,
    keyword: keyword ?? '',
    tools: await runQuick(target, target.search(keyword), { env, signal, openApp }),
    extra_tools: Object.keys(target.special ?? {}),
  }
}

/** cli_job */
export async function jobAction({ job, action, env }) {
  const targets = await loadTargets(env)
  await readMeta(job, env)
  if (action === 'stop') {
    const before = await jobState(job, env)
    if (before === 'running') await stopJob(job, env)
  }
  return describeJob(job, env, targets)
}
