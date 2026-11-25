#!/usr/bin/env python3
"""Two-phone field recorder. Usage: python3 scripts/field/record.py"""
import argparse
import json
import os
import select
import signal
import sys
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

from devices import DeviceError, discover, monitor, prepare, ios_pid, run, APP
from report import LABEL, PLATFORMS, write_report

ROOT = Path(__file__).resolve().parents[2]
DEFAULT = ROOT / "test-results" / "field"


class Session:
    def __init__(self, folder, platforms, stop):
        folder.mkdir(parents=True)
        self.folder = folder
        self.stream = (folder / "events.jsonl").open("x", buffering=1)
        self.start = time.monotonic()
        self.lock = threading.Lock()
        self.stop = stop
        self.children = set()
        self.bus = None
        self.last = {}
        self.wall_start = time.time()
        self.links = {}
        self.scans = {}
        self.add("session", platforms=platforms, formatVersion=1)

    def add(self, kind, **data):
        with self.lock:
            row = dict(t=round(time.monotonic()-self.start, 3), at=datetime.now().astimezone().isoformat(timespec="milliseconds"),
                       kind=kind, **data)
            self.stream.write(json.dumps(row, ensure_ascii=False) + "\n")
            if kind in ("bus", "note", "end", "stop", "link"):
                self.stream.flush()
                os.fsync(self.stream.fileno())
            device = data.get("device")
            if device and kind not in ("link","process","system_report","diagnostic"):
                self.scans[device] = {"confirmed":"確認 "+str(data.get("route","")), "no_result":"本輪沒有確認車號",
                                      "camera":"相機掃描中", "capture":"相機掃描中", "session_stop":"手機場次已結束"}.get(kind,self.scans.get(device,"已收到事件"))

                self.last[device] = (row["t"],row["at"])
            if kind == "link":
                self.links[device] = data["message"]
                print(f"[{PLATFORMS[device]}] {data['message']}", flush=True)
            if kind == "confirmed":
                print(f"[{PLATFORMS[device]}] 確認 {data.get('route','？')}", flush=True)

    def attach(self, child):
        with self.lock:
            self.children.add(child)
            if self.stop.is_set():
                child.terminate()

    def detach(self, child):
        if child.poll() is None:
            child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
        child.wait()
        child.stdout.close()
        with self.lock:
            self.children.discard(child)

    def status(self, platforms):
        with self.lock:
            now = time.monotonic() - self.start
            for p in platforms:
                age = now - self.last[p][0] if p in self.last else None
                text = "尚無取像或 OCR 資料" if age is None else f"最後收到 {self.last[p][1]}（{age:.0f} 秒前），{self.scans[p]}"
                if age is not None and age > 10:
                    text += "，請檢查 App 是否仍在前景辨識"
                print(f"{PLATFORMS[p]}：{self.links.get(p, '等待連線')}，{text}", flush=True)


HELP = "看到車時輸入車號與方向（例 941 三峽）按 Enter；離開輸入 end；備註 note 逆光；狀態 status；結束 q 或 Ctrl+C。"


def command(session, text, platforms):
    text = text.strip()
    if text == "q":
        return False
    if text == "end" and session.bus:
        session.add("end", route=session.bus)
        print(f"已結束 {session.bus}", flush=True)
        session.bus = None
    elif text.startswith("note ") and text[5:].strip():
        session.add("note", message=text[5:].strip()[:400])
        print("備註已存", flush=True)
    elif text == "status":
        session.status(platforms)
    elif text not in ("end", "help") and LABEL.fullmatch(text.split()[0] if text else "") and any(c.isdigit() for c in text.split()[0]):
        if session.bus:
            print(f"正在記錄 {session.bus}，請先輸入 end，或用 note 註記同時進站的車。", flush=True)
        else:
            route, _, direction = text.partition(" ")
            session.bus = route.upper()
            session.add("bus", route=session.bus, direction=direction.strip()[:80])
            print(f"已標記 {session.bus} 進入視野", flush=True)
    elif text:
        print(HELP, flush=True)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=["both", *PLATFORMS], default="both")
    parser.add_argument("--serial", help="Android serial")
    parser.add_argument("--udid", help="iPhone UDID")
    parser.add_argument("--check", action="store_true", help="檢查連線後退出")
    parser.add_argument("--report", type=Path, metavar="SESSION", help="重新產生指定場次報告")
    parser.add_argument("--output", type=Path, default=DEFAULT)
    parser.add_argument("--seconds", type=int, help="自動結束的秒數")
    args = parser.parse_args()
    if args.report:
        print(write_report(args.report))
        return 0
    if args.seconds is not None and args.seconds < 1:
        parser.error("--seconds 必須大於 0")
    platforms = list(PLATFORMS) if args.platform == "both" else [args.platform]
    chosen = {"ios": args.udid, "android": args.serial}
    if args.check:
        ok = True
        for p in platforms:
            try:
                identifier, model = discover(p, chosen[p])
                detail = "App 行程 "+ios_pid(run,identifier,APP) if p=="ios" else "已授權且套件存在"
                prepare(p,identifier)
                print(f"{PLATFORMS[p]}：{model} {detail}")
            except (DeviceError, ValueError, KeyError) as exc:
                print(f"{PLATFORMS[p]}：{exc}")
                ok = False
        return 0 if ok else 1
    stop = threading.Event()
    folder = args.output.resolve() / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    session = Session(folder, platforms, stop)
    print(f"記錄資料夾 {folder}\n{HELP}", flush=True)
    threads = [threading.Thread(target=monitor, args=(p, chosen[p], session, stop)) for p in platforms]
    for thread in threads:
        thread.start()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    try:
        next_status = time.monotonic() + 15
        # Read bytes directly: TextIOWrapper can buffer multiple redirected lines beyond select().
        pending = b""
        stdin = sys.stdin.fileno()
        while not stop.is_set():
            if args.seconds and time.monotonic() >= session.start + args.seconds:
                break
            if time.monotonic() >= next_status:
                session.status(platforms)
                next_status = time.monotonic() + 15
            if stdin is None:
                stop.wait(.3)
            elif select.select([stdin], [], [], .3)[0]:
                part = os.read(stdin, 4096)
                if not part:
                    stdin = None
                    if not args.seconds:
                        break
                pending += part
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if not command(session, line.decode("utf-8", "replace"), platforms):
                        stop.set()
                        break
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        with session.lock:
            children = list(session.children)
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
        for thread in threads:
            thread.join()
        session.add("stop")
        session.stream.close()
        print(f"報告已存到 {write_report(folder)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
