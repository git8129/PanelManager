# Windows Window Lifecycle

## Duplicate Launch

PanelManager uses two session-local named objects:

- `PanelManager.SingleInstance` elects the primary host process.
- `PanelManager.SecondLaunch` forwards a later desktop/shortcut launch to that process.

The duplicate process only signals the event and exits. The primary process owns recovery: it calls `FloatingWindowManager.RestoreFromFloatingAsync()`, which confirms the floating window is hidden before showing and foregrounding the main window.

## Main/Floating Handoff

The main window and floating window are mutually exclusive. The hidden WPF companion is prewarmed after the host WebSocket starts, so the first minimize does not pay process startup cost.

- Entering floating mode hides the main window before sending `floatingShow`. The main window is restored if the companion does not acknowledge visibility.
- Restoring hides the floating window first and waits for a `visible=false` acknowledgement before showing the main window.
- If hidden state cannot be confirmed, the host terminates the companion before showing the main window. This preserves the exclusivity invariant across transport failures.
- Repeated minimize requests reapply the invariant even when the manager already reports floating mode; stale foreground/show operations cannot leave the main window visible beside the companion.
- The Win32 title-bar maximize command and non-client double-click are blocked because the host window is fixed size.

Do not reduce this path to a mutex-only silent exit. When the main window is hidden in floating mode, a silent duplicate exit leaves users with no obvious indication that PanelManager is already running.

## Regression Check

1. Start PanelManager and minimize it into floating mode.
2. Confirm the main window is hidden and the floating window is visible.
3. Launch PanelManager again from its executable or shortcut.
4. Confirm the duplicate process exits, the existing main window becomes visible, and the floating window is hidden.
5. Repeatedly minimize and restore by double-click and by the context menu; confirm only one window is visible throughout each transition.
6. Terminate `FloatingWindow.exe` while floating; confirm the main window recovers automatically.
