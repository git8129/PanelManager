# Windows Window Lifecycle

## Duplicate Launch

PanelManager uses two session-local named objects:

- `PanelManager.SingleInstance` elects the primary host process.
- `PanelManager.SecondLaunch` forwards a later desktop/shortcut launch to that process.

The duplicate process only signals the event and exits. The primary process owns recovery: it calls `FloatingWindowManager.RestoreFromFloatingAsync()`, which shows the main window and sends `floatingHide`, then applies the existing foreground-window retries.

Do not reduce this path to a mutex-only silent exit. When the main window is hidden in floating mode, a silent duplicate exit leaves users with no obvious indication that PanelManager is already running.

## Regression Check

1. Start PanelManager and minimize it into floating mode.
2. Confirm the main window is hidden and the floating window is visible.
3. Launch PanelManager again from its executable or shortcut.
4. Confirm the duplicate process exits, the existing main window becomes visible, and the floating window is hidden.
