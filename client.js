/**
 * Browser half of `@fufu1437/dsh-delete-chat`.
 *
 * Two registrations, one operation:
 *
 * - `sidebar.workspaces.session.menu.item` adds "删除对话 / Delete
 *   conversation" to the shipped "..." menu of every Session row (beside
 *   pin/rename/fork/archive);
 * - `shell.overlay` owns the confirmation dialog, because the surface must
 *   outlive the row menu it was opened from.
 *
 * The flow is deliberately short: choosing the menu row opens the confirmation
 * immediately, with no pre-delete query, no inventory, and no byte totals.
 * Confirming closes the dialog at once and starts the deletion in the
 * background; the sidebar entry vanishes when the Host broadcasts the removal.
 * Only a failure — a conversation still running, an unreachable Host — comes
 * back, as a small alert card, because that is the one thing the user must not
 * miss.
 *
 * The dialog renders its own controls and reads only `--dsw-alias-*` theme
 * tokens, so it matches the host in both themes without importing any Harness
 * Client package. The destructive work happens in the Host half's fenced
 * route; this module never touches the filesystem.
 *
 * @module @fufu1437/dsh-delete-chat/client
 */

window.__ModuleLoader__.load({
  id: '@fufu1437/dsh-delete-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'fufu-delete-chat'
    const DELETE_PATH = '/dsh-delete-chat/delete'

    /* ------------------------------------------------------------------ */
    /* Locale                                                             */
    /* ------------------------------------------------------------------ */

    const zh = {
      'menu.delete': '删除对话…',
      'menu.delete.aria': '删除对话「{title}」',
      'dialog.title': '删除对话',
      'dialog.desc': '将永久删除「{title}」及其在本机的全部数据。此操作不可撤销。',
      'dialog.note': '确认后删除在后台执行，本窗口会立即关闭；完成后该对话从侧边栏消失。',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.close': '关闭',
      'dialog.failed.title': '删除失败',
      'dialog.failed.desc': '「{title}」未能删除：{message}',
      'error.session-live': '该对话正在当前 Harness 进程中打开，Host 仍持有它的日志写入句柄，因此无法安全删除。请重启 Harness 后再试。',
      'error.session-running': '该对话正在运行中，无法删除。请先停止它，重启 Harness 后再试。',
      'error.descendant-live': '该对话的子代理会话仍在当前 Harness 进程中运行，无法删除。请重启 Harness 后再试。',
      'error.invalid-session-id': '会话标识无效。',
    }

    const en = {
      'menu.delete': 'Delete conversation…',
      'menu.delete.aria': 'Delete conversation "{title}"',
      'dialog.title': 'Delete conversation',
      'dialog.desc': 'This permanently erases "{title}" and every copy of its data on this machine. It cannot be undone.',
      'dialog.note': 'The deletion runs in the background: this dialog closes now and the sidebar entry disappears when it finishes.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.close': 'Close',
      'dialog.failed.title': 'Deletion failed',
      'dialog.failed.desc': 'Could not delete "{title}": {message}',
      'error.session-live': 'This conversation is open in the current Harness process, which still holds its log write handle, so it cannot be erased safely. Restart the Harness and try again.',
      'error.session-running': 'This conversation is running. Stop it, restart the Harness, and try again.',
      'error.descendant-live': "This conversation's subagent sessions are still live in the current Harness process. Restart the Harness and try again.",
      'error.invalid-session-id': 'The session id is invalid.',
    }

    /** Literal fallback used only when the host locale service yields no translator. */
    const FALLBACK = en

    /** @param text - template. @param params - substitutions. @returns the filled template. */
    function interpolate(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])))
    }

    /** @param t - candidate translator. @returns a translator that always answers. */
    const translator = (t) => (typeof t === 'function' ? t : (key, params) => interpolate(FALLBACK[key] ?? key, params))

    /* ------------------------------------------------------------------ */
    /* Styles (theme tokens only)                                          */
    /* ------------------------------------------------------------------ */

    const CSS = `
.fdc-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.fdc-menu-item:hover{background:var(--dsw-alias-bg-layer-2)}
.fdc-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));backdrop-filter:var(--dsw-mask-blur,none)}
.fdc-card{box-sizing:border-box;display:flex;flex-direction:column;width:min(400px,100%);max-height:min(560px,calc(100vh - 48px));overflow:auto;padding:0 0 20px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.18))}
.fdc-title{margin:0;padding:20px 20px 0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.fdc-desc{margin:0;padding:6px 20px 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary)}
.fdc-body{display:flex;flex-direction:column;gap:8px;padding:16px 20px 0}
.fdc-body p{margin:0}
.fdc-muted{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.fdc-actions{display:flex;justify-content:flex-end;gap:8px;padding:20px 20px 0}
.fdc-btn{padding:6px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.fdc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.fdc-btn-danger{background:transparent;border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.fdc-toast{position:fixed;right:16px;bottom:16px;z-index:1000;width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.18))}
.fdc-toast-title{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-state-error-primary)}
.fdc-toast-text{margin:0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.fdc-toast-actions{display:flex;justify-content:flex-end}
`

    /** The one stylesheet element this bundle owns, removed when the plugin unloads. */
    let styleElement = null

    /** Create the shared stylesheet once; its owner is the plugin effect. */
    function mountStyles() {
      if (styleElement !== null || typeof document === 'undefined') return
      styleElement = document.createElement('style')
      styleElement.setAttribute('data-dsh-plugin', NS)
      styleElement.textContent = CSS
      document.head.appendChild(styleElement)
    }

    /** Remove the stylesheet; safe before mount and after an earlier removal. */
    function unmountStyles() {
      if (styleElement === null) return
      styleElement.remove()
      styleElement = null
    }

    function TrashIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' },
        h('path', {
          d: 'M3 4h10M6.5 4V2.8h3V4M5 4l.6 8.2a1 1 0 0 0 1 .8h2.8a1 1 0 0 0 1-.8L11 4M6.8 6.7v4M9.2 6.7v4',
          stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }))
    }

    /* ------------------------------------------------------------------ */
    /* Dialog state                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * One observable store for both surfaces. The snapshot object is replaced
     * only on a write, so `useSyncExternalStore` sees a stable reference
     * between changes.
     */
    const store = (() => {
      let snapshot = { pending: null, notice: null }
      const subscribers = new Set()
      return {
        /** @returns the current dialog state. */
        read: () => snapshot,
        /** @param patch - fields to replace. */
        write: (patch) => {
          snapshot = { ...snapshot, ...patch }
          for (const notify of [...subscribers]) notify()
        },
        /** @param notify - subscriber. @returns its unsubscribe. */
        subscribe: (notify) => {
          subscribers.add(notify)
          return () => { subscribers.delete(notify) }
        },
      }
    })()

    /** @returns the dialog state, re-rendering on change. */
    function useDialogState() {
      return React.useSyncExternalStore(store.subscribe, store.read, store.read)
    }

    /* ------------------------------------------------------------------ */
    /* Host call                                                           */
    /* ------------------------------------------------------------------ */

    /**
     * POST one JSON body to the deletion route and decode its JSON answer.
     * @param body - the request body.
     * @returns the decoded payload.
     * @throws an Error carrying `code` and `status` for a refused request.
     */
    async function postDelete(body) {
      const response = await fetch(DELETE_PATH, {
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

    /**
     * Turn one background failure into text the user can act on: the localized
     * reason for a known refusal code, otherwise the Host's own message.
     * @param reason - the thrown value.
     * @param translate - the locale translator.
     * @returns the message to display.
     */
    function describeFailure(reason, translate) {
      const code = reason?.code
      if (typeof code === 'string') {
        const key = `error.${code}`
        const text = translate(key)
        if (text !== key) return text
      }
      return String(reason?.message ?? reason)
    }

    /* ------------------------------------------------------------------ */
    /* Sidebar menu entry                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * One "删除对话" row in a Session's "..." menu.
     * @param props - owner props (sessionId, displayTitle), the menu open-state
     *   hook, and the locale translator.
     * @returns the menu row.
     */
    function DeleteChatMenuItem({ sessionId, displayTitle, useMenuOpenState, t }) {
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
          store.write({ pending: { sessionId, displayTitle: title } })
        },
      }, h(TrashIcon), h('span', null, translate('menu.delete')))
    }

    /* ------------------------------------------------------------------ */
    /* Confirmation                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * The `shell.overlay` entry: the confirmation while one is pending, the
     * alert for a failed background deletion when one exists, otherwise
     * nothing.
     * @param props - the locale translator.
     * @returns the overlay content.
     */
    function DeleteChatDialog({ t }) {
      const { pending, notice } = useDialogState()
      if (pending !== null) return h(ConfirmDialog, { key: `confirm:${pending.sessionId}`, request: pending, t })
      if (notice !== null) return h(FailureNotice, { key: `notice:${notice.sessionId}`, notice, t })
      return null
    }

    /**
     * The confirmation itself: title, the irreversibility warning, and a note
     * that the work continues in the background. Confirming closes the dialog
     * first and then launches the deletion, so the surface never blocks on it.
     * @param props - the pending request and the locale translator.
     * @returns the dialog element.
     */
    function ConfirmDialog({ request, t }) {
      const translate = translator(t)
      const cancelRef = React.useRef(null)
      const close = React.useCallback(() => { store.write({ pending: null }) }, [])

      React.useEffect(() => {
        const onKeyDown = (event) => { if (event.key === 'Escape') close() }
        window.addEventListener('keydown', onKeyDown)
        return () => { window.removeEventListener('keydown', onKeyDown) }
      }, [close])

      React.useEffect(() => {
        if (cancelRef.current !== null) cancelRef.current.focus()
      }, [])

      const confirm = () => {
        const { sessionId, displayTitle } = request
        // Close first: the deletion is a background operation from here on.
        store.write({ pending: null })
        void postDelete({ sessionId }).catch((reason) => {
          store.write({ notice: { sessionId, displayTitle, message: describeFailure(reason, translate) } })
        })
      }

      return h(DialogShell, {
        label: translate('dialog.title'),
        onClose: close,
      },
      h('h2', { className: 'fdc-title' }, translate('dialog.title')),
      h('p', { className: 'fdc-desc' }, translate('dialog.desc', { title: request.displayTitle })),
      h('div', { className: 'fdc-body' }, h('p', { className: 'fdc-muted' }, translate('dialog.note'))),
      h('div', { className: 'fdc-actions' },
        h('button', { type: 'button', className: 'fdc-btn', ref: cancelRef, onClick: close }, translate('dialog.cancel')),
        h('button', { type: 'button', className: 'fdc-btn fdc-btn-danger', onClick: confirm }, translate('dialog.confirm'))))
    }

    /**
     * The alert for a deletion that failed in the background. It is a corner
     * card rather than a modal: it must not block work the user moved on to,
     * and it stays until dismissed because it reports lost intent.
     * @param props - the failure notice and the locale translator.
     * @returns the alert element.
     */
    function FailureNotice({ notice, t }) {
      const translate = translator(t)
      const close = React.useCallback(() => { store.write({ notice: null }) }, [])
      const closeRef = React.useRef(null)

      React.useEffect(() => {
        const onKeyDown = (event) => { if (event.key === 'Escape') close() }
        window.addEventListener('keydown', onKeyDown)
        return () => { window.removeEventListener('keydown', onKeyDown) }
      }, [close])

      React.useEffect(() => {
        if (closeRef.current !== null) closeRef.current.focus()
      }, [])

      return h('div', { className: 'fdc-toast', role: 'alert' },
        h('div', { className: 'fdc-toast-title' }, translate('dialog.failed.title')),
        h('p', { className: 'fdc-toast-text' },
          translate('dialog.failed.desc', { title: notice.displayTitle, message: notice.message })),
        h('div', { className: 'fdc-toast-actions' },
          h('button', { type: 'button', className: 'fdc-btn', ref: closeRef, onClick: close }, translate('dialog.close'))))
    }

    /**
     * The shared modal frame: a scrim that dismisses on backdrop click, and the
     * host-styled card that holds one dialog's content.
     * @param props - the accessible label, the close action, and the content.
     * @returns the overlay element.
     */
    function DialogShell({ label, onClose, children }) {
      return h('div', {
        className: 'fdc-overlay',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      }, h('div', {
        className: 'fdc-card',
        role: 'dialog',
        'aria-modal': true,
        'aria-label': label,
      }, children))
    }

    /* ------------------------------------------------------------------ */
    /* Plugin body                                                         */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],

      apply(ctx) {
        ctx.effect(() => {
          mountStyles()
          return () => { unmountStyles() }
        }, 'dsh-delete-chat: styles')
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
