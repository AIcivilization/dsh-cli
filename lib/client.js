/* global window, document, navigator, fetch, setInterval, setTimeout, clearInterval, AbortSignal */
// lib/client.js — 对话顶部的入口
//
// 只有一个按钮，接几十家也不会变长（位置和判断标准照 dsh-vps-manager）：
//   灰          自动：dsh 自己判断要不要调用、调用哪家
//   绿          指定了一家。agent 是直通，工具类仍然走模型
//   黄（闪）    正在调用
//   红          指定了但现在用不了（没登录、没安装）
// 点开是面板：搜索、最近用过、按能力分组，没装的折叠。打开面板只查装没装，
// 登录状态要启动进程，选中时才查，所以家数多了也不会慢。
// 输入框下方平时一个像素都不占，只有在跑任务时才冒一行，可以停止后台任务。
//
// 手写单文件，没有构建链，供 DSH web 客户端的 ModuleLoader 注入。
// 硬约束：界面出错不能影响 AI 工具，注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'dsh-cli',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    let localeSvc = null
    function lang() {
      try {
        const active = localeSvc?.getLocale?.()?.active
        if (active) return String(active).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        // 语言服务出错就看网页
      }
      const page = typeof document !== 'undefined' ? document.documentElement.lang : ''
      return !page || page.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }
    const L = (zh, en) => (lang() === 'zh' ? zh : en)

    // 跟随 DSH 主题
    const T = {
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,0.25))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      secondary: 'var(--dsw-alias-label-secondary, inherit)',
      tertiary: 'var(--dsw-alias-label-tertiary, #81858c)',
      solid: 'var(--dsw-alias-bg-base, #ffffff)',
      hover: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.12))',
      ok: 'var(--dsw-alias-state-success-primary, #2ea043)',
      danger: 'var(--dsw-alias-state-error-primary, #e5534b)',
      busy: '#d99a16',
    }
    // 只读内存，很轻。间隔太长的话，几秒就结束的调用灯根本来不及亮（实测踩过）
    const POLL_IDLE_MS = 2000
    const POLL_BUSY_MS = 1500
    const STYLE_ID = 'dsh-cli-style'

    function ensureStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = '@keyframes dsh-cli-pulse{0%,100%{opacity:1}50%{opacity:.45}}'
      document.head.appendChild(style)
    }

    async function api(action, body = {}, timeoutMs = 10000) {
      const res = await fetch('/api/dsh-cli', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      let data = null
      try {
        data = await res.json()
      } catch {
        throw new Error(res.status === 404
          ? L('接口不存在：装了新版本要重启 DSH 才生效', 'API not found: restart DSH after installing a new version')
          : `HTTP ${res.status}`)
      }
      if (!data?.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      return data
    }

    // —— 状态：头部和输入框下方共用一份，每个对话只轮询一次 ——
    const stores = new Map()

    function storeOf(sessionId) {
      if (!stores.has(sessionId)) {
        stores.set(sessionId, { status: null, error: '', listeners: new Set(), timer: null, wait: 0 })
      }
      return stores.get(sessionId)
    }

    function publish(store, patch) {
      Object.assign(store, patch)
      store.listeners.forEach((fn) => fn())
    }

    async function refresh(sessionId) {
      const store = storeOf(sessionId)
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        publish(store, { status: await api('status', { sessionId }), error: '' })
      } catch (e) {
        publish(store, { error: e.message })
      }
      schedule(sessionId)
    }

    function schedule(sessionId) {
      const store = storeOf(sessionId)
      const wait = store.status?.running?.length ? POLL_BUSY_MS : POLL_IDLE_MS
      if (store.timer && store.wait === wait) return
      if (store.timer) clearInterval(store.timer)
      store.wait = wait
      store.timer = setInterval(() => refresh(sessionId), wait)
    }

    function useStatus(sessionId) {
      const [, force] = useState(0)
      useEffect(() => {
        if (!sessionId) return undefined
        const store = storeOf(sessionId)
        const listener = () => force((n) => n + 1)
        store.listeners.add(listener)
        if (store.listeners.size === 1) refresh(sessionId)
        return () => {
          store.listeners.delete(listener)
          if (!store.listeners.size && store.timer) {
            clearInterval(store.timer)
            store.timer = null
          }
        }
      }, [sessionId])
      return sessionId ? storeOf(sessionId) : { status: null, error: '' }
    }

    // —— 有哪些目标：只查装没装，很快。整个页面只问一次 ——
    let targetCache = null
    const targetListeners = new Set()

    async function loadTargets() {
      targetCache = (await api('targets', {}, 30000)).targets
      targetListeners.forEach((fn) => fn())
      return targetCache
    }

    function useTargets() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((n) => n + 1)
        targetListeners.add(listener)
        if (!targetCache) loadTargets().catch(() => {})
        return () => targetListeners.delete(listener)
      }, [])
      return targetCache
    }

    // —— 能不能用：要启动进程查登录状态，只查选中的那一家 ——
    const health = new Map()

    async function checkHealth(target, force = false) {
      const result = await api('targetStatus', { target, force }, 30000)
      health.set(target, result)
      targetListeners.forEach((fn) => fn())
      return result
    }

    // —— 最近用过：存在本机浏览器里，只影响面板的排序 ——
    const RECENT_KEY = 'dsh-cli:recent'
    const RECENT_MAX = 3

    function readRecent() {
      try {
        const saved = JSON.parse(window.localStorage?.getItem(RECENT_KEY) ?? '[]')
        return Array.isArray(saved) ? saved : []
      } catch {
        return []
      }
    }

    function nextRecent(list, target) {
      return [target, ...list.filter((id) => id !== target)].slice(0, RECENT_MAX)
    }

    function rememberRecent(target) {
      try {
        window.localStorage?.setItem(RECENT_KEY, JSON.stringify(nextRecent(readRecent(), target)))
      } catch {
        // 存不下只是少了排序
      }
    }

    const seconds = (from) => Math.max(0, Math.round((Date.now() - from) / 1000))
    const shortName = (label) => String(label).replace(/\s+Code$/i, '')

    const CAPABILITIES = {
      code: () => L('编程', 'Coding'),
      video: () => L('视频', 'Video'),
      image: () => L('图片', 'Images'),
      audio: () => L('语音', 'Audio'),
      music: () => L('音乐', 'Music'),
      other: () => L('其他', 'Other'),
    }
    const capabilityLabel = (cap) => (CAPABILITIES[cap] ?? CAPABILITIES.other)()

    function matches(target, query) {
      if (!query) return true
      const q = query.trim().toLowerCase()
      const caps = target.capabilities ?? []
      const words = [target.target, target.label, ...caps, ...caps.map((c) => capabilityLabel(c))]
      return words.some((word) => String(word).toLowerCase().includes(q))
    }

    /**
     * 面板的分组：先最近用过，再按能力分组；没装的单独放，默认折叠。
     * 一家只出现一次，归到它的第一个能力下面。搜索时不单列最近用过。
     */
    function groupTargets(targets, query, recent = []) {
      const found = (targets ?? []).filter((t) => matches(t, query))
      const usable = found.filter((t) => t.installed !== false)
      const missing = found.filter((t) => t.installed === false)
      const recentRows = query ? [] : recent.map((id) => usable.find((t) => t.target === id)).filter(Boolean)
      const taken = new Set(recentRows.map((t) => t.target))
      const buckets = new Map()
      for (const target of usable) {
        if (taken.has(target.target)) continue
        const cap = CAPABILITIES[target.capabilities?.[0]] ? target.capabilities[0] : 'other'
        if (!buckets.has(cap)) buckets.set(cap, [])
        buckets.get(cap).push(target)
      }
      const groups = Object.keys(CAPABILITIES).filter((cap) => buckets.has(cap)).map((cap) => ({ cap, items: buckets.get(cap) }))
      return { recent: recentRows, groups, missing }
    }

    /** 按钮的样子：在跑优先；打开了但用不了是红；打开了是绿；其余是灰 */
    function buttonState(status, labelOf, healthOf) {
      const running = status?.running ?? []
      if (running.length) {
        const first = running[0]
        const more = running.length > 1 ? ` +${running.length - 1}` : ''
        return { tone: 'busy', text: `CLI · ${shortName(labelOf(first.target))} ${seconds(first.startedAt)}s${more}` }
      }
      const binding = status?.binding
      if (!binding) return { tone: 'off', text: 'CLI' }
      const name = shortName(binding.label)
      if (healthOf(binding.target)?.ready === false) return { tone: 'fail', text: name }
      return { tone: 'on', text: binding.kind === 'agent' ? `${name} ${L('直通', 'direct')}` : name }
    }

    function usageText(status) {
      const calls = status?.calls ?? 0
      if (!calls) return L('这个对话还没有调用过', 'No calls in this conversation yet')
      const credits = status?.usage?.credits
      const spent = typeof credits === 'number' ? ` · ${Math.round(credits * 100) / 100} credits` : ''
      return L(`这个对话调用过 ${calls} 次`, `${calls} calls in this conversation`) + spent
    }

    /** 每行右边的小标签。说明只在面板底部写一次，家数多了才不吵 */
    function rowTag(target) {
      if (target.installed === false) return ''
      return target.kind === 'agent' ? L('直通', 'Direct') : L('经 dsh', 'Via dsh')
    }

    const TONE = {
      off: T.tertiary,
      on: T.ok,
      busy: T.busy,
      fail: T.danger,
    }

    function CliToggle(props) {
      const sessionId = props?.sessionId ? String(props.sessionId) : ''
      const store = useStatus(sessionId)
      const targets = useTargets()
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [showMissing, setShowMissing] = useState(false)
      const [pending, setPending] = useState('')
      const [rowHint, setRowHint] = useState(null)
      const [error, setError] = useState('')
      const [place, setPlace] = useState(null)
      const [, tick] = useState(0)
      const anchor = useRef(null)
      const panel = useRef(null)
      const status = store.status
      const binding = status?.binding ?? null
      const running = status?.running ?? []
      useEffect(ensureStyle, [])

      // 已经打开的那一家要知道现在能不能用，用不了就变红
      useEffect(() => {
        if (binding?.target) checkHealth(binding.target).catch(() => {})
      }, [binding?.target])

      // 运行时每秒刷新已用时间
      useEffect(() => {
        if (!running.length) return undefined
        const timer = setInterval(() => tick((n) => n + 1), 1000)
        return () => clearInterval(timer)
      }, [running.length > 0])

      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (panel.current?.contains(event.target) || anchor.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (!sessionId) return null

      const labelOf = (id) => targets?.find((t) => t.target === id)?.label ?? id
      const state = buttonState(status, labelOf, (id) => health.get(id))
      const color = TONE[state.tone]
      const problem = error || store.error

      const toggleOpen = () => {
        if (open) {
          setOpen(false)
          return
        }
        const box = anchor.current?.getBoundingClientRect?.()
        if (box) setPlace({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) })
        setQuery('')
        setShowMissing(false)
        setRowHint(null)
        setError('')
        setOpen(true)
        if (!targetCache) loadTargets().catch((e) => setError(e.message))
      }

      const choose = async (target) => {
        setError('')
        setRowHint(null)
        setPending(target?.target ?? 'auto')
        try {
          if (target) {
            // 可能刚登录好，所以不用缓存
            const result = await checkHealth(target.target, true)
            if (result.ready === false) {
              setRowHint({ target: target.target, text: result.hint ?? L('现在用不了', 'Unavailable') })
              return
            }
          }
          const next = await api('bind', { sessionId, target: target?.target ?? null })
          publish(storeOf(sessionId), { status: next, error: '' })
          schedule(sessionId)
          if (target) rememberRecent(target.target)
          setOpen(false)
        } catch (e) {
          setError(e.message)
        } finally {
          setPending('')
        }
      }

      const row = (key, active, disabled, onClick, main, sub, tag) => h('button', {
        key,
        type: 'button',
        'data-cli-option': key,
        disabled: disabled || Boolean(pending),
        onClick,
        style: {
          display: 'flex', width: '100%', gap: 6, alignItems: 'flex-start', padding: '5px 8px', border: 'none', borderRadius: 6,
          background: active ? T.hover : 'transparent', color: T.text, textAlign: 'left', fontSize: 12, lineHeight: 1.4,
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        },
      },
        h('span', { style: { width: 12, flex: '0 0 auto', color: T.ok } }, pending === key ? '·' : active ? '✓' : ''),
        h('span', { style: { minWidth: 0, flex: '1 1 auto' } },
          h('span', { style: { display: 'block', fontWeight: 500 } }, main),
          sub ? h('span', { style: { display: 'block', color: T.secondary, fontSize: 11 } }, sub) : null),
        tag ? h('span', { 'data-cli-tag': '', style: { flex: '0 0 auto', color: T.tertiary, fontSize: 11 } }, tag) : null)

      const targetRow = (target) => {
        const hint = rowHint?.target === target.target ? rowHint.text : ''
        return row(
          target.target,
          binding?.target === target.target,
          target.installed === false,
          () => choose(target),
          target.label,
          hint ? h('span', { 'data-cli-hint': '', style: { color: T.danger } }, hint) : null,
          rowTag(target),
        )
      }

      const heading = (key, text) => h('div', {
        key: `h-${key}`,
        'data-cli-heading': key,
        style: { padding: '8px 8px 2px', fontSize: 11, color: T.tertiary },
      }, text)

      const { recent, groups, missing } = groupTargets(targets, query, open ? readRecent() : [])
      const first = recent[0] ?? groups[0]?.items[0]
      const nothing = targets && !recent.length && !groups.length && !missing.length

      return h('span', { style: { display: 'inline-flex', position: 'relative' } },
        h('button', {
          ref: anchor,
          type: 'button',
          'data-cli-button': state.tone,
          title: problem || `${state.tone === 'off'
            ? L('dsh 自己判断要不要调用别的 AI 工具。点开可以指定一家', 'dsh decides whether to call other AI tools. Click to pick one')
            : state.tone === 'fail'
              ? (health.get(binding?.target)?.hint ?? L('现在用不了', 'Unavailable'))
              : L('点开查看或更换', 'Click to view or change')}　${usageText(status)}`,
          onClick: toggleOpen,
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 5, height: 25, boxSizing: 'border-box', padding: '0 8px',
            border: `1px solid ${state.tone === 'off' ? T.border : color}`, borderRadius: 8, background: 'transparent',
            color: state.tone === 'off' ? T.secondary : T.text, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
          },
        },
          h('span', {
            'data-cli-light': state.tone,
            style: {
              width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto', boxSizing: 'border-box',
              background: state.tone === 'off' ? 'transparent' : color,
              border: state.tone === 'off' ? `1px solid ${T.tertiary}` : 'none',
              boxShadow: state.tone === 'off' ? 'none' : `0 0 6px ${color}`,
              animation: state.tone === 'busy' ? 'dsh-cli-pulse 1.1s ease-in-out infinite' : 'none',
            },
          }),
          state.text,
          problem ? h('span', { 'data-cli-problem': '', style: { color: T.danger, fontWeight: 600 } }, '!') : null),
        open ? h('div', {
          ref: panel,
          'data-cli-panel': '',
          style: {
            position: 'fixed', top: place?.top ?? 48, right: place?.right ?? 16, zIndex: 1000, width: 300, boxSizing: 'border-box', padding: 6, borderRadius: 10,
            background: T.solid, color: T.text, border: `1px solid ${T.border}`, boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
          },
        },
          h('input', {
            'data-cli-search': '',
            autoFocus: true,
            value: query,
            placeholder: L('搜索工具或能力，比如 视频', 'Search tools or abilities'),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && query && first) choose(first)
            },
            style: {
              width: '100%', boxSizing: 'border-box', height: 28, padding: '0 8px', marginBottom: 4, borderRadius: 6,
              border: `1px solid ${T.border}`, background: 'transparent', color: T.text, fontSize: 12, outline: 'none',
            },
          }),
          h('div', { 'data-cli-list': '', style: { maxHeight: `min(380px, calc(100vh - ${(place?.top ?? 48) + 110}px))`, overflowY: 'auto' } },
            query ? null : row('auto', !binding, false, () => choose(null), L('自动', 'Auto'), L('dsh 自己判断要不要调用、调用哪家', 'dsh decides whether and which to call')),
            recent.length ? [heading('recent', L('最近用过', 'Recent')), ...recent.map((t) => targetRow(t))] : null,
            groups.map((group) => [heading(group.cap, capabilityLabel(group.cap)), ...group.items.map((t) => targetRow(t))]),
            !targets ? h('div', { style: { padding: 8, fontSize: 12, color: T.secondary } }, L('正在读取…', 'Loading…')) : null,
            nothing ? h('div', { 'data-cli-empty': '', style: { padding: 8, fontSize: 12, color: T.secondary } }, L('没有匹配的工具', 'No matching tools')) : null,
            missing.length
              ? (showMissing || query
                ? [heading('missing', L('没有安装', 'Not installed')), ...missing.map((t) => targetRow(t))]
                : h('button', {
                  key: 'show-missing',
                  type: 'button',
                  'data-cli-show-missing': '',
                  onClick: () => setShowMissing(true),
                  style: { display: 'block', width: '100%', padding: '8px', border: 'none', background: 'transparent', color: T.secondary, fontSize: 11, textAlign: 'left', cursor: 'pointer' },
                }, L(`还有 ${missing.length} 个没有安装 ›`, `${missing.length} more not installed ›`)))
              : null),
          h('div', { style: { marginTop: 4, padding: '6px 8px 2px', borderTop: `1px solid ${T.border}`, fontSize: 11, color: T.secondary, lineHeight: 1.6 } },
            h('div', null, L('直通：消息直接交给它，不花 dsh 的 token', 'Direct: messages skip the dsh model and use no dsh tokens')),
            h('div', { 'data-cli-usage': '' }, usageText(status)),
            error ? h('div', { style: { color: T.danger } }, error) : null)) : null)
    }

    /** 输入框下方：平时不渲染，只有在跑任务时才冒一行（判断标准照 dsh-vps：你不问就不知道的事） */
    function CliDock(props) {
      const sessionId = props?.sessionId ? String(props.sessionId) : ''
      const store = useStatus(sessionId)
      const targets = useTargets()
      const running = store.status?.running ?? []
      const [, tick] = useState(0)
      const [error, setError] = useState('')
      useEffect(() => {
        if (!running.length) return undefined
        const timer = setInterval(() => tick((n) => n + 1), 1000)
        return () => clearInterval(timer)
      }, [running.length > 0])

      if (!sessionId || !running.length) return null
      const labelOf = (id) => targets?.find((t) => t.target === id)?.label ?? id

      const stop = async (job) => {
        try {
          publish(storeOf(sessionId), { status: await api('stop', { sessionId, job }) })
          setError('')
        } catch (e) {
          setError(e.message)
        }
      }

      return h('div', { 'data-cli-dock': '', style: { padding: '2px 4px 6px', fontSize: 12, color: T.secondary, lineHeight: 1.6 } },
        running.map((r) => h('div', { key: `${r.target}-${r.startedAt}`, style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { width: 7, height: 7, borderRadius: '50%', background: T.busy, animation: 'dsh-cli-pulse 1.1s ease-in-out infinite' } }),
          h('span', null, `${labelOf(r.target)}${r.tool ? ` · ${r.tool.split('__').pop()}` : ''} ${L('运行中', 'running')} ${seconds(r.startedAt)}s`),
          r.job ? h('button', {
            type: 'button',
            'data-cli-stop': r.job,
            onClick: () => stop(r.job),
            style: { padding: '0 6px', height: 18, border: `1px solid ${T.border}`, borderRadius: 4, background: 'transparent', color: T.text, fontSize: 11, cursor: 'pointer' },
          }, L('停止', 'Stop')) : null)),
        error ? h('div', { style: { color: T.danger } }, error) : null)
    }

    /** 设置页：桥上还能叠什么 */
    function SettingsSection() {
      const [extras, setExtras] = useState(null)
      const [error, setError] = useState('')
      const [copied, setCopied] = useState('')
      useEffect(() => {
        api('extras').then((r) => setExtras(r.extras)).catch((e) => setError(e.message))
      }, [])
      const textOf = (value) => (lang() === 'zh' ? value.zh : value.en)
      const copy = (extra) => {
        navigator.clipboard?.writeText(extra.command).then(() => {
          setCopied(extra.name)
          setTimeout(() => setCopied(''), 1500)
        })
      }
      return h('div', { 'data-cli-settings': '', style: { color: T.text, fontSize: 13, lineHeight: 1.6 } },
        h('div', { style: { color: T.secondary, marginBottom: 12 } },
          L('dsh-cli 只负责让 dsh 调用你电脑上的工具，够用就不用再装别的。下面这些按需要装，装完重启 DSH 生效。',
            'dsh-cli only lets dsh call the tools on your computer. Install these only if you need them, then restart DSH.')),
        error ? h('div', { style: { color: T.tertiary } }, error) : null,
        (extras ?? []).map((extra) => h('div', {
          key: extra.name,
          'data-cli-extra': extra.name,
          'data-cli-extra-installed': String(extra.installed),
          style: { padding: '10px 0', borderTop: `1px solid ${T.border}` },
        },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600 } }, textOf(extra.title)),
            h('code', { style: { fontSize: 12, color: T.tertiary } }, extra.name),
            h('span', { style: { fontSize: 12, color: T.tertiary, marginLeft: 'auto' } },
              extra.installed ? L('已安装', 'Installed') : extra.published ? L('未安装', 'Not installed') : L('还没发布', 'Not published yet'))),
          h('div', { style: { color: T.secondary, fontSize: 12 } }, textOf(extra.description)),
          !extra.installed && extra.command
            ? h('button', {
              type: 'button',
              'data-cli-extra-copy': extra.name,
              onClick: () => copy(extra),
              style: { marginTop: 6, padding: '3px 8px', borderRadius: 6, border: `1px solid ${T.border}`, background: 'transparent', color: T.text, fontSize: 12, cursor: 'pointer' },
            }, copied === extra.name ? L('已复制', 'Copied') : L('复制安装命令', 'Copy install command'))
            : null)))
    }

    const name = 'dsh-cli-client'
    const inject = ['slots']

    function apply(ctx) {
      try {
        ctx.inject?.(['locale'], (scope) => {
          const svc = scope.locale ?? scope.get?.('locale')
          if (svc) localeSvc = svc
        })
      } catch {
        // 没有语言服务就看网页语言
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-cli', order: 35, label: () => 'CLI' }, SettingsSection))
      } catch (error) {
        console.warn('[dsh-cli] 设置页注册失败', error)
      }
      try {
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register({ name: 'conversation.session.header.actions', id: 'dsh-cli', order: 35 }, CliToggle))
      } catch (error) {
        console.warn('[dsh-cli] 对话头部开关注册失败', error)
      }
      try {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'dsh-cli', order: 42 }, CliDock))
      } catch (error) {
        console.warn('[dsh-cli] 输入框状态条注册失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { buttonState, groupTargets, nextRecent, usageText, shortName, L } }
    return module.exports
  },
})
