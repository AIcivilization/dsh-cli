import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { jobAction, listAction, runAction } from '../lib/actions.js'
import { isReadOnlyTool, summarizeArgs } from '../lib/approval.js'
import { dataDir, findCommand } from '../lib/config.js'
import { jobDir, jobsRoot, jobState, pruneJobs } from '../lib/jobs.js'
import { cleanLmsOutput } from '../lib/targets.js'
import { fakeCtx, installMinimax, makeEnv } from './helpers.js'

const qoderArgs = async (log) => (await readFile(join(log, 'qoder-args'), 'utf8')).trim().split('\n')
const until = async (check, ms = 5000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

// —— agent：Qoder ——

test('agent：默认 accept_edits，提示词放在 -- 之后，返回回复、会话和用量', async () => {
  const { env, log } = await makeEnv()
  const r = await runAction({ target: 'qoder', prompt: '-x 以横线开头', ctx: fakeCtx(), env })
  assert.equal(r.ok, true)
  assert.equal(r.state, 'done')
  assert.equal(r.reply, 'PONG')
  assert.deepEqual(r.usage, { credits: 0.25 })
  const args = await qoderArgs(log)
  assert.deepEqual(args.slice(0, 2), ['--permission-mode', 'accept_edits'])
  assert.ok(args.includes('--session-id'))
  assert.deepEqual(args.slice(-5), ['-p', '-o', 'json', '--', '-x 以横线开头'])
  assert.equal(r.session, args[args.indexOf('--session-id') + 1])
})

test('agent：引号、$、反引号和换行原样传递，不经过 shell', async () => {
  const { env, log } = await makeEnv()
  const prompt = 'A"B\'C $HOME `id` ; rm -rf /'
  await runAction({ target: 'qoder', prompt, ctx: fakeCtx(), env })
  assert.equal((await qoderArgs(log)).at(-1), prompt)
})

test('agent：未登录时报失败并给出提示，退出码不是唯一依据', async () => {
  const { env } = await makeEnv()
  const r = await runAction({ target: 'qoder', prompt: 'NOTLOGGED', ctx: fakeCtx(), env })
  assert.equal(r.ok, false)
  assert.match(r.hint, /qodercli login/)
})

test('agent：崩溃时带上 stderr', async () => {
  const { env } = await makeEnv()
  const r = await runAction({ target: 'qoder', prompt: 'CRASH', ctx: fakeCtx(), env })
  assert.equal(r.ok, false)
  assert.equal(r.exitCode, 42)
  assert.match(r.stderr, /boom/)
})

test('agent：回复很长时 JSON 仍能解析，回复被截断并给出完整文件', async () => {
  const { env } = await makeEnv()
  const r = await runAction({ target: 'qoder', prompt: 'HUGE', ctx: fakeCtx(), env })
  assert.equal(r.ok, true)
  assert.ok(r.reply.length < 20_000)
  assert.match(r.reply, /已省略/)
  assert.ok(r.output_path)
})

test('agent：不传 cwd 时在任务目录干活，并列出生成的文件', async () => {
  const { env } = await makeEnv()
  const r = await runAction({ target: 'qoder', prompt: 'MAKEFILE', ctx: fakeCtx(), env })
  assert.equal(r.files.length, 1)
  assert.match(r.files[0], /made\.txt$/)
})

test('agent：传了 cwd 就在那里干活，不扫描文件', async () => {
  const { env, root, log } = await makeEnv()
  const project = join(root, 'project')
  await mkdir(project)
  const r = await runAction({ target: 'qoder', prompt: 'MAKEFILE', cwd: project, ctx: fakeCtx(), env })
  assert.equal(r.files, undefined)
  assert.equal((await readFile(join(log, 'qoder-cwd'), 'utf8')).trim(), await realpath(project))
})

test('agent：cwd 不能是根目录、家目录、相对路径或不存在的目录', async () => {
  const { env, home, root } = await makeEnv()
  for (const cwd of ['/', home, 'relative/path', join(root, 'nope')]) {
    await assert.rejects(runAction({ target: 'qoder', prompt: 'x', cwd, ctx: fakeCtx(), env }), /cwd/, cwd)
  }
})

test('agent：继续会话时自动回到原目录，换目录和未知会话都报错', async () => {
  const { env, root, log } = await makeEnv()
  const project = join(root, 'project')
  const other = join(root, 'other')
  await mkdir(project)
  await mkdir(other)
  const first = await runAction({ target: 'qoder', prompt: 'first', cwd: project, ctx: fakeCtx(), env })

  const second = await runAction({ target: 'qoder', prompt: 'second', session: first.session, ctx: fakeCtx(), env })
  assert.equal(second.ok, true)
  assert.equal(second.session, first.session)
  const args = await qoderArgs(log)
  assert.equal(args[args.indexOf('-r') + 1], first.session)
  assert.ok(!args.includes('--session-id'))
  assert.equal((await readFile(join(log, 'qoder-cwd'), 'utf8')).trim(), await realpath(project))

  await assert.rejects(runAction({ target: 'qoder', prompt: 'x', session: first.session, cwd: other, ctx: fakeCtx(), env }), /不能换目录/)
  await assert.rejects(runAction({ target: 'qoder', prompt: 'x', session: 'aaaaaaaa-unknown', ctx: fakeCtx(), env }), /不认识这个会话/)
  await assert.rejects(runAction({ target: 'qoder', prompt: 'x', session: '../../etc/passwd', ctx: fakeCtx(), env }), /不合法/)
})

test('agent：没传 prompt 报错；没装时给安装提示', async () => {
  const { env } = await makeEnv()
  await assert.rejects(runAction({ target: 'qoder', ctx: fakeCtx(), env }), /prompt/)
  const missing = await makeEnv({ qoder: false })
  await assert.rejects(runAction({ target: 'qoder', prompt: 'x', ctx: fakeCtx(), env: missing.env }), /qodercli/)
})

// —— 后台任务 ——

test('任务：超过等待上限转后台，任务不停，cli_job 能查能停', async () => {
  const { env } = await makeEnv()
  const r = await runAction({ target: 'qoder', prompt: 'SLOW', timeoutSeconds: 1, ctx: fakeCtx(), env })
  assert.equal(r.state, 'running')
  assert.ok(r.session)
  assert.equal((await jobAction({ job: r.job, action: 'status', env })).state, 'running')
  const stopped = await jobAction({ job: r.job, action: 'stop', env })
  assert.equal(stopped.state, 'stopped')
  assert.ok(await until(async () => (await jobState(r.job, env)) === 'stopped'))
})

test('任务：background 立刻返回，跑完后 cli_job 拿到结果', async () => {
  const { env } = await makeEnv()
  const r = await runAction({ target: 'qoder', prompt: 'quick', background: true, ctx: fakeCtx(), env })
  assert.ok(['running', 'done'].includes(r.state))
  assert.ok(await until(async () => (await jobState(r.job, env)) === 'exited'))
  const done = await jobAction({ job: r.job, action: 'status', env })
  assert.equal(done.reply, 'PONG')
})

test('任务：前台等待时取消信号会停掉任务', async () => {
  const { env } = await makeEnv()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 500)
  const r = await runAction({ target: 'qoder', prompt: 'SLOW', timeoutSeconds: 20, signal: controller.signal, ctx: fakeCtx(), env })
  assert.equal(r.state, 'stopped')
})

