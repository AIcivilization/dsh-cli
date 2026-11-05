import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, test } from 'node:test'
import vm from 'node:vm'
import { bindingOf, boundText, lastAnnouncement, loadBindings, OFF_TEXT, planAnnouncement, registerMode, setBinding, SOURCE_KIND } from '../lib/mode.js'
import { createActions, createHandler } from '../lib/routes.js'
import { buildToolDefinitions, rawTool } from '../lib/tools.js'
import { _resetUsage, usageOf } from '../lib/usage.js'
import { fakeCtx, makeEnv } from './helpers.js'

const QODER = { target: 'qoder', kind: 'agent', label: 'Qoder' }
const MINIMAX = { target: 'minimax', kind: 'tools', label: 'MiniMax Code' }

beforeEach(async () => {
  _resetUsage()
  const { env } = await makeEnv()
  await loadBindings(env)
})

async function toolsFor(env) {
  const defs = await buildToolDefinitions(fakeCtx(), { env, defineTool: rawTool })
  return Object.fromEntries(defs.map((d) => [d.name, d]))
}
const execIn = (id, cwd) => ({ signal: new AbortController().signal, agent: { session: { id, header: { cwd } } }, callId: 'c' })

// —— 开关 ——

test('开关：打开后写入文件，重启进程读得回来，关闭后清掉', async () => {
  const { env } = await makeEnv()
  await loadBindings(env)
  await setBinding('s1', QODER, env)
  assert.deepEqual(bindingOf('s1'), QODER)
  assert.equal(bindingOf('s2'), null)
  await loadBindings(env)
  assert.deepEqual(bindingOf('s1'), QODER)
  await setBinding('s1', null, env)
  await loadBindings(env)
  assert.equal(bindingOf('s1'), null)
})

test('开关：target 默认用这个对话绑定的工具，其他对话不受影响', async () => {
  const { env, root, log } = await makeEnv()
  await loadBindings(env)
  await setBinding('bound', MINIMAX, env)
  const tools = await toolsFor(env)
  const r = await tools.cli_run.execute({ tool: 'get_asset_url', args: { node_id: '1' } }, execIn('bound', root))
  assert.equal(r.ok, true)
  assert.match(await readFile(join(log, 'mcode-args'), 'utf8'), /get-asset-url/)
  await assert.rejects(tools.cli_run.execute({ prompt: 'hi' }, execIn('other', root)), /没有指定 target/)
})

test('开关：模型显式指定别的目标时听模型的', async () => {
  const { env, root } = await makeEnv()
  await loadBindings(env)
  await setBinding('s', MINIMAX, env)
  const tools = await toolsFor(env)
  const r = await tools.cli_run.execute({ target: 'qoder', prompt: 'MAKEFILE' }, execIn('s', root))
  assert.equal(r.files.length, 1)
})

// —— 给模型的说明 ——

test('说明：只在变化时发，关闭时说一声，没开过不发', () => {
  assert.equal(planAnnouncement('qoder', null), 'qoder')
  assert.equal(planAnnouncement('qoder', 'qoder'), null)
  assert.equal(planAnnouncement('minimax', 'qoder'), 'minimax')
  assert.equal(planAnnouncement(null, 'qoder'), 'off')
  assert.equal(planAnnouncement(null, 'off'), null)
  assert.equal(planAnnouncement(null, null), null)
})

test('说明：能从会话历史找回上次发过的，重启不重复发', () => {
  const event = (kind, text) => ({ type: 'user/message', data: { source: { kind, sections: [{ text }] } } })
  const session = (events) => ({ seq: events.length, eventAt: (i) => events[i] })
  assert.equal(lastAnnouncement(session([])), null)
  assert.equal(lastAnnouncement(session([event(SOURCE_KIND, boundText(QODER))])), 'qoder')
  assert.equal(lastAnnouncement(session([event(SOURCE_KIND, boundText(QODER)), event(SOURCE_KIND, OFF_TEXT)])), 'off')
  assert.equal(lastAnnouncement(session([event('plugin:other', boundText(QODER))])), null)
})

test('说明：工具类告诉模型会花额度', () => {
  assert.match(boundText(MINIMAX), /花用户的额度/)
})

