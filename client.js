/**
 * Client half of @local/dsh-reload-restart (v4 — native-styled dialogs).
 *
 * Adds two buttons into the desktop caption menubar (the 应用/编辑 bar that
 * lib/preload-app.cjs mounts as a <div data-windows-menu> with an OPEN shadow
 * root); buttons are appended inside that shadow root so they inherit the exact
 * same `button {}` styling as 应用/编辑.
 *
 * Dialogs use the app's own UI kit (@deepseek-ai/dsh-client-ui-primitives is
 * part of the client bundle's base require map): a plain Modal with
 * 取消/重启 buttons for the restart confirm (no acknowledgement checkbox —
 * that interaction is reserved for the app's high-risk operations) and
 * Modal+Button for error notices — fully inherited look. If the primitives
 * module is ever missing, we fall back to the plain window.confirm/alert so
 * the plugin keeps working.
 *
 *   - 刷新: reloads the page (a fresh HTML fetch also refreshes the plugin
 *     manifest snapshot — never blocked, no pre-probe).
 *   - 重启: confirm → ping the Host route → POST it. The Host hands the
 *     restart to a detached worker which closes the app shell and relaunches;
 *     the page dying with the shell is the expected success path.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-reload-restart',
  factory(require) {
    const React = require('react')
    const ReactDOMClient = require('react-dom/client')
    const h = React.createElement

    // 应用自带 UI 套件（基础 require 表成员；缺失时降级到原生 confirm/alert）。
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    const Modal = primitives && primitives.Modal
    const Button = primitives && primitives.Button
    const hasNativeDialog = Boolean(Modal && Button)

    const RESTART_URL = '/dsh-reload-restart/restart'
    const PING_URL = '/dsh-reload-restart/ping'
    const CLIENT_VERSION = '1.8.0'

    function api(path) {
      const relative = String(path).replace(/^\/+/, '')
      if (typeof document === 'undefined') return '/' + relative
      return new URL(relative, document.baseURI).pathname
    }

    /* ------------------------------------------------------------------ *
     * i18n — 与桌面壳同一套语义（preload 的 resolveDesktopLocale）：
     * 语言源是 <html lang>，取主子标签，zh → zh-CN，其余 → en；
     * lang 属性变化时实时跟随（见 apply 里的 MutationObserver）。
     * ------------------------------------------------------------------ */
    const LOCALES = {
      'zh-CN': {
        refreshLabel: '刷新',
        refreshAria: '刷新页面',
        restartLabel: '重启',
        restartAria: '重启应用',
        restarting: '重启中…',
        confirmTitle: '重启 DeepSeek Harness',
        confirmDescription: '应用会完全关闭，几秒后自动重新打开。会话记录会保留，未保存的界面状态会随重启丢失。',
        cancelLabel: '取消',
        closeLabel: '关闭',
        confirmLabel: '重启',
        confirmFallback: '重启 DeepSeek Harness？\n\n界面会随应用一起关闭，几秒后自动重新打开。',
        failTitle: '重启失败',
        failNoHost: '宿主半边没有响应（插件可能没装全，或内核已停止）。',
        failRequest: '重启请求没有成功：',
        incompleteTitle: '重启未完成',
        incompleteDescription: '应用没有关闭——上一轮重启可能没有完成。可以再点一次；若反复出现请查看 logs/dsh-reload-restart-*.log。',
      },
      en: {
        refreshLabel: 'Refresh',
        refreshAria: 'Refresh page',
        restartLabel: 'Restart',
        restartAria: 'Restart app',
        restarting: 'Restarting…',
        confirmTitle: 'Restart DeepSeek Harness',
        confirmDescription: 'The app will close completely and reopen automatically in a few seconds. Sessions are preserved; unsaved UI state will be lost.',
        cancelLabel: 'Cancel',
        closeLabel: 'Close',
        confirmLabel: 'Restart',
        confirmFallback: 'Restart DeepSeek Harness?\n\nThe interface will close with the app and reopen automatically in a few seconds.',
        failTitle: 'Restart failed',
        failNoHost: 'The host side is not responding (the plugin may be incomplete, or the kernel has stopped).',
        failRequest: 'The restart request failed: ',
        incompleteTitle: 'Restart not completed',
        incompleteDescription: 'The app did not close — the previous restart may not have finished. You can try again; if it keeps happening, check logs/dsh-reload-restart-*.log.',
      },
    }
    function resolveLocale() {
      const lang = (typeof document !== 'undefined' && document.documentElement.lang) || ''
      const primary = String(lang).toLowerCase().split('-')[0]
      return primary === 'zh' ? LOCALES['zh-CN'] : LOCALES.en
    }
    let t = resolveLocale()
    // 菜单栏按钮的引用，供 lang 变化时刷新文案（mountBar 里赋值）。
    let barButtons = null
    // 看门狗定时器：POST 发出后若壳一直没关（页面 15 秒后还活着），恢复按钮
    // 并告知用户。放在 factory 作用域，dispose 时能统一清理，避免泄漏定时器。
    let watchdogTimer = null
    function armWatchdog() {
      if (watchdogTimer) clearTimeout(watchdogTimer)
      watchdogTimer = setTimeout(() => {
        watchdogTimer = null
        // 插件已停用/按钮已摘除（cleanup 会置 barButtons = null）就不再弹窗。
        if (!barButtons || !barButtons.restartButton.isConnected) return
        barButtons.restartButton.disabled = false
        barButtons.restartButton.textContent = t.restartLabel
        alertDialog(t.incompleteTitle, t.incompleteDescription)
      }, 15000)
    }

    /* ------------------------------------------------------------------ *
     * Dialog host: one React root on document.body rendering the app's
     * own Modal (+Button). Promise-based helpers below.
     * ------------------------------------------------------------------ */
    let dialogHost = null
    let dialogState = null
    const dialogSubscribers = new Set()

    function ensureDialogHost() {
      if (dialogHost || !hasNativeDialog) return
      const el = document.createElement('div')
      el.dataset.dshReloadRestartDialog = ''
      document.body.append(el)
      const root = ReactDOMClient.createRoot(el)
      const render = () => root.render(h(DialogHost))
      dialogHost = { el, root, render, dispose() { root.unmount(); el.remove() } }
    }

    function publishDialog(next) {
      // 同一时刻只保留一个对话框：新弹窗顶掉旧的之前，先把旧 Promise 收尾
      // （确认框按取消算、提示框按已读算），否则调用方会永远 await 不到结果。
      if (dialogState && dialogState.resolve) {
        dialogState.resolve(dialogState.type === 'confirm' ? false : undefined)
      }
      dialogState = next
      dialogSubscribers.forEach((notify) => notify(next))
      if (dialogHost) dialogHost.render()
    }

    function DialogHost() {
      const [state, setState] = React.useState(dialogState)
      React.useEffect(() => {
        dialogSubscribers.add(setState)
        return () => dialogSubscribers.delete(setState)
      }, [])
      if (!state) return null
      const settle = (value) => {
        try {
          fetch(api(PING_URL) + '?stage=settle-' + String(value), { cache: 'no-store' }).catch(() => {})
        } catch { /* 探针失败不影响流程 */ }
        const resolve = state.resolve
        // 关键：先把「当前弹窗」从登记处摘掉，再走 publishDialog——
        // 否则 publishDialog 会把正在关闭的它当「被顶掉的旧弹窗」，
        // 抢先用 false 结算同一个 Promise，真正的结果反而作废。
        dialogState = null
        publishDialog(null)
        resolve(value)
      }
      if (state.type === 'confirm') {
        // 普通「取消 / 确认」双按钮确认框。按钮必须放 children 内部：
        // Modal 的 footer 插槽渲染在它的「外部点击」判定区之外，点那里会
        // 先触发 onClose（按取消处理），按钮自身的 onClick 反而不生效。
        return h(Modal, {
          open: true,
          onClose: () => settle(false),
          title: state.title,
          closeLabel: state.closeLabel,
        }, h('div', null,
          h('p', { style: { margin: '0 0 16px', lineHeight: 1.6 } }, state.description),
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h(Button, { variant: 'outline', onClick: () => settle(false) }, state.cancelLabel),
            h(Button, { variant: 'primary', onClick: () => settle(true) }, state.confirmLabel),
          ),
        ))
      }
      return h(Modal, {
        open: true,
        onClose: () => settle(undefined),
        title: state.title,
        closeLabel: t.closeLabel,
      }, h('p', { style: { margin: 0, lineHeight: 1.6 } }, state.description))
    }

    /** 应用风格确认框（无 UI 套件时回退 window.confirm）。resolve(true)=继续。 */
    function confirmDialog(opts) {
      if (!hasNativeDialog) return Promise.resolve(window.confirm(opts.fallbackText))
      ensureDialogHost()
      return new Promise((resolve) => {
        publishDialog({ type: 'confirm', resolve, ...opts })
      })
    }

    /** 应用风格提示框（无 UI 套件时回退 window.alert）。 */
    function alertDialog(title, description) {
      if (!hasNativeDialog) return Promise.resolve(window.alert(description))
      ensureDialogHost()
      return new Promise((resolve) => {
        publishDialog({ type: 'alert', resolve, title, description })
      })
    }

    function mountBar(shadow) {
      const bar = shadow.querySelector('[role=menubar]')
      if (!bar) return false
      if (shadow.querySelector('[data-dsh-reload-restart]')) return true

      const make = (label, title, onClick) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        button.tabIndex = 0
        button.textContent = label
        button.dataset.dshReloadRestart = ''
        // 与原生「应用/编辑」一致：不设 title（会冒浏览器悬停提示框），
        // 无障碍语义走 aria-label。
        button.setAttribute('aria-label', title)
        button.addEventListener('pointerdown', (e) => e.preventDefault())
        button.addEventListener('mousedown', (e) => e.preventDefault())
        button.addEventListener('click', onClick)
        return button
      }

      const refreshButton = make(t.refreshLabel, t.refreshAria, () => {
        // 直接刷新：location.reload 会重新拉取最新 HTML 与插件清单，
        // 这本身就是纠正过期快照的手段，不做任何拦截。
        window.location.reload()
      })

      const restartButton = make(t.restartLabel, t.restartAria, async () => {
        if (restartButton.disabled) return
        // 阶段探针 0：点击处理函数已进入（与弹窗结果无关，宿主记入 diag 日志）。
        try {
          fetch(api(PING_URL) + '?stage=restart-click', { cache: 'no-store' }).catch(() => {})
        } catch { /* 探针失败不影响流程 */ }
        const confirmed = await confirmDialog({
          title: t.confirmTitle,
          description: t.confirmDescription,
          cancelLabel: t.cancelLabel,
          closeLabel: t.closeLabel,
          confirmLabel: t.confirmLabel,
          fallbackText: t.confirmFallback,
        })
        // 阶段探针 1：弹窗已出结果（confirm=1 确认，confirm=0 取消/关闭）。
        try {
          fetch(api(PING_URL) + '?stage=confirm=' + (confirmed ? '1' : '0'), { cache: 'no-store' }).catch(() => {})
        } catch { /* 探针失败不影响流程 */ }
        if (!confirmed) return
        restartButton.disabled = true
        restartButton.textContent = t.restarting
        // 先探测宿主半边，失败时给出可读原因。
        let alive = false
        try {
          const ping = await fetch(api(PING_URL), { method: 'GET', cache: 'no-store' })
          alive = ping.ok
        } catch {
          alive = false
        }
        if (!alive) {
          restartButton.disabled = false
          restartButton.textContent = t.restartLabel
          alertDialog(t.failTitle, t.failNoHost)
          return
        }
        try {
          const response = await fetch(api(RESTART_URL), {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-reload-restart': 'restart' },
            body: '{}',
          })
          if (!response.ok) {
            let reason = 'HTTP ' + response.status
            try {
              const payload = await response.json()
              if (payload && payload.error) reason = payload.error
            } catch { /* 非 JSON 回包就用状态码 */ }
            throw new Error(reason)
          }
          // 看门狗：正常情况下壳在几秒内关闭、页面随之消失；15 秒后页面还活着
          // 说明这轮重启没真正发生（如接手进程静默失败），恢复按钮并告知用户。
          armWatchdog()
          // 成功：壳很快关闭，页面随之断开；这里无需再做任何事。
        } catch (error) {
          // ping 刚成功后的网络层异常（TypeError）＝壳大概率已在关闭、连接被掐断，
          // 属预期中的成功路径，不算失败；仍挂看门狗兜底——万一壳其实没死，
          // 按钮 15 秒后会自己恢复，而不是永远卡在「重启中」。
          if (error instanceof TypeError) {
            armWatchdog()
            return
          }
          restartButton.disabled = false
          restartButton.textContent = t.restartLabel
          alertDialog(t.failTitle, t.failRequest + (error && error.message ? error.message : error))
        }
      })

      bar.append(refreshButton, restartButton)
      barButtons = { refreshButton, restartButton }
      return true
    }

    let attachedHost = null

    function attach() {
      const host = document.querySelector('div[data-windows-menu]')
      if (!host || !host.shadowRoot) return false
      if (mountBar(host.shadowRoot)) {
        attachedHost = host
        return true
      }
      return false
    }

    return {
      inject: [],
      apply(ctx) {
        // 版本 + 组件状态上报（宿主记到 diag 日志；用于远程诊断客户端实际加载情况）。
        try {
          fetch(api(PING_URL) + '?v=' + CLIENT_VERSION + '&native=' + (hasNativeDialog ? '1' : '0'), {
            cache: 'no-store',
          }).catch(() => {})
        } catch { /* 上报失败不影响功能 */ }
        let observer = null
        const stop = () => {
          if (observer) { observer.disconnect(); observer = null }
        }
        // 语言跟随：<html lang> 变化（应用内切换语言）时实时刷新按钮文案，
        // 与桌面壳对菜单栏标签的处理一致。
        const langObserver = new MutationObserver(() => {
          t = resolveLocale()
          if (!barButtons) return
          barButtons.refreshButton.textContent = t.refreshLabel
          barButtons.refreshButton.setAttribute('aria-label', t.refreshAria)
          barButtons.restartButton.textContent = barButtons.restartButton.disabled ? t.restarting : t.restartLabel
          barButtons.restartButton.setAttribute('aria-label', t.restartAria)
        })
        langObserver.observe(document.documentElement, { attributeFilter: ['lang'] })
        const watchShadow = () => {
          if (!observer) return
          const host = document.querySelector('div[data-windows-menu]')
          if (host && host.shadowRoot) {
            observer.observe(host.shadowRoot, { childList: true, subtree: true })
          }
        }
        ctx.effect(() => {
          if (!attach()) {
            observer = new MutationObserver(() => {
              if (attach()) { stop(); return }
              // 栏位宿主已出现但 shadow 里的 menubar 还没建好：
              // shadow 内部变更 light-DOM observer 看不见，要单独盯着 shadowRoot。
              watchShadow()
            })
            observer.observe(document.body, { childList: true, subtree: true })
            watchShadow()
          }
          return () => {
            stop()
            // 挂着的对话框先收尾，别让调用方悬挂。
            if (dialogState && dialogState.resolve) {
              const pending = dialogState
              dialogState = null
              pending.resolve(pending.type === 'confirm' ? false : undefined)
            }
            // 卸载/升级时把留在菜单栏里的按钮摘掉，别留下僵尸控件。
            if (attachedHost && attachedHost.isConnected && attachedHost.shadowRoot) {
              attachedHost.shadowRoot
                .querySelectorAll('[data-dsh-reload-restart]')
                .forEach((button) => button.remove())
            }
            attachedHost = null
            if (dialogHost) { dialogHost.dispose(); dialogHost = null }
            langObserver.disconnect()
            // 看门狗定时器一并清掉，别让卸载后的定时器再触发。
            if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
            barButtons = null
          }
        }, 'dsh-reload-restart-topbar')
      },
    }
  },
})