test('任务：任务号不合法或不存在都报错，不会走出任务目录', async () => {
  const { env } = await makeEnv()
  await assert.rejects(jobAction({ job: '../../secret', action: 'status', env }), /不合法/)
  await assert.rejects(jobAction({ job: '0123456789abcdef', action: 'status', env }), /没有这个任务/)
})

test('任务：清理旧任务，新的留下', async () => {
  const { env } = await makeEnv()
  const oldJob = await runAction({ target: 'qoder', prompt: 'old', ctx: fakeCtx(), env })
  const newJob = await runAction({ target: 'qoder', prompt: 'new', ctx: fakeCtx(), env })
  const past = new Date(Date.now() - 8 * 86_400_000)
  await utimes(jobDir(oldJob.job, env), past, past)
  assert.equal(await pruneJobs(env), 1)
  await assert.rejects(jobAction({ job: oldJob.job, action: 'status', env }), /没有这个任务/)
  assert.equal((await jobAction({ job: newJob.job, action: 'status', env })).reply, 'PONG')
  assert.ok(jobsRoot(env).startsWith(dataDir(env)))
})

// —— 工具：MiniMax ——

test('工具：生成类调用先确认，确认框带上模型和时长', async () => {
  const { env, log } = await makeEnv()
  const ctx = fakeCtx()
  const args = { model: 'MiniMax-Hailuo-2.3', duration: 6, prompt: '纸船'.repeat(100) }
  const r = await runAction({ target: 'minimax', tool: 'connector__matrix__submit_video_generation', args, ctx, env })
  assert.equal(r.ok, true)
  assert.match(r.output, /"task_id":"t1"/)
  assert.equal(ctx.asked.length, 1)
  assert.equal(ctx.asked[0].toolName, 'cli_run')
  assert.match(ctx.asked[0].reason, /MiniMax-Hailuo-2\.3/)
  assert.match(ctx.asked[0].reason, /duration=6/)
  assert.ok(ctx.asked[0].reason.length <= 300)
  assert.deepEqual(JSON.parse(await readFile(join(log, 'mcode-call-args'), 'utf8')), args)
})

