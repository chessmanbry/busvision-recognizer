# Android 實機測試腳本

使用 Node.js 22 以上及 Android SDK platform-tools。手機解鎖、允許 USB 偵錯並裝好 BusVision debug APK。腳本會自動選擇唯一已授權裝置；多支裝置請加 `--serial`。若找不到 adb，設定 `ADB` 為它的完整路徑。

基本檢查：

```bash
npm run test:android -- --expect-auto-start
```

會重新啟動 App、檢查公車查詢及辨識紀錄、切換並還原靜音與鏡像，最後留在辨識頁。加上 --expect-auto-start 時也會驗證冷啟動、從其他頁面切回及設定站點後是否開啟相機並完成一輪辨識，以及切到系統背景時是否釋放相機。請不要在正在保存或匯出時執行。腳本不清空資料、不修改路線、不匯出照片，也不自動授予權限。紀錄頁只檢查載入是否成功，不把紀錄內容寫入報告。

手動辨識測速：

```bash
npm run test:android -- --observe 60
```

這個模式不重新啟動 App，也不點按控制項；會將 App 帶到前景。看到「開始觀察」後，請自行用固定公車照片操作。可將 60 改成 1–600 秒。測試時保持解鎖，不要拔線。系統拍照或選圖返回後仍可繼續記錄。超過設定時間才回到 App 的辨識結果可能不在報告內。

輸出在 `test-results/android-時間/`：

- `report.md`：基本檢查、啟動時間與限制。
- `report.json`：App 版本、裝置型號、檢查結果、辨識階段事件、每輪耗時及中位數。事件可能包含 OCR 文字與路線號碼，分享前請檢查；不含照片。

`androidActivityStartMs` 是 Android Activity 的啟動量測，不是畫面完全可互動或 OCR 延遲。`recognitionSamples` 的 `elapsedMs` 是影像分析流程，不包含選圖等待、保存及實際語音開始。沒有辨識事件時中位數是 null，不能解讀成 0 ms。主行程 PSS 不含獨立 WebView renderer；單次快照不能證明沒有記憶體洩漏。

基本模式成功只表示操作檢查通過，不代表相機、照片匯入、OCR 正確率、原生語音與所有崩潰情況都已驗證。JavaScript 例外檢查涵蓋連上除錯器之後；未檢測全部原生或 WebView 子行程錯誤。需要固定真值圖片集與長時間測試才能做效能及準確率結論。

腳本只連線到指定 App 的 localhost WebView，完成或失敗時會移除它建立的 adb forwarding，不修改永久偵錯設定。

## rc27 新增測試

基本測試現在檢查直接進入辨識、雙北搜尋及三峽校區周邊路線、兩市官方資料新鮮度、去返程實際站序、站點輔助及畫面寬度，並保存 App 截圖。預設不讀取照片。

`node scripts/replay-android-recognition.mjs SERIAL --frame` 讀取 App 內最近一筆記錄為 932 的相簿來源原圖，透過暫時替換選圖回傳值，執行兩次實際辨識管線。測試期間請保持 App 前景並勿操作；照片只在記憶體內，不匯出，檔案寫入及語音在測試期間攔截，結束恢復並重載 App。這不是原生選圖、保存或報讀的完整端到端驗收。若強制中斷測試，請關閉再開 App 以清除記憶體內攔截。移除 --frame 則測既有裁切圖，屬特殊輸入壓力案例。

`node scripts/benchmark-android-ocr.mjs SERIAL 2` 比較 6 筆既有裁切照片的舊版／新版前處理與 OCR。第二輪反轉順序；資料可能重複且缺乏人工真值，不能推算正確率或完整操作延遲。腳本與 rc27 Vite 產物格式相依。

公開照片固定測試：`node scripts/benchmark-public-buses.mjs SERIAL`，照片授權與限制見 `test-assets/public-buses/README.md`。
