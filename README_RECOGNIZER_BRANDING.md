# BusVision 辨識器 branding update

本版已與原本採集器分離：

- Android applicationId: `com.chessman.busvision2.recognizer`
- 手機顯示名稱: `BusVision 辨識器`
- 可與原本 `com.chessman.busvision2` 採集器同時安裝，不互相覆蓋。
- 圖示已改成 Q 版女僕頭像。
- Splash 啟動畫面改成輕量女僕插圖，並將 Capacitor SplashScreen 顯示時間壓低到 350ms。

建議安裝命令：

```bash
npm install --legacy-peer-deps
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell monkey -p com.chessman.busvision2.recognizer 1
```
