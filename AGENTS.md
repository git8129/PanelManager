# PanelManager 智能体工作手册

本文件约束仓库内智能体的工作方式。所有回复与说明默认使用中文。若规则冲突，按 `稳定性 > 正确性 > 可交付性 > 体验优化` 处理。

## 1. 修改边界

允许修改：

- `PanelManager/**`
- `FloatingWindow/**`
- `Installer/**`
- `skills/**`
- `README.md`
- `AGENTS.md`

禁止修改：

- `PanelManager/Tools/**`，这是二进制工具目录
- 证书、密钥、签名、凭据文件
- 未经用户明确授权的破坏性操作

需要用户确认后再改：

- 发布/签名策略
- 安装目录、线上运行目录结构
- 对外协议兼容字段
- 是否让 Release 开启 WebView2/CDP 调试端口

## 2. 工程入口

- 宿主入口：`PanelManager/MauiProgram.cs`
- Windows 窗口：`PanelManager/Platforms/Windows/App.xaml.cs`
- 主页面：`PanelManager/MainPage.xaml`
- 前端：`PanelManager/wwwroot/index.html`、`PanelManager/wwwroot/script.js`、`PanelManager/wwwroot/style.css`
- 前端拆分模块：`PanelManager/wwwroot/ui_*.js`
- 消息桥：`PanelManager/Services/MessageBridge.cs`
- 宿主命令：`PanelManager/Services/HostCommandHandler.cs`
- OpenCode sidecar：`PanelManager/Services/OpenCodeSidecarService.cs`
- 悬浮窗：`FloatingWindow/FloatingWindow.csproj`
- 安装器：`Installer/PanelManager.Installer.csproj`、`Installer/Program.cs`
- 工程 skill：`skills/panelmanager-opencode/SKILL.md`

## 3. 工作原则

- 先定位根因，再改代码。
- 每轮只解决一个主题问题。
- 优先做最小正确改动，避免无必要重构。
- 小改动后立即做对应最小验证。
- 每次失败只修首个错误。
- 连续 3 轮同类失败必须停止并说明阻塞点。
- 不要回退、覆盖或整理用户/其他智能体的无关改动。

## 4. 验证矩阵

仅改前端主脚本：

```powershell
node --check .\PanelManager\wwwroot\script.js
```

改动前端拆分模块时，同时检查对应文件：

```powershell
node --check .\PanelManager\wwwroot\ui_misc.js
```

涉及 C# / MAUI / 宿主 / 安装器工程：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-cli.ps1
```

发布主程序：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-windows-cli.ps1
```

