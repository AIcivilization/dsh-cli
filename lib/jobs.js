// lib/jobs.js — 后台任务（目录结构和状态判断照 dsh-vps lib/task.js）
//
// 不管模型要不要等，每次调用都是一个任务，只有这一条代码路径。
// 任务目录 $DSH_HOME/dsh-cli/jobs/<id>/ 里有 meta.json / pid / stdout / stderr / rc。
//   rc 存在       = 跑完了
//   stopped 存在  = 被 cli_job 或取消信号终止
//   pid 还活着    = 在跑
//   都没有        = 异常中断（比如电脑重启）
//
// 用 sh 包一层是为了让 rc 不依赖 DSH 进程：DSH 重启后任务照跑，结果也还在。
// 参数以位置参数传给 sh，不拼进脚本文本，所以不存在注入。

import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { dataDir, searchPath } from './config.js'

const WRAPPER = 'd=$1; shift; "$@" >"$d/stdout" 2>"$d/stderr" </dev/null; c=$?; echo "$c" >"$d/rc.tmp"; mv "$d/rc.tmp" "$d/rc"; exit "$c"'
const POLL_MS = 200
const STOP_GRACE_MS = 5000
const HEAD = 4000
const TAIL = 12000
const KEEP_DAYS = 7
const KEEP_COUNT = 50
const JOB_ID = /^[a-f0-9]{16}$/

export const jobsRoot = (env) => join(dataDir(env), 'jobs')
const sessionsRoot = (env) => join(dataDir(env), 'sessions')

export function jobDir(id, env) {
  if (!JOB_ID.test(String(id))) throw new Error(`任务号不合法：${id}`)
  return join(jobsRoot(env), id)
}

/** 建一个空任务目录。权限 700：结果里可能有带签名的下载地址 */
export async function createJob(meta, env) {
  const id = randomBytes(8).toString('hex')
  const dir = jobDir(id, env)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, id, startedAt: Date.now() }), { mode: 0o600 })
  return { id, dir }
}

export async function updateMeta(id, patch, env) {
  const path = join(jobDir(id, env), 'meta.json')
  const meta = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ ...meta, ...patch }), { mode: 0o600 })
}

/** 启动任务。detached 让它自成进程组，停止时能连子进程一起收掉 */
export async function startJob({ id, dir, file, args, cwd, env }) {
  const childEnv = { ...env, PATH: searchPath(env).join(delimiter) }
  const child = spawn('/bin/sh', ['-c', WRAPPER, 'sh', dir, file, ...args], {
    cwd,
    env: childEnv,
    detached: true,
    stdio: 'ignore',
  })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
  await writeFile(join(dir, 'pid'), String(child.pid), { mode: 0o600 })
  return id
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const readText = (path) => readFile(path, 'utf8').catch(() => null)

/** @returns {'running'|'exited'|'stopped'|'lost'} */
export async function jobState(id, env) {
  const dir = jobDir(id, env)
  if ((await readText(join(dir, 'rc'))) !== null) return 'exited'
  if ((await readText(join(dir, 'stopped'))) !== null) return 'stopped'
  const pid = Number((await readText(join(dir, 'pid'))) ?? NaN)
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return 'running'
  // 刚跑完的瞬间：rc 可能在上面检查之后才写好
  if ((await readText(join(dir, 'rc'))) !== null) return 'exited'
  return 'lost'
}

export async function readMeta(id, env) {
  const text = await readText(join(jobDir(id, env), 'meta.json'))
  if (text === null) throw new Error(`没有这个任务：${id}`)
  return JSON.parse(text)
}

export async function exitCodeOf(id, env) {
  const text = await readText(join(jobDir(id, env), 'rc'))
  const code = Number(String(text ?? '').trim())
  return Number.isInteger(code) && text !== null ? code : null
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** 读输出文件，太长就只留头尾：错误信息常在开头，结果常在结尾 */
export async function readCapped(path, head = HEAD, tail = TAIL) {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return { text: '', truncated: false }
  }
  try {
    const { size } = await handle.stat()
    if (size <= head + tail) {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(size), 0, size, 0)
      return { text: buffer.subarray(0, bytesRead).toString('utf8').replace(ANSI, ''), truncated: false }
    }
    const a = await handle.read(Buffer.alloc(head), 0, head, 0)
    const b = await handle.read(Buffer.alloc(tail), 0, tail, size - tail)
    const text = `${a.buffer.toString('utf8')}\n\n...[中间已省略，完整输出见文件]...\n\n${b.buffer.toString('utf8')}`
    return { text: text.replace(ANSI, ''), truncated: true }
  } finally {
    await handle.close()
  }
}

