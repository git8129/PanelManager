# PanelManager 上位机开发规则

本文件约束公开上位机及独立源码包；操作命令按需查 `skills/panelmanager-opencode/SKILL.md`。

## 开发与边界

- 动手前查 Git 状态、相关 diff/提交及已有实现、工具、测试和记录，复用成果，不重复工作或覆盖他人改动。
- 沿现有结构做最小正确改动，新增/移动源码同步源清单；保留已验证修复的根因与证据。
- 常规修改归 `PanelManager/`、`FloatingWindow/`、`Installer/`、`scripts/`、`skills/` 和现有文档。
- 临时工具、测试和输入输出归 `.sandbox/<任务>/`，正式文件归既有模块；保留有效缓存和交付产物，不清理未知文件。

## 工程入口

- 宿主：`PanelManager/MauiProgram.cs`、`PanelManager/Platforms/Windows/App.xaml.cs`、`PanelManager/MainPage.xaml`。
- 前端：`PanelManager/wwwroot/index.html`、`script.js`、`style.css`、`ui_*.js`。
- 消息桥/命令：`PanelManager/Services/MessageBridge.cs`、`HostCommandHandler.cs`；AI sidecar：同目录 `OpenCodeSidecarService.cs`。
- 悬浮窗：`FloatingWindow/FloatingWindow.csproj`；安装器：`Installer/PanelManager.Installer.csproj`、`Installer/Program.cs`。

## 前端与验证

- 通用 UI 先查 `UI_COMPONENTS.md`，复用 `.ui-*`、tokens、组件 CSS 和 `window.UIComponents`；领域 CSS 只管特有布局/状态，不另建同义基础类。
- 文本使用 `textContent` 或安全转义，不把不可信数据拼入 `innerHTML`；静态外观写入 CSS，内联样式仅用于运行时值。
- 完成可交付改动后集中验证：文档核对 diff，JS 检查改动文件，C#/MAUI 用构建脚本，安装器用对应工程入口；协议/并发等高风险改动覆盖失败边界。
- 通用 UI 通过 CDP 回归主界面、设置页、弹窗和一个设备列表；运行版本交付做启动及关键交互冒烟，具体范围见 skill。
- 复用已有测试和未变化的结果，仅为缺陷/关键行为/高风险边界补测试；不写源码形状测试，不默认全量验证、发布或打包。
- 无新变化/失败/风险不重跑；优先处理首个可操作错误，说明实际验证及未验证项。

## 构建、运行与更新

- 构建/发布/打包以 `scripts/` 为准，工具链、缓存和输出归 `.sandbox/`，不得污染运行目录或全局系统。
- 源码包须包含完整工程、规则、skill、脚本及构建依赖，排除 Git/缓存/IDE/编译临时文件；目录清单见 skill。
- AI 工作区根目录即项目根目录；OpenCode 默认位于 exe 同级 `.sandbox/OpenCode/`。
- 安装器从发布 staging 生成精简 payload，默认用户级，仅驱动安装申请 UAC；主程序拒绝提权后仍可兼容运行。
- 新版本在独立目录验证，切换运行入口时保留旧版本，不覆盖正在使用的运行目录。
- CDP `9222` 仅 Debug 默认开启；连接前确认实际运行的是 Debug 版本，并检查端口是否可用。
- COM 被宿主占用时优先 `system/manualUpdate`；仅宿主不可用、更新失败或设备已独立下载态时用独立流程，默认保留数据，明确要求才全擦除。
