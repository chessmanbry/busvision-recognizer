function preprocessForOcr(src, label = '') {
  const maxSide = OCR_MAX_SIDE;
  const shrink = Math.min(1, maxSide / Math.max(src.width, src.height));
  const scale = Math.max(1, shrink * (src.width < 520 ? 2.0 : 1.35));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(src.width * scale));
  c.height = Math.max(1, Math.floor(src.height * scale));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let sum = 0, redCount = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
    if (r > 100 && r > g * 1.25 && r > b * 1.15 && r - g > 30) redCount += 1;
  }
  const totalPx = Math.max(1, d.length / 4);
  const redMode = /紅色|LED/.test(label) || redCount / totalPx > 0.018;
  if (redMode) {
    const mask = new Uint8Array(totalPx);
    for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      mask[p] = (r > 92 && r > g * 1.18 && r > b * 1.12 && r - g > 24) ? 1 : 0;
    }
    // 對 LED 點陣做小幅膨脹，讓 Tesseract 看到較連續的筆畫。
    const dilated = new Uint8Array(totalPx);
    for (let y = 1; y < c.height - 1; y += 1) {
      for (let x = 1; x < c.width - 1; x += 1) {
        const p = y * c.width + x;
        if (mask[p] || mask[p - 1] || mask[p + 1] || mask[p - c.width] || mask[p + c.width]) dilated[p] = 1;
      }
    }
    for (let i = 0, p = 0; i < d.length; i += 4, p += 1) {
      const v = dilated[p] ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  const mean = sum / totalPx;
  const threshold = clamp(mean * 0.92 + 28, 80, 190);
  for (let i = 0; i < d.length; i += 4) {
    const g0 = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // 對黑字紙牌與普通號碼牌做強對比，但保留灰階，不做純二值化，避免字邊破碎。
    let g = clamp((g0 - threshold) * 2.25 + 158, 0, 255);
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
