#!/usr/bin/env node
/**
 * 接手重启的独立脚本 —— 由插件宿主 detached 拉起，独立于应用进程树存活。
 *
 * 为什么「先关界面壳」而不是内核自己退出：
 * 桌面主进程把内核退出无条件当致命故障（child close -> fail -> 弹恢复框），
 * 内核自己 exit 必弹框。反过来：先杀掉 Electron 主进程，内核收到 IPC 断开会走
 * 自己的优雅收尾（dsh-desktop-host 的 process.once('disconnect')），且没有任何
 * 进程能弹框。随后本脚本把应用 exe 重新拉起。
 *
 * 本脚本必须用应用的 exe 以 ELECTRON_RUN_AS_NODE=1 方式运行（父进程传好环境），
 * 全程 detached + windowsHide，没有 cmd、没有可见窗口。
 *
 * 参数：node restart-app.mjs <主进程PID> <exe路径> <内核PID> <web端口> <日志路径> <延迟ms>
 */

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { appendFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const [parentPid, exePath, hostPid, portArg, logPath, delayArg] = process.argv.slice(2)
const port = Number(portArg || 0)
const delayMs = Math.min(600000, Math.max(0, Number(delayArg || 1200)))

// 日志上限 256KB，超限轮转为 .old（与宿主半边的 diag 日志同策略）。
const LOG_CAP = 256 * 1024
function log(line) {
  try {
    try {
      if (statSync(logPath).size > LOG_CAP) renameSync(logPath, `${logPath}.old`)
    } catch {
      /* 文件还不存在＝直接追加 */
    }
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* 日志写不进去不影响重启 */
  }
}

function portOpen() {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const timer = setTimeout(() => done(false), 300)
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function kill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    process.kill(pid)
  } catch (error) {
    log(`kill ${pid} failed: ${error.message}`)
  }
}

log(`start parent=${parentPid} host=${hostPid} exe=${exePath} delay=${delayMs}ms`)

// 1) 等调用方把 HTTP 响应交回去（否则用户会看到连接被掐断）。
await sleep(delayMs)

// 2) 关掉界面壳：主进程一没，内核 IPC 断开自动优雅收尾，也没有东西能弹恢复框。
kill(Number(parentPid))

// 3) 等端口释放（内核收尾 + 退出）；150ms 步进轮询（12 秒总时限不变，只是
//    平均快 ~350ms），迟迟不放就补一刀内核，避免新实例撞端口起不来。
let released = false
if (port > 0) {
  for (let i = 0; i < 80; i += 1) {
    await sleep(150)
    if (!(await portOpen())) {
      released = true
      break
    }
  }
  if (!released) {
    log('port still busy after 12s, killing host')
    kill(Number(hostPid))
    for (let i = 0; i < 80; i += 1) {
      await sleep(150)
      if (!(await portOpen())) {
        released = true
        break
      }
    }
  }
  log(`port ${released ? 'released' : 'STILL BUSY'}`)
}

// 4) 清理累积的会话 Cookie。桌面版每次启动换端口，认证 Cookie 名里编着端口、
//    却按域名存储不分端口，每重启一次多一条；堆到约 70 条时请求头超 16KB，下次
//    启动会认证失败。此刻应用必须已完全退出（端口已释放），数据库才没人占着。
async function pruneAuthCookies() {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const { join } = await import('node:path')
    const { homedir } = await import('node:os')
    const { existsSync, copyFileSync } = await import('node:fs')
    const dbPath = join(homedir(), 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
    if (!existsSync(dbPath)) {
      log('cookie db missing, skip')
      return
    }
    const db = new DatabaseSync(dbPath)
    const count = () => db.prepare(
      "select count(*) as n from cookies where host_key = '127.0.0.1' and name like 'dsh-auth-%'",
    ).get().n
    const before = count()
    if (before <= 30) {
      db.close()
      log(`cookies ${before} <= 30, skip`)
      return
    }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    copyFileSync(dbPath, `${dbPath}.bak-${stamp}`)
    db.exec("delete from cookies where host_key = '127.0.0.1' and name like 'dsh-auth-%'")
    db.exec('vacuum')
    const after = count()
    db.close()
    log(`cookies pruned ${before} -> ${after}`)
    // 备份只留最近 2 份，别让 .bak 永久堆积。
    const dir = join(dbPath, '..')
    const baks = readdirSync(dir).filter((name) => name.startsWith('Cookies.bak-')).sort()
    for (const name of baks.slice(0, Math.max(0, baks.length - 2))) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        /* 删不掉就算了 */
      }
    }
  } catch (error) {
    // 清不了不影响重启：重启本身必须先完成。
    log(`cookie prune skipped: ${error.message}`)
  }
}
// 只有确认端口已释放（内核确实退了）才清理 Cookie：绝不动一个可能还活着
// 的应用的库。没有端口信号（port<=0）同样视为未确认。重启本体不受影响，
// 继续往下走拉起流程（撞锁的实例会退出，还有重试兜底）。
if (released) {
  await pruneAuthCookies()
} else {
  log(port > 0 ? 'port STILL BUSY, skip cookie prune' : 'no port signal, skip cookie prune')
}

// 5) 重新拉起应用。必须把 ELECTRON_RUN_AS_NODE 从环境里摘掉：本脚本就是靠它在
//    Node 模式下跑的，继承下去被拉起的 exe 也会变成裸 node（症状：应用关了不回来）。
if (!exePath) {
  log('no exe path, stop')
  process.exit(1)
}
function launchApp(label) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false, env })
  child.on('error', (error) => log(`${label} spawn failed: ${error.message}`))
  child.unref()
  log(`${label} spawned exe pid=${String(child.pid)}`)
  return child
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// 等进程稳定活着：先等 2.5 秒（撞单实例锁的实例这时已经退了），再等满总时限复查一次。
async function waitAlive(pid, ms) {
  const early = Math.min(2500, ms)
  await sleep(early)
  if (!alive(pid)) return false
  await sleep(Math.max(0, ms - early))
  return alive(pid)
}

const first = launchApp('first launch')

// 6) 起来了吗？起不来就再试一次（第二次失败只能让用户手动开）。
if (await waitAlive(first.pid, 8000)) {
  log(`ok: app is back (pid ${first.pid} alive)`)
  process.exit(0)
}
log('first launch did not stay alive, retry once')
const retry = launchApp('retry')
await sleep(8000)
if (alive(retry.pid)) {
  log(`ok after retry (pid ${retry.pid} alive)`)
  process.exit(0)
}
log('FAILED: app did not come back')
process.exit(1)
