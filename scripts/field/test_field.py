"""End-to-end regression using two simulated command streams; no phones required."""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from report import parse_console, write_report

HERE = Path(__file__).resolve().parent
FAKE = '''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
if "list" in args and "devices" in args:
    print(json.dumps({"result":{"devices":[{"identifier":"phone","hardwareProperties":{"udid":"phone","marketingName":"iPhone 16e"}}]}}))
elif "devices" in args:
    print("List of devices attached\\nsample device model:S22")
elif "packages" in args:
    print("package:com.chessman.busvision2.recognizer uid:10123")
elif "shell" in args:
    print("ok")
else:
    ios = "--console" in args
    prefix = "⚡️  [log] - " if ios else "File: https://localhost - Line 1 - Msg: "
    print(prefix + '[BusVisionRecognizer] camera-started {"videoWidth":1080,"videoHeight":1920}', flush=True)
    trigger = Path(os.environ["TRIGGER"])
    while not trigger.exists(): time.sleep(.02)
    print(prefix + '[BusVisionRecognizer] native-ocr-result {"engine":"apple-vision","elapsedMs":123,"lines":[{"text":"PRIVATE-CONTENT"}],"selected":"941","reliable":true}', flush=True)
    route = "941" if ios else "932"
    print(prefix + '[BusVisionRecognizer] recognize-result ' + json.dumps({"route":route,"source":"auto-preview-ocr"}), flush=True)
    print("⚡️  To Native ->  Haptics impact 123" if ios else "To native (Capacitor plugin): callbackId: 12, pluginId: Haptics, methodName: impact", flush=True)
    time.sleep(12)
'''


class FieldTests(unittest.TestCase):
    def test_two_platforms(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for command in ("xcrun", "adb"):
                tool = root / command
                tool.write_text(FAKE)
                tool.chmod(0o755)
            trigger = root / "go"
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ["PATH"], ADB=str(root / "adb"), TRIGGER=str(trigger))
            proc = subprocess.Popen([sys.executable, str(HERE / "record.py"), "--output", str(root / "sessions")],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
            def await_lines(fragment, count=1):
                for _ in range(150):
                    found = list(root.glob("sessions/*/events.jsonl"))
                    if found and found[0].read_text().count(fragment) >= count:
                        return found[0]
                    time.sleep(.03)
                self.fail(f"Missing {fragment}")
            try:
                timeline = await_lines('"kind": "camera"', 2)
                proc.stdin.write("941\n")
                proc.stdin.flush()
                await_lines('"kind": "bus"')
                trigger.touch()
                await_lines('"action": "haptic"', 2)
                output, _ = proc.communicate("note 逆光\nend\nq\n", timeout=8)
                self.assertEqual(proc.returncode, 0, output)
                report = (timeline.parent / "report.md").read_text()
                self.assertIn("iPhone：首次確認", report)
                self.assertIn("Android：期間未收到此路線的自動確認", report)
                self.assertIn("也確認了 932", report)
                self.assertIn("首次出現候選", report)
                self.assertIn("逆光", report)
                self.assertNotIn("PRIVATE-CONTENT", timeline.read_text())
                self.assertEqual(write_report(timeline.parent).read_text(), report)
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    proc.communicate(timeout=8)

    def test_truncated_ocr(self):
        event = parse_console('[BusVisionRecognizer] native-ocr-result {"engine":"apple-vision","elapsedMs":422,"lines":[{"text":"trunc')
        self.assertEqual(event, {"kind":"ocr", "partialLog":True, "ms":422})

    def test_missing_device_and_incomplete_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            events = [dict(kind="session", t=0, at="test", platforms=["ios"]), dict(kind="bus", t=1, route="941"),
                      dict(kind="capture", t=2, device="ios"), dict(kind="link", t=3, device="ios", message="中斷")]
            (folder/"events.jsonl").write_text("".join(json.dumps(x)+"\n" for x in events)+'{"unfinished"')
            report = write_report(folder).read_text()
            self.assertIn("iPhone：資料不足", report)
            self.assertIn("無樣本", report)
            self.assertIn("未正常結束", report)


if __name__ == "__main__":
    unittest.main()
