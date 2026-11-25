# BusVision 雙手機外測記錄器

在 Mac 使用 Python 3、Android SDK platform-tools 與 Xcode 的 devicectl，配合 Android rc.39 和 iOS build 40 的開發版。記錄和報告只存於 Mac。出發前接好 USB 資料線、解鎖兩支手機、允許 USB 偵錯或信任電腦，並讓 Mac 保持開蓋。兩支手機盡量對著同一台車。

```sh
cd "/Users/chessman/Documents/ChatGPT/bus-vision2.0"
python3 scripts/field/record.py
```

開始前可加 `--check` 單獨檢查裝置。若當天只有一支，加 `--platform ios` 或 `--platform android`。若同平台接了多支，指定 `--serial` 或 `--udid`。若 adb 在其他位置，可設定環境變數 ADB。

開始收錄時記錄器會將 Android 帶到前景，並重新啟動 iPhone 上的 BusVision 以取得主控台。先等兩台各自顯示「正在收錄」，再確認 status 都有近期取像或 OCR 事件。每 15 秒會顯示上一次收到事件距今多久。斷線時仍保存另一支的資料，會等待原手機重新連上。重接 iPhone 時會再啟動 App。請讓兩台都停在辨識頁；結束記錄後，iOS 開發工具可能也會關閉 App。

| 何時 | 在終端機輸入並按 Enter |
|---|---|
| 已知路線的車進入視野 | `941` 或 `藍46` |
| 該車離開 | `end` |
| 記下當時狀況或人工聽見的結果 | `note 逆光，第二台車遮住 941，iPhone 沒唸出來` |
| 查兩台是否仍在送資料 | `status` |
| 完成整趟測試 | `q` 或 Ctrl+C |

請依現場實際車號標記，起點愈準，首次確認時間愈有參考價值。每次只追一台車。目標車號稍後才清楚或兩車同時進站時，用 note 記下，分析時可排除這段計時。

每場會建立 `test-results/field/日期-時間/`。逐筆資料寫進 `events.jsonl`，停止後同一資料夾會有 `report.md`。若終端機意外關閉，執行 `python3 scripts/field/record.py --report "該場資料夾路徑"` 重建。回到同一台 Mac 的專案對話，只要說「分析最近一次外測」，即可從這個位置讀取。若改用另一台電腦，請提供該場的 report.md 和 events.jsonl。

時間戳採 Mac 接收時間，包含 USB 與日誌傳輸延遲。每車結果取人工區間內主流程的自動確認，手動辨識另記。若缺乏 OCR 證據、區間未結束、重接或出現超過 10 秒的資料空白，會註明資料不足或不完整。候選號碼、確認號碼和報讀請求是不同事件。候車追蹤或螢幕閱讀器另行發出的提醒應用 note 註記。沒有標記車次時只統計效能和事件數量。事件欄位採允許清單，會略過照片、原始 OCR 文字、定位座標與裝置序號。現場備註依照你輸入的內容保存。
