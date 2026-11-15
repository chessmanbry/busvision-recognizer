# iOS 測試版 2.0.0 rc 28

本版沿用 rc26 的完整 iOS App 專案，新增雙北公車查詢及站點輔助辨識、共用介面與圖示更新，以及 OCR 尺寸及等待預算修正。這是供開發及實機驗證的版本，尚未發佈至 App Store 或 TestFlight。iOS 顯示版本為 `2.0.0`、build `28`；原始碼及診斷版本為 `2.0.0-rc.28`。

## 在 VS Code 修改並用 Xcode 執行

需要 Mac、Node.js 22 以上、Xcode 26 以上，以及首次解析 Swift 套件所需的網路。本次開發環境為 Xcode 27。最低部署版本設定為 iOS 15；不能據此推定所有 iOS 15 以上手機均已測試。

1. 用 VS Code 開啟解壓縮後含 `package.json` 的資料夾。
2. 在終端機執行：

```bash
npm ci
npm run ios:sync
npm run ios:open
```

3. Xcode 開啟 `ios/App/App.xcodeproj`，等待 Swift Package Manager 完成解析，選擇 `App` scheme。
4. 選擇 iPhone 模擬器並按 Run，可先測試啟動及介面。模擬器不能代表真實相機、震動或效能。
5. 使用實機時，連接並信任 iPhone，依系統提示開啟 Developer Mode；在 App target 的 Signing & Capabilities 選擇自己的開發 Team，再選 iPhone 執行。專案未填入任何人的 Team 或憑證。

VS Code 用於修改來源；iOS 安裝仍由 Mac 上的 Xcode 和 Apple 簽章完成。若自己的 Team 無法使用現有 Bundle Identifier，可在 Xcode 改成自己可用的唯一識別碼；這會成為不同 App，不會繼承舊安裝的紀錄。對應的 `capacitor.config.json` appId 也應一併維護。

每次修改前端後重新執行 `npm run ios:sync`，再於 Xcode Run。只重新開啟 Xcode 不會更新打包的網頁。

## 本版適配內容

- 新增 iOS App target、Swift Package Manager 相依關係及 `Package.resolved`。
- 對齊 Capacitor iOS 與 core 8.4.0；語音套件升級為相容 Capacitor 8 的 8.0.2。
- 加入繁體中文相機、相簿讀取及相簿新增用途說明。當前拍照設定不自動存入系統相簿。
- 加入 `PrivacyInfo.xcprivacy` 並納入 App Resources，宣告檔案時間戳 C617.1、UserDefaults CA92.1；無追蹤。這份清單不等於完成 App Store 隱私審查，未來接 API、遙測或上傳照片時須重新檢查。
- 使用 WKWebView 預覽與原生 Camera 拍照／選圖；照片模式限制分析照片尺寸，降低大照片的記憶體壓力。
- 直向操作與 iPhone 安全區域布局；iPad 設定全螢幕直向，尚未驗證 iPad 實機。
- 切到背景或鎖屏時停止即時掃描、關閉預覽並停止語音。回到前景後需再次按「立即辨識」或「自動辨識」，避免自動報讀舊畫面。系統照片選取返回後仍會處理所選照片。
- 紀錄沿用 App 私有儲存區；匯出經系統分享介面。原生自訂插件目前只有 echo，未把它宣稱為 Core ML 辨識器。

## 首輪 iPhone 驗收

2026 年 11 月 12 日已完成：11 項 Node 回歸測試、前端建置、Android APK 建置、iOS 模擬器 arm64／x86_64 建置及 iPhone arm64 無簽章編譯。已在 iPhone 17 Pro／iOS 26.5 模擬器安裝、啟動並確認首頁與底部導覽顯示。相機、OCR、語音、保存及分享尚未做完整 iPhone 實機驗收；無簽章編譯成功不代表已產生可直接安裝的 IPA。

先保留網路連線：Tesseract 與 COCO-SSD 首次使用仍需下載資源，尚未完成離線資源打包。

| 情境 | 驗收方式 |
| --- | --- |
| 立即辨識 | 同意相機權限，確認後鏡頭預覽不全螢幕跳出、不鏡像錯位，能顯示結果。 |
| 拍照辨識 | 拍攝公車，確認回 App 後能辨識；取消拍照後可再啟動預覽。 |
| 匯入圖片 | 測試 JPEG、HEIC、橫拍及直拍圖片；確認旋轉方向、框位置與文字。 |
| 自動辨識 | 確認兩次相同候選才報讀；暫停、鎖屏、切 App 後不再報讀舊結果。 |
| 語音與靜音 | 測試繁體中文語音、靜音切換、耳機及系統靜音開關；記下實際行為。 |
| 紀錄 | 保存後重開 App，檢視原圖及裁切，修改路線並匯出到「檔案」。 |
| 權限拒絕 | 拒絕相機後應顯示失敗資訊；到 iOS 設定允許後重新進入並重試。 |
| 效能 | 用同一批照片分別量冷啟動、熱機、顯示及語音延遲；連續操作 10 分鐘觀察熱度與記憶體。 |

iOS 適配並未更換辨識模型，不能由建置成功推定辨識速度或正確率改善。rc27 已接入大臺北公車官方 NTPC 開放到站資料；不需要 TDX 金鑰。自訓模型及原生 Core ML 推論仍是後續工作。

2026 年 11 月 14 日 rc28 已完成 iOS Simulator 無簽章建置。新介面與到站查詢只在 S22 Ultra 完成實機驗證，iPhone 的 HTTPS 原生資料解壓、相機、OCR 與語音仍須實機驗收。

## 官方參考

- [Capacitor iOS](https://capacitorjs.com/docs/ios)
- [Swift Package Manager](https://capacitorjs.com/docs/ios/spm)
- [Camera 權限](https://capacitorjs.com/docs/apis/camera)
- [Filesystem 隱私清單](https://capacitorjs.com/docs/apis/filesystem)
- [Preferences 隱私清單](https://capacitorjs.com/docs/apis/preferences)
