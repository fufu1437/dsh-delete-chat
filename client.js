/**
 * Browser half of `@fufu1437/dsh-delete-chat`.
 *
 * Two registrations, one operation:
 *
 * - `sidebar.workspaces.session.menu.item` adds "彻底删除对话 / Delete
 *   conversation permanently" to the shipped "..." menu of every Session row
 *   (beside pin/rename/fork/archive);
 * - `shell.overlay` owns the confirmation dialog, because the surface must
 *   outlive the row menu it was opened from.
 *
 * The dialog renders its own controls and reads only `--dsw-alias-*` theme
 * tokens, so it matches the host in both themes without importing any Harness
 * Client package. The destructive work happens in the Host half's fenced
 * routes; this module never touches the filesystem.
 *
 * @module @fufu1437/dsh-delete-chat/client
 */

window.__ModuleLoader__.load({
  id: '@fufu1437/dsh-delete-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'fufu-delete-chat'
    const INSPECT_PATH = '/dsh-delete-chat/inspect'
    const DELETE_PATH = '/dsh-delete-chat/delete'

    /* ------------------------------------------------------------------ */
    /* Locale                                                             */
    /* ------------------------------------------------------------------ */

    const zh = {
      'menu.delete': '彻底删除对话…',
      'menu.delete.aria': '彻底删除对话「{title}」',
      'dialog.title': '彻底删除对话',
      'dialog.desc': '将永久删除「{title}」及其在本机的全部数据。此操作不可撤销。',
      'dialog.loading': '正在统计将删除的数据…',
      'dialog.blocked': '无法删除',
      'dialog.inventory': '将删除的数据',
      'dialog.total': '共 {entries} 项，约 {size}',
      'dialog.descendants': '同时删除 {n} 个子代理会话',
      'dialog.attachments': '附件：候选 {n} 个，仅在确认没有任何其他会话引用后删除',
      'dialog.attachments.unproven': '{n} 个附件因无法证实未被引用而保留',
      'dialog.empty': '没有找到可删除的本地数据。',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.deleting': '正在删除…',
      'dialog.done': '已删除 {n} 项，释放 {size}',
      'dialog.done.warn': '，{n} 条警告',
      'dialog.failed': '{n} 项删除失败，详见 Harness 日志',
      'dialog.close': '关闭',
      'kind.session-log': '会话日志目录',
      'kind.session-file': '会话日志文件',
      'kind.projection-cache': '投影缓存（标题/首条提示）',
      'kind.spill': '溢写的工具输出',
      'kind.legacy-feedback': '旧版反馈记录',
      'kind.attachment': '附件',
      'error.session-live': '该对话正在当前 Harness 进程中打开，Host 仍持有它的日志写入句柄，因此无法安全彻底删除。请重启 Harness 后再试。',
      'error.session-running': '该对话正在运行中，无法删除。请先停止它，重启 Harness 后再试。',
      'error.descendant-live': '该对话的子代理会话仍在当前 Harness 进程中运行，无法删除。请重启 Harness 后再试。',
      'error.invalid-session-id': '会话标识无效。',
      'error.failed': '操作失败：{message}',
    }

    const en = {
      'menu.delete': 'Delete conversation permanently…',
      'menu.delete.aria': 'Delete conversation "{title}" permanently',
      'dialog.title': 'Delete conversation permanently',
      'dialog.desc': 'This permanently erases "{title}" and every copy of its data on this machine. It cannot be undone.',
      'dialog.loading': 'Measuring what will be deleted…',
      'dialog.blocked': 'Cannot delete',
      'dialog.inventory': 'Data to delete',
      'dialog.total': '{entries} artifact(s), about {size}',
      'dialog.descendants': 'Also deletes {n} subagent session(s)',
      'dialog.attachments': 'Attachments: {n} candidate(s), removed only when no other session references them',
      'dialog.attachments.unproven': '{n} attachment(s) kept because they could not be proven unreferenced',
      'dialog.empty': 'No local data was found for this conversation.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.deleting': 'Deleting…',
      'dialog.done': 'Deleted {n} artifact(s), freed {size}',
      'dialog.done.warn': ', {n} warning(s)',
      'dialog.failed': '{n} artifact(s) failed to delete; see the Harness log',
      'dialog.close': 'Close',
      'kind.session-log': 'Session log directory',
      'kind.session-file': 'Session log file',
      'kind.projection-cache': 'Projection cache (title / first prompt)',
      'kind.spill': 'Spilled tool output',
      'kind.legacy-feedback': 'Legacy feedback record',
      'kind.attachment': 'Attachment',
      'error.session-live': 'This conversation is open in the current Harness process, which still holds its log write handle, so it cannot be erased safely. Restart the Harness and try again.',
      'error.session-running': 'This conversation is running. Stop it, restart the Harness, and try again.',
      'error.descendant-live': "This conversation's subagent sessions are still live in the current Harness process. Restart the Harness and try again.",
      'error.invalid-session-id': 'The session id is invalid.',
      'error.failed': 'The operation failed: {message}',
    }

    /** Literal fallback used only when the host locale service yields no translator. */
    const FALLBACK = en
    /** @param t - candidate translator. @returns a translator that always answers. */
    const translator = (t) => (typeof t === 'function' ? t : (key, params) => interpolate(FALLBACK[key] ?? key, params))

    /** @param text - template. @param params - substitutions. @returns the filled template. */
    function interpolate(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
    }

    /* ------------------------------------------------------------------ */
    /* Styles (theme tokens only)                                          */
    /* ------------------------------------------------------------------ */

    const CSS = `
.fdc-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.fdc-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.fdc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--dsw-alias-bg-base) 72%, transparent)}
.fdc-card{width:min(460px,calc(100vw - 32px));max-height:min(560px,80vh);overflow:auto;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)}
.fdc-title{margin:0 0 6px;font-size:15px;font-weight:600}
.fdc-desc{margin:0 0 12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.fdc-section{margin:12px 0 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:none}
.fdc-list{margin:0;padding:0;list-style:none;border-top:1px solid var(--dsw-alias-border-l1)}
.fdc-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:12.5px;line-height:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.fdc-muted{color:var(--dsw-alias-label-secondary)}
.fdc-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.fdc-btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.fdc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.fdc-btn:disabled{opacity:.5;cursor:default}
.fdc-btn-danger{background:transparent;border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.fdc-alert{margin:10px 0 0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-state-warn-primary)}
.fdc-error{margin:10px 0 0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
.fdc-ok{margin:10px 0 0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-state-success-primary)}
.fdc-spinner{display:inline-block;width:12px;height:12px;margin-right:6px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:fdc-spin .8s linear infinite;vertical-align:-2px}
@keyframes fdc-spin{to{transform:rotate(360deg)}}
`

    let styleInjected = false
    /** Inject the shared stylesheet exactly once per bundle. */
    function ensureStyles() {
      if (styleInjected) return
      styleInjected = true
      if (typeof document === 'undefined') return
      const element = document.createElement('style')
      element.setAttribute('data-dsh-plugin', NS)
      element.textContent = CSS
      document.head.appendChild(element)
    }

    function TrashIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
        h('path', {
          d: 'M3 4h10M6.5 4V2.8h3V4M5 4l.6 8.2a1 1 0 0 0 1 .8h2.8a1 1 0 0 0 1-.8L11 4M6.8 6.7v4M9.2 6.7v4',
          stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }))
    }

    /** @param bytes - byte count. @returns a compact human-readable size. */
    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${String(value)} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let scaled = value / 1024
      let index = 0
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024
        index += 1
      }
      return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[index]}`
    }

    /* ------------------------------------------------------------------ */
    /* Pending-request store shared by the menu entry and the overlay      */
    /* ------------------------------------------------------------------ */

    let pending = null
    const subscribers = new Set()
    /** @returns the current pending request. */
    const readPending = () => pending
    /** @param next - the new pending request, or null. */
    const writePending = (next) => {
      pending = next
      for (const notify of [...subscribers]) notify()
    }
    /** @param notify - subscriber. @returns its unsubscribe. */
    const subscribePending = (notify) => {
      subscribers.add(notify)
      return () => { subscribers.delete(notify) }
    }
    /** @returns the pending request, re-rendering on change. */
    const usePending = () => React.useSyncExternalStore(subscribePending, readPending, readPending)

    /* ------------------------------------------------------------------ */
    /* Host calls                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * POST one JSON body to a Host route and decode its JSON answer.
     * @param path - the fenced route path.
     * @param body - the request body.
     * @returns the decoded payload.
     * @throws an Error carrying `code` and `status` for a refused request.
     */
    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok) {
        const error = new Error(payload?.message ?? `request failed (${String(response.status)})`)
        error.code = payload?.code
        error.status = response.status
        throw error
      }
      return payload
    }

    /* ------------------------------------------------------------------ */
    /* Sidebar menu entry                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * One "彻底删除对话" row in a Session's "..." menu.
     * @param props - owner props (sessionId, displayTitle), the menu open-state
     *   hook, and the locale translator.
     * @returns the menu row.
     */
    function DeleteChatMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
      ensureStyles()
      const translate = translator(t)
      const [, setMenuOpen] = useMenuOpenState()
      const title = displayTitle !== undefined && displayTitle !== '' ? displayTitle : sessionId
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'fdc-menu-item',
        title: translate('menu.delete.aria', { title }),
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setMenuOpen(false)
          writePending({ sessionId, displayTitle: title })
        },
      }, h(TrashIcon), h('span', null, translate('menu.delete')))
    }

    /* ------------------------------------------------------------------ */
    /* Confirmation dialog                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * The `shell.overlay` entry: nothing while no deletion is pending,
     * otherwise exactly one dialog for the pending conversation.
     * @param props - the locale translator.
     * @returns the dialog, or null.
     */
    function DeleteChatDialog({ t }) {
      const request = usePending()
      if (request === null) return null
      return h(DeleteChatForm, { key: request.sessionId, request, t })
    }

    /**
     * One deletion's dialog: the inventory preview, the confirm/cancel pair,
     * and the post-deletion report. All request state dies with the dialog.
     * @param props - the pending request and the locale translator.
     * @returns the dialog element.
     */
    function DeleteChatForm({ request, t }) {
      ensureStyles()
      const translate = translator(t)
      const [phase, setPhase] = React.useState('loading')
      const [plan, setPlan] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [result, setResult] = React.useState(null)
      const cancelRef = React.useRef(null)
      const busy = phase === 'deleting'

      const close = React.useCallback(() => {
        if (busy) return
        writePending(null)
      }, [busy])

      React.useEffect(() => {
        let cancelled = false
        postJson(INSPECT_PATH, { sessionId: request.sessionId })
          .then((payload) => {
            if (cancelled) return
            setPlan(payload)
            setPhase('ready')
          })
          .catch((reason) => {
            if (cancelled) return
            setError(reason)
            setPhase('error')
          })
        return () => { cancelled = true }
      }, [request.sessionId])

      React.useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => { window.removeEventListener('keydown', onKeyDown) }
      }, [close])

      React.useEffect(() => {
        if (cancelRef.current !== null) cancelRef.current.focus()
      }, [phase])

      const confirm = () => {
        setPhase('deleting')
        setError(null)
        postJson(DELETE_PATH, { sessionId: request.sessionId })
          .then((payload) => {
            setResult(payload)
            setPhase('done')
          })
          .catch((reason) => {
            setError(reason)
            setPhase(reason?.status === 409 ? 'blocked' : 'error')
          })
      }

      const blocked = plan?.blocked ?? null
      return h('div', {
        className: 'fdc-overlay',
        onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
      }, h('div', {
        className: 'fdc-card',
        role: 'dialog',
        'aria-modal': true,
        'aria-label': translate('dialog.title'),
      },
      h('h2', { className: 'fdc-title' }, translate('dialog.title')),
      h('p', { className: 'fdc-desc' }, translate('dialog.desc', { title: request.displayTitle })),

      phase === 'loading' && h('div', { className: 'fdc-muted', role: 'status' },
        h('span', { className: 'fdc-spinner' }), translate('dialog.loading')),

      plan !== null && phase !== 'loading' && h(Inventory, { plan, translate }),

      blocked !== null && h('div', { className: 'fdc-error', role: 'alert' },
        h('strong', null, `${translate('dialog.blocked')}: `),
        translate(`error.${String(blocked.code)}`) === `error.${String(blocked.code)}`
          ? String(blocked.message ?? '')
          : translate(`error.${String(blocked.code)}`)),

      error !== null && phase !== 'blocked' && h('div', { className: 'fdc-error', role: 'alert' },
        translate('error.failed', { message: String(error.message ?? error) })),

      result !== null && h('div', { className: 'fdc-ok', role: 'status' },
        translate('dialog.done', { n: result.deleted.length, size: formatBytes(result.removedBytes) }),
        (result.warnings?.length ?? 0) > 0 ? translate('dialog.done.warn', { n: result.warnings.length }) : '',
        (result.failures?.length ?? 0) > 0 ? ` — ${translate('dialog.failed', { n: result.failures.length })}` : ''),

      h('div', { className: 'fdc-actions' },
        phase === 'done'
          ? h('button', { type: 'button', className: 'fdc-btn', onClick: close }, translate('dialog.close'))
          : h('button', { type: 'button', className: 'fdc-btn', ref: cancelRef, disabled: busy, onClick: close }, translate('dialog.cancel')),
        phase !== 'done' && h('button', {
          type: 'button',
          className: 'fdc-btn fdc-btn-danger',
          disabled: busy || blocked !== null || plan === null,
          onClick: confirm,
        }, busy ? translate('dialog.deleting') : translate('dialog.confirm')))))
    }

    /**
     * The measured inventory, grouped by artifact kind.
     * @param props - the plan and the locale translator.
     * @returns the summary block.
     */
    function Inventory({ plan, translate }) {
      const groups = new Map()
      for (const entry of plan.inventory ?? []) {
        const group = groups.get(entry.kind) ?? { kind: entry.kind, count: 0, bytes: 0 }
        group.count += 1
        group.bytes += entry.bytes ?? 0
        groups.set(entry.kind, group)
      }
      const rows = [...groups.values()]
      return h(React.Fragment, null,
        h('div', { className: 'fdc-section' }, translate('dialog.inventory')),
        rows.length === 0
          ? h('p', { className: 'fdc-muted' }, translate('dialog.empty'))
          : h('ul', { className: 'fdc-list' }, rows.map(group => h('li', { className: 'fdc-row', key: group.kind },
              h('span', null, translate(`kind.${group.kind}`)),
              h('span', { className: 'fdc-muted' }, `${String(group.count)} · ${formatBytes(group.bytes)}`)))),
        h('p', { className: 'fdc-muted' },
          translate('dialog.total', { entries: plan.totals?.entries ?? 0, size: formatBytes(plan.totals?.bytes ?? 0) })),
        (plan.descendants?.length ?? 0) > 0
          ? h('p', { className: 'fdc-alert' }, translate('dialog.descendants', { n: plan.descendants.length }))
          : null,
        (plan.attachmentCandidates ?? 0) > 0
          ? h('p', { className: 'fdc-muted' }, translate('dialog.attachments', { n: plan.attachmentCandidates }))
          : null)
    }

    /* ------------------------------------------------------------------ */
    /* Plugin body                                                         */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],

      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-delete-chat: dictionaries')

        ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
          yield ctx.slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'fufu-delete-chat',
            order: 450,
            locale: NS,
          }, DeleteChatMenuItem)
        })

        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register({
            name: 'shell.overlay',
            id: 'fufu-delete-chat-confirm',
            locale: NS,
          }, DeleteChatDialog)
        })
      },
    }
  },
})
