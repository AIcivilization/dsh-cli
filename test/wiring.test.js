import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { guardedCommandIn, makeGuard } from '../lib/guard.js'
import { _resetInstanceGuard, apply, inject, name } from '../lib/index.js'
import { buildToolDefinitions, rawTool, toPlainJson } from '../lib/tools.js'
import { fakeCtx, makeEnv } from './helpers.js'

/** 仿 cordis：没在 inject 里声明就读可选服务会抛异常 */
function hostCtx({ skills = true } = {}) {
  const r = { tools: [], skills: [] }
  const ctx = {
    tools: { register: (def) => { r.tools.push(def); return () => {} } },
    effect: () => {},
    inject(names, fn) {
      if (names.includes('skills') && skills) {
        fn({ skills: { register: (def) => { r.skills.push(def); return () => {} } } })
      }
    },
    logger: { warn() {}, info() {} },
  }
  return { ctx, r }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

beforeEach(() => _resetInstanceGuard())

test('插件接线：3 个工具和 skill 都注册上', async () => {
  const { env } = await makeEnv()
  const { ctx, r } = hostCtx()
  assert.equal(name, 'dsh-cli')
  assert.deepEqual(inject, ['tools'])
  apply(ctx, { env })
  await settle()
  assert.deepEqual(r.tools.map((t) => t.name), ['cli_list', 'cli_run', 'cli_job'])
  assert.equal(r.skills[0].name, 'dsh-cli')
  assert.equal(r.skills[0].source, 'runtime')
  assert.match(r.skills[0].content, /ok. 为真只表示/)
})

test('插件接线：没有 skills 服务也能激活', async () => {
  const { env } = await makeEnv()
  const { ctx, r } = hostCtx({ skills: false })
  apply(ctx, { env })
  await settle()
  assert.equal(r.tools.length, 3)
  assert.equal(r.skills.length, 0)
})

test('插件接线：同一进程第二份让路，不重复注册', async () => {
  const { env } = await makeEnv()
  const first = hostCtx()
  const second = hostCtx()
  apply(first.ctx, { env })
  apply(second.ctx, { env })
  await settle()
  assert.equal(first.r.tools.length, 3)
  assert.equal(second.r.tools.length, 0)
})

test('工具：模型拿不到跳过权限的参数', async () => {
  const { env } = await makeEnv()
  const defs = await buildToolDefinitions({}, { env })
  const run = defs.find((d) => d.name === 'cli_run')
  const names = Object.keys(run.parameters)
  assert.ok(!names.some((n) => /permission|bypass|yolo|dangerous/i.test(n)), names.join())
})

test('工具：execute 返回纯 JSON，render 有输出且不泄露多余内容', async () => {
  const { env } = await makeEnv()
  const defs = await buildToolDefinitions(fakeCtx(), { env })
  const tools = Object.fromEntries(defs.map((d) => [d.name, d]))
  const exec = { signal: new AbortController().signal, agent: {}, callId: 'c1' }

  const listed = await tools.cli_list.execute({}, exec)
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed)
  assert.match(tools.cli_list.output.render({}, listed)[0].text, /qoder/)

  const ran = await tools.cli_run.execute({ target: 'qoder', prompt: 'hi' }, exec)
  assert.deepEqual(JSON.parse(JSON.stringify(ran)), ran)
  const text = tools.cli_run.output.render({}, ran)[0].text
  assert.match(text, /PONG/)
  assert.match(text, /credits/)

  const job = await tools.cli_job.execute({ job: ran.job, action: 'status' }, exec)
  assert.equal(job.reply, 'PONG')
})

test('工具：链接安装取不到 dsh-tools 时，退回完整 JSON Schema（回归：曾因此注册失败）', async () => {
  const { env } = await makeEnv()
  const defs = await buildToolDefinitions(fakeCtx(), { env, defineTool: rawTool })
  const run = defs.find((d) => d.name === 'cli_run')
  assert.equal(run.parameters.type, 'object')
  assert.equal(run.parameters.additionalProperties, false)
  assert.equal(run.parameters.required, undefined)
  assert.equal(run.parameters.properties.target.required, undefined)
  assert.equal(run.output.schema.type, 'object')
  await assert.rejects(run.execute({ prompt: 'x' }, {}), /没有指定 target/)
  const job = defs.find((d) => d.name === 'cli_job')
  assert.deepEqual(job.parameters.required, ['job', 'action'])
  await assert.rejects(job.execute({ action: 'status' }, {}), /缺少参数 job/)
  const ran = await run.execute({ target: 'qoder', prompt: 'hi' }, { signal: new AbortController().signal })
  assert.equal(ran.reply, 'PONG')
})

