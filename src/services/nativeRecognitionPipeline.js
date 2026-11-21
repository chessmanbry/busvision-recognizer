import { findLedRegions } from "./ledRegions.js";
import { selectNativeRoute } from "./nativeRouteSelection.js";

// All OCR boxes are returned in the original image coordinate system.
export async function runNativePipeline(
  image,
  { recognize, context, isCurrent, budgetMs = 12000 },
) {
  const started = performance.now(),
    deadline = started + budgetMs;
  let attempted = 0;
  const call = async (data) => {
    if (!isCurrent()) throw new Error("Recognition cancelled");
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Recognition time budget reached");
    let timer;
    try {
      attempted++;
      return await Promise.race([
        recognize(data),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Recognition time budget reached")),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const result = await call(image);
  if (!isCurrent()) throw new Error("Recognition cancelled");
  let selection = selectNativeRoute(
    result.lines,
    result.width,
    result.height,
    context,
  );
  if (selection.reliable) return { ...result, selection, attempted };
  const im = new Image();
  im.src = image;
  await im.decode();
  const scale = Math.min(1, 960 / im.width, 1280 / im.height),
    canvas = document.createElement("canvas");
  canvas.width = Math.round(im.width * scale);
  canvas.height = Math.round(im.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const boxes = await locateLights(pixels, canvas.width, canvas.height);
  const lines = [...result.lines];
  for (const box of boxes) {
    if (!isCurrent() || performance.now() > deadline - 200) break;
    const crop = document.createElement("canvas");
    crop.width = 600;
    crop.height = Math.max(1, Math.round((600 * box.h) / box.w));
    const cc = crop.getContext("2d", { willReadFrequently: true });
    cc.drawImage(
      im,
      box.x / scale,
      box.y / scale,
      box.w / scale,
      box.h / scale,
      0,
      0,
      crop.width,
      crop.height,
    );
    const pixels = cc.getImageData(0, 0, crop.width, crop.height);
    // Continuous red-channel contrast preserves dim LED strokes instead of a hard threshold.
    for (let i = 0; i < pixels.data.length; i += 4) {
      const r = pixels.data[i],
        g = pixels.data[i + 1],
        b = pixels.data[i + 2];
      const v = 255 - Math.min(255, Math.max(0, r - Math.max(g, b)) * 3);
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = v;
    }
    cc.putImageData(pixels, 0, 0);
    const partial = await call(crop.toDataURL("image/png"));
    for (const line of partial.lines) {
      lines.push({
        ...line,
        x:
          ((box.x + (line.x / partial.width) * box.w) / canvas.width) *
          result.width,
        y:
          ((box.y + (line.y / partial.height) * box.h) / canvas.height) *
          result.height,
        w: (((line.w / partial.width) * box.w) / canvas.width) * result.width,
        h:
          (((line.h / partial.height) * box.h) / canvas.height) * result.height,
        source: "led-contrast",
      });
    }
    selection = selectNativeRoute(lines, result.width, result.height, context);
    // Inspect all shortlisted regions, so competing readable routes remain uncertain.
  }
  return { ...result, lines, selection, attempted };
}

// Keep bright, densely connected lamps from blocking controls or camera rendering.
async function locateLights(pixels, width, height) {
  if (typeof Worker === "undefined") return findLedRegions(pixels, width, height);
  const worker = new Worker(new URL("./ledRegions.worker.js", import.meta.url), {type:"module"});
  try {
    return await new Promise(resolve => {
      const timer = setTimeout(() => resolve([]), 900);
      const finish = boxes => { clearTimeout(timer); resolve(boxes); };
      worker.onmessage = event => finish(event.data);
      worker.onerror = () => finish([]);
      worker.postMessage({pixels,width,height}, [pixels.buffer]);
    });
  } finally { worker.terminate(); }
}
