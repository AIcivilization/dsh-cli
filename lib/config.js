// lib/config.js — 路径和用户配置
//
// 用户配置放在 $DSH_HOME/dsh-cli/config.json，只有想改默认值或自己加一家时才需要：
//   {
//     "targets": {
//       "qoder":   { "permission": "default" },
//       "minimax": { "confirm": false, "env": { "MCODE_REGION": "cn" } },
//       "my-cli":  { "kind": "agent", "command": "my-cli", "run": ["-p", "{prompt}"] }
//     }
//   }

import { constants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export function homeOf(env = process.env) {
  return env.HOME?.trim() || homedir()
}

/** $DSH_HOME 必须读环境变量解析后的值，不能硬编码 ~/.dsh（dsh-vps lib/config.js 的教训） */
export function dataDir(env = process.env) {
  const dshHome = env.DSH_HOME?.trim() || join(homeOf(env), '.dsh')
  return join(dshHome, 'dsh-cli')
}

export async function loadUserConfig(env = process.env) {
  const path = join(dataDir(env), 'config.json')
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error(`读不了配置文件 ${path}：${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`配置文件 ${path} 不是合法 JSON：${error.message}`)
  }
}

/** 从桌面启动的 DSH 拿到的 PATH 很短，常见安装位置要自己补上 */
export function searchPath(env = process.env) {
  const home = homeOf(env)
  const extra = [join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
  const fromEnv = (env.PATH ?? '').split(delimiter).filter(Boolean)
  return [...new Set([...fromEnv, ...extra])]
}

export async function isExecutable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 找到命令的绝对路径；带目录的按原样检查。找不到返回 null */
export async function findCommand(command, env = process.env) {
  if (command.startsWith('~/')) {
    const full = join(homeOf(env), command.slice(2))
    return (await isExecutable(full)) ? full : null
  }
  if (command.includes('/')) return (await isExecutable(command)) ? command : null
  for (const dir of searchPath(env)) {
    const full = join(dir, command)
    if (await isExecutable(full)) return full
  }
  return null
}