test('工具：用户拒绝就不执行', async () => {
  const { env, log } = await makeEnv()
  const r = await runAction({ target: 'minimax', tool: 'connector__matrix__submit_video_generation', args: {}, ctx: fakeCtx('rejected'), env })
  assert.equal(r.state, 'refused')
  assert.equal(r.ok, false)
  await assert.rejects(readFile(join(log, 'mcode-args')))
})

test('工具：没有确认界面时按拒绝处理', async () => {
  const { env, log } = await makeEnv()
  const r = await runAction({ target: 'minimax', tool: 'connector__lark__send_message', args: {}, ctx: {}, env })
  assert.equal(r.state, 'refused')
  assert.match(r.hint, /确认/)
  await assert.rejects(readFile(join(log, 'mcode-args')))
})

test('工具：只读工具不问；其余一律问，包括不认识的工具', () => {
  assert.equal(isReadOnlyTool('connector__matrix__query_video_generation'), true)
  assert.equal(isReadOnlyTool('connector__matrix__list_voices'), true)
  assert.equal(isReadOnlyTool('connector__matrix__submit_video_generation'), false)
  assert.equal(isReadOnlyTool('connector__matrix__synthesize_speech'), false)
  assert.equal(isReadOnlyTool('connector__lark__send_message'), false)
  assert.equal(isReadOnlyTool('something_new'), false)
})

test('工具：查询不弹确认；业务 code 非 0 算失败', async () => {
  const { env } = await makeEnv()
  const ctx = fakeCtx()
  const ok = await runAction({ target: 'minimax', tool: 'connector__matrix__query_video_generation', args: { task_id: 't1' }, ctx, env })
  assert.equal(ok.ok, true)
  assert.equal(ctx.asked.length, 0)
  const bad = await runAction({ target: 'minimax', tool: 'connector__matrix__query_FAIL', args: {}, ctx, env })
  assert.equal(bad.ok, false)
})

test('工具：用户可以在配置里关闭确认', async () => {
  const { env } = await makeEnv()
  await mkdir(dataDir(env), { recursive: true })
  await writeFile(join(dataDir(env), 'config.json'), JSON.stringify({ targets: { minimax: { confirm: false } } }))
  const ctx = fakeCtx()
  const r = await runAction({ target: 'minimax', tool: 'connector__matrix__submit_video_generation', args: {}, ctx, env })
  assert.equal(r.ok, true)
  assert.equal(ctx.asked.length, 0)
})

