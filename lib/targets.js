// lib/targets.js — 每家一条配置（思路来自 Orca 的 tui-agent-config）
//
// 三种类型：
//   agent    把一段任务交给对方的 agent，它自己干完再回复（Qoder、OpenCode）
//   tools    直接调用对方提供的工具，不经过对方的大模型（MiniMax）
//   command  普通程序，按参数运行（ffmpeg、say、Blender）。电脑里的工具都可以这样接
//
// 这里的参数都实测过，见 设计方案.md 第九节。
// 注意 Qoder 的 -w 是工作目录、Trae 的 -w 却是 worktree，所以一律用子进程的 cwd，不传这个参数。

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { findCommand, loadUserConfig } from './config.js'

const MINIMAX_APP = '/Applications/MiniMax Code.app'
const READY_TIMEOUT_MS = 30_000
const STATUS_TIMEOUT_MS = 15_000

/** 把 ['-p', '{prompt}'] 里的占位符换成实际值。按数组传，不经过 shell，不存在注入 */
export function fill(template, values) {
  return template.map((part) => part.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? String(values[key]) : whole)))
}

function run(file, args, env, signal) {
  return new Promise((resolve) => {
    execFile(file, args, { env, signal, timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error('已取消'))
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    reject(new Error('已取消'))
  }, { once: true })
})

/** 解析 Qoder 的 JSON 结果。退出码不可靠：未登录时 subtype 是 success，要看 is_error */
function parseQoder(stdout) {
  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const reply = typeof data.result === 'string' ? data.result : ''
  return {
    ok: data.is_error !== true,
    reply,
    session: typeof data.session_id === 'string' ? data.session_id : undefined,
    usage: typeof data.total_credits === 'number' ? { credits: data.total_credits } : undefined,
    hint: /not logged in/i.test(reply) ? '用户还没登录 Qoder。请让用户在终端运行 qodercli login，插件不代办登录。' : undefined,
  }
}

/** 没有专门解析函数的 agent：退出码为 0 就当正常结束，整段输出作为回复 */
function parseText(stdout, exitCode) {
  return { ok: exitCode === 0, reply: stdout.trim() }
}

/** OpenCode 的 --format json：每行一个事件。文字可能分几段，错误单独一行 */
function parseOpencode(stdout) {
  const events = stdout.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  if (!events.length) return null
  const reply = events.filter((e) => e.type === 'text').map((e) => e.part?.text ?? '').join('').trim()
  const failure = events.find((e) => e.type === 'error')
  const costs = events.map((e) => e.part?.cost).filter((c) => typeof c === 'number')
  return {
    ok: !failure,
    reply,
    session: events.find((e) => e.sessionID)?.sessionID,
    usage: costs.length ? { cost: costs.reduce((a, b) => a + b, 0) } : undefined,
    hint: failure ? `OpenCode 报错：${String(failure.error?.data?.message ?? failure.error?.name ?? '未知').slice(0, 300)}` : undefined,
  }
}

/** lms chat 把加载进度条和本地模型的思考过程都打在标准输出里，这些不能当回复传下去 */
export function cleanLmsOutput(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/Loading \S+ \d+%\s*[\u2800-\u28ff]?\s*/g, '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
}

function parseLms(stdout, exitCode) {
  return { ok: exitCode === 0, reply: cleanLmsOutput(stdout) }
}

const PARSERS = { qoder: parseQoder, opencode: parseOpencode, lmstudio: parseLms, text: parseText }

