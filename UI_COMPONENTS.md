# PanelManager 前端 UI 组件库

本组件库用于统一 `PanelManager/wwwroot` 的桌面触控界面。组件库负责颜色、字体、间距、圆角、焦点、触摸尺寸和通用组件外观；硬件页面仍负责自己的布局、数据绑定和设备交互。

## 入口

- Token：`PanelManager/wwwroot/ui_tokens.css`
- CSS 组件：`PanelManager/wwwroot/ui_components.css`
- JS 构造器：`PanelManager/wwwroot/ui_components.js`
- 页面入口：`PanelManager/wwwroot/index.html`
- 旧页面样式：`PanelManager/wwwroot/style.css`

加载顺序固定为 `style.css`、`ui_tokens.css`、`ui_components.css`。旧样式保留页面专用布局，组件层在最后统一通用外观。

## 设计约束

| 类别 | 规范 |
| --- | --- |
| 正文 | `20px`，页面标题 `36px`，区域标题 `24px`，页面内二级标题 `28px` |
| 间距 | `4/8/12/16/20/24/32px`，优先使用 `--ui-space-*` |
| 圆角 | 小组件 `8px`，常规组件 `12px`，面板 `16px`，胶囊 `999px` |
| 控件高度 | 紧凑 `48px`，标准 `56px`，重要操作 `72px` |
| 最小触摸目标 | `48px`；设备工作台可按硬件布局使用更大尺寸 |
| 焦点 | 使用 `--ui-focus-ring`，键盘和 WebView2 聚焦必须可见 |
| 动效 | 使用 `--ui-duration-*`；尊重 `prefers-reduced-motion` |
| 字体 | 所有按钮、输入、选择、文本域继承 `--ui-font-sans`，字距固定为 `0` |

颜色使用语义 token，不在组件 CSS 中新增页面专用颜色：`primary`、`success`、`warning`、`danger`、`text`、`text-muted`、`border`、`surface`。

## CSS 组件

### 布局和表面

```html
<section class="ui-panel ui-stack">
    <h3 class="ui-section-title">网络配置</h3>
    <div class="ui-grid ui-grid--two">
        <div class="ui-field">...</div>
        <div class="ui-field">...</div>
    </div>
</section>
```

- `.ui-stack`：垂直堆叠，标准间距 `16px`
- `.ui-inline`：水平对齐，标准间距 `12px`
- `.ui-actions`：操作按钮行，自动换行
- `.ui-grid`、`.ui-grid--two`：表单和信息网格
- `.ui-panel`：页面级面板，`16px` 圆角
- `.ui-section`、`.ui-card`：面板内部的分组和重复项，`12px` 圆角
- `.ui-divider`：分隔线

### 按钮

```html
<button class="ui-button ui-button--primary">应用</button>
<button class="ui-button ui-button--warning ui-button--sm">清空</button>
<button class="ui-icon-button" aria-label="刷新">↻</button>
```

变体：`primary`、`secondary`、`success`、`warning`、`danger`、`ghost`。尺寸：`sm`、默认 `md`、`lg`。按钮必须使用 `button` 语义元素，图标按钮必须提供 `aria-label` 或 `title`。

### 表单

```html
<label class="ui-field">
    <span class="ui-field-label">设备名称</span>
    <input class="ui-input" type="text" placeholder="输入名称">
    <span class="ui-field-hint">最多 31 个字符</span>
</label>
```

可用类：`.ui-input`、`.ui-select`、`.ui-textarea`、`.ui-check`。旧类 `.input-base`、`.select-base`、`.textarea-base`、`.input-md`、`.textarea-md` 已接入相同的字体、圆角、焦点和缺失 token 兼容层。

### 标签页、状态和列表

```html
<div class="ui-tabs" role="tablist">
    <button class="ui-tab is-active" role="tab" aria-selected="true">概览</button>
    <button class="ui-tab" role="tab" aria-selected="false">详情</button>
</div>

<span class="ui-status ui-status--success">已连接</span>
<div class="ui-list">
    <div class="ui-list-item">设备列表项</div>
</div>
```

状态变体：`info`、`success`、`warning`、`danger`。空态使用 `.ui-empty-state`，不要用散落的内联颜色、字号和间距重复实现。

## JavaScript API

`window.UIComponents` 中的构造器只写入 `textContent`，不会把不可信文本拼接到 `innerHTML`。

```js
const applyButton = UIComponents.createButton({
    label: '应用',
    icon: '✓',
    variant: 'primary',
    size: 'md',
    onClick: applyConfig
});

const status = UIComponents.createStatusBadge({ label: '已连接', tone: 'success' });
const empty = UIComponents.createEmptyState({
    icon: '□',
    title: '暂无设备',
    description: '扫描完成后将在此显示设备'
});
```

现有 Wi-Fi、应用列表、快捷键、电话列表构造器继续保留原函数名，并通过 `.ui-list-item`、`.ui-input`、`.ui-stack` 等组件类接入统一视觉层。

## 旧类适配表

| 旧类 | 统一组件 | 说明 |
| --- | --- | --- |
| `.btn-base`、`.btn-tonal`、`.btn-glass` | Button | 保留旧变体和事件，统一字体、圆角、焦点和触摸高度 |
| `.input-base`、`.select-base`、`.textarea-base` | Form control | 保留页面尺寸，统一字体、边框、焦点 |
| `.widget`、`.panel-dark`、`.monitor-card`、`.info-card`、`.update-card`、`.modal-content` | Panel/Surface | 统一面板圆角 |
| `.btn-tab`、`.phone-tab`、`.phone-filter-btn`、`.pomodoro-mode-btn` | Tab/Segment | 统一字体、焦点和圆角基线 |
| `.device-item`、`.app-list-item` | List item | 动态列表追加 `.ui-list-item` |
| `.empty-state` | Empty state | 兼容旧名称，新增页面优先使用 `.ui-empty-state` |

旧类适配层是迁移期入口，不新增第三套同义类。新页面必须使用 `.ui-*`；领域专用类只能负责布局和业务状态。

## 内联样式政策

允许内联样式的运行时值：进度百分比、壁纸地址、用户选择的颜色、动态尺寸计算值。

禁止内联静态外观：字体、颜色、圆角、阴影、固定间距、控件高度、焦点效果。应在 `ui_components.css` 或页面领域 CSS 中定义类。

## 迁移顺序

1. 新增页面直接使用 `.ui-*`，不再复制 `.btn-*`、`.panel-*`、`.*-empty-state` 的基础外观。
2. 修改已有页面时，先把重复控件加上 `.ui-*`，保留旧类处理业务布局和事件。
3. 动态 DOM 优先使用 `window.UIComponents` 构造器或在现有渲染器中追加 `.ui-*` 类。
4. 当某个领域页面完全迁移并完成 WebView2 回归后，才删除对应旧基础规则。

## 验证

前端脚本：

```powershell
node --check .\PanelManager\wwwroot\script.js
node --check .\PanelManager\wwwroot\ui_components.js
```

视觉回归至少覆盖 `1904x1080` WebView2、主界面、设置页、Wi-Fi/蓝牙列表、弹窗、空态、禁用态、错误态和 RK628 工作台。页面布局改变后必须通过 CDP 检查滚动容器的 `clientHeight` 与 `scrollHeight`。