test('工具：get_asset_url 和 upload_temp_url 转成子命令，上传要确认', async () => {
  const { env, log } = await makeEnv()
  const ctx = fakeCtx()
  const asset = await runAction({ target: 'minimax', tool: 'get_asset_url', args: { node_id: '123' }, ctx, env })
  assert.match(asset.output, /download_url/)
  assert.equal(ctx.asked.length, 0)
  assert.deepEqual((await readFile(join(log, 'mcode-args'), 'utf8')).trim().split('\n'), ['get-asset-url', '123'])

  await runAction({ target: 'minimax', tool: 'upload_temp_url', args: { file_path: '/tmp/a.png', mime_type: 'image/png' }, ctx, env })
  assert.equal(ctx.asked.length, 1)
  assert.deepEqual((await readFile(join(log, 'mcode-args'), 'utf8')).trim().split('\n'), ['upload-temp-url', '/tmp/a.png', '--mime-type', 'image/png'])

  await assert.rejects(runAction({ target: 'minimax', tool: 'upload_temp_url', args: { file_path: 'relative.png' }, ctx, env }), /绝对路径/)
  await assert.rejects(runAction({ target: 'minimax', tool: 'get_asset_url', args: { node_id: '--evil' }, ctx, env }), /不能以 - 开头/)
  await assert.rejects(runAction({ target: 'minimax', tool: 'get_asset_url', args: {}, ctx, env }), /node_id/)
})

test('工具：工具名不能当命令行选项；没传 tool 报错', async () => {
  const { env } = await makeEnv()
  await assert.rejects(runAction({ target: 'minimax', tool: '--help', args: {}, ctx: fakeCtx(), env }), /不合法/)
  await assert.rejects(runAction({ target: 'minimax', tool: 'a b', args: {}, ctx: fakeCtx(), env }), /不合法/)
  await assert.rejects(runAction({ target: 'minimax', ctx: fakeCtx(), env }), /必须传 tool/)
})

test('工具：入口不在时启动应用并等它出现（app 关闭后入口会被删除）', async () => {
  const { env, home, root } = await makeEnv({ minimax: false })
  const appPath = join(root, 'MiniMax Code.app')
  await mkdir(appPath)
  await mkdir(dataDir(env), { recursive: true })
  await writeFile(join(dataDir(env), 'config.json'), JSON.stringify({ targets: { minimax: { appPath } } }))
  const opened = []
  const openApp = async (path) => {
    opened.push(path)
    setTimeout(() => installMinimax(home), 300)
  }
  const r = await runAction({ target: 'minimax', tool: 'get_asset_url', args: { node_id: '1' }, ctx: fakeCtx(), env, openApp })
  assert.equal(r.ok, true)
  assert.deepEqual(opened, [appPath])
})

test('工具：应用没装时报错，不尝试启动', async () => {
  const { env, root } = await makeEnv({ minimax: false })
  await mkdir(dataDir(env), { recursive: true })
  await writeFile(join(dataDir(env), 'config.json'), JSON.stringify({ targets: { minimax: { appPath: join(root, 'nope.app') } } }))
  let opened = false
  await assert.rejects(
    runAction({ target: 'minimax', tool: 'get_asset_url', args: { node_id: '1' }, ctx: fakeCtx(), env, openApp: async () => { opened = true } }),
    /没找到 MiniMax Code/,
  )
  assert.equal(opened, false)
})

// —— 权限 ——

test('权限：跳过权限只能由用户配置开启，开了也每次确认', async () => {
  const { env, log } = await makeEnv()
  await mkdir(dataDir(env), { recursive: true })
  await writeFile(join(dataDir(env), 'config.json'), JSON.stringify({ targets: { qoder: { permission: 'bypass_permissions' } } }))
  const refused = await runAction({ target: 'qoder', prompt: 'x', ctx: fakeCtx('rejected'), env })
  assert.equal(refused.state, 'refused')
  await assert.rejects(readFile(join(log, 'qoder-args')))

  const ctx = fakeCtx()
  await runAction({ target: 'qoder', prompt: 'x', ctx, env })
  assert.equal(ctx.asked.length, 1)
  assert.deepEqual((await qoderArgs(log)).slice(0, 2), ['--permission-mode', 'bypass_permissions'])
})

