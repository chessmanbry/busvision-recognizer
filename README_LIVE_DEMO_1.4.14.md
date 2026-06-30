# BusVision 辨識器 1.4.14

重點：
- 偵錯/狀態面板改成可展開/收起，預設不遮取景畫面。
- 修正 g3z / Q32 / S32 等 OCR 形狀誤判，特別強化 932 類三碼公車路線。
- route-candidate log 會顯示每個 OCR raw text 回推出的 route、digitLike 計數與可靠性判斷。
- 保留 1.4.13 的文字方塊與 YOLO ROI 流程。