test('拦截：模型用 bash 直接调这些工具会被拦，正常命令不受影响', () => {
  for (const command of [
    'qodercli -p hi',
    '/Users/me/.qoder/entry/qoder -p --permission-mode bypass_permissions "x" 2>&1 | tail -40',
    'cd /tmp && qodercli -p --dangerously-skip-permissions hi',
    'FOO=1 sudo qoderclicn -p hi',
    '~/.minimax/bin/mcode-tools connector call connector__matrix__submit_video_generation --args "{}"',
    'bash -c "qodercli -p hi"',
    'echo $(qodercli -p hi)',
  ]) {
    assert.ok(guardedCommandIn(command), command)
  }
  for (const command of [
    'ls -la',
    'qodercli --help',
    'qodercli status',
    'qodercli --version | head -1',
    'which qodercli',
    'ls ~/.qoder',
    'echo "qodercli is a tool"',
    'git log --grep qodercli',
    'python3 hello.py',
  ]) {
    assert.equal(guardedCommandIn(command), null, command)
  }
})

test('拦截：只拦模型发起的 bash；关掉后放行；拒绝理由指向 cli_run', () => {
  const guard = makeGuard()
  const bash = { name: 'bash', agent: {}, arguments: { command: 'qodercli -p hi' } }
  assert.match(guard(bash), /cli_run/)
  assert.equal(guard({ ...bash, agent: undefined }), undefined)
  assert.equal(guard({ ...bash, name: 'read' }), undefined)
  assert.equal(makeGuard(() => false)(bash), undefined)
})

test('拦截：工具注册成功后才启用；工具注册失败时不拦 bash', async () => {
  const { env } = await makeEnv()
  const guards = []
  const { ctx } = hostCtx()
  ctx.tools.guard = (fn) => guards.push(fn)
  apply(ctx, { env })
  await settle()
  assert.equal(guards.length, 1)

  _resetInstanceGuard()
  const failing = hostCtx()
  const seen = []
  failing.ctx.tools.register = () => { throw new Error('schema 不对') }
  failing.ctx.tools.guard = (fn) => seen.push(fn)
  apply(failing.ctx, { env })
  await settle()
  assert.equal(seen.length, 0)
})

test('toPlainJson 去掉 undefined', () => {
  assert.deepEqual(toPlainJson({ a: undefined, b: 1 }), { b: 1 })
  assert.equal(toPlainJson(undefined), null)
})

test('可选插件：看全局表判断装没装；没发布的不给命令，也不告诉模型', async () => {
  const { extrasForModel, extrasStatus, EXTRAS } = await import('../lib/extras.js')
  const key = Symbol.for('dsh-cli-flow.packs')
  assert.deepEqual(extrasStatus({ scope: {} }).map((e) => e.installed), [false, false])
  assert.deepEqual(extrasStatus({ scope: { [key]: new Map() } }).map((e) => e.installed), [true, false])
  assert.deepEqual(extrasStatus({ scope: { [key]: new Map([['audio', {}]]) } }).map((e) => e.installed), [true, true])
  assert.ok(extrasStatus({ scope: {} }).every((e) => !e.published === !e.command))

  assert.deepEqual(extrasForModel({ list: EXTRAS.map((e) => ({ ...e, published: false })), scope: {} }), [])
  const published = EXTRAS.map((e) => ({ ...e, published: true }))
  const forModel = extrasForModel({ list: published, scope: { [key]: new Map() } })
  assert.deepEqual(forModel.map((e) => e.name), ['dsh-cli-flow-audio'])
  assert.match(forModel[0].command, /dsh plugin --profile desktop add dsh-cli-flow-audio/)
})
