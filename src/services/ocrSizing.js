export function getOcrDimensions(width, height, maxSide = 1280) {
  if (![width, height, maxSide].every(v => Number.isFinite(v) && v >= 1)) throw new RangeError('Invalid OCR dimensions');
  const scale = Math.min(width < 520 ? 2 : 1.35, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
