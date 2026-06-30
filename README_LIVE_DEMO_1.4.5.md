# BusVision 辨識器 2.0.0.1.4.5 Live Demo 穩定版

這版以「臨時現場展示能跑」為優先，降低一開啟就卡住的機率。

## 主要調整

- 預設關閉手機端重型 COCO-SSD/TensorFlow 偵測流程，避免 WebView 啟動卡死。
- 保留目前可用的現成 OCR 技術：Tesseract.js。
- 使用手寫比例區塊演算法找車頭上方 LED、擋風玻璃號碼牌、中央車頭區。
- 新增「拍照辨識」備援：若 App 內相機不能穩定預覽，可用系統相機拍一張後回到 App OCR。
- 新增 Demo 932 / 939 / 916 按鈕：現場即使網路、相機、OCR 不穩，仍可展示中央大字、語音報讀、震動、紀錄寫入流程。
- 自動辨識改為 6.5 秒低頻率，避免手機過熱或卡頓。

## 建議現場 demo 流程

1. 打開 App → 進入即時辨識。
2. 按「啟用相機」。
3. 若有預覽，對準公車照片或螢幕上的公車車頭，按「立即辨識」。
4. 如果 App 內相機不穩，按「拍照辨識」。
5. 如果現場 OCR 沒讀到，使用 Demo 932 / 手動輸入，展示報讀與紀錄流程。

## 編譯安裝

```bash
npm install --legacy-peer-deps
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.chessman.busvision2.recognizer 1
```
