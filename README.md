# PanelManager

PanelManager 是一个基于 .NET MAUI + BlazorWebView 的桌面控制面板项目，面向触控屏/设备管理场景，集成了系统控制、串口通信、WiFi/蓝牙管理、页面工具集和 AI 助手能力（OpenCode sidecar）。

## 主要能力

- 设备连接与状态监控（串口、系统状态）
- WiFi / 蓝牙基础管理与状态展示
- 工具页与配置页（包含 EDID、快捷控制、便签等界面能力）
- AI 助手页（模型选择、会话、步骤/工具详情、Provider 配置）
- Windows 悬浮窗协同（`FloatingWindow` 子工程）

## 技术栈

- .NET 9（MAUI）
- BlazorWebView（前端页面托管）
- 原生前端：`wwwroot/index.html + script.js + style.css`
- WebSocket（上位机与前端消息桥）

## 仓库结构

- `PanelManager/`：主应用（MAUI + BlazorWebView）
- `FloatingWindow/`：Windows 悬浮窗子项目（WPF）
- `skills/panelmanager-opencode/SKILL.md`：OpenCode 本地工程技能（主规则入口）
- `AGENTS.md`：仓库智能体手册，也是源码包工作区的通用规则入口
- `scripts/build-windows-cli.ps1`：最小化 Windows CLI 编译脚本
- `scripts/publish-windows-cli.ps1`：最小化 Windows CLI 发布脚本

## 环境要求

- Windows 10/11（开发与运行主场景）
- PowerShell（用于发布脚本）
- Node.js（前端语法校验，建议）

## 快速开始

在仓库根目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-cli.ps1
```

编译输出目录：

- `.sandbox/artifacts/build-cli`

## 发布（文件夹模式）

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-windows-cli.ps1
```

默认输出目录：

- `.sandbox/artifacts/publish/windows-win-x64`

发布成功后可在发布目录中看到：

- 主程序与依赖文件
- `PanelManager-source-*.zip` 源码包

## GitHub Actions

仓库通过 `.github/workflows/build-windows.yml` 调用
`scripts/package-windows-installer.ps1` 自动构建 Windows x64 安装包：

- 推送到 `main` 时自动运行
- 向 `main` 提交 Pull Request 时自动运行
- 支持在 GitHub Actions 页面手动运行
- 安装程序保存为 `PanelManagerSetup-win-x64` artifact
- 源码包保存为 `PanelManager-source` artifact
- Actions artifact 默认保留 14 天

## 替换旧版本建议

- 不要直接覆盖当前运行目录
- 先从发布目录验证新版本
- 备份旧版本后再切换快捷方式/启动入口/目录指向

## AI（OpenCode）说明

- AI 页面通过 `system:aiStart / aiStatus / aiEvent` 等桥接命令与 sidecar 通信。
- 启动策略优先复用已有实例；本地存在可用 `opencode.exe` 时直接启动；仅在缺失时触发下载与解压。
- 下载/解压进度会体现在 AI 页状态区，并在安装阶段显示安装进度弹窗。
- AI 页面首次打开会自动显示一份简短帮助，提示如何编译、发布、修 Bug 与查看产物。

## 常见问题

- `NETSDK1045`：当前 SDK 版本过低，请安装 .NET SDK 9.x。
- `MSB3030` 且涉及 `MsixContent` / `Microsoft.UI.Xaml.Controls.pri`：先检查工作区里的 `PanelManager/Tools/` 与根目录 `skills/` 是否补齐。
- 构建成功但页面异常：优先检查 `PanelManager/wwwroot/script.js` 与 `style.css` 修改是否引入语法/布局问题。

## 开发建议

- 功能入口通常在 `PanelManager/wwwroot/script.js`。
- 宿主命令与设备侧桥接在 `PanelManager/Services/HostCommandHandler.cs`。
- OpenCode 生命周期与事件订阅在 `PanelManager/Services/OpenCodeSidecarService.cs`。

## 许可证

本项目使用 [MIT License](LICENSE)。