test('说明：挂在 pre-step 上，绑定变化时追加一条消息，之后不再发；agent 是直通，不发', async () => {
  const { env } = await makeEnv()
  await loadBindings(env)
  let hook
  registerMode({ on: (name, fn) => { assert.equal(name, 'agent/pre-step'); hook = fn; return () => {} } })
  const payload = { agent: { session: { id: 's', seq: 0, eventAt: () => null } } }
  const next = async () => ({ kind: 'continue' })

  assert.equal((await hook(payload, next)).messages, undefined)
  await setBinding('s', QODER, env)
  assert.equal((await hook(payload, next)).messages, undefined, 'agent 直通不需要告诉模型')
  await setBinding('s', MINIMAX, env)
  const first = await hook(payload, next)
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].source.kind, SOURCE_KIND)
  assert.match(first.messages[0].content[0].text, /已绑定 minimax/)
  assert.equal((await hook(payload, next)).messages, undefined)

  await setBinding('s', null, env)
  assert.match((await hook(payload, next)).messages[0].content[0].text, /已关闭/)
})

// —— 指示灯数据 ——

test('使用情况：调用中亮，结束后灭，并累计次数和用量', async () => {
  const { env, root } = await makeEnv()
  await loadBindings(env)
  const tools = await toolsFor(env)
  const pending = tools.cli_run.execute({ target: 'qoder', prompt: 'hi', cwd: root }, execIn('s', root))
  assert.equal((await usageOf('s', env)).running[0].target, 'qoder')
  await pending
  const after = await usageOf('s', env)
  assert.deepEqual(after.running, [])
  assert.equal(after.calls, 1)
  assert.equal(after.usage.credits, 0.25)
  assert.equal(after.last.ok, true)
  assert.equal((await usageOf('other', env)).calls, 0)
})

test('使用情况：被拒绝的不算调用，出错也会灭灯', async () => {
  const { env, root } = await makeEnv()
  await loadBindings(env)
  const defs = await buildToolDefinitions(fakeCtx('rejected'), { env, defineTool: rawTool })
  const run = defs.find((d) => d.name === 'cli_run')
  await run.execute({ target: 'minimax', tool: 'connector__x__submit', args: {} }, execIn('s', root))
  assert.equal((await usageOf('s', env)).calls, 0)
  await assert.rejects(run.execute({ target: 'nope', prompt: 'x' }, execIn('s', root)), /没有这个目标/)
  assert.deepEqual((await usageOf('s', env)).running, [])
})

test('使用情况：转后台继续亮，结束后自动灭，用量由 cli_job 补上', async () => {
  const { env, root } = await makeEnv()
  await loadBindings(env)
  const tools = await toolsFor(env)
  const r = await tools.cli_run.execute({ target: 'qoder', prompt: 'quick', background: true, cwd: root }, execIn('s', root))
  const during = await usageOf('s', env)
  if (r.state === 'running') assert.equal(during.running[0].job, r.job)
  for (let i = 0; i < 100 && (await usageOf('s', env)).running.length; i += 1) await new Promise((done) => setTimeout(done, 50))
  assert.deepEqual((await usageOf('s', env)).running, [])
  const job = await tools.cli_job.execute({ job: r.job, action: 'status' }, execIn('s', root))
  assert.equal(job.reply, 'PONG')
  assert.equal((await usageOf('s', env)).usage.credits, 0.25)
  await tools.cli_job.execute({ job: r.job, action: 'status' }, execIn('s', root))
  assert.equal((await usageOf('s', env)).usage.credits, 0.25, '同一个任务不重复累计')
})

// —— 接口 ——

test('接口：status、targets、bind 都能用；目标不存在就拒绝', async () => {
  const { env } = await makeEnv()
  await loadBindings(env)
  const actions = createActions({ env })
  assert.equal((await actions.status({ sessionId: 's' })).binding, null)
  const { targets } = await actions.targets()
  assert.deepEqual(targets.map((t) => t.target), ['qoder', 'minimax', 'opencode'], '普通程序不进面板')
  assert.ok(!JSON.stringify(targets).includes('someone@example.com'))
  assert.equal(targets[0].description, undefined, '界面不需要描述，少传')
  assert.deepEqual((await actions.bind({ sessionId: 's', target: 'qoder' })).binding, { target: 'qoder', kind: 'agent', label: 'Qoder' })
  assert.equal((await actions.bind({ sessionId: 's', target: null })).binding, null)
  await assert.rejects(actions.bind({ sessionId: 's', target: 'nope' }), /没有这个目标/)
  await assert.rejects(actions.bind({ target: 'qoder' }), /对话编号/)
})

test('接口：只能停这个对话自己的后台任务', async () => {
  const { env, root } = await makeEnv()
  await loadBindings(env)
  const tools = await toolsFor(env)
  const r = await tools.cli_run.execute({ target: 'qoder', prompt: 'SLOW', background: true, cwd: root }, execIn('mine', root))
  const actions = createActions({ env })
  await assert.rejects(actions.stop({ sessionId: 'other', job: r.job }), /不是这个对话/)
  const stopped = await actions.stop({ sessionId: 'mine', job: r.job })
  assert.deepEqual(stopped.running, [])
})

