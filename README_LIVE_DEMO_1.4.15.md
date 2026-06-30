# BusVision 辨識器 1.4.15 - 色彩 ROI + 候選框檢查版

## 本版重點

1. 優先尋找紅色 LED 路線號碼區，例如車頭上方紅色 932。
2. 加入黑字號碼牌候選區，針對擋風玻璃內的黑字紙牌。
3. OCR 前會依候選區顏色做前處理：紅色 LED 會被轉成黑字白底，降低綠色目的地文字與背景雜訊干擾。
4. 修正直線/欄杆/反光被誤判成 111 的問題，不再把 `|` 直接當成 1。
5. 紀錄頁的「看裁切」改成候選框檢查：可以看完整畫面、結果框、全部候選框與實際 OCR 裁切圖。
6. 新增 `roi-candidates` log，方便檢查演算法到底框到哪裡。

## 建議測試流程

1. 先不開 YOLO，測試紅色 LED 932。
2. 再開 YOLO，確認 bus ROI 是否讓候選框更集中。
3. 到紀錄頁按「看裁切」，檢查結果框是否真的落在紅色 932 或擋風玻璃紙牌。

## 即時 log 命令

```bash
adb logcat -c

adb shell am force-stop com.chessman.busvision2.recognizer

adb shell monkey -p com.chessman.busvision2.recognizer 1

sleep 2

PID=$(adb shell pidof com.chessman.busvision2.recognizer | tr -d '\r')

echo "BusVision PID = $PID"

adb logcat --pid=$PID | grep -i -E "BusVisionRecognizer|roi-candidates|recognize-start|capture-video|ocr-start|ocr-done|route-candidate|yolo-predictions|timeout|reliable|route|tesseract|camera|getPhoto|error|exception|fail"
```
