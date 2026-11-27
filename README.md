# 刷新 / 重启（dsh-reload-restart）

为 DeepSeek Harness 桌面版的**顶部菜单栏**（「应用 / 编辑」右侧）添加两个按钮：

- **刷新** — 立即重新加载页面。
- **重启** — 确认后重启整个应用：界面关闭，几秒后自动重新打开。全程无黑窗、无报错弹窗。

## 安装

在 DSH 会话里任选一条：

```bash
dsh plugin add dsh-reload-restart
dsh plugin add github:wind-h/dsh-reload-restart
```

> 已安装过时，先 `plugin_manager remove_bundle dsh-reload-restart` 再装。

## 要求

- Windows 桌面版 DeepSeek Harness。
- Web / Linux 下载版没有应用壳，「重启」会提示不可用，「刷新」不受影响。

## 卸载

```bash
plugin_manager remove_bundle dsh-reload-restart
```

## 说明

- 「重启」由一个独立后台进程完成：关应用 → 等端口释放 → 清理累积的会话 Cookie → 重新拉起应用。技术细节见 [docs/DETAIL.md](docs/DETAIL.md)。
- 日志在 `%DSH_HOME%\logs\dsh-reload-restart-*.log`；觉得「点了没反应」时先看这里。
- 重启接口只接受本机请求，并要求自定义请求头，跨站网页无法调用。
- 界面语言跟随应用语言（中文 / English）。

## License

[MIT](LICENSE)
