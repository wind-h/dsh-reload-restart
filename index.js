/**
 * Host half of @local/dsh-reload-restart.
 *
 * Registers loopback HTTP routes on the GUI web server. The client half pings
 * and POSTs to arm the restart:
 *
 *   GET  /dsh-reload-restart/ping     liveness probe (client checks before restart)
 *   POST /dsh-reload-restart/restart  hands the restart to the detached worker
 *
 * Restart model ("close the shell, not the kernel"):
 *   The desktop main process treats ANY host-kernel exit as fatal (error dialog).
 *   So we never exit the kernel ourselves on the happy path. Instead the worker
 *   (assets/restart-app.mjs, run by process.execPath with ELECTRON_RUN_AS_NODE=1 —
 *   no cmd, no window) kills the Electron MAIN process (our ppid): the kernel
 *   then sees its IPC disconnect and shuts down gracefully on its own, and with
 *   the main process gone nothing can pop the recovery dialog. The worker waits
 *   for the web port to be released, prunes accumulated auth cookies, and
 *   relaunches the exe (retrying once).
 *
 *   Fallback: if the worker cannot be spawned, we emit the kernel's own shutdown
 *   message and exit — this DOES pop the recovery dialog, whose 重启 button is
 *   the app's native restart; ugly but never stuck.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = '/dsh-reload-restart/restart'
const PING_ROUTE = '/dsh-reload-restart/ping'
const WORKER = fileURLToPath(new URL('./assets/restart-app.mjs', import.meta.url))

// 一次性闸：接手进程已在路上时，重复 POST 不再拉新的 worker。
let restartArmed = false

export const name = 'dsh-reload-restart'
export const inject = ['webServer']

/** 桌面端＝宿主跑在 Electron 的 Node 模式里（有可拉起的壳）。 */
function isDesktop() {
  return typeof process.versions?.electron === 'string' && process.versions.electron !== ''
}

function logDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(home, 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return tmpdir()
  }
  return dir
}

function logPath() {
  return join(logDir(), 'dsh-reload-restart-restart.log')
}

/**
 * 把重启交给独立脚本：延迟 0.2 秒（响应早已刷回客户端，这只是避免掐断
 * 连接的余量）后关壳再拉起。本进程不退出——壳一走，内核收到 IPC 断开自行优雅收尾。
 */
function handOffRestart(port, delayMs = 200) {
  if (!existsSync(WORKER)) return false
  const exe = process.execPath
  const parentPid = process.ppid
  const child = spawn(process.execPath, [
    WORKER,
    String(parentPid),
    exe,
    String(process.pid),
    String(port ?? ''),
    logPath(),
    String(delayMs),
  ], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {
    // spawn 异步失败＝接手进程没跑起来：退回内核自己退出的兜底（弹原生恢复框）。
    shutdownAndExit()
  })
  // 接手进程非零退出＝这轮交接失败（壳还活着）：解除一次性闸，
  // 否则闸永远卡死，之后每次点击都拿到静默的 mode:already，重启按钮变砖。
  child.on('exit', (code) => {
    if (code !== 0) restartArmed = false
  })
  child.unref()
  return child.pid !== undefined
}

/** 兜底：走内核自己的 shutdown，跑完进程自然退出（会弹恢复框，框里有原生的「重启」）。 */
function shutdownAndExit() {
  let exited = false
  const hardExit = () => {
    if (exited) return
    exited = true
    process.exit(0)
  }
  try {
    process.emit('message', { type: 'shutdown' }, null)
  } catch {
    hardExit()
    return
  }
  setTimeout(hardExit, 3000)
}

function isLocal(req) {
  const addr = req.socket && req.socket.remoteAddress
  return typeof addr === 'string' && /^(::1|127\.|::ffff:127\.)/.test(addr)
}

function sendJson(res, code, value) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  } catch {
    /* 客户端已断开就算了 */
  }
}

const DIAG_LOG = join(logDir(), 'dsh-reload-restart-diag.log')
// 日志上限 256KB：diag 会随每次页面加载/点击追加，不设上限会无限膨胀。
// 超限时把当前文件轮转为 .old（覆盖旧 .old），再从头写。
const LOG_CAP = 256 * 1024
function appendCapped(file, line) {
  try {
    try {
      if (statSync(file).size > LOG_CAP) renameSync(file, `${file}.old`)
    } catch {
      /* 文件还不存在＝直接追加 */
    }
    appendFileSync(file, line)
  } catch {
    /* 日志写不进去不影响功能 */
  }
}
function diag(line) {
  appendCapped(DIAG_LOG, `${new Date().toISOString()} ${line}\n`)
}

/** 防跨站触发：浏览器表单/跨站 fetch 带不了这个自定义头（带了也会被 CORS 预检拦下）。 */
function hasGuardHeader(req) {
  return req.headers['x-dsh-reload-restart'] === 'restart'
}

export function apply(ctx) {
  const webServer = ctx.webServer
  const dispose = webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler(req, res) {
      res.on('error', () => {})
      req.resume()
      diag(`${req.socket?.remotePort || '?'}->${req.method} ${req.url} guard=${hasGuardHeader(req) ? 1 : 0}`)
      if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: '只接受本机请求' })
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
      if (!hasGuardHeader(req)) return sendJson(res, 403, { ok: false, error: '缺少请求头 x-dsh-reload-restart: restart' })
      if (!isDesktop()) {
        return sendJson(res, 400, { ok: false, error: '非桌面端没有可拉起的应用壳' })
      }
      if (restartArmed) return sendJson(res, 200, { ok: true, mode: 'already' })
      let handedOff = false
      try {
        handedOff = handOffRestart(webServer.port)
      } catch {
        handedOff = false
      }
      if (handedOff) restartArmed = true
      sendJson(res, 200, { ok: true, mode: handedOff ? 'relaunch' : 'exit' })
      // 接手失败就别干等：退回内核自己退出（弹恢复框，框里有原生「重启」可用）。
      if (!handedOff) setTimeout(shutdownAndExit, 400)
    },
  })
  ctx.effect(() => dispose)

  const disposePing = webServer.register({
    kind: 'exact',
    path: PING_ROUTE,
    handler(req, res) {
      res.on('error', () => {})
      req.resume()
      diag(`${req.socket?.remotePort || '?'}->${req.method} ${req.url}`)
      if (!isLocal(req)) return sendJson(res, 403, { ok: false, error: '只接受本机请求' })
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' })
      sendJson(res, 200, { ok: true })
    },
  })
  ctx.effect(() => disposePing)
}
