// lib/tools.js — 给模型的 3 个工具
//
// 工具描述保持短，用法写在 skill（lib/skills/dsh-cli.md）里。
// 约定照 dsh-vps lib/tools.js：
//   - 每个工具都接 exec.signal，否则超时策略切不断
//   - 返回值先转成纯 JSON（DSH 要求无损 JSON），schema 用任意 JSON，模型只看 render 的文字
//   - 没有跳过权限的参数：模型不能给自己提权

import { extrasForModel } from './extras.js'
import { jobAction, listAction, runAction } from './actions.js'
import { bindingOf } from './mode.js'
import { beginCall, endCall, noteJobResult } from './usage.js'

const sessionIdOf = (exec) => (exec?.agent?.session?.id ? String(exec.agent.session.id) : '')

/**
 * 不用 dsh-tools 也能注册的原始格式。
 *
 * 用 `dsh plugin add <目录>` 链接安装时，插件从自己的真实路径加载，import 不到 dsh-tools。
 * 这时必须自己给出完整的 JSON Schema：简写格式 DSH 不认，工具会注册失败（实测踩过，
 * 现象是 skill 在、工具不在，模型只好用 bash 硬来）。
 */
export function rawTool(def) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(def.parameters)) {
    const { required: isRequired, ...rest } = value
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return {
    name: def.name,
    description: def.description,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    output: { schema: { type: 'object' }, render: def.output.render },
    async execute(args, exec) {
      for (const key of required) {
        if (args?.[key] === undefined) throw new Error(`缺少参数 ${key}`)
      }
      return def.execute(args ?? {}, exec)
    },
  }
}

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    return mod.defineTool ?? rawTool
  } catch {
    return rawTool
  }
}

const ANY_JSON = { type: 'json' }

export function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value ?? null))
}

function renderResult(value) {
  const head = [value.target, value.tool, value.state, value.job ? `任务 ${value.job}` : '', value.session ? `会话 ${value.session}` : '']
    .filter(Boolean)
    .join(' · ')
  const parts = [head]
  if (value.ok === false) parts.push('结果：失败')
  if (value.hint) parts.push(value.hint)
  if (value.reply) parts.push(value.reply)
  if (value.output) parts.push(value.output)
  if (value.stderr) parts.push(`stderr：${value.stderr}`)
  if (value.usage) parts.push(`用量：${JSON.stringify(value.usage)}`)
  if (value.files?.length) parts.push(`生成的文件：\n${value.files.join('\n')}`)
  if (value.output_path) parts.push(`完整输出：${value.output_path}`)
  return [{ type: 'text', text: parts.join('\n') }]
}

const withExtras = (extras, result) => (extras.length ? { ...result, extras } : result)

function renderList(value) {
  if (value.targets) {
    // 模型只看本机装了的：接了几十家时，把没装的都列出来只会白花 token
    const installed = value.targets.filter((t) => t.installed)
    const lines = installed.map((t) => {
      const status = t.ready ? '可用' : '不可用'
      const permission = t.permission ? ` 权限:${t.permission}` : ''
      const tags = t.capabilities?.length ? ` [${t.capabilities.join(',')}]` : ''
      return `${t.target}（${t.kind}，${status}${permission}）${tags} ${t.description}${t.hint ? ` ${t.hint}` : ''}`
    })
    const missing = value.targets.length - installed.length
    if (missing) lines.push(`另有 ${missing} 个没有安装。`)
    for (const extra of value.extras ?? []) lines.push(`可选插件 ${extra.name}（${extra.for}），用户同意后才能装：${extra.command}`)
    return [{ type: 'text', text: lines.join('\n') || '没有可用目标' }]
  }
  if (value.detail) return [{ type: 'text', text: value.detail }]
  const extra = value.extra_tools?.length ? `\n另外还有：${value.extra_tools.join('、')}` : ''
  return [{ type: 'text', text: `${value.tools}${extra}` }]
}

