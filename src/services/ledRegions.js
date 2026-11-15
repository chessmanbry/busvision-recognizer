// Locate connected red/amber LED strokes; no route-specific templates or digit substitutions.
export function findLedRegions(d, W, H) {
  const mask = new Uint8Array(W * H),
    dil = new Uint8Array(W * H),
    seen = new Uint8Array(W * H),
    found = [];
  for (let y = 1; y < H * 0.7; y++)
    for (let x = 1; x < W - 1; x++) {
      let i = (y * W + x) * 4;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      if (r > 110 && r > g * 1.4 && r > b * 1.2 && r - g > 35) {
        mask[y * W + x] = 1;
        for (let yy = Math.max(0, y - 2); yy <= Math.min(H - 1, y + 2); yy++)
          for (let xx = Math.max(0, x - 2); xx <= Math.min(W - 1, x + 2); xx++)
            dil[yy * W + xx] = 1;
      }
    }
  for (let i = 0; i < dil.length; i++) {
    if (!dil[i] || seen[i]) continue;
    let stack = [i],
      minX = W,
      minY = H,
      maxX = 0,
      maxY = 0,
      n = 0;
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop(),
        x = p % W,
        y = Math.floor(p / W);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      n += mask[p];
      for (const q of [p - 1, p + 1, p - W, p + W])
        if (
          q >= 0 &&
          q < dil.length &&
          !seen[q] &&
          dil[q] &&
          Math.abs((q % W) - x) <= 1
        ) {
          seen[q] = 1;
          stack.push(q);
        }
    }
    const w = maxX - minX + 1,
      h = maxY - minY + 1,
      density = n / (w * h);
    if (
      w >= 6 &&
      h >= 10 &&
      h < H * 0.18 &&
      w / h > 0.12 &&
      w / h < 8 &&
      density > 0.06 &&
      density < 0.7
    )
      found.push({ x: minX, y: minY, w, h, n });
  }
  found.sort((a, b) => a.x - b.x);
  const groups = [];
  for (const a of found) {
    let g = groups.find(
      (b) =>
        Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) < Math.max(a.h, b.h) * 0.45 &&
        a.x - (b.x + b.w) < Math.max(a.h, b.h) * 1.1 &&
        Math.max(a.h, b.h) / Math.min(a.h, b.h) < 2,
    );
    if (g) {
      let right = Math.max(g.x + g.w, a.x + a.w),
        bottom = Math.max(g.y + g.h, a.y + a.h);
      g.x = Math.min(g.x, a.x);
      g.y = Math.min(g.y, a.y);
      g.w = right - g.x;
      g.h = bottom - g.y;
      g.n += a.n;
    } else groups.push({ ...a });
  }
  return groups
    .filter((a) => a.w / a.h > 0.5 && a.w / a.h < 8)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((a) => {
      const x = Math.max(0, a.x - 8),
        y = Math.max(0, a.y - 8);
      return {
        x,
        y,
        w: Math.min(W - x, a.w + 16),
        h: Math.min(H - y, a.h + 16),
      };
    });
}
