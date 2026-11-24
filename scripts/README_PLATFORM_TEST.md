# 雙平台測試入口

Node.js 22 以上、已安裝 npm 相依套件。執行 `npm run test:platforms -- --platform both` 會跑 46 項共用單元測試、前端建置、Capacitor Android/iOS 同步、Android debug APK 編譯及 iOS Simulator 無簽章編譯。可用 `--platform android` 或 `--platform ios` 縮小範圍。每一步的日誌獨立保存，終端機只顯示結果與耗時；`test-results/platforms-時間/report.md` 和 `report.json` 提供摘要。

Android 實機連線、解鎖並已裝 debug APK 後，使用 `npm run test:platforms -- --platform android --android-device`；多支裝置再加 `--serial 序號`。此模式沿用既有 Android 操作檢查，不測照片真值辨識率。Android 腳本會暫時切換介面與設定並還原，詳細限制見 `README_ANDROID_TEST.md`。

iPhone 16e 實機：使用 `xcrun xctrace list devices` 確認 UDID，Xcode 中完成 Team 簽章設定後，執行 `npm run test:platforms -- --platform ios --ios-device --udid UDID`。目前腳本會針對該裝置編譯並驗證簽章，**尚未自動安裝、啟動、操作相機或判定 OCR 正確率**；這些需要 iOS App 完成原生橋接後接入同一報告格式。不能將 iOS 編譯通過當作實機驗收。

不要提交 `test-results`。這些報告可能包含裝置資訊或 Android 辨識事件。