test('权限：普通 accept_edits 委托不弹确认', async () => {
  const { env } = await makeEnv()
  const ctx = fakeCtx()
  await runAction({ target: 'qoder', prompt: 'x', ctx, env })
  assert.equal(ctx.asked.length, 0)
})

// —— cli_list ——

test('列表：报告是否可用和登录状态，不返回账号', async () => {
  const { env } = await makeEnv()
  const { targets } = await listAction({ env })
  const qoder = targets.find((t) => t.target === 'qoder')
  assert.equal(qoder.ready, true)
  assert.equal(qoder.permission, 'accept_edits')
  assert.ok(!JSON.stringify(targets).includes('someone@example.com'))
  assert.equal(targets.find((t) => t.target === 'minimax').ready, true)
})

test('列表：未登录、未安装都说明原因', async () => {
  const a = await makeEnv({ account: 'Not logged in', auth: 'unauthenticated' })
  const rows = (await listAction({ env: a.env })).targets
  assert.match(rows.find((t) => t.target === 'qoder').hint, /qodercli login/)
  assert.equal(rows.find((t) => t.target === 'qoder').ready, false)
  assert.equal(rows.find((t) => t.target === 'minimax').ready, false)

  const b = await makeEnv({ qoder: false })
  assert.equal((await listAction({ env: b.env })).targets.find((t) => t.target === 'qoder').ready, false)
})

test('列表：能搜索和查看工具；agent 类型没有工具清单', async () => {
  const { env, log } = await makeEnv()
  const found = await listAction({ target: 'minimax', keyword: 'video', env })
  assert.match(found.tools, /submit_video_generation/)
  assert.deepEqual(found.extra_tools, ['get_asset_url', 'upload_temp_url'])
  assert.deepEqual((await readFile(join(log, 'mcode-args'), 'utf8')).trim().split('\n'), ['connector', 'tools', '--keyword', 'video'])
  const one = await listAction({ target: 'minimax', tool: 'connector__x', env })
  assert.match(one.detail, /connector__x/)
  assert.match((await listAction({ target: 'minimax', tool: 'get_asset_url', env })).detail, /node_id/)
  await assert.rejects(listAction({ target: 'qoder', keyword: 'x', env }), /agent 类型/)
  await assert.rejects(listAction({ target: 'nope', env }), /没有这个目标/)
})

// —— 自定义 ——

test('配置：可以加一家 agent，非法配置给出明确错误', async () => {
  const { env, root } = await makeEnv()
  const script = join(root, 'bin', 'my-cli')
  await writeFile(script, '#!/bin/sh\necho "got: $2"\n', { mode: 0o755 })
  await mkdir(dataDir(env), { recursive: true })
  const config = join(dataDir(env), 'config.json')
  await writeFile(config, JSON.stringify({ targets: { mine: { kind: 'agent', command: 'my-cli', run: ['-p', '{prompt}'] } } }))
  const r = await runAction({ target: 'mine', prompt: 'hello', ctx: fakeCtx(), env })
  assert.equal(r.ok, true)
  assert.equal(r.reply, 'got: hello')

  await writeFile(config, JSON.stringify({ targets: { bad: { kind: 'tools' } } }))
  await assert.rejects(listAction({ env }), /必须写 "kind"/)
  await writeFile(config, '{oops')
  await assert.rejects(listAction({ env }), /不是合法 JSON/)
})

