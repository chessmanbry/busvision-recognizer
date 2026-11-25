"""Capture the app's Android logcat or iOS developer console, without saving raw console output."""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from report import parse_console
from phone import poll_phone, ios_pid, crash_names

APP = "com.chessman.busvision2.recognizer"


class DeviceError(Exception):
    pass


def run(*args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise DeviceError(f"{Path(args[0]).name} 無法執行或逾時") from exc
    if result.returncode:
        raise DeviceError(f"{Path(args[0]).name} 失敗（{result.returncode}），請確認解鎖、授權及連線")
    return result.stdout.strip()


def adb_path():
    sdk = Path(os.environ.get("ANDROID_HOME") or Path.home() / "Library/Android/sdk")
    return os.environ.get("ADB") or shutil.which("adb") or str(sdk / "platform-tools/adb")


def pick(devices, chosen):
    if chosen:
        devices = [d for d in devices if d[0] == chosen]
    if len(devices) != 1:
        raise DeviceError("等待已連線、解鎖並授權的手機" if not devices else "找到多支手機，請用 --serial 或 --udid 指定")
    return devices[0]


def discover(platform, chosen):
    if platform == "android":
        listing = run(adb_path(), "devices", "-l")
        rows = [s.split() for s in listing.splitlines()]
        for r in rows:
            if len(r)>1 and (not chosen or r[0]==chosen) and r[1] in ('unauthorized','offline'):
                raise DeviceError('Android USB 偵錯尚未授權' if r[1]=='unauthorized' else 'Android 連線中斷（offline）')
        devices = [(r[0], next((v[6:] for v in r if v.startswith("model:")), "Android")) for r in rows
                   if len(r) >= 2 and r[1] == "device" and not r[0].startswith("emulator-")]
    else:
        data = run("xcrun", "devicectl", "list", "devices", "--filter",
                   "State BEGINSWITH 'available' AND Reality == 'physical' AND Model CONTAINS 'iPhone'",
                   "--json-output", "-", "--quiet")
        devices = []
        for row in json.loads(data)["result"]["devices"]:
            hardware = row.get("hardwareProperties") or row["properties"]["hardware"]
            devices.append((hardware.get("udid") or row["identifier"], hardware.get("marketingName", "iPhone")))
    return pick(devices, chosen)


def prepare(platform, identifier):
    if platform == "ios":
        return None
    adb = [adb_path(), "-s", identifier]
    user = run(*adb, "shell", "am", "get-current-user")
    if not user.isdigit():
        raise DeviceError("無法查詢 Android 使用者")
    package = run(*adb, "shell", "pm", "list", "packages", "--user", user, APP)
    if "package:"+APP not in package.splitlines():
        raise DeviceError(f"已授權，使用者 {user} 未安裝套件 {APP}")
    # Use device time to avoid replaying logs from a previous field session.
    since = run(*adb, "shell", "date '+%m-%d %H:%M:%S.%3N'")
    return [*adb, "logcat", "-T", since, "-v", "raw", "Capacitor/Console:V", "chromium:V", "*:S"]


def monitor(platform, chosen, session, stop):
    cursor = {}
    previous = None
    previous_pid = None
    reports = None
    def state(message):
        nonlocal previous
        if message != previous and not stop.is_set():
            session.add("link", device=platform, message=message)
            previous = message
    while not stop.is_set():
        child = None
        try:
            identifier, model = discover(platform, chosen)
            chosen = identifier  # Reconnect only to the same handset.
            if platform == "ios":
                pid = ios_pid(run,identifier,APP)
                if pid != previous_pid:
                    session.add("process",device=platform,pid=pid)
                    try:
                        names = set(crash_names(run,identifier))
                        if reports is not None:
                            for name in sorted(names-reports):
                                session.add("system_report",device=platform,name=name)
                        reports = names
                    except (DeviceError, KeyError, ValueError):
                        session.add("diagnostic",device=platform,message="無法讀取系統報告索引")
                    previous_pid = pid
                state(f"{model} 已連線，App 行程 {pid}")
                try:
                    poll_phone(run,identifier,APP,cursor,session)
                except DeviceError:
                    state("已連線，尚無可讀場次，請在手機開啟外測工具")
                stop.wait(2)
                continue
            command = prepare(platform, identifier)
            if stop.is_set():
                break
            state(f"{model} 已找到，等待 App 事件")
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, start_new_session=True)
            session.attach(child)
            received = False
            for raw in child.stdout:
                if stop.is_set():
                    break
                line = raw.decode("utf-8", "replace")
                event = parse_console(line) if "[BusVisionField] " in line else None
                if event:
                    received = True
                    state(f"{model} 正在收錄")
                    session.add(device=platform, **event)
            state("日誌串流中斷，等待重連" if received else "日誌串流結束，未收到 App 事件")
        except (DeviceError, OSError, KeyError, ValueError) as exc:
            state(str(exc) if isinstance(exc, DeviceError) else "無法讀取裝置資料，等待重試")
        finally:
            if child is not None:
                session.detach(child)
        stop.wait(4)