export async function buildToolDefinitions(ctx, deps = {}) {
  const defineTool = deps.defineTool ?? await loadDefineTool()
  const env = deps.env ?? process.env
  const openApp = deps.openApp

  return [
    defineTool({
      name: 'cli_list',
      description:
        '看用户本机能调用哪些 AI 工具。不传参数列出全部及是否可用；传 capability 按能力筛选，自己选合适的一家；' +
        '传 target + keyword 搜索工具（如 video）；传 target + tool 看单个工具的参数。',
      parameters: {
        capability: { type: 'string', description: '按能力筛选，如 code、text、video、image、audio、music、tts、render、media-edit' },
        target: { type: 'string', description: '目标，如 minimax' },
        keyword: { type: 'string', description: '搜索词，如 video、image、music' },
        tool: { type: 'string', description: '工具名，用来查看它的完整参数' },
      },
      output: { schema: ANY_JSON, render: (_a, v) => renderList(v) },
      async execute(args, exec) {
        const extras = args.target ? [] : extrasForModel()
        return toPlainJson(withExtras(extras, await listAction({ target: args.target, keyword: args.keyword, tool: args.tool, capability: args.capability, env, signal: exec?.signal, openApp })))
      },
    }),

    defineTool({
      name: 'cli_run',
      description:
        '调用用户本机的 AI 工具，用的是用户自己的订阅。agent 类型传 prompt，工具类型传 tool 和 args。' +
        '结果里 ok 为真只表示对方正常结束，agent 的回复和实际改动要自己检查。超过等待上限会转后台，用 cli_job 查询。',
      parameters: {
        target: { type: 'string', description: '目标，如 qoder、minimax。先用 cli_list 确认。对话打开了开关时可以省略' },
        prompt: { type: 'string', description: 'agent 类型：交给对方的完整任务' },
        session: { type: 'string', description: 'agent 类型：接着之前的会话继续，填上次返回的会话号' },
        cwd: { type: 'string', description: 'agent 类型：工作目录（绝对路径）。不传就用一个新的任务目录' },
        model: { type: 'string', description: 'agent 类型：指定模型，不传用默认' },
        tool: { type: 'string', description: '工具类型：工具名' },
        args: { type: 'object', additionalProperties: true, description: '工具类型：工具参数。普通程序：{ "argv": ["参数", ...] }' },
        background: { type: 'boolean', description: '长任务：true 表示不等结果，立刻返回任务号' },
        timeout_seconds: { type: 'integer', description: '等待上限（秒），最多 600，超过转后台，任务不会停' },
      },
      output: { schema: ANY_JSON, render: (_a, v) => renderResult(v) },
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec)
        const binding = bindingOf(sessionId)
        const target = args.target || binding?.target
        if (!target) throw new Error('没有指定 target，这个对话也没有打开开关。先用 cli_list 看有哪些目标。')
        const call = beginCall(sessionId, { target, tool: args.tool })
        let result = null
        try {
          result = toPlainJson(await runAction({
            target,
            prompt: args.prompt,
            session: args.session,
            cwd: args.cwd,
            model: args.model,
            tool: args.tool,
            args: args.args,
            background: args.background === true,
            timeoutSeconds: args.timeout_seconds,
            ctx,
            env,
            signal: exec?.signal,
            openApp,
            agent: exec?.agent,
            callId: exec?.callId,
          }))
          return result
        } finally {
          endCall(sessionId, call, result ?? { state: 'error', ok: false })
        }
      },
    }),

    defineTool({
      name: 'cli_job',
      description: '查询或终止 cli_run 的任务：status 查状态和结果，stop 终止。',
      parameters: {
        job: { type: 'string', required: true, description: '任务号' },
        action: { type: 'string', enum: ['status', 'stop'], required: true },
      },
      output: { schema: ANY_JSON, render: (_a, v) => renderResult(v) },
      async execute(args, exec) {
        const result = toPlainJson(await jobAction({ job: args.job, action: args.action, env }))
        noteJobResult(sessionIdOf(exec), result)
        return result
      },
    }),
  ]
}

export async function registerTools(ctx, deps = {}) {
  const defs = await buildToolDefinitions(ctx, deps)
  return defs.map((def) => ctx.tools.register(def))
}
