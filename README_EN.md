# PanelManager

English | [简体中文](README.md)

PanelManager is a desktop secondary-display control panel built with .NET
MAUI and BlazorWebView. It targets touchscreen and device-management
scenarios and combines system controls, serial communication, Wi-Fi and
Bluetooth management, utility pages, and an AI assistant powered by an
OpenCode sidecar.

This repository primarily contains the host application. See the
[OSHWHub project](https://oshwhub.com/5473675a/project_rnkdtbtx) for the
hardware implementation.

## Latest Development Update

- Stability work covers composite PanelLink USB PID `5F55` detection, duplicate-event and transport-error handling for Wi-Fi/Bluetooth toggles, persistent display scaling, and serial authentication plus worker/WebSocket recovery paths.
- Firmware updates support inspection, planning, download, verification, and device reconnection for self-contained `.pmfw` files.
- The RK628 display workflow is simplified and its text and controls are sized for touch screens.

## Features

- Device connection and status monitoring, including serial and system status
- Basic Wi-Fi and Bluetooth management with status display
- Utility and configuration pages for EDID, shortcuts, notes, and related tools
- AI assistant with model selection, conversations, step and tool details, and provider configuration
- Windows floating-window integration through the `FloatingWindow` project

## Host And Device Boundary

- This repository contains the desktop host. Its Wi-Fi, Bluetooth, audio, RK628, and USB/HID pages primarily send device protocol commands and display results.
- Contribution and coding-agent guidance is documented in `AGENTS.md`.

## Technology

- .NET 9 with .NET MAUI
- BlazorWebView for hosting the frontend
- Native frontend files: `wwwroot/index.html`, `script.js`, and `style.css`
- WebSocket communication between the desktop host and frontend

## Repository Structure

- `PanelManager/`: the .NET MAUI and BlazorWebView host application
- `PanelManager/Dependencies/Isd/IsdDownload.dll`: precompiled x64 native PMFW verification and download boundary, SHA-256 `08126B1CB737E3BB7CA64177DF333032B7AB8918B2A7F405D548F7358B72929C`
- `FloatingWindow/`: Windows floating-window companion application using WPF
- `Installer/`: Windows installer project
- `skills/panelmanager-opencode/SKILL.md`: local OpenCode project skill
- `AGENTS.md`: repository-wide instructions for coding agents
- `scripts/build-windows-cli.ps1`: minimal Windows CLI build script
- `scripts/publish-windows-cli.ps1`: Windows folder publishing script
- `scripts/package-windows-installer.ps1`: Windows installer packaging script

## Requirements

- Windows 10 or Windows 11
- PowerShell
- Node.js for frontend syntax validation

The build scripts install and cache the required .NET SDK, workloads, and
NuGet packages under the repository's `.sandbox/` directory.

## Quick Start

Run the following command from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-cli.ps1
```

Build output:

- `.sandbox/artifacts/build-cli`

## Publish a Folder Build

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\publish-windows-cli.ps1
```

Default output:

- `.sandbox/artifacts/publish/windows-win-x64`

The published directory contains:

- The application and its runtime dependencies
- A `PanelManager-source-*.zip` source archive

## Build the Installer

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-windows-installer.ps1
```

Default installer output:

- `.sandbox/artifacts/installer/output/PanelManagerSetup.exe`

## GitHub Actions

`.github/workflows/build-windows.yml` invokes
`scripts/package-windows-installer.ps1` to build the Windows x64 installer.

- Runs automatically on pushes to `main`
- Runs for pull requests targeting `main`
- Supports manual runs from the GitHub Actions page
- Uploads the installer as the `PanelManagerSetup-win-x64` artifact
- Uploads the source archive as the `PanelManager-source` artifact
- Retains artifacts for 14 days

## Replacing an Existing Installation

- Do not overwrite the currently running directory directly.
- Validate a new build in a separate directory first.
- Back up the previous version before changing shortcuts or startup paths.

## AI and OpenCode

- The AI page communicates with the sidecar through bridge commands such as
  `system:aiStart`, `aiStatus`, and `aiEvent`.
- The application reuses a running sidecar when possible.
- A local `opencode.exe` is used directly when available; download and
  extraction occur only when it is missing.
- Download and extraction progress is displayed in the AI page.

## Troubleshooting

- `NETSDK1045`: install or use .NET SDK 9.x.
- `MSB3030` involving `MsixContent` or `Microsoft.UI.Xaml.Controls.pri`:
  verify the workspace structure, MAUI workload, and Windows App SDK resources.
- If the build succeeds but the page is broken, inspect recent changes in
  `PanelManager/wwwroot/script.js` and `style.css`.

## Development Notes

- Most frontend entry points are in `PanelManager/wwwroot/script.js`.
- Host commands and device integration are in
  `PanelManager/Services/HostCommandHandler.cs`.
- OpenCode lifecycle and event subscriptions are in
  `PanelManager/Services/OpenCodeSidecarService.cs`.

## License

This project is licensed under the [MIT License](LICENSE).
