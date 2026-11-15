# BusVision 公車路線辨識器

**BusVision Bus Route Recognizer**

Android 測試版套件為 `com.chessman.busvision2.recognizer`，版本為 2.0.0-rc.33，版本碼 33。Android 從桌面開啟、從其他頁面切到「辨識」，或設定站點返回時，都會開啟後鏡頭並開始自動辨識。首次使用須允許相機權限。「暫停自動」會停止當次掃描。離開辨識頁或切到背景會釋放相機。從系統背景回到仍開著的辨識頁時，可按「自動辨識」恢復。

## 公車查詢與站點輔助

- 移除首頁，開啟即為辨識；深藍青色介面，公車掃描圖示，同步 Android 和 iOS。
- 「公車查詢」可搜尋雙北路線、選主管城市；點路線後看去程／返程及沿途站牌。資料來自官方 blobbus 與 ntpcbus 的 Route、Stop、EstimateTime，不是第三方「台北等公車」App 的私人 API；未接入車輛 GPS、票價或路線軌跡 API。
- 2026-11-14 備份索引有臺北 416、新北 637 筆去重路線，共 1,053 筆（含支線）。北大周邊依三峽校區中心 1.2 公里直線距離內有站牌篩選，共 51 條；不是熱門排名或步行距離。
- 路線與站牌在前景查詢時更新，記憶體快取最多 24 小時；預估到站每 30 秒更新。超過 2 分鐘的預估資料不顯示分鐘，離線時只保留備份路線索引。
- 每個站牌可「設為辨識站點」。手動選站後載入該實體站位行經路線，保留 30 分鐘，可在辨識頁清除；未使用 GPS 自動定位，也不把到站預估當成車輛確實出現的證明。
- 站點只核對視覺候選：不符的號碼繼續嘗試其他候選，仍不符就提示並停止報讀；絕不把 332 硬改成 932。選錯站點、臨時改道或官方漏資料可能造成拒絕正確結果，可清除站點再試。
- rc33 通過 35 項程式測試。前版 rc29 已在 S22 Ultra 驗證兩市到站資料及去返程操作。
- S22 Ultra 的 rc29 照片重播讀出 932 與 208，605 和紅2仍漏讀。三張公開照共六輪的分析耗時為 106～500 毫秒。詳細條件見 Word 報告。

## 在 VS Code 開始測試

解壓縮後，用 VS Code 開啟包含 `package.json` 的資料夾。在整合式終端機執行以下命令。建議使用 Node.js 22 以上，本次建置使用 Node.js 24。

```bash
npm ci
npm test
npm run dev
```

在電腦瀏覽器開啟 `http://localhost:5173`。瀏覽器版可測試介面、攝影機與支援的 Web 功能。手機透過區域網路連線時，相機需要 HTTPS 或受信任的安全來源。Android 原生相機、檔案分享與語音行為以實機安裝結果為準。

瀏覽器版的備援辨識首次使用會載入 COCO-SSD 及 Tesseract 資源。Android 使用隨 App 打包的原生文字辨識，公車即時到站需要網路。

## Android 編譯與安裝

需要 JDK 21、Android SDK 36 與 Android SDK Platform Tools。先用 Android Studio 開啟 `android/`，讓它建立本機的 SDK 設定，或自行建立 `android/local.properties`，內容為自己電腦上的 `sdk.dir` 路徑。

macOS 與 Linux 的建置命令如下。Windows 請將 `./gradlew` 換成 `gradlew.bat`。

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
cd ..
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

可從 GitHub Releases 下載預先建置的 Android 測試 APK。若使用附 APK 的來源壓縮檔，可直接安裝其中的 `release/app-debug.apk`。

```bash
adb install -r release/app-debug.apk
```

若手機回報簽章不同，請先匯出現有辨識紀錄並確認舊版的簽章來源，再決定更新方式。解除安裝會移除 App 內部資料。

## 附近站牌定位

Android 辨識頁左上角的「附近站牌」會要求定位權限，並使用雙北官方站牌座標找出約 120 公尺內最近的站位。按站名可更新，結果在這次開啟的 App 中保留三分鐘。座標在手機上比對，App 不上傳也不保存定位座標。

