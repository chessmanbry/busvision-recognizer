# BusVision Recognizer 1.4.16 - Diagnostic Export

本版將「匯出 JSON」改為「匯出除錯資料包」。匯出的 JSON 會包含：

- recognition logs
- panelBox / allCandidates / busBox 座標
- OCR raw text
- 最近 12 筆紀錄的完整 frame image base64
- 最近 12 筆紀錄的 crop image base64

用途：讓後續演算法調整時，可以直接看到辨識框內實際圖片，而不只看文字與座標。

## Build / install

```bash
cd /Users/chessman/公車辨識器/work1416
npm install --legacy-peer-deps
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.chessman.busvision2.recognizer 1
```

## Live focused log

```bash
adb logcat -c
adb shell am force-stop com.chessman.busvision2.recognizer
adb shell monkey -p com.chessman.busvision2.recognizer 1
sleep 2
PID=$(adb shell pidof com.chessman.busvision2.recognizer | tr -d '\r')
echo "BusVision PID = $PID"
adb logcat --pid=$PID | grep -i -E "BusVisionRecognizer|recognize-start|capture-video|roi-candidates|ocr-start|ocr-done|route-candidate|yolo-predictions|timeout|reliable|route|tesseract|camera|getPhoto|error|exception|fail"
```
