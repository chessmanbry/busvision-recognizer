"""Capture the app's Android logcat or iOS developer console, without saving raw console output."""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

from report import parse_console

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
        return ["xcrun", "devicectl", "device", "process", "launch", "--device", identifier,
                "--terminate-existing", "--console", APP]
    adb = [adb_path(), "-s", identifier]
    app_info = run(*adb, "shell", "cmd", "package", "list", "packages", "-U", APP)
    uid = re.search(r"^package:" + re.escape(APP) + r"\s+uid:(\d+)$", app_info, re.M)
    if not uid:
        raise DeviceError("手機上找不到 BusVision")
    # Use device time to avoid replaying logs from a previous field session.
    since = run(*adb, "shell", "date '+%m-%d %H:%M:%S.%3N'")
    launch = run(*adb, "shell", "am", "start", "-n", APP + "/com.chessman.busvision2.MainActivity")
    if "Error" in launch or "Exception" in launch:
        raise DeviceError("Android 無法開啟 BusVision")
    return [*adb, "logcat", "--uid=" + uid[1], "-T", since, "-v", "raw", "Capacitor/Console:I", "Capacitor/Plugin:V", "*:S"]


def monitor(platform, chosen, session, stop):
    previous = None
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
            command = prepare(platform, identifier)
            if stop.is_set():
                break
            state(f"{model} 已找到，等待 App 事件")
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     stdin=subprocess.DEVNULL, start_new_session=True)
            session.attach(child)
            for raw in child.stdout:
                if stop.is_set():
                    break
                line = raw.decode("utf-8", "replace")
                event = parse_console(line)
                if event:
                    state(f"{model} 正在收錄")
                    session.add(device=platform, **event)
            state("連線中斷或 App 已結束，等待重連")
        except (DeviceError, OSError, KeyError, ValueError) as exc:
            state(str(exc) if isinstance(exc, DeviceError) else "無法讀取裝置資料，等待重試")
        finally:
            if child is not None:
                session.detach(child)
        stop.wait(4)