/** 字符串版的头尾截断：agent 的 JSON 要整段解析后，再截回复 */
export function capText(text, head = HEAD, tail = TAIL) {
  if (text.length <= head + tail) return { text, truncated: false }
  return { text: `${text.slice(0, head)}\n\n...[中间已省略，完整输出见文件]...\n\n${text.slice(-tail)}`, truncated: true }
}

/** 等任务结束，最多等 timeoutMs。取消信号到了就停掉任务（只有前台等待时才传 signal） */
export async function waitForJob(id, { timeoutMs, signal, env }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) {
      await stopJob(id, env)
      return 'stopped'
    }
    const state = await jobState(id, env)
    if (state !== 'running') return state
    if (Date.now() >= deadline) return 'running'
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** 按进程组终止。先 TERM，等一会儿不退再 KILL */
export async function stopJob(id, env) {
  const dir = jobDir(id, env)
  const state = await jobState(id, env)
  if (state !== 'running') return state
  const pid = Number(await readText(join(dir, 'pid')))
  await writeFile(join(dir, 'stopped'), String(Date.now()), { mode: 0o600 })
  const signalGroup = (name) => {
    try {
      process.kill(-pid, name)
    } catch {
      // 已经退出
    }
  }
  signalGroup('SIGTERM')
  const deadline = Date.now() + STOP_GRACE_MS
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  if (isAlive(pid)) signalGroup('SIGKILL')
  return 'stopped'
}

/** 列出目录里生成的文件，最多 200 个 */
export async function listFiles(root, limit = 200) {
  const found = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) found.push(full)
    }
  }
  await walk(root)
  return found
}

/** 记住会话的目标和目录：Qoder 只在原目录下才能找到会话 */
export async function saveSession(session, data, env) {
  await mkdir(sessionsRoot(env), { recursive: true, mode: 0o700 })
  await writeFile(join(sessionsRoot(env), `${sessionFile(session)}.json`), JSON.stringify(data), { mode: 0o600 })
}

export async function loadSession(session, env) {
  const text = await readText(join(sessionsRoot(env), `${sessionFile(session)}.json`))
  return text === null ? null : JSON.parse(text)
}

function sessionFile(session) {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(session))) throw new Error(`会话号不合法：${session}`)
  return session
}

/** 清理旧任务：超过 7 天的、以及超过 50 个的最旧部分。还在跑的不动 */
export async function pruneJobs(env, now = Date.now()) {
  let names
  try {
    names = await readdir(jobsRoot(env))
  } catch {
    return 0
  }
  const jobs = []
  for (const name of names.filter((n) => JOB_ID.test(n))) {
    const info = await stat(join(jobsRoot(env), name)).catch(() => null)
    if (info) jobs.push({ name, mtime: info.mtimeMs })
  }
  jobs.sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  for (const [index, job] of jobs.entries()) {
    const tooOld = now - job.mtime > KEEP_DAYS * 86_400_000
    if (!tooOld && index < KEEP_COUNT) continue
    if ((await jobState(job.name, env)) === 'running') continue
    await rm(join(jobsRoot(env), job.name), { recursive: true, force: true })
    removed += 1
  }
  return removed
}