test('接口：请求格式错、操作不存在都有明确回应，不会碰到原型方法', async () => {
  const { env } = await makeEnv()
  const handler = createHandler({ env })
  const post = (body) => handler(new Request('http://x/api/dsh-cli', { method: 'POST', body }))
  assert.equal((await post('{oops')).status, 400)
  assert.equal((await post(JSON.stringify({ action: 'nope' }))).status, 404)
  assert.equal((await post(JSON.stringify({ action: 'constructor' }))).status, 404)
  const ok = await (await post(JSON.stringify({ action: 'status', sessionId: 's' }))).json()
  assert.equal(ok.ok, true)
  const bad = await (await post(JSON.stringify({ action: 'bind', target: 'qoder' }))).json()
  assert.equal(bad.ok, false)
})

// —— 界面 ——

async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded
  const window = { __ModuleLoader__: { load: (def) => { loaded = def } } }
  vm.runInNewContext(source, { window, console, document: { documentElement: { lang: 'zh' } } })
  const React = { useCallback: () => {}, useEffect: () => {}, useRef: () => ({}), useState: () => [], createElement: () => null }
  return { id: loaded.id, client: loaded.factory(() => React) }
}

test('界面：能加载，注册在对话头部和输入框下方；注册失败不影响插件', async () => {
  const { id, client } = await loadClient()
  assert.equal(id, 'dsh-cli')
  assert.deepEqual([...client.inject], ['slots'])
  const slots = []
  client.apply({ slots: { inject: (name, fn) => { fn(); slots.push(name) }, register: () => () => {} } })
  assert.deepEqual(slots, ['settings.section', 'conversation.session.header.actions', 'conversation.composer.dock'])
  assert.doesNotThrow(() => client.apply({ slots: { inject: () => { throw new Error('boom') } } }))
})

test('界面：按钮状态。灰是自动，绿是指定，黄是在跑，红是指定了但用不了', async () => {
  const { buttonState, usageText, shortName } = (await loadClient()).client.__test
  const labelOf = (id) => ({ qoder: 'Qoder', minimax: 'MiniMax Code' }[id] ?? id)
  const healthy = () => undefined
  const state = (status, healthOf = healthy) => buttonState(status, labelOf, healthOf)
  assert.deepEqual({ ...state(null) }, { tone: 'off', text: 'CLI' })
  assert.deepEqual({ ...state({ running: [], binding: null, calls: 5 }) }, { tone: 'off', text: 'CLI' })
  assert.deepEqual({ ...state({ running: [], binding: QODER }) }, { tone: 'on', text: 'Qoder 直通' })
  assert.deepEqual({ ...state({ running: [], binding: MINIMAX }) }, { tone: 'on', text: 'MiniMax' }, '工具类不是直通')
  const busy = state({ running: [{ target: 'qoder', startedAt: Date.now() - 12000 }], binding: null })
  assert.equal(busy.tone, 'busy', '没有指定，模型调用时也亮')
  assert.match(busy.text, /^CLI · Qoder 1[23]s$/)
  assert.match(state({ running: [{ target: 'qoder', startedAt: Date.now() }, { target: 'minimax', startedAt: Date.now() }], binding: QODER }).text, /\+1$/)
  assert.equal(state({ running: [], binding: QODER }, () => ({ ready: false })).tone, 'fail')
  assert.equal(state({ running: [{ target: 'qoder', startedAt: Date.now() }], binding: QODER }, () => ({ ready: false })).tone, 'busy', '在跑优先')
  assert.match(usageText({ calls: 2, usage: { credits: 1.234 } }), /2 次 · 1\.23 credits/)
  assert.match(usageText({ calls: 0 }), /还没有调用过/)
  assert.equal(shortName('MiniMax Code'), 'MiniMax')
})

const CATALOG = [
  { target: 'qoder', label: 'Qoder', kind: 'agent', capabilities: ['code'], installed: true },
  { target: 'trae', label: 'Trae', kind: 'agent', capabilities: ['code'], installed: true },
  { target: 'minimax', label: 'MiniMax Code', kind: 'tools', capabilities: ['video', 'image'], installed: true },
  { target: 'hailuo', label: 'Hailuo', kind: 'tools', capabilities: ['video'], installed: false },
  { target: 'custom', label: 'Custom', kind: 'agent', capabilities: [], installed: true },
]

