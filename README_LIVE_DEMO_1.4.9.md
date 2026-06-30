# BusVision 辨識器 1.4.9

立即辨識改為優先使用 Android 原生 CameraX 靜默截圖，再進行 OCR/YOLO 流程；若原生截圖失敗，才退回 WebView video 擷取。畫面內加入簡易偵錯訊息，不必只靠 logcat。
