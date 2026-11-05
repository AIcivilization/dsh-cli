// lib/approval.js — 什么时候必须问人
//
// MiniMax 的周限额不够时会扣账户积分，connector 还能操作用户连接的应用（比如发消息）。
// 我们不可能列全所有会花钱或对外的工具，所以反过来：**只有明确是只读的才不问，其余都问。**
//
// 审批的三个坑照 dsh-vps lib/safety.js：
//   - 取服务用 ctx.get('approval')：没 inject 就读 ctx.approval 会抛
//   - 请求字段是 toolName，不是 tool
//   - 结果是 allowed-once / rejected / cancelled / unavailable

const READ_ONLY = /^(query|get|list|search|read|describe|fetch)_/

/** 工具名形如 connector__matrix__query_video_generation，看最后一段 */
export function isReadOnlyTool(tool) {
  const last = String(tool).split('__').pop().replace(/^matrix_/, '')
  return READ_ONLY.test(last)
}

/** 确认框里显示的摘要：只放简短的值，长文本截断 */
export function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return ''
  const parts = []
  for (const [key, value] of Object.entries(args)) {
    if (value === null || typeof value === 'object') continue
    const text = String(value)
    parts.push(`${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`)
  }
  return parts.join(' ')
}

export const OUTCOME_ALLOWED = 'allowed-once'

/** @returns {{ allowed: boolean, hint?: string }} */
export async function askUser(ctx, { tool, reason, agent, callId, signal }) {
  let approval
  try {
    approval = ctx?.get?.('approval')
  } catch {
    approval = undefined
  }
  if (!approval || typeof approval.request !== 'function') {
    return { allowed: false, hint: '当前环境没有确认界面（无人值守），这个操作需要用户确认，所以没有执行。' }
  }
  try {
    const outcome = await approval.request({
      agent,
      toolName: tool,
      ...(callId !== undefined ? { callId } : {}),
      reason: String(reason).slice(0, 300),
      signal,
    })
    if (outcome === OUTCOME_ALLOWED) return { allowed: true }
    if (outcome === 'rejected') return { allowed: false, hint: '用户拒绝了这次操作，没有执行。' }
    if (outcome === 'cancelled') return { allowed: false, hint: '确认被取消了（对话被中断），没有执行。' }
    return { allowed: false, hint: '拿不到用户确认，按拒绝处理，没有执行。' }
  } catch (error) {
    return { allowed: false, hint: `确认不可用（${error.message}），没有执行。` }
  }
}
