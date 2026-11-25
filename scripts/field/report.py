"""Local, reproducible reports from an append-only BusVision timeline."""
import json
import math
from datetime import datetime
import re

PLATFORMS = {"ios": "iPhone", "android": "Android"}
LABEL = re.compile(r"[A-Za-z0-9\u3400-\u9fff（）()－-]{1,20}")
SCANS = {"ocr", "confirmed"}
NATIVE = {
    ("BusVisionNative", "startZoomCamera"): "camera_start",
    ("BusVisionNative", "stopZoomCamera"): "camera_stop",
    ("BusVisionNative", "setCameraRatio"): "zoom",
    ("BusVisionNative", "recognizeText"): "ocr_request",
    ("TextToSpeech", "speak"): "speech",
    ("Haptics", "impact"): "haptic",
    ("Geolocation", "getCurrentPosition"): "location",
}
IOS_CALL = re.compile(r"To Native ->\s+(\w+) (\w+) \d+")
ANDROID_CALL = re.compile(r"To native \(Capacitor plugin\): callbackId: [^,]+, pluginId: (\w+), methodName: (\w+)")


def field_row(data):
    if data.get("kind") not in ("capture","camera","confirmed","ocr","request","problem","no_result","bus_entry","session_start","session_stop"):
        return None
    result = {"kind":data["kind"]}
    for k in ("source","stage","action","direction","at","route"):
        if isinstance(data.get(k),str):
            result["phoneAt" if k=="at" else k] = data[k][:80]
    for k in ("ms","width","height","capturedAt"):
        if type(data.get(k)) in (int,float):
            result[k] = data[k]
    if isinstance(data.get("candidates"),list):
        result["candidates"] = [x for x in data["candidates"][:12] if isinstance(x,str) and LABEL.fullmatch(x)]
    if data["kind"]=="request" and data.get("action") in ("speech","screen_reader"):
        result["text"] = str(data.get("text",""))[:80]
    return result


def parse_console(line):
    if "[BusVisionField] " in line:
        try:
            data,_ = json.JSONDecoder().raw_decode(line.split("[BusVisionField] ",1)[1].strip())
            return field_row(data)
        except (TypeError,ValueError):
            return None
    marker = "[BusVisionRecognizer] "
    if marker not in line:
        call = IOS_CALL.search(line) or ANDROID_CALL.search(line)
        action = NATIVE.get(call.groups()) if call else None
        return {"kind": "request", "action": action} if action else None
    label, _, raw = line.partition(marker)[2].strip().partition(" ")
    errors = {"native-camera-fallback", "native-ocr-failed", "detect-once-failed",
              "vehicle-model-failed", "vehicle-prediction-failed", "recognize-save-failed"}
    if label in errors:
        return {"kind": "ocr_error" if label == "native-ocr-failed" else "problem", "stage": label}
    if label not in {"native-ocr-result", "recognize-result", "camera-started", "capture-video"}:
        return None
    try:
        data, _ = json.JSONDecoder().raw_decode(raw.lstrip())
        if not isinstance(data, dict):
            return None
    except ValueError:
        # Phone consoles can truncate a long OCR line before the selected route.
        # Extract only the numeric timing before the OCR text array.
        if label != "native-ocr-result":
            return None
        ms = re.match(r'\s*\{"engine":"(?:apple-vision|mlkit-chinese)","elapsedMs":(\d+)\b', raw)
        return {"kind": "ocr", "partialLog": True, **({"ms": int(ms[1])} if ms else {})}
    event = {"kind": {"native-ocr-result": "ocr", "recognize-result": "confirmed",
                      "camera-started": "camera", "capture-video": "capture"}[label]}
    for key, new in [("elapsedMs", "ms"), ("videoWidth", "width"), ("videoHeight", "height")]:
        value = data.get(key)
        if type(value) in (int, float) and math.isfinite(value) and value >= 0:
            event[new] = round(value)
    if data.get("engine") in ("apple-vision", "mlkit-chinese"):
        event["engine"] = data["engine"]
    route = data.get("route" if label == "recognize-result" else "selected")
    if isinstance(route, str) and LABEL.fullmatch(route):
        event["route"] = route.upper()
    if type(data.get("reliable")) is bool:
        event["reliable"] = data["reliable"]
    if label == "recognize-result":
        event["source"] = data.get("source") if data.get("source") in (
            "auto-preview-ocr", "preview-ocr", "photo", "gallery") else "other"
    return event


def percentile(values, p):
    return sorted(values)[math.ceil(len(values) * p) - 1] if values else None


def read_events(folder):
    rows = []
    with (folder / "events.jsonl").open() as src:
        for line in src:
            try:
                rows.append(json.loads(line))
            except ValueError:
                if line.endswith("\n"):
                    raise
                # A power loss may interrupt the last append.
    return rows