const BUILT_IN = {
  qoder: {
    kind: 'agent',
    label: 'Qoder',
    capabilities: ['code', 'text'],
    description: '编程 agent：把代码任务交给它，它在工作目录里改文件后回复。默认只能改工作目录内的文件，不能执行命令。',
    command: 'qodercli',
    run: ['-p', '-o', 'json', '--', '{prompt}'],
    newSession: ['--session-id', '{session}'],
    resume: ['-r', '{session}'],
    permissionArgs: ['--permission-mode', '{permission}'],
    permission: 'accept_edits',
    bypassValues: ['bypass_permissions'],
    parser: 'qoder',
    async status({ path, env, signal }) {
      const { stdout } = await run(path, ['status'], env, signal)
      // 只判断有没有登录，账号本身不返回
      const line = stdout.split('\n').find((l) => l.startsWith('Account:')) ?? ''
      if (!line) return { ready: true }
      return /not logged in/i.test(line)
        ? { ready: false, hint: '还没登录。请让用户在终端运行 qodercli login，插件不代办登录。' }
        : { ready: true }
    },
    installHint: '没找到 qodercli。请让用户先安装 Qoder CLI。',
  },

  minimax: {
    kind: 'tools',
    label: 'MiniMax Code',
    capabilities: ['video', 'image', 'audio', 'music'],
    description: '多模态工具：图片、视频、音频、音乐的生成和理解，以及用户在 MiniMax Code 里连接的应用。走 MiniMax 套餐。',
    command: '~/.minimax/bin/mcode-tools',
    confirm: true,
    search: (keyword) => ['connector', 'tools', ...(keyword ? ['--keyword', keyword] : [])],
    inspect: (tool) => ['connector', 'tool', tool],
    call: (tool, argsFile) => ['connector', 'call', tool, '--args-file', argsFile],
    // 这两个是独立子命令，对模型来说和普通工具一样
    special: {
      get_asset_url: {
        confirm: false,
        args: (a) => ['get-asset-url', requireValue(a.node_id, 'node_id')],
      },
      upload_temp_url: {
        confirm: true, // 会生成临时公开链接，等于把本地文件传出去
        args: (a) => [
          'upload-temp-url',
          requireAbsolute(a.file_path, 'file_path'),
          ...(a.mime_type ? ['--mime-type', requireValue(a.mime_type, 'mime_type')] : []),
          ...(a.video_reference === true ? ['--video-reference'] : []),
        ],
      },
    },
    /** MiniMax Code 关闭时入口会被删除，所以不在就后台启动并等它就绪 */
    async ensureReady({ env, signal, openApp }) {
      const existing = await findCommand(this.command, env)
      if (existing) return existing
      const appPath = this.appPath ?? MINIMAX_APP
      if (!(await exists(appPath))) throw new Error('没找到 MiniMax Code。请让用户先安装并登录。')
      await openApp(appPath, env)
      const deadline = Date.now() + READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        const path = await findCommand(this.command, env)
        if (path) return path
        await delay(500, signal)
      }
      throw new Error('启动 MiniMax Code 后等了 30 秒，工具入口还没出现。请让用户打开它并确认已登录。')
    },
    async status({ path, env, signal }) {
      if (!path) {
        const installed = await exists(this.appPath ?? MINIMAX_APP)
        return installed
          ? { ready: true, installed: true, hint: 'MiniMax Code 没在运行，调用时会自动在后台启动。' }
          : { ready: false, installed: false, hint: '没找到 MiniMax Code。请让用户先安装并登录。' }
      }
      const { stdout } = await run(path, ['auth', 'status'], env, signal)
      return /"status"\s*:\s*"authenticated"/.test(stdout)
        ? { ready: true }
        : { ready: false, hint: 'MiniMax Code 还没登录。请让用户打开它并登录，插件不代办登录。' }
    },
    installHint: '没找到 MiniMax Code。请让用户先安装并登录。',
  },

  opencode: {
    kind: 'agent',
    label: 'OpenCode',
    capabilities: ['code', 'text'],
    description: '编程和写作 agent，有免费模型。免费模型可能用输入改进模型，不要发敏感内容。默认只读，不改文件。',
    command: 'opencode',
    // plan 是 OpenCode 自带的只读模式。它没有 Qoder 那样的权限参数，所以默认不让它改文件
    run: ['run', '--format', 'json', '--agent', 'plan', '-m', '{model}', '--', '{prompt}'],
    resume: ['-s', '{session}'],
    model: 'opencode/deepseek-v4.1-flash-free',
    parser: 'opencode',
    // 所有 OpenCode 共用一个本地数据库，同时跑会报 database is locked（实测）
    exclusive: 'opencode',
    installHint: '没找到 opencode。请让用户先安装。',
  },

  ffmpeg: { kind: 'command', label: 'ffmpeg', capabilities: ['media-edit'], description: '处理音视频：转码、拼接、加字幕。', command: 'ffmpeg' },
  say: { kind: 'command', label: 'macOS 语音', capabilities: ['tts'], description: '系统自带的文字转语音，免费，音质一般。', command: 'say' },
  blender: { kind: 'command', label: 'Blender', capabilities: ['render'], description: '3D 建模和渲染，免费，本地运行，用 Python 脚本驱动。', command: 'blender', realpath: true },
  chrome: { kind: 'command', label: 'Chrome', capabilities: ['render'], description: '把网页渲染成图片，免费，本地运行。', command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
}

function requireValue(value, name) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`args.${name} 必填`)
  // 值是单独一个参数，不经过 shell；挡的是被对方当成命令行选项
  if (text.startsWith('-')) throw new Error(`args.${name} 不能以 - 开头`)
  return text
}

function requireAbsolute(value, name) {
  const text = requireValue(value, name)
  if (!isAbsolute(text)) throw new Error(`args.${name} 必须是绝对路径`)
  return text
}

/** 工具名只能是名字，防止被当成命令行选项 */
export function checkToolName(tool) {
  if (typeof tool !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(tool)) {
    throw new Error(`工具名不合法：${tool}`)
  }
  return tool
}

const registered = {}

/** 其他插件带来的工具（比如完整版的场景要用的）。优先级低于用户配置 */
export function registerTargets(targets) {
  Object.assign(registered, targets)
}

/** 内置配置 + 其他插件注册的 + 用户配置。用户可以覆盖内置项，也可以自己加 */
export async function loadTargets(env = process.env) {
  const user = await loadUserConfig(env)
  const merged = {}
  for (const [id, target] of Object.entries({ ...BUILT_IN, ...registered })) merged[id] = { capabilities: [], ...target, id }
  for (const [id, override] of Object.entries(user.targets ?? {})) {
    const base = merged[id]
    if (!base && override.kind !== 'agent' && override.kind !== 'command') {
      throw new Error(`配置里的 ${id} 必须写 "kind": "agent" 或 "command"`)
    }
    if (!base && !override.command) throw new Error(`配置里的 ${id} 必须有 command`)
    if (!base && override.kind === 'agent' && !Array.isArray(override.run)) throw new Error(`配置里的 ${id} 必须有 run`)
    merged[id] = { label: id, description: '用户在配置里添加的工具。', capabilities: [], ...base, ...override, id }
  }
  return merged
}

export function getTarget(targets, id) {
  const target = targets[id]
  if (!target) throw new Error(`没有这个目标：${id}。可用：${Object.keys(targets).join('、')}。先用 cli_list 看看。`)
  return target
}

/** 解析 agent 输出：有专门的解析函数且解析成功就用它，否则按纯文本 */
export function parseAgentOutput(target, stdout, exitCode) {
  const parse = PARSERS[target.parser]
  const parsed = parse ? parse(stdout, exitCode) : null
  return parsed ?? parseText(stdout, exitCode)
}
