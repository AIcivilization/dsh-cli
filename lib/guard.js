// lib/guard.js — 拦下模型用 bash 直接调这些工具
//
// 真实对话里见过：Qoder 因权限拒绝后，模型明知 skill 说不要绕过，还是用 bash 加上
// bypass_permissions 重跑。mcode-tools 同理，走 bash 就没有花钱前的确认。
// 所以这些命令必须走 cli_run，权限和确认才算数。
//
// 这只是防止模型顺手绕过，不是安全边界：字符串匹配总有办法绕开。
// 只拦模型发起的调用（有 agent），不影响用户自己在终端里用。

const SHELL_TOOLS = /^(bash|bash_persistent|pwsh|powershell|shell|sh|pty|pty_.*)$/i
const GUARDED = new Set(['qodercli', 'qoder', 'qoderclicn', 'mcode-tools', 'mcode-tools-global', 'mcode-tools-cn'])
const HARMLESS = /^\s*(--help|-h|--version|-v|status|help)?\s*$/

const WRAPPERS = /^(sudo|command|exec|time|nohup|env)\s+/

function simpleCommands(script) {
  return String(script)
    .split(/&&|\|\||[;|\n&()`]|\$\(/)
    .map((part) => {
      let text = part.trim()
      for (let previous = ''; previous !== text;) {
        previous = text
        text = text.replace(/^\w+=\S*\s+/, '').replace(WRAPPERS, '').trim()
      }
      return text
    })
    .filter(Boolean)
}

/** 命令里有没有直接调这些工具。返回程序名，没有就返回 null */
export function guardedCommandIn(script) {
  for (const command of simpleCommands(script)) {
    const [first = ''] = command.split(/\s+/)
    const program = first.replace(/^['"]|['"]$/g, '').split('/').pop().toLowerCase()
    if ((program === 'sh' || program === 'bash' || program === 'zsh')) {
      const inner = command.match(/\s-l?c\s+(['"])(.+)\1/)
      if (inner) {
        const found = guardedCommandIn(inner[2])
        if (found) return found
      }
      continue
    }
    if (!GUARDED.has(program)) continue
    if (HARMLESS.test(command.slice(first.length))) continue
    return program
  }
  return null
}

export function makeGuard(isEnabled = () => true) {
  return (exec) => {
    if (!exec?.agent || !isEnabled()) return undefined
    if (!SHELL_TOOLS.test(String(exec.name ?? ''))) return undefined
    const args = exec.arguments ?? {}
    const program = guardedCommandIn(args.command ?? args.script ?? args.input ?? '')
    if (!program) return undefined
    return (
      `不要用 bash 直接运行 ${program}，请用 cli_run：权限和花钱前的确认都在那里。` +
      '如果对方因权限做不了，把情况如实告诉用户，或者你自己来做。放开权限只能由用户改配置，你不能自己绕过。'
    )
  }
}
