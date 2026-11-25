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
FAKE = r'''#!/usr/bin/env python3
import json, os, sys, time
from datetime import datetime,timezone
from pathlib import Path
args=sys.argv[1:]
trigger=Path(os.environ['TRIGGER'])
def emit_result(obj):print(json.dumps({'result':obj}))
def event(kind,**kw):
    return dict(kind=kind,at=datetime.now(timezone.utc).isoformat(),**kw)
if 'launch' in args or '--console' in args or '--terminate-existing' in args:
    sys.exit(90)
if 'devices' in args and 'list' in args:
    emit_result({'devices':[{'identifier':'phone','hardwareProperties':{'udid':'phone','marketingName':'iPhone 16e'}}]})
elif 'devices' in args: print('List of devices attached\nsample device model:S22')
elif 'apps' in args: emit_result({'apps':[{'url':'file:///Test.app'}]})
elif 'processes' in args: emit_result({'runningProcesses':[{'executable':'file:///Test.app/App','processIdentifier':12}]})
elif 'files' in args: emit_result({'files':[]})
elif 'copy' in args:
    dest=Path(args[args.index('--destination')+1])
    if 'current.json' in args[args.index('--source')+1]: dest.write_text(json.dumps({'id':'2026-11-25T12-00-00-000Z','part':0}))
    else:
        rows=[event('camera',seq=0)]
        if trigger.exists(): rows += [event('ocr',seq=1,route='941',ms=123),event('confirmed',seq=2,route='941',source='bus-crop'),event('request',seq=3,action='haptic')]
        dest.write_text(''.join(json.dumps(r)+'\n' for r in rows))
elif 'get-current-user' in args:print('0')
elif 'packages' in args:print('package:com.chessman.busvision2.recognizer')
elif 'shell' in args:print('06-01 12:00:00.000')
else:
    def log(e):print('[BusVisionField] '+json.dumps(e),flush=True)
    log(event('camera'))
    while not trigger.exists():time.sleep(.02)
    log(event('ocr',route='941',ms=123,raw='PRIVATE-CONTENT'))
    log(event('confirmed',route='932',source='auto-preview-ocr'))
    log(event('request',action='haptic'))
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
