# 刷新 / 重启（@local/dsh-reload-restart）

在 DeepSeek Harness 桌面应用**顶部菜单栏**（「应用 / 编辑」一栏的右侧）添加两个按钮：

- **刷新**：直接重新加载页面（重新拉取最新 HTML 与插件清单，不做事前拦截）。
- **重启**：确认后重启整个 DeepSeek Harness 桌面应用——界面随应用一起关闭，几秒后自动重新打开（无可见窗口、无错误弹窗）。

注：原生「应用」下拉菜单的内容由桌面主进程固定提供（`Menu.buildFromTemplate`），没有插件扩展点，因此按钮放在菜单栏（与「应用 / 编辑」并排）而不是下拉菜单里。

界面文案（按钮、确认框、错误提示）跟随应用语言：与桌面壳同一套语义——语言源是 `<html lang>`，`zh*` 显示中文，其余显示英文；在应用内切换语言时按钮文案实时跟随。

## 工作原理

- 顶部菜单栏由桌面预加载脚本挂载为页面 DOM（`<div data-windows-menu>`，开放 Shadow DOM）。客户端半部找到该栏的 shadow root，向其 `[role=menubar]` 追加两个按钮，样式继承栏内既有的 `button {}` 规则；挂载点未就绪时由 MutationObserver 等待其出现，附着成功即停止观察（页面重载会重新附着），插件卸载时自动清理按钮与观察器。
- 「重启」先弹应用原生样式的确认框，再 `GET /dsh-reload-restart/ping` 探测宿主半边，最后 `POST /dsh-reload-restart/restart`（仅接受本机回环请求；非 POST 返回 405，可作存活探测）。确认框与错误提示都使用应用自带 UI 套件 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal` / `Button`（客户端 bundle 基础 require 表成员），样式随应用主题；组件缺失时回退到 `window.confirm` / `window.alert`。
- 主机半部收到重启请求后，**分离拉起 `assets/restart-app.mjs` 接手**（用应用 exe 自身以 `ELECTRON_RUN_AS_NODE=1` 运行——纯 Node 模式，全程无 cmd、无可见窗口）：

  1. 等 0.2 秒（足够把 HTTP 响应交回去，避免用户看到连接被掐断）；
  2. **精准 kill Electron 主进程 PID**（宿主内核的 `process.ppid`）——主进程一死，内核收到 IPC 断开走自己的优雅收尾，而弹「致命错误」恢复框的逻辑在主进程里，所以没有任何框会弹出；
  3. 等 Web 端口释放（12 秒兜底补杀内核），避免新实例撞端口；
  4. 清理累积的 `dsh-auth-%` 会话 Cookie（桌面版每次启动换端口，Cookie 按域名累积，攒多了请求头超 16KB 会导致认证失败；超过 30 条时清理一次并先备份）；
  5. 摘掉 `ELECTRON_RUN_AS_NODE` 后重新拉起应用 exe，确认进程稳定存活，失败自动重试一次。

- 日志写入 `DSH_HOME\logs\dsh-reload-restart-restart.log`；另有诊断日志 `DSH_HOME\logs\dsh-reload-restart-diag.log`（记录客户端版本上报与重启点击各阶段探针，便于远程排查）。
- 接手失败的兜底：内核发出自身 shutdown 消息后退出——这会弹应用原生的恢复对话框，其中「重启」按钮即是应用自己的重启路径（丑但不卡死）。
- 应用可执行文件来自宿主进程自身的 `process.execPath`（桌面端即应用 exe）。

## 注意事项

- 重启按「关壳、让内核优雅退出」的顺序收尾；不会等后台任务确认收尾，会话数据由会话持久化保留。
- 该路由只接受本机回环请求；重启接口还要求自定义请求头 `x-dsh-reload-restart: restart`（浏览器跨站表单带不了这个头，跨站 fetch 带自定义头会被 CORS 预检拦下），防止恶意网页从浏览器直接触发重启。仍请注意勿将 Web 界面暴露到不可信网络。
- 卸载本插件即移除按钮与路由；日志与 Cookie 备份分别保留在 `DSH_HOME\logs` 与 `%APPDATA%\@deepseek-ai\dsh-desktop\Network` 下，可手动删除。

## 平台

- 目标：桌面版 DeepSeek Harness（Windows，GUI 由本机 HTTP 服务器提供）。
