---
name: panelmanager-opencode
description: Use when working in the PanelManager repository: build, publish, package installers, manage AI workspace/source archives, or fix MAUI/WinUI/frontend/device-bridge issues.
---

# PanelManager OpenCode Skill

本 skill 是 PanelManager 工程内 OpenCode 的首选规则入口。默认使用中文回复，直接执行可验证的工程任务，不把用户带入不必要的选择题。

## 1. 工作区规则

- 当前工作目录应是项目根目录，包含 `PanelManager.sln`。
- 工作区根目录就是项目根目录，不应再额外假设 `src/` 子目录。
- 所有临时文件、下载工具、缓存、输出产物默认放到 `./.sandbox/`。
- OpenCode 运行时工作区默认在 exe 同级 `.sandbox/OpenCode/`。
- 工作区必须包含 `AGENTS.md` 和 `skills/`。
- 源码包解压后应直接成为完整工作区，包含 `PanelManager/`、`FloatingWindow/`、`Installer/`、`scripts/`、`skills/`、`README.md`、`README_EN.md`、`AGENTS.md`、`PanelManager.sln`。
- 固件更新只接受自包含 PMFW，按现有工程引用和发布结构维护。
- 不再依赖运行目录根部的 `AI_AGENT.md` 或 `skills/`；它们仅作为旧版本兼容回退。
- 配套下位机工程作为独立工程维护；公开仓库不依赖其本地目录结构。

## 2. 修改边界

允许修改：

- `PanelManager/**`
- `FloatingWindow/**`
- `Installer/**`
- `skills/**`
- `README.md`
- `README_EN.md`
- `AGENTS.md`

禁止修改：

- 证书、密钥、签名、凭据文件
- 未经用户确认的破坏性操作

需要确认后再改：

- 发布/签名策略
- 安装目录、线上运行目录结构
- 协议兼容字段
- Release 版 WebView2/CDP 调试端口策略

## 3. 默认动作

- 先定位根因，再做最小正确改动。
- 用户要求编译、发布、打包时直接运行对应脚本。
- 用户报告错误时，优先复现或定位首个错误，并持续迭代到通过或明确阻塞。
- 每次失败只修首个错误。
- 不要默认手拼 `dotnet build` / `dotnet publish`；除非工程脚本失败后需要拆解定位。
- 不要直接覆盖当前运行目录，不要误杀正在运行的主程序。

## 4. 首选命令

编译：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-cli.ps1
```

发布：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-windows-cli.ps1
```

生成安装包：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows-installer.ps1 -WatermarkText ""
```

仅改前端主脚本：

```powershell
node --check .\PanelManager\wwwroot\script.js
```

改动拆分前端模块时，检查对应文件，例如：

```powershell
node --check .\PanelManager\wwwroot\ui_misc.js
```

## 5. 用户意图映射

- “编译项目 / 编一下 / 重新编译” -> 直接执行 `build-windows-cli.ps1`。
- “发布 / 出发布目录” -> 直接执行 `publish-windows-cli.ps1`。
- “打包 / 安装包 / 给普通用户安装” -> 直接执行 `package-windows-installer.ps1 -WatermarkText ""`。
- “测试版 / 带水印 / 内测包” -> 使用 `-WatermarkText "测试版本"`，只在打包 staging 中注入水印。
- “普通安装包”且用户未明确要求水印 -> 使用 `-WatermarkText ""`，覆盖脚本的默认测试水印。
- “这个版本可以了 / 就这样发版 / 交付” -> 主动提示生成图形化安装包。
- “修 Bug / 排查错误” -> 先定位首错，再修改和验证。
- “新增功能” -> 做最小可运行实现，保留现有设计语言和交互结构。

## 6. 产物位置

- 编译结果：`.sandbox/artifacts/build-cli`
- 发布结果：`.sandbox/artifacts/publish/windows-win-x64`
- 源码包：发布目录中的 `PanelManager-source-*.zip`
- 安装包：`.sandbox/artifacts/installer/output/PanelManagerSetup*.exe`
- 安装器 staging：`.sandbox/artifacts/installer/staging`
- payload：`.sandbox/artifacts/installer/payload.7z`

## 7. 源码包要求

源码包应包含：

- `AGENTS.md`
- `skills/panelmanager-opencode/SKILL.md`
- `scripts/**`
- `Installer/**`
- `PanelManager/**`
- `FloatingWindow/**`
- `PanelManager.sln`
- `README.md`
- `README_EN.md`

源码包应排除：

- `.git/**`
- `.sandbox/**`
- `.vs/**`
- `bin/**`、`obj/**`
- `*.user`、`*.suo`

## 8. 安装包规则

- 安装器默认用户级安装，不应要求管理员权限。
- 安装器 payload 来自发布产物 staging，不直接修改源码目录。
- 普通安装包规则是不带水印；调用现有脚本时必须显式使用 `-WatermarkText ""`，覆盖默认测试水印。
- `-WatermarkText` 只影响 staging 中的 `wwwroot/index.html`。
- payload 默认排除 PDB/XML/winmd、无用 splash/dotnet_bot/workloads 资源，以及除 `en*`、`zh*` 外的语言资源目录。
- 如果标准输出名 `PanelManagerSetup.exe` 被系统拒绝写入，脚本可输出带时间戳的 `PanelManagerSetup-*.exe`。

## 9. 常见失败处理

- `MSB3021` 写入 `.sandbox/artifacts/build-cli/PanelManager.exe` 被拒绝：通常是旧程序仍在运行或文件被系统占用；先说明阻塞，不要强行删除用户正在使用的程序。
- `NETSDK1045`：优先使用脚本在 `.sandbox/dotnet/` 准备本地 SDK。
- `MSB3030` 涉及 `MsixContent` / `Microsoft.UI.Xaml.Controls.pri`：不要默认靠禁用打包绕过，先检查工作区结构和 MAUI workload。
- `MSB3030` 指向全局 `.nuget\packages`：优先确认 restore/build 是否已使用 `.sandbox/nuget/packages/`。
- 前端弹窗/页面空白：先检查 `node --check`，再查动态模块是否因 `ReferenceError` 导致 `window.UI*` 未初始化。

## 10. 替换旧版本

1. 停止当前运行实例。
2. 备份旧版本。
3. 把新版本放到独立 candidate 目录。
4. 做本地冒烟验证。
5. 用户确认后再切换快捷方式、启动入口或目录指向。
6. 保留旧版本一段时间，便于快速回滚。

禁止直接覆盖当前运行目录。

## 11. 推荐外部 skills

- 页面截图、DOM 快照、点击回归、WebView2/CDP 调试：`https://github.com/vercel-labs/agent-browser`
- 外部工具应安装或缓存到 `.sandbox/`，不要做全局安装。

agent-browser 常用命令：

```powershell
npm exec --yes agent-browser -- --session pm connect 9222
npm exec --yes agent-browser -- --session pm tab
npm exec --yes agent-browser -- --session pm screenshot "C:\Temp\panelmanager.png"
npm exec --yes agent-browser -- --session pm screenshot --annotate "C:\Temp\panelmanager-annotated.png"
```

- 仅 Debug 构建默认开启 WebView2 CDP 端口 `9222`。
- 若 npm 报 `Maximum call stack size exceeded`，在 `.sandbox/` 下新建干净 npm 目录后再运行。

## 12. 输出要求

- 说明改了什么和为什么。
- 列出改动文件。
- 明确验证命令与结果。
- 若未完成，说明阻塞原因和建议下一步。
- 修改本 skill 或 OpenCode 配置后，提醒用户重启 OpenCode/AI sidecar 让规则重新加载。
