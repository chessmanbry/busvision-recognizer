# BusVision 辨識器 1.4.12 OCR Fix

- 修正拍照辨識與立即辨識卡在 OCR 的問題：限制 OCR 影像尺寸、加入 9 秒 timeout。
- 直拍照片改用多條橫向 ROI，避免只切到錯誤區域。
- OCR log 會輸出 ocr-start / ocr-done 與短文字摘要，不再把整張 base64 影像刷進 log。
- 拍照辨識可靠度門檻稍微放寬，避免清楚三位數被過度保守規則擋掉。
