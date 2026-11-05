import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { _resetDirect, directStateOf, DirectAdapter, formatReply, lastUserInput, loadDirectState, registerDirectHook, ROUTE } from '../lib/direct.js'
import { loadBindings, setBinding } from '../lib/mode.js'
import { _resetUsage, usageOf } from '../lib/usage.js'
import { fakeCtx, makeEnv } from './helpers.js'

const QODER = { target: 'qoder', kind: 'agent', label: 'Qoder' }
const MINIMAX = { target: 'minimax', kind: 'tools', label: 'MiniMax Code' }
const ORIGIN = { provider: 'workbuddy', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }

beforeEach(async () => {
  _resetDirect()
  _resetUsage()
})

async function setup(id = 's') {
  const made = await makeEnv()
  await loadBindings(made.env)
  await loadDirectState(made.env)
  const hooks = {}
  registerDirectHook({ on: (name, fn) => { hooks[name] = fn; return () => {} } }, { env: made.env })
  const session = { id, header: { cwd: made.root } }
  const request = (seed = ORIGIN) => hooks['agent/request']({ agent: { session } }, async () => seed)
  const preStep = (messages) => hooks['agent/pre-step']({ agent: { session }, messages }, async () => ({ kind: 'enter', messages }))
  const adapter = new DirectAdapter({ env: made.env, ctx: fakeCtx() })
  const ask = async (text, extra = {}) => {
    const chunks = []
    for await (const chunk of adapter.stream({
      sessionId: id,
      model: 'qoder',
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
      ...extra,
    })) chunks.push(chunk)
    return chunks
  }
  return { ...made, id, request, preStep, adapter, ask }
}

const textOf = (chunks) => chunks.find((c) => c.type === 'block-end')?.block.text ?? ''

// —— 改写和还原 ——

test('改写：开关开着转到 dsh-cli 通道，不带原来的推理强度', async () => {
  const { env, id, request } = await setup()
  await setBinding(id, QODER, env)
  assert.deepEqual(await request(), { provider: ROUTE, model: 'qoder' })
})

test('改写：没开开关的对话原样放行', async () => {
  const { request } = await setup()
  assert.deepEqual(await request(), ORIGIN)
})

test('改写：绑定工具类不是直通，仍然走模型', async () => {
  const { env, id, request } = await setup()
  await setBinding(id, MINIMAX, env)
  assert.deepEqual(await request(), ORIGIN)
})

test('还原：关掉开关后回到原来的模型（回归：改过的通道会写进请求头）', async () => {
  const { env, id, request } = await setup()
  await setBinding(id, QODER, env)
  await request()
  // 第二次请求的初始值已经是 dsh-cli，原来的模型不能被覆盖
  assert.deepEqual(await request({ provider: ROUTE, model: 'qoder' }), { provider: ROUTE, model: 'qoder' })
  assert.deepEqual(directStateOf(id).origin, ORIGIN)
  await setBinding(id, null, env)
  assert.deepEqual(await request({ provider: ROUTE, model: 'qoder' }), ORIGIN)
})

test('还原：DSH 重启后也能还原', async () => {
  const { env, id, request } = await setup()
  await setBinding(id, QODER, env)
  await request()
  await setBinding(id, null, env)
  _resetDirect()
  await loadDirectState(env)
  assert.deepEqual(await request({ provider: ROUTE, model: 'qoder' }), ORIGIN)
})

test('还原：对话还没选过模型时不保存空值，开关也能用', async () => {
  const { env, id, request } = await setup()
  await setBinding(id, QODER, env)
  assert.deepEqual(await request({ provider: '', model: '' }), { provider: ROUTE, model: 'qoder' })
  assert.equal(directStateOf(id).origin, undefined)
})

// —— 运行 CLI ——

test('直通：把用户的话交给 CLI，在对话的工作目录运行，dsh 用量为 0', async () => {
  const { env, id, root, log, request, ask } = await setup()
  await setBinding(id, QODER, env)
  await request()
  const chunks = await ask('写个文件')
  assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.match(textOf(chunks), /PONG/)
  assert.match(textOf(chunks), /0\.25 credits/)
  assert.deepEqual(chunks.find((c) => c.type === 'usage').usage, { inputTokens: 0, outputTokens: 0 })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  const args = (await readFile(join(log, 'qoder-args'), 'utf8')).trim().split('\n')
  assert.equal(args.at(-1), '写个文件')
  assert.equal((await readFile(join(log, 'qoder-cwd'), 'utf8')).trim(), await realpath(root))
  const usage = await usageOf(id, env)
  assert.equal(usage.calls, 1)
  assert.deepEqual(usage.running, [])
})