def write_report(folder):
    events = read_events(folder)
    if not events or events[0]["kind"] != "session":
        raise ValueError("無有效的外測紀錄")
    platforms = events[0]["platforms"]
    lines = ["# BusVision 外測報告", "", f"開始時間 {events[0]['at']}",
             f"。記錄長度 {events[-1]['t']:.1f} 秒。"
             + ("已正常結束。" if events[-1]["kind"] == "stop" else "由未正常結束的紀錄重建。"),
             "", "| 手機 | 相機取像次數 | OCR 回傳次數 | OCR 耗時 P50 / P90 | 自動確認次數 | 錯誤或降級事件 |",
             "|---|---:|---:|---|---:|---:|"]
    def confirmed(e):
        return e["kind"] == "confirmed" and e.get("source") in ("auto-preview-ocr","bus-crop") and e.get("route")
    for p in platforms:
        own = [e for e in events if e.get("device") == p]
        times = [e["ms"] for e in own if e["kind"] == "ocr" and "ms" in e]
        timing = f"{percentile(times, .5)} / {percentile(times, .9)} ms（{len(times)} 筆）" if times else "無樣本"
        lines.append(f"| {PLATFORMS[p]} | {sum(e['kind']=='capture' for e in own)} | {sum(e['kind']=='ocr' for e in own)} | {timing} | {sum(bool(confirmed(e)) for e in own)} | {sum(e['kind'] in ('ocr_error','problem') for e in own)} |")
    lines += ["", "| 手機 | 原生 OCR 請求 | 變焦請求 | 報讀請求 | 震動請求 |",
              "|---|---:|---:|---:|---:|"]
    for p in platforms:
        requests = [e["action"] for e in events if e.get("device") == p and e["kind"] == "request"]
        counts = " | ".join(str(requests.count(k)) for k in ("ocr_request", "zoom", "speech", "haptic"))
        lines.append(f"| {PLATFORMS[p]} | {counts} |")
    lines += ["", "表內僅統計收到的事件。兩支手機的引擎不同，請用相同車次比較。", "", "## 人工標記的車次", "", "計時從操作員標記進入視野開始。新版使用手機事件時間，舊版使用 Mac 接收時間。報讀是否實際出聲可用 note 註記。兩車重疊時請在備註說明，這裡只比較測試區間內的路線。", ""]
    windows = []
    current = None
    # Use the phone event time for buffered USB delivery. Both phones and the Mac
    # must have automatic time enabled. Historical records retain receive time.
    timeline = []
    for row in events:
        e = dict(row)
        if e.get("phoneAt"):
            try:
                received = datetime.fromisoformat(e["at"])
                captured = datetime.fromisoformat(e["phoneAt"].replace("Z","+00:00"))
                e["t"] += (captured-received).total_seconds()
            except ValueError:
                pass
        timeline.append(e)
    for e in sorted(timeline,key=lambda row:row["t"]):
        if e["kind"] == "bus":
            current = [e]
            windows.append(current)
        elif current is not None:
            current.append(e)
            if e["kind"] == "end":
                current = None
    for window in windows:
        bus = window[0]
        lines += [f"### {bus['route']} {bus.get('direction','')}（第 {bus['t']:.1f} 秒）", ""]
        for p in platforms:
            observed = [e for e in window if e.get("device") == p]
            scans = [e["t"] for e in observed if e["kind"] in SCANS]
            edge = [bus["t"], *scans, window[-1]["t"]]
            gap = (not scans or window[-1]["kind"] != "end" or
                   any(e["kind"] == "link" for e in observed) or
                   any(b-a > 10 for a, b in zip(edge, edge[1:])))
            decisions = [e for e in observed if confirmed(e)]
            same = next((e for e in decisions if e["route"] == bus["route"]), None)
            other = list(dict.fromkeys(e["route"] for e in decisions if e["route"] != bus["route"]))
            result = (f"首次確認 {same['t']-bus['t']:.1f} 秒" if same else
                      "資料不足" if gap else "期間未收到此路線的自動確認")
            candidate = next((e for e in observed if e["kind"] == "ocr" and (e.get("route") == bus["route"] or bus["route"] in e.get("candidates",[]))), None)
            if same:
                if bus.get("direction"):
                    actual = same.get("direction") or "待確認"
                    result += f"，相機方向 {actual}，人工方向 {bus['direction']}"
                spoken = next((e for e in observed if e["t"]>=same["t"] and e["kind"]=="request"
                               and e.get("action") in ("speech","screen_reader")
                               and re.search(r"(?<![A-Za-z0-9])"+re.escape(bus["route"])+r"(?![A-Za-z0-9])", e.get("text",""))),None)
                if spoken:
                    result += f"，首次正確報號請求 {spoken['t']-bus['t']:.1f} 秒"
            if candidate:
                result += f"，首次出現候選 {candidate['t']-bus['t']:.1f} 秒"
            if same and gap:
                result += "（區間資料不完整）"
            if other:
                result += f"，也確認了 {'、'.join(other)}"
            lines.append(f"- {PLATFORMS[p]}：{result}")
        lines.append("")
    if not windows:
        lines += ["未標記車次，無法評估每車辨識結果。", ""]
    lines += ["## 裝置狀態與現場備註", ""]
    for e in events:
        if e["kind"] in ("link", "note", "problem", "ocr_error","process","system_report","diagnostic"):
            lines.append(f"- {e['t']:.1f}s {PLATFORMS.get(e.get('device'), '現場')}　{e.get('message', e.get('stage',e.get('pid',e.get('name',''))))}")
    lines += ["", "逐筆時間、候選號碼、判定與取像尺寸見 events.jsonl。手機主辨識流程以外的候車提醒、震動和語音可能另行觸發。每次確認可重複，次數不能直接當成正確車數。"]
    target = folder / "report.md"
    temp = folder / "report.md.tmp"
    temp.write_text("\n".join(lines) + "\n")
    temp.replace(target)
    return target
