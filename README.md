# 刷新 / 重启（dsh-reload-restart）

DeepSeek Harness 桌面版插件：在应用**顶部菜单栏**（「应用 / 编辑」一栏右侧）添加两个按钮——

- **刷新**：重新加载页面（重新拉取最新 HTML 与插件清单，无拦截）。
- **重启**：确认后重启整个 DeepSeek Harness 桌面应用。界面随应用一起关闭，几秒后自动重新打开；全程无 cmd 窗口、无错误弹窗。

> 为什么不放进「应用」下拉菜单：下拉菜单内容由桌面主进程 `Menu.buildFromTemplate` 固定提供，没有插件扩展点，因此按钮与「应用 / 编辑」并排放在菜单栏上。

## 安装

```bash
git clone https://github.com/wind-h/dsh-reload-restart.git
# 在 DSH 会话里（插件以 link 方式安装，指向克隆出的目录）
plugin_manager install_bundle <克隆路径>/dsh-reload-restart
```

已安装时更新需先 `remove_bundle dsh-reload-restart` 再执行上面的安装。

## 工作原理

```
点击「重启」
  └─ 确认框（应用原生 Modal/Button 样式）
      └─ GET  /dsh-reload-restart/ping      探测宿主半边存活
      └─ POST /dsh-reload-restart/restart   （带 x-dsh-reload-restart 请求头）
          └─ 宿主内核 detached 拉起 assets/restart-app.mjs 接手：
              1. 等 0.2s（让 HTTP 响应先刷回）
              2. kill Electron 主进程（内核的 ppid）
                 —— 主进程一死，内核收到 IPC 断开自行优雅收尾；
                    弹「致命错误」恢复框的逻辑在主进程里，所以没有任何框
              3. 轮询等 Web 端口释放（12s 兜底补杀内核）
              4. 清理累积的 dsh-auth-% 会话 Cookie（>30 条时，先备份）
              5. 摘掉 ELECTRON_RUN_AS_NODE 后重新拉起应用 exe，确认存活，失败重试一次
```

细节见 [docs/DETAIL.md](docs/DETAIL.md)。

## 安全

- 两条路由只接受本机回环请求（`127.*` / `::1`）。
- 重启接口额外要求自定义请求头 `x-dsh-reload-restart: restart`——浏览器跨站表单带不了这个头，跨站 fetch 带自定义头会被 CORS 预检拦下。
- 请勿将 Web 界面暴露到不可信网络。

## 日志与排查

| 文件 | 内容 |
| --- | --- |
| `DSH_HOME\logs\dsh-reload-restart-restart.log` | 接手进程（worker）执行轨迹：kill → 端口释放 → Cookie → 拉起 |
| `DSH_HOME\logs\dsh-reload-restart-diag.log` | 客户端版本上报 + 重启点击各阶段探针（`?stage=`），便于远程诊断 |

两份日志超 256KB 自动轮转为 `.old`。

## 目录结构

```
dsh-reload-restart/
├── index.js              # 宿主半边：注册 ping / restart 两条回环路由
├── client.js             # 客户端半边：菜单栏按钮 + 确认框（React + 应用 UI 套件）
├── assets/restart-app.mjs # 独立接手进程：关壳 → 等端口 → 清 Cookie → 拉起
├── package.json          # dsh-reload-restart（ESM，exports 四个入口）
├── cordis.patch.yml      # cordis 补丁：插入 dsh-reload-restart 插件
├── locale/zh-CN.json     # 插件元数据（标题/描述，插件详情页展示）
├── locale/en.json
├── icon.svg              # 插件图标
└── docs/DETAIL.md        # 详细说明（插件详情页「了解更多」）
```

## 平台要求

- 桌面版 DeepSeek Harness（Windows）。Web / Linux 下载版没有可拉起的应用壳，重启接口会返回 400（刷新按钮仍可用）。

## 卸载

`plugin_manager remove_bundle dsh-reload-restart`——按钮与路由随即移除；日志与 Cookie 备份保留在 `DSH_HOME\logs` 与 `%APPDATA%\@deepseek-ai\dsh-desktop\Network` 下，可手动删除。