test('查找命令：桌面启动时 PATH 很短，也能找到 ~/.local/bin 里的命令', async () => {
  const { env, home } = await makeEnv({ qoder: false })
  await mkdir(join(home, '.local', 'bin'), { recursive: true })
  const path = join(home, '.local', 'bin', 'qodercli')
  await writeFile(path, '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(await findCommand('qodercli', { ...env, PATH: '/usr/bin' }), path)
})

test('确认摘要：长文本截断，对象不展开', () => {
  const text = summarizeArgs({ a: 'x'.repeat(100), b: 2, c: { secret: 1 }, d: null })
  assert.match(text, /a=x{60}…/)
  assert.match(text, /b=2/)
  assert.ok(!text.includes('secret'))
})

// —— 普通程序 ——

test('普通程序：参数按数组传，不经过 shell；退出码决定成败', async () => {
  const { env, root } = await makeEnv()
  await mkdir(dataDir(env), { recursive: true })
  await writeFile(join(dataDir(env), 'config.json'), JSON.stringify({ targets: {
    echoer: { kind: 'command', command: '/bin/echo', capabilities: ['text'] },
    failer: { kind: 'command', command: '/usr/bin/false' },
  } }))
  const r = await runAction({ target: 'echoer', args: { argv: ['a b', '$HOME', ';rm'] }, env })
  assert.equal(r.ok, true)
  assert.equal(r.output, 'a b $HOME ;rm')
  assert.equal((await runAction({ target: 'failer', args: { argv: [] }, env })).ok, false)
  await assert.rejects(runAction({ target: 'echoer', args: {}, env }), /argv/)
  await assert.rejects(runAction({ target: 'echoer', args: { argv: [1] }, env }), /argv/)
  assert.ok(root)
})

test('普通程序：内置 ffmpeg、say 等都列出来，能按能力筛选', async () => {
  const { env } = await makeEnv()
  const { targets } = await listAction({ capability: 'tts', env })
  assert.deepEqual(targets.map((t) => t.target), ['say'])
  assert.equal(targets[0].kind, 'command')
})

// —— OpenCode ——

test('OpenCode：解析事件流，带模型参数，只读模式', async () => {
  const { env, root, log } = await makeEnv()
  const bin = join(root, 'bin', 'opencode')
  await writeFile(bin, `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LOG/oc-args"
echo '{"type":"step_start","sessionID":"ses_1","part":{}}'
echo '{"type":"text","sessionID":"ses_1","part":{"text":"第一段"}}'
echo '{"type":"text","sessionID":"ses_1","part":{"text":"第二段"}}'
echo '{"type":"step_finish","sessionID":"ses_1","part":{"cost":0}}'
`, { mode: 0o755 })
  const r = await runAction({ target: 'opencode', prompt: '-以横线开头', model: 'opencode/x-free', ctx: fakeCtx(), env })
  assert.equal(r.ok, true)
  assert.equal(r.reply, '第一段第二段')
  assert.equal(r.session, 'ses_1')
  assert.deepEqual(r.usage, { cost: 0 })
  const args = (await readFile(join(log, 'oc-args'), 'utf8')).trim().split('\n')
  assert.deepEqual(args.slice(args.indexOf('--agent'), args.indexOf('--agent') + 2), ['--agent', 'plan'])
  assert.equal(args[args.indexOf('-m') + 1], 'opencode/x-free')
  assert.deepEqual(args.slice(-2), ['--', '-以横线开头'])
})

test('OpenCode：报错事件算失败，并带上原因', async () => {
  const { env, root } = await makeEnv()
  await writeFile(join(root, 'bin', 'opencode'), `#!/bin/sh
echo '{"type":"error","sessionID":"s","error":{"name":"ProviderError","data":{"message":"额度用完"}}}'
`, { mode: 0o755 })
  const r = await runAction({ target: 'opencode', prompt: 'x', ctx: fakeCtx(), env })
  assert.equal(r.ok, false)
  assert.match(r.hint, /额度用完/)
})

// —— 实测踩过的坑 ——

test('排队：同一个 exclusive 的调用不会同时跑（OpenCode 同时跑报 database is locked）', async () => {
  const { env, root } = await makeEnv()
  const lock = join(root, 'lock')
  await mkdir(dataDir(env), { recursive: true })
  const script = join(root, 'bin', 'locker')
  await writeFile(script, `#!/bin/sh
if ! mkdir "${lock}" 2>/dev/null; then echo 'database is locked' >&2; exit 9; fi
sleep 0.3
rmdir "${lock}"
echo ok
`, { mode: 0o755 })
  await writeFile(join(dataDir(env), 'config.json'), JSON.stringify({ targets: {
    one: { kind: 'agent', command: 'locker', run: ['{prompt}'], exclusive: 'shared' },
    two: { kind: 'agent', command: 'locker', run: ['{prompt}'], exclusive: 'shared' },
    free: { kind: 'agent', command: 'locker', run: ['{prompt}'] },
  } }))
  const ctx = fakeCtx()
  const results = await Promise.all([
    runAction({ target: 'one', prompt: 'a', ctx, env }),
    runAction({ target: 'two', prompt: 'b', ctx, env }),
    runAction({ target: 'one', prompt: 'c', ctx, env }),
  ])
  assert.deepEqual(results.map((r) => r.ok), [true, true, true])
  // 对照：不排队就会撞车，说明上面的测试不是碰巧通过
  const clashing = await Promise.all([runAction({ target: 'free', prompt: 'a', ctx, env }), runAction({ target: 'free', prompt: 'b', ctx, env })])
  assert.ok(clashing.some((r) => !r.ok))
})

test('排队：一个失败不会卡住后面的；后台任务结束前也占着', async () => {
  const { env, root } = await makeEnv()
  await mkdir(dataDir(env), { recursive: true })
  await writeFile(join(root, 'bin', 'slow'), '#!/bin/sh\nsleep 0.5\necho done >> "$FAKE_LOG/order"\n', { mode: 0o755 })
  await writeFile(join(root, 'bin', 'fast'), '#!/bin/sh\necho fast >> "$FAKE_LOG/order"\nexit 3\n', { mode: 0o755 })
  await writeFile(join(dataDir(env), 'config.json'), JSON.stringify({ targets: {
    slow: { kind: 'agent', command: 'slow', run: ['{prompt}'], exclusive: 'k' },
    fast: { kind: 'agent', command: 'fast', run: ['{prompt}'], exclusive: 'k' },
  } }))
  const ctx = fakeCtx()
  await runAction({ target: 'slow', prompt: 'x', background: true, ctx, env })
  const failed = await runAction({ target: 'fast', prompt: 'x', ctx, env })
  assert.equal(failed.ok, false)
  assert.equal((await runAction({ target: 'fast', prompt: 'y', ctx, env })).ok, false, '失败后还能继续排')
  const { log } = { log: env.FAKE_LOG }
  assert.equal((await readFile(join(log, 'order'), 'utf8')).trim().split('\n')[0], 'done', '后台任务先跑完')
})

test('Blender：通过符号链接启动会起不来，要用真实路径', async () => {
  const { env, root, log } = await makeEnv()
  const { symlink } = await import('node:fs/promises')
  const real = join(root, 'real-blender')
  await writeFile(real, `#!/bin/sh\necho "$0" > "$FAKE_LOG/self"\n`, { mode: 0o755 })
  await symlink(real, join(root, 'bin', 'blender'))
  const r = await runAction({ target: 'blender', args: { argv: [] }, env })
  assert.equal(r.ok, true)
  assert.equal((await readFile(join(log, 'self'), 'utf8')).trim(), await realpath(real))
})

test('本地模型：过滤加载进度条和思考过程', () => {
  const raw = 'Loading m-1 0% ⠋Loading m-1 2% ⠙Loading m-1 100% ⠹\r\n\u001b[2K<think>想一想\n再想想</think>\n第一条\n第二条\n'
  assert.equal(cleanLmsOutput(raw), '第一条\n第二条')
  assert.equal(cleanLmsOutput('普通 100% 文字'), '普通 100% 文字')
})
