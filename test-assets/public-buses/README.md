# 公開公車照片測試集

這三張照片供固定輸入的速度與失敗案例回歸，不代表真實乘車場景的整體辨識率。皆為 Wikimedia Commons 原始檔案，未修改；各檔案 SHA-256、尺寸、下載位置與來源見 manifest.json。照片不隨 APK 載入，只放在開發測試資料夾。

| 檔案 | 車頭路線標記 | 作者 | 授權及來源 |
| --- | --- | --- | --- |
| route-605.jpg | 605（LED 掃描造成局部缺筆） | Rico Shen | [來源](https://commons.wikimedia.org/wiki/File:CSBus605_528FL_Front.jpg) · CC BY-SA 3.0 |
| route-208.jpg | 208 | Sap32aaa | [來源](https://commons.wikimedia.org/wiki/File:CSGB-CNBus_208_533FL_Front.jpg) · CC BY-SA 3.0 |
| route-red2.jpg | 紅2 | Sap32aaa；來源標示 Rico Shen 修正浮水印 | [來源](https://commons.wikimedia.org/wiki/File:CSGB-GHBus_R2_687AD_Front.jpg) · CC BY-SA 3.0 |

授權：[Creative Commons 姓名標示 相同方式分享 3.0](https://creativecommons.org/licenses/by-sa/3.0/)。散布照片時請一併保留作者、來源、授權；若修改照片，標示改動並以相容的相同方式分享授權散布。應用程式程式碼的授權不因獨立收錄這些照片而被本文件改變。

預期路線是助理直接觀看目的地顯示器的初步標註，尚未經第二人獨立複核。照片為舊車、日間、靜態與偏正面，缺少夜間、雨天、遠距離、現代 LED 和移動模糊。

在手機保持解鎖及 App 前景時執行：

```
node scripts/benchmark-public-buses.mjs 手機序號
```

每張測兩輪，經正式匯入影像與辨識流程；測試暫時替換原生選圖輸入，攔截檔案寫入及語音，停用站點輔助以量測純視覺辨識。結束還原並重載 App。若強制終止，重新啟動 App。報告在 test-results/iteration-rc28/public-photo-benchmark.json；只有 3 張圖，不能將少量命中率當產品正確率。
