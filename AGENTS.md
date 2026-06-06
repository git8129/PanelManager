# PanelManager 智能体工作手册

本文件约束仓库内智能体的工作方式。所有回复与说明默认使用中文。若规则冲突，按 `稳定性 > 正确性 > 可交付性 > 体验优化` 处理。

## 1. 修改边界

允许修改：

- `PanelManager/**`
- `FloatingWindow/**`
- `Installer/**`
- `skills/**`
- `README.md`
- `README_EN.md`
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

## 4. Git 与提交管理

- 开始工作前必须执行 `git --version`、`git status` 和 `git remote -v`，确认 Git 可用并了解工作区状态。
- 如果未安装 Git，且当前环境可以正常访问 GitHub，必须明确提示用户安装 [Git for Windows](https://git-scm.com/download/win)，不得无提示地跳过版本控制。
- 如果无法访问 GitHub，也要说明 Git 缺失及网络阻塞，待条件具备后优先补齐 Git。
- 如果 Git 已安装并配置完成，必须使用 Git 管理本轮改动，不得改用手工备份或复制目录代替。
- 如果当前工作区不是 Git 仓库，必须先在项目根目录执行 `git init`；默认分支使用 `main`。
- 初始化已有项目时，先检查 `.gitignore`、敏感信息和大文件；确认安全后创建一次基线提交，再开始功能修改。
- 开始修改前先检查现有未提交内容，不得覆盖、回退或混入用户及其他智能体的无关改动。
- 每轮源码、脚本、配置或配套文档修改完成并验证后，必须创建 Git 提交；一个提交只包含一个明确主题。
- 提交标题应简短、可追踪，推荐使用 `feat:`、`fix:`、`refactor:`、`docs:`、`build:`、`ci:` 等前缀。
- 大改动必须在提交正文记录上下文，至少包含：修改背景、主要范围、关键决策、验证结果，以及仍存在的风险或后续事项。
- 禁止使用会丢失历史或用户改动的命令，例如未经明确授权的 `git reset --hard`、强制推送或重写公共历史。
- 默认只要求提交到本地仓库；仅在用户要求或任务已明确包含远程交付时执行 `git push`。
- 交付前必须再次执行 `git status`，确保本轮应提交内容已提交，并向用户报告提交哈希。

大改动提交示例：

```text
feat: add device firmware update workflow

Context:
- Add a reproducible firmware update path for the Windows application.

Changes:
- Add update orchestration and progress reporting.
- Reuse the existing device transport abstraction.

Validation:
- Build completed successfully.
- Update flow verified with a test device.

Risks:
- Recovery after an interrupted update still needs hardware regression testing.
```

## 5. 验证矩阵

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

## 6. 构建、发布与安装包

- 构建、发布、打包优先使用 `scripts/` 下的脚本，不要默认手拼 `dotnet build` 或 `dotnet publish`。
- 脚本会把 SDK、workload、NuGet 缓存、构建输出放在工程 `.sandbox/` 内。
- 编译输出：`.sandbox/artifacts/build-cli`
- 发布输出：`.sandbox/artifacts/publish/windows-win-x64`
- 源码包：发布目录中的 `PanelManager-source-*.zip`
- 安装包：`.sandbox/artifacts/installer/output/PanelManagerSetup*.exe`
- 安装包脚本会使用 staging 目录生成 payload，测试水印只注入 staging 中的发布产物，不污染源码。
- 安装包 payload 默认排除 PDB/XML/winmd、无用 splash/dotnet_bot/workloads 资源，以及除 `en*`、`zh*` 外的语言资源目录。
- 默认安装器是用户级图形化安装器，不应要求管理员权限。

## 7. 源码包与 AI 工作区

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

## 8. 用户意图映射

- 用户说“编译项目 / 编一下 / 重新编译”时，直接执行 `build-windows-cli.ps1`。
- 用户说“发布 / 打包”时，按语义选择 `publish-windows-cli.ps1` 或 `package-windows-installer.ps1`。
- 用户认可调试版本、要求交付普通用户、或表示“这个版本可以了/就这样发版”时，主动建议生成安装包。
- 用户要求测试版本水印时，使用 `package-windows-installer.ps1 -WatermarkText "测试版本"`，不要把水印写死到源码。
- 用户报告错误时，优先复现或定位首个错误，不要停留在泛泛分析。

## 9. 替换旧版本流程

1. 停止当前运行实例。
2. 备份旧版本。
3. 把新版本放到独立 candidate 目录。
4. 做本地冒烟验证。
5. 用户确认后再切换快捷方式、启动入口或目录指向。
6. 保留旧版本一段时间，便于快速回滚。

禁止直接覆盖当前运行目录。

## 10. 回归要求

- 应用可启动。
- 主界面可渲染。
- 关键页面可打开和返回。
- AI 页面可打开，`aiStatus -> aiStart -> aiEvent` 链路可走通。
- 虚拟键盘、触摸板、弹窗、滚动、输入等关键交互无明显回归。
- 安装包生成后能找到明确输出路径。

## 11. 推荐外部 skills

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

## 12. 故障处置

1. 立即止损，不继续扩大改动。
2. 锁定最后一批改动文件和函数。
3. 优先恢复可运行状态。
4. 仍失败则只回退本轮智能体改动，不动用户无关改动。
5. 输出失败点、已尝试方案、建议下一步。

常见构建故障：

- `ResolveComReference` 失败：优先定位具体 COM 依赖与代码使用点，不要默认要求安装完整 IDE。
- `MSB3030` 涉及 `MsixContent` / `Microsoft.UI.Xaml.Controls.pri`：优先检查工作区结构、MAUI workload 与 Windows App SDK 资源，不要反复要求用户手工选择方案。
- `MSB3021` 写入 `.sandbox/artifacts/build-cli/PanelManager.exe` 被拒绝：通常是旧程序仍在运行或文件被系统占用，说明阻塞后让用户关闭占用进程，不要误杀宿主。

## 13. 交付自检

- [ ] 改动只覆盖本轮需求。
- [ ] 未修改 `PanelManager/Tools/**` 与敏感文件。
- [ ] 前端语法检查通过，或说明无需检查。
- [ ] C# 构建通过，或明确记录环境/文件占用阻塞原因。
- [ ] 若涉及源码包，确认源码包包含 `AGENTS.md` 与 `skills/`，且不包含 `PanelManager/Tools/**`。
- [ ] 若涉及安装包，确认输出路径与是否带水印。
- [ ] 本轮改动已创建主题明确的 Git 提交；大改动提交正文已记录上下文与验证结果。
- [ ] `git status` 已复查，未混入用户或其他智能体的无关改动。
- [ ] 输出包含改动文件、核心原因、验证结果、未完成项。
