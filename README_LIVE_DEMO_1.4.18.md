# BusVision Recognizer 1.4.18

本版修正相簿匯入照片後卡死問題：

- 相簿匯入改用 `CameraResultType.Uri`，避免一次把原圖塞成超大 DataUrl。
- 選圖後先用 WebView 讀取 `webPath`，縮到最長邊 1600px，再進入 ROI/OCR。
- 新增 log：`gallery-import-open`、`gallery-import-picked`、`gallery-import-ready`、`gallery-import-failed`。
- 匯入流程最後會關閉 WebView 相機，避免 Camera2 與系統相簿/相機互搶造成 `videoWidth=0`。
