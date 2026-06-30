# BusVision Recognition MVP

這個版本把原本的 BusVision 採集工具升級成「即時公車號碼辨識 + 辨識紀錄資料庫」。

## 新增重點

1. 即時辨識頁
   - 啟動相機後自動低頻抓圖。
   - COCO-SSD 現成模型先找 bus / truck / car。
   - 找到車輛 ROI 後，用傳統影像處理演算法找 LED / 紙牌號碼候選區。
   - Top-K 候選區交給 Tesseract OCR。
   - 多幀投票穩定結果。
   - 畫面中央大字顯示路線號碼。
   - 信心足夠時 TTS 報讀與震動。

2. 辨識資料庫
   - 每次穩定辨識會寫入 `BusData/recognition_logs.json`。
   - 儲存 frame 截圖、號碼牌 crop、OCR 原文、信心分數、bus box、panel box、GPS。
   - 支援搜尋、修正、看裁切圖、匯出 JSON。

3. 原生相機插件補強
   - 新增 `BusVisionNative.takePhoto()`。
   - Android 原生 CameraX preview 可定時拍照給前端辨識。

## 執行命令

```bash
npm install --legacy-peer-deps
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.chessman.busvision2 1
```

## 注意事項

- 本環境已成功完成 `npm run build` 與 `npx cap sync android`。
- 由於目前沙盒無法連線下載 Gradle distribution，`./gradlew assembleDebug` 無法在沙盒內完成；在你的 Mac 上有網路時可正常下載 Gradle 後編譯。
- 第一版使用 Tesseract OCR，LED 點陣、夜間過曝與遠距模糊仍可能失準；但每次辨識都會留下 crop 與修正資料，方便後續訓練專用模型。
