---
name: panelmanager-opencode
description: Use for PanelManager build, publish, installer packaging, AI workspace/source archives, or WebView2/CDP debugging. Ordinary application development follows AGENTS.md without loading this operational reference.
---

# PanelManager 构建与调试操作参考

- 本参考提供构建与调试命令；开发规范见工作区根目录 `AGENTS.md`。
- 在包含 `PanelManager.sln` 的根目录执行以下脚本。
- 只有构建、发布、安装包、AI 工作区或 CDP 调试任务才需要本参考，普通代码修改无需加载。
- 修改 skill 或 OpenCode 配置后，退出并重启 OpenCode/AI sidecar，使新规则生效。

## 构建、发布和替换版本

| 任务 | 命令 | 产物 |
| --- | --- | --- |
| 编译（默认 Debug） | `powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-cli.ps1` | `.sandbox/artifacts/build-cli` |
| 发布 | `powershell -ExecutionPolicy Bypass -File .\scripts\publish-windows-cli.ps1` | `.sandbox/artifacts/publish/windows-win-x64` |
| 安装包 | `powershell -ExecutionPolicy Bypass -File .\scripts\package-windows-installer.ps1` | `.sandbox/artifacts/installer/output/PanelManagerSetup*.exe` |

- 首选仓库脚本，不默认手拼 `dotnet build/publish`；脚本失败需要定位时再拆解。工具链、workload、NuGet 缓存在工程 `.sandbox/`。
- 源码包位于发布目录 `PanelManager-source-*.zip`；安装器 staging 为 `.sandbox/artifacts/installer/staging`，payload 为 `.sandbox/artifacts/installer/payload.7z`。标准 `PanelManagerSetup.exe` 无法写入时，脚本可输出带时间戳的 `PanelManagerSetup-*.exe`。
- 源码包根目录包含 `PanelManager.sln`、README、`AGENTS.md`、`skills/`、`scripts/`、`Installer/`、`PanelManager/`、`FloatingWindow/` 及构建依赖；排除 `.git`、`.sandbox`、`.vs`、`bin/obj`、`*.user`、`*.suo`，不依赖本地 SDK 目录。
- payload 排除 PDB/XML/winmd、无用 splash/dotnet_bot/workloads 资源及非 `en*`/`zh*` 语言目录。
- 新版本先在独立目录完成冒烟验证，再停止当前实例并切换运行入口，保留旧版本以便恢复。
- 运行版本冒烟：启动、主界面、关键页面往返、AI `aiStatus -> aiStart -> aiEvent`、虚拟键盘/触摸板/弹窗/滚动/输入；安装包交付说明输出路径。

## 失败定位

- `ResolveComReference` 查具体 COM 依赖，不默认安装完整 IDE；`NETSDK1045` 查脚本准备的本地 SDK。
- `MSB3030` 查工作区、MAUI workload 和 Windows App SDK 资源；指向全局 NuGet 时查工程 `.sandbox/nuget/packages/`，不默认禁用打包绕过。
- `MSB3021` 查旧实例/文件占用，说明阻塞，不误杀宿主。
- JS 语法检查：`node --check <改动文件路径>`；页面空白再查动态模块 `ReferenceError` 和 `window.UI*` 初始化。
- npm `Maximum call stack size exceeded`：在 `.sandbox/` 使用干净 npm 目录，再执行需要的工具，不清理无关浏览器或全局环境。

## WebView2/CDP

页面截图、DOM 快照和点击回归可用 `https://github.com/vercel-labs/agent-browser`。工具安装/缓存及截图放入工程 `.sandbox/`，测试结束按全局临时清理规则处理。先实际启动 Debug 版，再连接 CDP `9222`：

```powershell
npm exec --yes agent-browser -- --session pm connect 9222
npm exec --yes agent-browser -- --session pm tab
npm exec --yes agent-browser -- --session pm screenshot ".sandbox/agent-browser/panelmanager.png"
npm exec --yes agent-browser -- --session pm screenshot --annotate ".sandbox/agent-browser/panelmanager-annotated.png"
```

截图前确保目标目录存在。CDP `9222` 仅 Debug 默认开启；连接前确认实际运行的是 Debug 版本，并检查端口是否可用。

## 经宿主更新 PMFW

需要带 `debugHostCapability` 的 Debug 宿主及 Python `websockets`：

```powershell
python .\scripts\manual-update-via-panelmanager.py `
  --package "<package-path>" `
  --bridge-port 5000
```

脚本获取 capability，经 WebSocket `5000` 调用 `system/manualUpdate`，等待现有认证会话或独立下载态，不自行打开串口/认证；明确全擦除才加 `--full-erase`。
