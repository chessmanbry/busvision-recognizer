# BusVision 辨識器 1.4.7

修正即時辨識視差：擷取 CSS cover 後使用者實際看到的畫面。新增可手動載入的 YOLO/COCO-SSD 公車偵測，找到 bus/truck/car 後只在車輛 ROI 裡跑 OCR；找不到公車時退回中央區域 OCR。