如果 GPS 無法分辨鄰近站位，畫面會提示確認方向。可靠定位只提高本站路線候選的排序，影像讀到的號碼仍需通過辨識門檻。手動選站優先。這些路線是官方站牌資料中的行經路線，實際到站預估仍在公車查詢查看。

## 辨識操作與螢幕閱讀器

「開始／暫停自動辨識」常駐。「辨識操作」可展開立即辨識、拍照、匯入圖片與辨識詳情。鍵盤可按 Enter 或空白鍵展開，接著按 Tab 順序操作。

開啟 TalkBack 或 VoiceOver 時，可關閉「App 語音報讀」，讓螢幕閱讀器讀出確認結果。自動掃描期間只通知重要事件，手動辨識沒有結果時亦會提示。放大文字時可捲動操作區。VoiceOver 仍待 iPhone 實機驗收。

## 辨識流程

Android 先使用原生 OCR 讀取整張影像，需要時再擷取最多三個 LED 區域。條件不足的候選不報讀。自動模式會等兩次一致的候選。最近 100 次分析的耗時可以從辨識紀錄匯出，原有除錯匯出可能包含使用者照片。

## 本次修正與驗證範圍

- OCR 工作程序可跨候選圖重用，逾時或離開辨識頁面時釋放資源。
- 自動辨識有候選路線後，安排較快的第二次確認，並處理停止、重新開始與過期工作的狀態。
- 清楚的 OCR 字串優先保留路線身分，避免 `307` 被紅色 LED 修正成 `397`、`F123` 遺失前綴，或 `1921` 被截成 `921`。
- 辨識紀錄共用序列化儲存服務，修正紀錄會讀取最新資料後更新，讀取或資料格式錯誤會顯示訊息。
- 版本號同步至 Android 與診斷資料，分數以規則分數呈現。

`npm test` 執行回歸測試，`npm run build` 產生正式前端資源。整個舊專案仍有既有的 ESLint 問題，因此 `npm run lint` 目前不是全部通過的驗證項目。實際速度與辨識率需要使用固定照片集和 Android／iOS 實機測試。

## 實機測試步驟

1. 先以同一批照片測試 `307`、`F123`、`1921`、`921` 與 `932`，記下實際號碼、辨識結果及失敗樣本。
2. 分別量測首次啟動及連續辨識，記錄從按下按鈕到顯示結果，以及到語音開始的時間。
3. 測試自動辨識、暫停、重新開始、切換鏡像與靜音，以及辨識中切換到紀錄頁。
4. 測試無公車、反光、逆光、夜間 LED、遠距離與多台公車，保存錯誤案例。
5. 到「辨識紀錄」匯出除錯資料包，並以人工確認路線作為評估答案。

查看辨識日誌可使用以下命令。

```bash
adb logcat -s Capacitor/Console
```

日誌中的 `BusVisionRecognizer` 記錄辨識階段與耗時。診斷資料包含影像，分享前可先檢查內容。

## 平台與未來整合

Android 與既有 iOS 專案共用 React 介面、LED 裁切、候選評分及站點比對。啟動策略由 `src/App.jsx` 傳入，平台文字辨識走 `src/services/nativeOcr.js` 的共用介面。Android 使用 ML Kit，工作區內既有的 iOS 原生端使用 Vision，前一版已完成模擬器編譯。rc33 發行包提供 Android 建置，iOS 實機及啟動策略留待後續驗證。

## 專案目錄

| 路徑 | 用途 |
| --- | --- |
| `src/components/Recorder.jsx` | 辨識入口、相機、候選區、OCR 與報讀 |
| `src/components/RecognitionLogs.jsx` | 紀錄檢視、人工修正與診斷匯出 |
| `src/services/` | 共用儲存與辨識處理服務 |
| `tests/` | 回歸測試 |
| `android/` | Android 主程式 |
| `plugins/bus-vision-native/` | 現有原生插件 |
| `release/app-debug.apk` | 本次預先編譯的 Android 測試包 |

專案壓縮檔省略 `node_modules`、本機 SDK 路徑及建置快取。請使用鎖定的 `package-lock.json` 安裝依賴。
