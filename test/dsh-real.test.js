// 用真实的 DSH 代码校验（做法照 dsh-vps test/dsh-real.test.js）
//
// 假的 ctx 什么 schema 都收，dsh-vps 曾因此工具注册失败三天没人发现。
// 需要环境变量 DSH_MODULES 指向装了 @deepseek-ai/dsh 的 node_modules，没给就跳过：
//   mkdir /tmp/dsh && cd /tmp/dsh && npm i @deepseek-ai/dsh
//   DSH_MODULES=/tmp/dsh/node_modules npm test

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { OUTCOME_ALLOWED } from '../lib/approval.js'
import { registerSkill } from '../lib/index.js'
import { buildToolDefinitions, rawTool } from '../lib/tools.js'
import { fakeCtx, makeEnv } from './helpers.js'

const APP = process.env.DSH_MODULES ? join(process.env.DSH_MODULES, '@deepseek-ai') : ''
const DSH_TOOLS = APP ? join(APP, 'dsh-tools', 'lib', 'index.js') : ''
const skip = DSH_TOOLS && existsSync(DSH_TOOLS) ? false : '没设置 DSH_MODULES，跳过真实校验'

test('真实 defineTool 接受全部 3 个工具', { skip }, async () => {
  const real = await import(pathToFileURL(DSH_TOOLS).href)
  const { env } = await makeEnv()
  const defs = await buildToolDefinitions({}, { env, defineTool: (def) => def })
  assert.equal(defs.length, 3)
  for (const def of defs) {
    assert.doesNotThrow(() => real.defineTool(def), `${def.name} 过不了 DSH 的 schema 校验`)
  }
})

test('真实 schema 校验接受退回格式（链接安装时用的那种）', { skip }, async () => {
  const real = await import(pathToFileURL(DSH_TOOLS).href)
  const { env } = await makeEnv()
  const defs = await buildToolDefinitions(fakeCtx(), { env, defineTool: rawTool })
  for (const def of defs) {
    assert.doesNotThrow(() => real.assertSupportedJsonSchema(def.parameters), `${def.name} 的参数 schema 不被接受`)
    assert.doesNotThrow(() => real.assertSupportedJsonSchema(def.output.schema), `${def.name} 的输出 schema 不被接受`)
  }
})

test('真实校验：参数合法、返回无损 JSON、符合声明、render 不报错', { skip }, async () => {
  const real = await import(pathToFileURL(DSH_TOOLS).href)
  const { env } = await makeEnv()
  const defs = await buildToolDefinitions(fakeCtx(), { env, defineTool: real.defineTool })
  const tools = Object.fromEntries(defs.map((d) => [d.name, d]))
  const exec = { agent: { session: { id: 'sess-real' } }, callId: 'c1', signal: new AbortController().signal }

  const ran = await tools.cli_run.execute({ target: 'qoder', prompt: 'hello' }, exec)
  const calls = [
    ['cli_list', {}],
    ['cli_list', { target: 'minimax', keyword: 'video' }],
    ['cli_list', { target: 'minimax', tool: 'connector__x' }],
    ['cli_run', { target: 'qoder', prompt: 'CRASH' }], // 失败结果也要合法
    ['cli_run', { target: 'minimax', tool: 'connector__matrix__submit_video_generation', args: { model: 'x', duration: 6 } }],
    ['cli_run', { target: 'minimax', tool: 'get_asset_url', args: { node_id: '1' } }],
    ['cli_job', { job: ran.job, action: 'status' }],
  ]
  for (const [name, args] of calls) {
    const tool = tools[name]
    const value = await tool.execute(args, exec) // 真实 execute 会先按真实规则校验参数
    const detached = JSON.parse(JSON.stringify(value))
    assert.deepEqual(detached, value, `${name} 的返回值不是无损 JSON`)
    const violations = real.validateJsonSchemaValue(tool.output.schema, detached, 'value')
    assert.deepEqual(violations, [], `${name} 返回值不符合声明：${violations.join('; ')}`)
    const rendered = tool.output.render(args, detached)
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} 的 render 没有输出`)
  }

  // 参数写错时，DSH 在执行前就拦下
  await assert.rejects(tools.cli_job.execute({ job: 'x', action: 'nope' }, exec))
  await assert.rejects(tools.cli_job.execute({ action: 'status' }, exec), /job/)
  // target 可以省略（开关打开时），没开开关时由插件报错
  await assert.rejects(tools.cli_run.execute({ prompt: 'no target' }, exec), /target/)
})

test('真实 dsh-skill：加载时必需的字段一个不缺，名字合法', { skip }, async () => {
  const lib = await readFile(join(APP, 'dsh-skill', 'lib', 'index.js'), 'utf8')
  const required = [...lib.matchAll(/if \(typeof (\w+) !== "string"\) throw new TypeError\(`loaded skill "\$\{name\}" \1 must be a/g)].map((m) => m[1])
  assert.ok(required.includes('source') && required.includes('content'), `没从源码里读到字段清单：${required}`)
  let registered
  await registerSkill({ skills: { register: (def) => { registered = def; return () => {} } } })
  const loaded = { invocation: { modelInvocable: true, userInvocable: true }, provider: 'runtime', ...registered }
  for (const field of required) {
    assert.equal(typeof loaded[field], 'string', `skill 缺字段 ${field}`)
  }
  const { isSkillName } = await import(pathToFileURL(join(APP, 'dsh-skill', 'lib', 'index.js')).href)
  assert.equal(isSkillName(registered.name), true)
})

test('真实 dsh-user-approval：结果词汇和请求字段对得上', { skip }, async () => {
  const lib = await readFile(join(APP, 'dsh-user-approval', 'lib', 'index.js'), 'utf8')
  const block = /const OUTCOMES = \[([^\]]*)\]/.exec(lib)?.[1] ?? ''
  const outcomes = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  assert.ok(outcomes.includes(OUTCOME_ALLOWED), `审批结果词汇变了：${outcomes}`)
  assert.ok(outcomes.includes('rejected') && outcomes.includes('cancelled'), `审批结果词汇变了：${outcomes}`)
  assert.match(lib, /toolName: req\.toolName/, '真实服务读的是 toolName')
})