test('界面：面板分组。按第一个能力归组，每家只出现一次，没装的单独放', async () => {
  const { groupTargets } = (await loadClient()).client.__test
  const { recent, groups, missing } = groupTargets(CATALOG, '', [])
  assert.equal(recent.length, 0)
  assert.deepEqual([...groups].map((g) => [g.cap, [...g.items].map((t) => t.target)]), [
    ['code', ['qoder', 'trae']],
    ['video', ['minimax']],
    ['other', ['custom']],
  ])
  assert.deepEqual([...missing].map((t) => t.target), ['hailuo'])
  assert.equal(groupTargets(null, '', []).groups.length, 0)
})

test('界面：面板最近用过排最前，不重复；没装的和已删除的不算；搜索时不单列', async () => {
  const { groupTargets, nextRecent } = (await loadClient()).client.__test
  const { recent, groups } = groupTargets(CATALOG, '', ['trae', 'gone', 'hailuo'])
  assert.deepEqual([...recent].map((t) => t.target), ['trae'])
  assert.deepEqual([...groups[0].items].map((t) => t.target), ['qoder'], '不在分组里重复')
  assert.equal(groupTargets(CATALOG, 'trae', ['trae']).recent.length, 0)
  assert.deepEqual([...nextRecent(['a', 'b', 'c'], 'b')], ['b', 'a', 'c'])
  assert.deepEqual([...nextRecent(['a', 'b', 'c'], 'd')], ['d', 'a', 'b'])
})

test('界面：搜索名字、编号和能力，中英文都行；没装的也能搜到', async () => {
  const { groupTargets } = (await loadClient()).client.__test
  const names = (query) => {
    const r = groupTargets(CATALOG, query, [])
    return [...r.groups.flatMap((g) => g.items), ...r.missing].map((t) => t.target)
  }
  assert.deepEqual(names('QOD'), ['qoder'])
  assert.deepEqual(names('minimax code'), ['minimax'])
  assert.deepEqual(names('视频'), ['minimax', 'hailuo'])
  assert.deepEqual(names('video'), ['minimax', 'hailuo'])
  assert.deepEqual(names('图片'), ['minimax'], '不只看第一个能力')
  assert.deepEqual(names('不存在'), [])
})

test('界面：60 家也能很快分好组', async () => {
  const { groupTargets } = (await loadClient()).client.__test
  const many = Array.from({ length: 60 }, (_, i) => ({ target: `t${i}`, label: `T${i}`, capabilities: [['code', 'video', 'image'][i % 3]], installed: i % 2 === 0 }))
  const { groups, missing } = groupTargets(many, '', [])
  assert.equal(missing.length, 30)
  assert.equal(groups.flatMap((g) => g.items).length, 30)
})

// —— 列表 ——

test('列表：quick 只查装没装，不启动 CLI；能按能力筛选', async () => {
  const { env, log } = await makeEnv()
  await loadBindings(env)
  const quick = await createActions({ env }).targets()
  assert.deepEqual(quick.targets.slice(0, 2).map((t) => [t.target, t.installed, t.capabilities[0]]), [['qoder', true, 'code'], ['minimax', true, 'video']])
  await assert.rejects(readFile(join(log, 'qoder-args')), undefined, 'quick 不应该启动 qodercli')
  const tools = await toolsFor(env)
  const video = await tools.cli_list.execute({ capability: 'video' }, {})
  assert.deepEqual(video.targets.map((t) => t.target), ['minimax'])
  assert.equal(video.targets[0].ready, true)
})

test('列表：模型只看到装了的，没装的只说数量', async () => {
  const { env } = await makeEnv({ qoder: false })
  const tools = await toolsFor(env)
  const value = await tools.cli_list.execute({}, {})
  const text = tools.cli_list.output.render({}, value)[0].text
  assert.ok(!text.includes('qoder（'))
  assert.match(text, /另有 \d+ 个没有安装/)
  assert.match(text, /\[video,image,audio,music\]/)
})

test('接口：targetStatus 查登录状态，1 分钟内用缓存，force 重新查', async () => {
  const { env } = await makeEnv({ account: 'Not logged in' })
  const actions = createActions({ env })
  const first = await actions.targetStatus({ target: 'qoder' })
  assert.equal(first.ready, false)
  assert.match(first.hint, /qodercli login/)
  env.FAKE_ACCOUNT = 'someone@example.com'
  assert.equal((await actions.targetStatus({ target: 'qoder' })).ready, false, '缓存')
  const fresh = await actions.targetStatus({ target: 'qoder', force: true })
  assert.equal(fresh.ready, true)
  assert.ok(!JSON.stringify(fresh).includes('someone'))
})