生成安装包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows-installer.ps1
```

## 5. 构建、发布与安装包

- 构建、发布、打包优先使用 `scripts/` 下的脚本，不要默认手拼 `dotnet build` 或 `dotnet publish`。
- 脚本会把 SDK、workload、NuGet 缓存、构建输出放在工程 `.sandbox/` 内。
- 编译输出：`.sandbox/artifacts/build-cli`
- 发布输出：`.sandbox/artifacts/publish/windows-win-x64`
- 源码包：发布目录中的 `PanelManager-source-*.zip`
- 安装包：`.sandbox/artifacts/installer/output/PanelManagerSetup*.exe`
- 安装包脚本会使用 staging 目录生成 payload，测试水印只注入 staging 中的发布产物，不污染源码。
- 安装包 payload 默认排除 PDB/XML/winmd、无用 splash/dotnet_bot/workloads 资源，以及除 `en*`、`zh*` 外的语言资源目录。
- 默认安装器是用户级图形化安装器，不应要求管理员权限。

## 6. 源码包与 AI 工作区

- `skills/panelmanager-opencode/SKILL.md` 是 OpenCode 首选规则入口。
- `AGENTS.md` 是仓库通用规则与 fallback 入口。
- 不再依赖发布目录根部散落的 `AI_AGENT.md` 或 `skills/`。
- 源码包解压后应成为完整工作区，根目录包含 `PanelManager.sln`、`AGENTS.md`、`skills/`、`scripts/`、`Installer/`、`PanelManager/`、`FloatingWindow/`。
- 源码包必须排除 `.git`、`.sandbox`、`.vs`、`bin/obj`、`*.user`、`*.suo`。
- `PanelManager/Tools/**` 不进源码包；安装版运行时从 exe 同级 `Tools/` 补复制到工作区 `PanelManager/Tools/`。
- OpenCode 工作区、缓存、配置默认位于当前运行 exe 同级 `.sandbox/OpenCode/`。
- 工作区根目录就是项目根目录，不应再假设额外 `src/` 子目录。
- NuGet 缓存优先使用工作区或工程内 `.sandbox/nuget/packages/`。
- 构建与打包必须在沙箱工作区或工程 `.sandbox/` 输出目录中进行，不得污染当前运行目录。

## 7. 用户意图映射

- 用户说“编译项目 / 编一下 / 重新编译”时，直接执行 `build-windows-cli.ps1`。
- 用户说“发布 / 打包”时，按语义选择 `publish-windows-cli.ps1` 或 `package-windows-installer.ps1`。
- 用户认可调试版本、要求交付普通用户、或表示“这个版本可以了/就这样发版”时，主动建议生成安装包。
- 用户要求测试版本水印时，使用 `package-windows-installer.ps1 -WatermarkText "测试版本"`，不要把水印写死到源码。
- 用户报告错误时，优先复现或定位首个错误，不要停留在泛泛分析。

## 8. 替换旧版本流程

1. 停止当前运行实例。
2. 备份旧版本。
3. 把新版本放到独立 candidate 目录。
4. 做本地冒烟验证。
5. 用户确认后再切换快捷方式、启动入口或目录指向。
6. 保留旧版本一段时间，便于快速回滚。

禁止直接覆盖当前运行目录。

## 9. 回归要求

- 应用可启动。
- 主界面可渲染。
- 关键页面可打开和返回。
- AI 页面可打开，`aiStatus -> aiStart -> aiEvent` 链路可走通。
- 虚拟键盘、触摸板、弹窗、滚动、输入等关键交互无明显回归。
- 安装包生成后能找到明确输出路径。

## 10. 推荐外部 skills

- 页面调试、截图回归、CDP/WebView2 调试：优先考虑 `https://github.com/vercel-labs/agent-browser`。
- UI 修改、视觉优化、布局调整、交互打磨：优先考虑 `https://github.com/nextlevelbuilder/ui-ux-pro-max-skill`。
- 外部工具应安装或缓存到 `.sandbox/`，不要污染全局系统。

agent-browser 常用命令示例：

```powershell
npm exec --yes agent-browser -- --session pm connect 9222
npm exec --yes agent-browser -- --session pm tab
npm exec --yes agent-browser -- --session pm screenshot "C:\Temp\panelmanager.png"
npm exec --yes agent-browser -- --session pm screenshot --annotate "C:\Temp\panelmanager-annotated.png"
```

- 仅 Debug 构建默认开启 WebView2 CDP 端口 `9222`。
- 若 npm 报 `Maximum call stack size exceeded`，在 `.sandbox/` 下新建干净 npm 目录后再运行。

## 11. 故障处置

1. 立即止损，不继续扩大改动。
2. 锁定最后一批改动文件和函数。
3. 优先恢复可运行状态。
4. 仍失败则只回退本轮智能体改动，不动用户无关改动。
5. 输出失败点、已尝试方案、建议下一步。

常见构建故障：

- `ResolveComReference` 失败：优先定位具体 COM 依赖与代码使用点，不要默认要求安装完整 IDE。
- `MSB3030` 涉及 `MsixContent` / `Microsoft.UI.Xaml.Controls.pri`：优先检查工作区结构、MAUI workload 与 Windows App SDK 资源，不要反复要求用户手工选择方案。
- `MSB3021` 写入 `.sandbox/artifacts/build-cli/PanelManager.exe` 被拒绝：通常是旧程序仍在运行或文件被系统占用，说明阻塞后让用户关闭占用进程，不要误杀宿主。

## 12. 交付自检

- [ ] 改动只覆盖本轮需求。
- [ ] 未修改 `PanelManager/Tools/**` 与敏感文件。
- [ ] 前端语法检查通过，或说明无需检查。
- [ ] C# 构建通过，或明确记录环境/文件占用阻塞原因。
- [ ] 若涉及源码包，确认源码包包含 `AGENTS.md` 与 `skills/`，且不包含 `PanelManager/Tools/**`。
- [ ] 若涉及安装包，确认输出路径与是否带水印。
- [ ] 输出包含改动文件、核心原因、验证结果、未完成项。
