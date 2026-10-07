#!/usr/bin/env python3
"""通过运行中的 PanelManager WebSocket bridge 执行 PMFW 手动升级。

用法：
  python manual-update-via-panelmanager.py --package <path> --bridge-port 5000
  python manual-update-via-panelmanager.py --preflight-only --bridge-port 5000

依赖：websockets；需要提供 debugHostCapability 的 Debug PanelManager。
脚本复用宿主现有会话执行 manualUpdate，不打开串口或二次认证。
通过5000 WebSocket获取Debug capability，不依赖WebView2/CDP 9222。
烧写需要USB0（宿主USB1.1）；USB1时翻转Type-C并等待宿主自动重连。
连接后先等首帧，接收上限4 MiB；下载设备等待15秒，超时请用户处理，不自动重试。
客户端超时不取消旧宿主的后台操作，处理设备前须确认宿主已结束等待。
宿主/设备请求15秒无响应、认证等待超时或USB控制器未知时，退出并提示用户重启设备。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.request
import uuid
from pathlib import Path


def json_request(url: str) -> object:
    with urllib.request.urlopen(url, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


async def cdp_eval(ws, expression: str) -> object:
    request_id = 1
    await ws.send(json.dumps({"id": request_id, "method": "Runtime.evaluate", "params": {
        "expression": expression, "returnByValue": True
    }}))
    while True:
        result = json.loads(await ws.recv())
        if result.get("id") == request_id:
            return result["result"]["result"].get("value")


async def run(args: argparse.Namespace) -> int:
    try:
        import websockets
    except ImportError as exc:
        raise RuntimeError("缺少 websockets，请在当前 Python 环境执行 python -m pip install websockets") from exc

    package = Path(args.package).resolve() if args.package else None
    if package is not None and not package.is_file():
        raise FileNotFoundError(package)

    uri = f"ws://127.0.0.1:{args.bridge_port}"
    async with websockets.connect(uri, origin="https://0.0.0.1", max_size=4 * 1024 * 1024) as bridge:
        # 宿主首帧到达后才请求capability，避免连接策略初始化竞态。
        try:
            await asyncio.wait_for(bridge.recv(), 10)
        except asyncio.TimeoutError as exc:
            raise RuntimeError("宿主桥接无响应，请重启设备并等待宿主自动重连后再试；不自动重试。") from exc
        device_deadline = None

        async def receive() -> dict:
            nonlocal device_deadline
            if device_deadline is None:
                message = await bridge.recv()
            else:
                remaining = device_deadline - asyncio.get_running_loop().time()
                try:
                    if remaining <= 0:
                        raise asyncio.TimeoutError
                    message = await asyncio.wait_for(bridge.recv(), remaining)
                except asyncio.TimeoutError as exc:
                    raise RuntimeError(
                        "15秒内未找到下载设备；客户端退出不取消旧宿主后台等待。"
                        "请先确认宿主操作已结束，再重启设备、检查USB0连接后重试；不自动重试。"
                    ) from exc
            result = json.loads(message)
            if result.get("mod") == 9 and result.get("cmd") == "isdUpdateProgress":
                stage = (result.get("data") or {}).get("stage")
                if stage == "WaitingForDevice" and device_deadline is None:
                    device_deadline = asyncio.get_running_loop().time() + 15
                elif stage and stage != "WaitingForDevice":
                    device_deadline = None
            return result

        token_id = uuid.uuid4().hex[:8]
        token_request = {"v": 1, "id": token_id, "target": 0, "type": 0,
                         "mod": 0, "cmd": "debugHostCapability", "data": {}}
        await bridge.send(json.dumps(token_request, separators=(",", ":")))
        try:
            async with asyncio.timeout(15):
                while True:
                    token_response = await receive()
                    if token_response.get("id") == token_id:
                        break
        except asyncio.TimeoutError as exc:
            raise RuntimeError("宿主请求15秒无响应，请重启设备并等待宿主自动重连后再试；不自动重试。") from exc
        capability = (token_response.get("data") or {}).get("capability")
        if token_response.get("code", 1) != 0 or not capability:
            raise RuntimeError(f"无法获取 Debug host capability: {token_response}")

        async def request(cmd: str, module: int, data: dict, target: int = 0) -> dict:
            message_id = uuid.uuid4().hex[:8]
            message = {"v": 1, "id": message_id, "target": target, "type": 0,
                       "mod": module, "cmd": cmd, "cap": capability, "data": data}
            await bridge.send(json.dumps(message, separators=(",", ":")))
            try:
                async with asyncio.timeout(15):
                    while True:
                        result = await receive()
                        if result.get("id") == message_id:
                            return result
            except asyncio.TimeoutError as exc:
                raise RuntimeError(
                    f"请求{cmd}超过15秒无响应，请重启设备并等待宿主自动重连后再试；不自动重试。"
                ) from exc

        state = await request("status", 0, {})
        serial_state = (state.get("data") or {}).get("serial") or {}
        # The host owns CDC authentication. Never reopen or reauthenticate
        # its device session from an automation client.
        for _ in range(30):
            preflight = await request("manualUpdatePreflight", 0, {})
            state = preflight.get("data") or {}
            if state.get("serialConnected") or state.get("downloadModePresent"):
                print(json.dumps(state, ensure_ascii=False), flush=True)
                break
            await asyncio.sleep(1)
        else:
            raise RuntimeError(f"等待设备认证超时，请重启设备并等待宿主自动重连后再试；未发起刷写: {state}")

        if args.preflight_only:
            if state.get("serialConnected"):
                version = await request("getVersion", 9, {}, target=1)
                print(json.dumps(version, ensure_ascii=False), flush=True)
                return 0 if version.get("code", 1) == 0 else 1
            return 0 if state.get("downloadModePresent") else 1

        if state.get("serialConnected") and state.get("usbId") is None:
            raise RuntimeError(
                "宿主未识别设备USB控制器，请重启设备并等待宿主自动重连、状态栏显示USB1.1后再试；未发起刷写。"
            )

        request_id = uuid.uuid4().hex[:8]
        request = {
            "v": 1, "id": request_id, "target": 0, "type": 0, "mod": 0,
            "cmd": "manualUpdate", "cap": capability,
            "data": {"path": str(package), "preserveUserData": not args.full_erase,
                      "enterUpgradeConfirmed": True},
        }
        await bridge.send(json.dumps(request, ensure_ascii=False, separators=(",", ":")))
        try:
            async with asyncio.timeout(15):
                while True:
                    response = await receive()
                    if response.get("id") == request_id:
                        break
        except asyncio.TimeoutError as exc:
            raise RuntimeError(
                "manualUpdate请求15秒无响应；请先确认宿主升级流程已结束，再重启设备并等待自动重连后重试。"
            ) from exc
        print(json.dumps(response, ensure_ascii=False))
        if response.get("code", 1) != 0:
            return 1
        while True:
            message = await receive()
            if message.get("mod") != 9:
                continue
            data = message.get("data") or {}
            if message.get("cmd") == "isdUpdateProgress":
                print(f'{data.get("percent")}% {data.get("stage")}: {data.get("message")}', flush=True)
            elif message.get("cmd") == "event":
                print(json.dumps(data, ensure_ascii=False), flush=True)
            # HostCommandHandler broadcasts Update/event with data.status.
            if message.get("cmd") == "event" and data.get("status") == "confirm_enter_upgrade":
                confirm = {
                    "v": 1, "id": uuid.uuid4().hex[:8], "target": 0, "type": 0,
                    "mod": 0, "cmd": "manualUpdateBootConfirm", "cap": capability,
                    "data": {"requestId": data.get("requestId"), "continue": True},
                }
                await bridge.send(json.dumps(confirm, separators=(",", ":")))
            elif message.get("cmd") == "event" and data.get("status") in ("success", "error"):
                if data["status"] == "error" and any(
                    text in str(data.get("error", "")).lower()
                    for text in ("timeout", "timed out", "超时", "无响应", "卡死")
                ):
                    print("升级流程已报错，请重启设备并等待宿主自动重连后再试；不自动重试。", file=sys.stderr)
                return 0 if data["status"] == "success" else 1


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--package")
    parser.add_argument("--preflight-only", action="store_true", help="只读宿主连接及设备固件版本；不触发进入下载态或写入")
    parser.add_argument("--cdp-port", type=int, default=9222, help="兼容旧调用保留；当前流程不使用CDP")
    parser.add_argument("--bridge-port", type=int, default=5000)
    parser.add_argument("--full-erase", action="store_true")
    args = parser.parse_args()
    if not args.preflight_only and not args.package:
        parser.error("更新必须提供--package；只读检查使用--preflight-only")
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
