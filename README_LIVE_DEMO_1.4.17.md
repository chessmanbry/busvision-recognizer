# BusVision Recognizer 1.4.17 - Stability + Gallery Import

修正重點：

1. 拍照辨識前先停止 WebView camera stream，避免系統相機返回後 videoWidth=0 卡死。
2. 立即辨識若偵測到預覽失效，會自動重啟 App 內相機，不再直接讀 null.videoWidth。
3. 新增「匯入圖片」按鈕，可直接從相簿選原始公車照片測試，避免用手機拍電腦螢幕造成 LED 摩爾紋與 OCR 失真。
4. 加入 noisy OCR raw 過濾，降低把整片背景文字誤報成 999/534 的機率。
5. 保留 1.4.16 的診斷資料包匯出。
