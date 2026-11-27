# AGENTS.md — 给 AI 代理的项目说明

本目录是 DeepSeek Harness (DSH) 桌面版插件 **dsh-reload-restart** 的源码（实际版本以 package.json 为准）：顶部菜单栏的「刷新 / 重启」按钮。已通过 `pnpm link` 安装进当前 profile——**本目录的文件就是运行中的文件**。

## 文件地图

| 文件 | 角色 |
| --- | --- |
| `index.js` | 宿主半边（真实 Node ESM）。注册回环路由 `GET /dsh-reload-restart/ping` 与 `POST /dsh-reload-restart/restart`，接手时 detached 拉起 worker |
| `client.js` | 客户端半边（`window.__ModuleLoader__.load`）。往 preload 建的菜单栏 shadow root 里挂按钮；确认框用应用自带 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`/`Button` |
| `assets/restart-app.mjs` | 独立接手进程：关壳 → 等端口释放 → 清 Cookie → 重新拉起 exe |
| `package.json` / `cordis.patch.yml` / `locale/*.json` / `icon.svg` / `docs/DETAIL.md` | bundle 元数据与文档 |

DSH 插件机制参考：DSH 工作区根目录下的 `docs/`（从 app.asar 提取的官方文档）、`template/`（官方插件模板）、`research/`（从 app.asar 提取的关键源码）。

## 架构不变量（改代码前必读，违反会直接破坏功能）

1. **绝不直接杀宿主内核**：桌面主进程把内核退出无条件当致命故障（弹恢复框）。正确路径只有一条：worker 杀 Electron **主进程**（内核的 `process.ppid`）→ 内核 IPC 断开自行优雅收尾，且没有进程能弹框。
2. **worker 重新拉起 exe 前必须从环境里删掉 `ELECTRON_RUN_AS_NODE`**（worker 自己靠它跑在 Node 模式；漏删则新实例变裸 node，应用关了不回来）。
3. **HTTP handler 永远不 await worker**：spawn + unref 后立即回 200；`restart-app.mjs` 开头 sleep（现 200ms）就是给响应刷回留的余量。
4. **一次性闸 `restartArmed`**：POST 处理是同步 check-arm-send，无双重 worker 竞态；worker `exit` 码非 0 必须 `restartArmed = false`（接手失败时允许重试，否则按钮变砖，只会拿到静默 `mode:'already'`）。
5. **安全三件套**：回环校验（`isLocal`）→ POST-only → 自定义头 `x-dsh-reload-restart: restart`。缺一不可。
6. **确认框按钮放 `Modal` 的 children 里，不放 footer 插槽**（footer 位于 Modal 的「外部点击」判定区外，点击会先触发 onClose）。
7. **弹窗 Promise 结算顺序**：`settle()` 必须**先 `dialogState = null` 再 `publishDialog(null)`**——否则 publishDialog 的「顶掉旧弹窗」逻辑会抢先用 false 结算当前 Promise（v1.4.7 修过的真实 bug：所有按钮点击都静默变「取消」）。
8. **刷新不做任何预检**：`location.reload()` 本身就是纠正过期插件清单快照的手段；v1.4.3 删掉过启动快照探测（会造成「旧客户端拦住刷新、只能重启」的死锁）。
9. **界面文案一律走 `client.js` 的 `LOCALES` 字典**，不许硬编码中文。语言语义与桌面壳一致（preload 的 `resolveDesktopLocale`）：源是 `<html lang>`，主子标签匹配，`zh` → zh-CN，其余 → en；`apply()` 里的 MutationObserver 监听 lang 属性变化实时刷新按钮文案。

## 修改与发布流程

1. 改本目录文件（installed bundle 是 link，无需拷贝）。
2. **版本号两处同步**：`package.json` 的 `version` + `client.js` 的 `CLIENT_VERSION` 常量（用于 diag 上报核对客户端实际加载版本）。
3. 语法检查：`node --check index.js client.js assets/restart-app.mjs`。
4. 更新安装：`plugin_manager remove_bundle dsh-reload-restart` → `plugin_manager install_bundle <本目录绝对路径>`（直接重装会报 already-installed）。
5. 生效时机：宿主半边**热应用**（装完即生效）；客户端半边要**刷新页面**才加载；worker 每次重启时从磁盘现读，装完下次重启即用新版。

## 验证手段

- 路由存活：`curl http://127.0.0.1:<port>/dsh-reload-restart/ping` → `{"ok":true}`。**端口每次重启都会变**，以系统上下文里的 Web GUI URL 为准。
- 完整重启验证要用户自己点（不要替用户重启应用）；需要代测时用带头的 curl：
  `curl -X POST -H "x-dsh-reload-restart: restart" http://127.0.0.1:<port>/dsh-reload-restart/restart`
- 日志：`%DSH_HOME%\logs\dsh-reload-restart-restart.log`（worker 轨迹，成功结尾 `ok: app is back`）、`dsh-reload-restart-diag.log`（阶段探针）。
- 诊断探针模式：客户端在关键阶段 `fetch(ping?stage=xxx)`，宿主把 ping/restart 每个请求记入 diag 日志——「用户说没反应」时先看这里定位断在哪一步（v1.4.4–1.4.7 就是这样定位出弹窗结算 bug 的）。

## 环境陷阱（本机工具链）

- **edit 工具参数是原样文本**：文件里是 `\n`（单反斜杠）转义时，old_string 就写单反斜杠；`ops_inspect` 的显示会把反斜杠 repr 成 `\\`，照抄显示文本会匹配失败。
- 本机 bash 是 winuxcmd：`cmd /c` 用**单斜杠**；`cmd //c` 会进交互模式。
- 读 DSH 源码用工作区根目录的 asar 提取脚本 `asar_tool.py`（用法 `asar_tool.py <asar> grep|read|extract <prefix> <pattern> [cap]`，第 5 个参数是**每文件字节上限**不是条数）。
- `cordis_inspect_query` 的目录类调用必须**完全省略 input**；带 input 会报 "input must be an object"。
- 桌面 GUI 有认证，外部浏览器打不开（只显示 authentication required）；视觉验证只能靠用户截图。
- 安装产物在 `%DSH_HOME%\profiles\desktop\.plugin-manager\`，不要手改。

## 已否决方案（别再提）

- 原生「应用」下拉菜单加项——`Menu.buildFromTemplate` 固定，无扩展点。
- `window.dshDesktop.restartHarness()` 之类的 API——**不存在**（全 asar grep 无 restartHarness）；preload 暴露面里没有任何重启 IPC。
- 路由 Origin 校验——本机进程可伪造，相比回环+自定义头无增益。
- 重启过渡画面——窗口整个关闭，无处显示。
- 动态（dynamic cordis）插件形态——客户端半部不持久（刷新即丢），必须用文件 bundle。
- CMD 脚本 / wscript 中转拉起——会留可见窗口或行为不可靠，已被「exe 自身 ELECTRON_RUN_AS_NODE 跑 worker」取代。