test('直通：之前失败的消息不会被一起转给 CLI（回归）', async () => {
  const { env, id, log, request, preStep, adapter } = await setup()
  await setBinding(id, QODER, env)
  const user = (mid, text) => ({ id: mid, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const old = user('m1', '之前失败的那条')
  const current = user('m2', '这次的')
  const decision = await preStep([current])
  assert.equal(decision.kind, 'enter', '不改变原来的决定')
  await request()
  for await (const _chunk of adapter.stream({ sessionId: id, model: 'qoder', messages: [old, current] })) { /* 读完 */ }
  const args = (await readFile(join(log, 'qoder-args'), 'utf8')).trim().split('\n')
  assert.equal(args.at(-1), '这次的')
  assert.ok(!args.join('\n').includes('之前失败的那条'))
})

test('直通：没开开关的对话不记录领取的消息', async () => {
  const { id, preStep, request, ask, log } = await setup()
  await preStep([{ id: 'm1' }])
  await request()
  await ask('不应该运行')
  await assert.rejects(readFile(join(log, 'qoder-args')))
  assert.equal(directStateOf(id).cliSessions, undefined)
})

test('直通：第二条接着同一个 CLI 会话', async () => {
  const { env, id, log, request, ask } = await setup()
  await setBinding(id, QODER, env)
  await request()
  await ask('第一条')
  const session = directStateOf(id).cliSessions.qoder
  assert.ok(session)
  await request()
  await ask('第二条')
  const args = (await readFile(join(log, 'qoder-args'), 'utf8')).trim().split('\n')
  assert.equal(args[args.indexOf('-r') + 1], session)
  assert.ok(!args.includes('--session-id'))
})

test('直通：不是对话主循环的请求绝不启动 CLI（比如自动生成标题）', async () => {
  const { env, id, log, ask } = await setup()
  await setBinding(id, QODER, env)
  const chunks = await ask('Generate a title')
  assert.deepEqual(chunks.map((c) => c.type), ['usage', 'finish'])
  await assert.rejects(readFile(join(log, 'qoder-args')))
})

test('直通：放行只用一次，重复的请求不会再跑一遍', async () => {
  const { env, id, request, ask } = await setup()
  await setBinding(id, QODER, env)
  await request()
  await ask('一次')
  await ask('重复')
  assert.equal((await usageOf(id, env)).calls, 1)
})

test('直通：CLI 失败、未登录都如实显示，不抛错让轮次失败', async () => {
  const { env, id, request, ask } = await setup()
  await setBinding(id, QODER, env)
  await request()
  const crash = textOf(await ask('CRASH'))
  assert.match(crash, /Qoder 没有完成/)
  assert.match(crash, /boom/)
  await request()
  assert.match(textOf(await ask('NOTLOGGED')), /qodercli login/)
  assert.equal(directStateOf(id).cliSessions?.qoder, undefined, '失败的会话不保存')
})

test('直通：工作目录不合适时说明原因', async () => {
  const made = await makeEnv()
  await loadBindings(made.env)
  await loadDirectState(made.env)
  const hooks = {}
  registerDirectHook({ on: (name, fn) => { hooks[name] = fn; return () => {} } }, { env: made.env })
  await setBinding('h', QODER, made.env)
  await hooks['agent/request']({ agent: { session: { id: 'h', header: { cwd: made.home } } } }, async () => ORIGIN)
  const adapter = new DirectAdapter({ env: made.env, ctx: fakeCtx() })
  const chunks = []
  for await (const c of adapter.stream({ sessionId: 'h', model: 'qoder', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(c)
  assert.match(textOf(chunks), /家目录/)
})

test('直通：取消时停掉 CLI', async () => {
  const { env, id, request, ask } = await setup()
  await setBinding(id, QODER, env)
  await request()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 400)
  const chunks = await ask('SLOW', { signal: controller.signal })
  assert.match(textOf(chunks), /没有结束|stopped/)
  assert.deepEqual((await usageOf(id, env)).running, [])
})

test('通道：不进模型选择器，不重试，声明上下文窗口', async () => {
  const adapter = new DirectAdapter()
  assert.deepEqual(await adapter.listModels(ROUTE), [])
  assert.equal(adapter.providerRetryPolicy().maxRetries, 0)
  assert.deepEqual(adapter.providerInfo(ROUTE), { id: ROUTE, name: 'dsh-cli' })
  const call = await adapter.prepareCall(ROUTE, 'qoder')
  assert.equal(call.model.id, 'qoder')
  assert.equal(typeof call.stream, 'function')
})

// —— 消息提取 ——

test('提取：只要最后一条回复之后用户说的话，不要系统注入的内容', () => {
  const user = (text, kind = 'user') => ({ role: 'user', source: { kind }, content: [{ type: 'text', text }] })
  const { text } = lastUserInput([
    user('上一轮'),
    { role: 'assistant', content: [{ type: 'text', text: '回复' }] },
    user('当前时间', 'time-context'),
    user('技能目录', 'skill-catalog'),
    user('第一句'),
    user('第二句'),
    user('运行环境', 'runtime-context'),
  ])
  assert.equal(text, '第一句\n\n第二句')
})

test('提取：附件不转交，但会提示', () => {
  const r = lastUserInput([{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image' }] }])
  assert.equal(r.text, '看图')
  assert.equal(r.hasAttachment, true)
  assert.equal(lastUserInput([]).text, '')
})

test('回复：显示生成的文件和用量；被拒绝时显示原因', () => {
  const ok = formatReply('Qoder', { state: 'done', ok: true, reply: 'DONE', files: ['/a/b.txt'], usage: { credits: 0.1234 } })
  assert.match(ok, /DONE/)
  assert.match(ok, /\/a\/b\.txt/)
  assert.match(ok, /0\.123 credits/)
  assert.equal(formatReply('Qoder', { state: 'refused', hint: '用户拒绝了' }), '用户拒绝了')
  assert.match(formatReply('Qoder', { state: 'done', ok: true, reply: '' }), /没有回复内容/)
})
