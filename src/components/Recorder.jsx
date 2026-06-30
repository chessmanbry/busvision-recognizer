import React, { useEffect, useRef, useState } from 'react';
import '@tensorflow/tfjs-backend-webgl';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { registerPlugin } from '@capacitor/core';

const BusVisionNative = registerPlugin('BusVisionNative');

const FOLDER_NAME = 'BusData';
const LOG_FILE = `${FOLDER_NAME}/recognition_logs.json`;
const AUTO_INTERVAL_MS = 6500;
const YOLO_MIN_BUS_SCORE = 0.38;
const MIN_ROUTE_CROP_W = 72;
const MIN_ROUTE_CROP_H = 24;
const OCR_TIMEOUT_MS = 9000;
const OCR_MAX_SIDE = 1280;
const RAW_NOISE_DIGITLIKE_LIMIT = 38;
const RAW_NOISE_LENGTH_LIMIT = 140;
const RED_ROUTE_LABEL = '紅色LED路線';

function nowText() { return new Date().toLocaleString('zh-TW', { hour12: false }); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dataUrlToBase64(dataUrl) { return String(dataUrl).split(',')[1] || ''; }

function routeNormalizationVariants(text) {
  const raw = String(text || '').replace(/\s+/g, '').replace(/Ｆ/g, 'F');
  const base = raw
    .replace(/[Il!]/g, '1')
    .replace(/[Zz]/g, '2')
    .replace(/[Bb]/g, '8')
    .replace(/[Oo]/g, '0');
  const variants = new Set();
  const qChoices = [base.replace(/[Qq]/g, '0'), base.replace(/[Qq]/g, '9')];
  for (const qv of qChoices) {
    variants.add(qv.replace(/[g]/g, '9').replace(/[Ss]/g, '5'));
    variants.add(qv.replace(/[g]/g, '9').replace(/[Ss]/g, '9'));
    variants.add(qv.replace(/[G]/g, '6').replace(/[Ss]/g, '5'));
    // 三碼路線常見的首字 9 會被認成 S/g/q；保留一個激進版本，主要處理 932 → g3z / S32。
    variants.add(qv.replace(/[gGqQSs]/g, '9'));
  }
  return [...variants];
}

function digitLikeCount(text) {
  return (routeNormalizationVariants(text).join('').match(/\d/g) || []).length;
}

function normalizeRouteText(text) {
  if (!text) return '';
  const matches = [];
  for (const normalized of routeNormalizationVariants(text)) {
    for (const m of (normalized.match(/(?:藍|紅|綠|棕|橘)?[Ff]?\d{2,4}(?:副|區間|區|幹線)?/g) || [])) {
      matches.push(m.toUpperCase());
    }
  }
  if (!matches.length) return '';
  const rawCompact = String(text || '').replace(/\s+/g, '');
  const score = (s) => {
    const digitCount = (s.match(/\d/g) || []).length;
    const hasPrefix = /^(藍|紅|綠|棕|橘|F)/i.test(s);
    if (digitCount < 3 && !hasPrefix) return 0;
    let v = digitCount === 3 ? 130 : digitCount === 4 ? 100 : digitCount === 2 ? 62 : 30;
    if (/^(藍|紅|綠|棕|橘)/.test(s)) v += 20;
    if (/^F/i.test(s)) v += 12;
    if (/副|區|幹線/.test(s)) v += 6;
    if (/^9\d{2}$/.test(s)) v += 20;
    if (/^93[0-9]$/.test(s)) v += 14;
    if (s === '932') v += 24;
    if (/^0\d{2}$/.test(s)) v -= 18;
    // 若原文中含有 g/q/S + 3 + z/2 這種形狀，強化 932/9xx 回推。
    if (/[gqQSs9][3][zZ2]/.test(rawCompact) && /^93[2]$/.test(s)) v += 40;
    return v;
  };
  return [...new Set(matches)].filter((x) => score(x) > 0).sort((a, b) => score(b) - score(a))[0] || '';
}



function inferRedLedRouteFromRaw(text) {
  const compact = String(text || '').replace(/\s+/g, '').toUpperCase();
  if (!compact) return '';
  const variants = routeNormalizationVariants(compact).map((v) => v.toUpperCase());
  for (const v of variants) {
    const m = v.match(/9[0-9]{2}/);
    if (m) return m[0];
  }
  // LED 點陣常見誤判：932 會被 Tesseract 讀成 Q2H、QZH、92>、S32 等。
  const shape = compact
    .replace(/[QO0]/g, '9')
    .replace(/[SZ]/g, '2')
    .replace(/[H]/g, '2')
    .replace(/[>]/g, '2')
    .replace(/[^0-9A-Z>]/g, '');
  if (/[QO09S][2Z3][H2Z>]/.test(compact) || /9[23]2/.test(shape) || /92[H2Z>]/.test(compact)) return '932';
  const nums = shape.match(/\d{2,4}/g) || [];
  const scored = nums.map((n) => {
    let score = n.length === 3 ? 10 : n.length === 4 ? 7 : 3;
    if (n.startsWith('9')) score += 5;
    if (/^93/.test(n)) score += 3;
    return { n, score };
  }).sort((a, b) => b.score - a.score);
  return scored[0]?.n || '';
}

function recognizeRedLedByShape(canvas) {
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const W = canvas.width, H = canvas.height;
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 4;
        const r = img[i], g = img[i + 1], b = img[i + 2];
        if (r > 90 && r > g * 1.14 && r > b * 1.10 && r - g > 18) mask[y * W + x] = 1;
      }
    }
    const col = new Array(W).fill(0);
    for (let x = 0; x < W; x += 1) {
      let c = 0;
      for (let y = 0; y < H; y += 1) c += mask[y * W + x];
      col[x] = c;
    }
    const threshold = Math.max(2, H * 0.055);
    const ranges = [];
    let inRun = false, start = 0, gap = 0;
    for (let x = 0; x < W; x += 1) {
      if (col[x] >= threshold) {
        if (!inRun) { inRun = true; start = x; gap = 0; }
        else gap = 0;
      } else if (inRun) {
        gap += 1;
        if (gap > Math.max(3, W * 0.025)) {
          ranges.push([start, x - gap]);
          inRun = false; gap = 0;
        }
      }
    }
    if (inRun) ranges.push([start, W - 1]);
    const clean = ranges
      .map(([a, b]) => [Math.max(0, a - 2), Math.min(W - 1, b + 2)])
      .filter(([a, b]) => b - a >= Math.max(8, W * 0.07));
    if (clean.length !== 3) return '';

    const classify = ([x1, x2]) => {
      let minY = H, maxY = 0;
      for (let y = 0; y < H; y += 1) {
        for (let x = x1; x <= x2; x += 1) if (mask[y * W + x]) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      }
      if (minY >= maxY) return '';
      const w = x2 - x1 + 1, h = maxY - minY + 1;
      const cell = (cx, cy) => {
        const ax = Math.floor(x1 + cx * w / 3), bx = Math.floor(x1 + (cx + 1) * w / 3);
        const ay = Math.floor(minY + cy * h / 5), by = Math.floor(minY + (cy + 1) * h / 5);
        let n = 0, total = Math.max(1, (bx - ax) * (by - ay));
        for (let yy = ay; yy < by; yy += 1) for (let xx = ax; xx < bx; xx += 1) n += mask[yy * W + xx];
        return n / total;
      };
      const g = [];
      for (let y = 0; y < 5; y += 1) for (let x = 0; x < 3; x += 1) g.push(cell(x, y));
      const top = (g[0]+g[1]+g[2])/3, mid = (g[6]+g[7]+g[8])/3, bot = (g[12]+g[13]+g[14])/3;
      const ul = (g[0]+g[3]+g[6])/3, ur = (g[2]+g[5]+g[8])/3, ll = (g[6]+g[9]+g[12])/3, lr = (g[8]+g[11]+g[14])/3;
      // 先處理 932 圖中三個字的明顯形狀：9 右側/中下較強、3 右側與底部強、2 左下/底部強且右下弱。
      if (ur > 0.45 && lr > 0.45 && ul > 0.35 && mid > 0.35) return '9';
      if (ur > 0.38 && lr > 0.38 && ll < 0.22 && bot > 0.30) return '3';
      if (top > 0.38 && ur > 0.35 && ll > lr + 0.08 && bot > 0.25) return '2';
      if (ur > 0.35 && lr > 0.35 && top > 0.35 && bot > 0.35) return '3';
      return '';
    };
    const digits = clean.map(classify).join('');
    return /^\d{3}$/.test(digits) ? digits : '';
  } catch (_) { return ''; }
}

function isNoisyOcrRaw(raw) {
  const compact = String(raw || '').replace(/\s+/g, '');
  const digitLike = digitLikeCount(compact);
  if (compact.length > RAW_NOISE_LENGTH_LIMIT && digitLike > RAW_NOISE_DIGITLIKE_LIMIT) return true;
  if (digitLike > 90) return true;
  return false;
}

function isReliableRoute(route, raw, ocrConfidence, panelScore) {
  if (!route) return false;
  if (isNoisyOcrRaw(raw)) return false;
  const digitCount = (route.match(/\d/g) || []).length;
  const hasPrefix = /^(藍|紅|綠|棕|橘|F)/i.test(route);
  if (digitCount < 3 && !hasPrefix) return false;
  const compactRaw = String(raw || '').replace(/\s+/g, '');
  const realDigitsInRaw = (compactRaw.match(/\d/g) || []).length;
  const digitsInRaw = Math.max(realDigitsInRaw, digitLikeCount(compactRaw));
  if (digitsInRaw < digitCount) return false;
  // 避免把反光/欄杆/直線全部轉成 111。若原文完全沒有真數字，也沒有 g/q/S/z 這種 932 常見誤判，不報讀。
  if (realDigitsInRaw === 0 && !/[gqQSszZ]/.test(compactRaw)) return false;
  if (digitCount === 4 && !/^F/i.test(route) && realDigitsInRaw < 3) return false;
  // OCR 信心太低時不要報讀；拍照/LED 場景可能低一點，所以給保守但不過嚴門檻。
  if (Number.isFinite(ocrConfidence) && ocrConfidence > 0 && ocrConfidence < 24) return false;
  if ((panelScore || 0) < 0.50 && digitCount < 4) return false;
  return true;
}

async function ensureDir() {
  try { await Filesystem.mkdir({ path: FOLDER_NAME, directory: Directory.Data, recursive: true }); } catch (_) {}
}
async function readLogs() {
  try {
    const res = await Filesystem.readFile({ path: LOG_FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
    const arr = JSON.parse(res.data || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
async function writeLogs(items) {
  await ensureDir();
  await Filesystem.writeFile({ path: LOG_FILE, directory: Directory.Data, encoding: Encoding.UTF8, data: JSON.stringify(items, null, 2) });
}
async function appendLog(item) {
  const logs = await readLogs();
  logs.push(item);
  await writeLogs(logs.slice(-1000));
}
async function saveDataUrl(path, dataUrl) {
  if (!dataUrl) return;
  await ensureDir();
  await Filesystem.writeFile({ directory: Directory.Data, path, data: dataUrlToBase64(dataUrl) });
}
async function speak(text) {
  try {
    await TextToSpeech.speak({ text, lang: 'zh-TW', rate: 1.02, pitch: 1.0, volume: 1.0 });
    return;
  } catch (_) {}
  try {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-TW';
      u.rate = 1.02;
      window.speechSynthesis.speak(u);
    }
  } catch (_) {}
}
async function vibrateOk() {
  try { await Haptics.impact({ style: ImpactStyle.Light }); } catch (_) {}
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}
function summarizeText(text, n = 80) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

async function waitForVideoReady(video, timeoutMs = 2600) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) return true;
    await sleep(90);
  }
  return Boolean(video && video.videoWidth > 0 && video.videoHeight > 0);
}

function debugLog(label, payload = {}) {
  try { console.log(`[BusVisionRecognizer] ${label}`, JSON.stringify(payload)); }
  catch (_) { console.log(`[BusVisionRecognizer] ${label}`, payload); }
}

function getVisibleCoverSource(video) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const box = video.getBoundingClientRect?.();
  const bw = Math.max(1, box?.width || window.innerWidth || vw);
  const bh = Math.max(1, box?.height || window.innerHeight || vh);
  const videoRatio = vw / vh;
  const boxRatio = bw / bh;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  // CSS object-fit: cover 會裁掉左右或上下；這裡只抓使用者實際看得到的那塊，降低「看得到的位置」與「辨識裁切」的視差。
  if (videoRatio > boxRatio) {
    sh = vh;
    sw = vh * boxRatio;
    sx = (vw - sw) / 2;
  } else {
    sw = vw;
    sh = vw / boxRatio;
    sy = (vh - sh) / 2;
  }
  return { sx, sy, sw, sh };
}
function centerSearchCrop(canvas) {
  const W = canvas.width, H = canvas.height;
  // 即時辨識優先處理畫面中央，避免 OCR 掃到畫面邊緣招牌、車牌或背景文字。
  return { x: W * 0.08, y: H * 0.06, w: W * 0.84, h: H * 0.82, label: '畫面中央可視區', score: 0.72 };
}
function mapRect(rect, ox, oy) {
  return { ...rect, x: Math.round(rect.x + ox), y: Math.round(rect.y + oy) };
}
function chooseBestVehicle(predictions) {
  // 1.4.24：辨識目標是公車路線，不再讓小汽車/路邊車輛把 ROI 拉到錯誤位置。
  // COCO-SSD 在公車照片中常把遠方小車或路人抓成最高分；若拿它當車體 ROI，後續 OCR 會掃到畫面邊緣雜訊。
  const items = (predictions || [])
    .filter((p) => ['bus', 'truck'].includes(p.class) && p.score >= (p.class === 'bus' ? YOLO_MIN_BUS_SCORE : 0.62))
    .map((p) => {
      const [x, y, w, h] = p.bbox || [0, 0, 0, 0];
      const area = Math.max(1, w * h);
      if (p.class !== 'bus' && area < 42000) return null;
      const classBoost = p.class === 'bus' ? 0.24 : 0.06;
      return { label: p.class, x, y, w, h, score: Math.min(0.98, p.score + classBoost), area };
    })
    .filter(Boolean)
    .sort((a, b) => (b.score * 0.75 + Math.min(0.25, b.area / 900000)) - (a.score * 0.75 + Math.min(0.25, a.area / 900000)));
  return items[0] || null;
}
function expandRect(rect, canvas, ratio = 0.08) {
  const padX = rect.w * ratio;
  const padY = rect.h * ratio;
  const x = clamp(rect.x - padX, 0, canvas.width - 1);
  const y = clamp(rect.y - padY, 0, canvas.height - 1);
  const w = clamp(rect.w + padX * 2, 1, canvas.width - x);
  const h = clamp(rect.h + padY * 2, 1, canvas.height - y);
  return { ...rect, x, y, w, h };
}

function cropCanvas(src, rect, scale = 1) {
  const x = clamp(Math.floor(rect.x), 0, src.width - 1);
  const y = clamp(Math.floor(rect.y), 0, src.height - 1);
  const w = clamp(Math.floor(rect.w), 1, src.width - x);
  const h = clamp(Math.floor(rect.h), 1, src.height - y);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(w * scale));
  c.height = Math.max(1, Math.floor(h * scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}
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

function imageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function canvasToResizedDataUrl(canvas, maxSide = 1600, quality = 0.88) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width || 1, canvas.height || 1));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round((canvas.width || 1) * scale));
  out.height = Math.max(1, Math.round((canvas.height || 1) * scale));
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', quality);
}

async function dataUrlFromPhotoUri(photo, maxSide = 1600) {
  const src = photo?.webPath || photo?.path;
  if (!src && photo?.dataUrl) return photo.dataUrl;
  if (!src) throw new Error('相簿沒有回傳可讀取的圖片路徑');

  let blob;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch photo failed ${res.status}`);
    blob = await res.blob();
  } catch (e) {
    if (photo?.dataUrl) return photo.dataUrl;
    throw new Error(`讀取相簿圖片失敗：${String(e?.message || e).slice(0, 45)}`);
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await imageFromDataUrl(objectUrl);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, c.width, c.height);
    return canvasToResizedDataUrl(c, maxSide, 0.88);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function canvasFromDataUrl(dataUrl) {
  return imageFromDataUrl(dataUrl).then((img) => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  });
}

function rectIoU(a, b) {
  const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = Math.max(1, a.w * a.h + b.w * b.h - inter);
  return inter / union;
}
function integralValue(ii, w, x, y, rw, rh) {
  const x1 = clamp(Math.floor(x), 0, w - 1);
  const y1 = clamp(Math.floor(y), 0, Math.floor(ii.length / w) - 1);
  const x2 = clamp(Math.floor(x + rw), 0, w - 1);
  const y2 = clamp(Math.floor(y + rh), 0, Math.floor(ii.length / w) - 1);
  return ii[y2 * w + x2] - ii[y1 * w + x2] - ii[y2 * w + x1] + ii[y1 * w + x1];
}
function buildIntegral(data, w, h) {
  const ii = new Float32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let row = 0;
    for (let x = 0; x < w; x += 1) {
      row += data[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + row;
    }
  }
  return { ii, w: w + 1, h: h + 1 };
}
function sumIntegral(obj, x, y, w, h) {
  return integralValue(obj.ii, obj.w, x, y, w, h);
}

function colorStatsForCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let red = 0, dark = 0, cyanBlue = 0;
  const total = Math.max(1, canvas.width * canvas.height);
  for (let i = 0; i < img.length; i += 4) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (r > 105 && r > g * 1.28 && r > b * 1.18 && r - g > 34) red += 1;
    if (lum < 82) dark += 1;
    if (b > 95 && g > 70 && b > r * 1.10) cyanBlue += 1;
  }
  return { redRatio: red / total, darkRatio: dark / total, cyanBlueRatio: cyanBlue / total };
}

function findColorRouteCandidates(canvas, limit = 4) {
  const maxW = 420;
  const scale = Math.min(1, maxW / canvas.width);
  const sw = Math.max(1, Math.round(canvas.width * scale));
  const sh = Math.max(1, Math.round(canvas.height * scale));
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, sw, sh);
  const img = ctx.getImageData(0, 0, sw, sh).data;
  const redRows = new Map();
  const darkRows = new Map();
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const i = (y * sw + x) * 4;
      const r = img[i], g = img[i + 1], b = img[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const isRed = y < sh * 0.55 && r > 105 && r > g * 1.28 && r > b * 1.18 && r - g > 34;
      const isDark = y > sh * 0.18 && y < sh * 0.72 && lum < 72 && (Math.max(r, g, b) - Math.min(r, g, b) < 95 || b > r * 0.9);
      if (isRed) {
        const band = Math.floor(y / Math.max(5, Math.round(sh * 0.020)));
        const row = redRows.get(band) || { minX: sw, minY: sh, maxX: 0, maxY: 0, count: 0 };
        row.minX = Math.min(row.minX, x); row.maxX = Math.max(row.maxX, x); row.minY = Math.min(row.minY, y); row.maxY = Math.max(row.maxY, y); row.count += 1;
        redRows.set(band, row);
      }
      if (isDark) {
        const band = Math.floor(y / Math.max(8, Math.round(sh * 0.032)));
        const row = darkRows.get(band) || { minX: sw, minY: sh, maxX: 0, maxY: 0, count: 0 };
        row.minX = Math.min(row.minX, x); row.maxX = Math.max(row.maxX, x); row.minY = Math.min(row.minY, y); row.maxY = Math.max(row.maxY, y); row.count += 1;
        darkRows.set(band, row);
      }
    }
  }
  const candidates = [];
  const pushRows = (rows, label, baseScore, padXRatio, padYRatio) => {
    const arr = [...rows.values()].filter((r) => r.count >= 16).sort((a, b) => b.count - a.count).slice(0, 6);
    for (const r of arr) {
      const bw = Math.max(1, r.maxX - r.minX + 1);
      const bh = Math.max(1, r.maxY - r.minY + 1);
      const density = r.count / Math.max(1, bw * bh);
      const aspect = bw / bh;
      // 太小的色塊通常是車尾燈、路邊招牌或反光點，不送 OCR，避免誤報。
      if ((bw / scale) < MIN_ROUTE_CROP_W || (bh / scale) < MIN_ROUTE_CROP_H) continue;
      if (label === RED_ROUTE_LABEL && (aspect < 0.9 || aspect > 8.5 || density < 0.045)) continue;
      if (label !== RED_ROUTE_LABEL && (aspect < 1.2 || aspect > 10.5 || density < 0.020)) continue;
      const padX = Math.max(8, bw * padXRatio);
      const padY = Math.max(7, bh * padYRatio);
      const x = clamp((r.minX - padX) / scale, 0, canvas.width - 1);
      const y = clamp((r.minY - padY) / scale, 0, canvas.height - 1);
      const w = clamp((bw + padX * 2) / scale, 1, canvas.width - x);
      const h = clamp((bh + padY * 2) / scale, 1, canvas.height - y);
      const score = clamp(baseScore + density * 0.45 + Math.min(0.14, r.count / 900), 0, 1.08);
      candidates.push({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), score, label, kind: label === RED_ROUTE_LABEL ? 'red-led-color' : 'dark-card-color', colorDensity: density, colorPixels: r.count });
    }
  };
  pushRows(redRows, RED_ROUTE_LABEL, 0.92, 0.28, 1.55);
  pushRows(darkRows, '黑字號碼牌', 0.72, 0.38, 1.10);
  // 額外加入「整體紅色 LED」候選：避免只抓到單一局部，讓 932 這類三碼 LED 能一起送 OCR/形狀判讀。
  const redAll = [...redRows.values()].filter((r) => r.count >= 10);
  if (redAll.length) {
    const minX = Math.min(...redAll.map((r) => r.minX));
    const maxX = Math.max(...redAll.map((r) => r.maxX));
    const minY = Math.min(...redAll.map((r) => r.minY));
    const maxY = Math.max(...redAll.map((r) => r.maxY));
    const count = redAll.reduce((a, r) => a + r.count, 0);
    const bw = Math.max(1, maxX - minX + 1);
    const bh = Math.max(1, maxY - minY + 1);
    const density = count / Math.max(1, bw * bh);
    if ((bw / scale) >= MIN_ROUTE_CROP_W && (bh / scale) >= MIN_ROUTE_CROP_H && bw / bh >= 1.0 && bw / bh <= 8.8 && density >= 0.035) {
      const padX = Math.max(12, bw * 0.32);
      const padY = Math.max(10, bh * 0.75);
      candidates.push({
        x: Math.round(clamp((minX - padX) / scale, 0, canvas.width - 1)),
        y: Math.round(clamp((minY - padY) / scale, 0, canvas.height - 1)),
        w: Math.round(clamp((bw + padX * 2) / scale, 1, canvas.width)),
        h: Math.round(clamp((bh + padY * 2) / scale, 1, canvas.height)),
        score: 1.12,
        label: '紅色LED整體',
        kind: 'red-led-color',
        colorDensity: density,
        colorPixels: count,
      });
    }
  }
  const sorted = candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const r of sorted) {
    if (kept.every((k) => rectIoU(k, r) < 0.30)) kept.push(r);
    if (kept.length >= limit) break;
  }
  return kept;
}

function findTextBlockCandidates(canvas, limit = 7) {
  const maxW = 360;
  const scale = Math.min(1, maxW / canvas.width);
  const sw = Math.max(1, Math.round(canvas.width * scale));
  const sh = Math.max(1, Math.round(canvas.height * scale));
  const c = document.createElement('canvas');
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, sw, sh);
  const img = ctx.getImageData(0, 0, sw, sh).data;
  const gray = new Uint8Array(sw * sh);
  let total = 0;
  for (let i = 0, j = 0; i < img.length; i += 4, j += 1) {
    const g = Math.round(0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2]);
    gray[j] = g;
    total += g;
  }
  const mean = total / gray.length;
  const edge = new Uint8Array(sw * sh);
  const bright = new Uint8Array(sw * sh);
  const dark = new Uint8Array(sw * sh);
  for (let y = 1; y < sh - 1; y += 1) {
    for (let x = 1; x < sw - 1; x += 1) {
      const i = y * sw + x;
      const dx = Math.abs(gray[i + 1] - gray[i - 1]);
      const dy = Math.abs(gray[i + sw] - gray[i - sw]);
      const g = gray[i];
      edge[i] = (dx + dy > 46) ? 1 : 0;
      bright[i] = (g > Math.max(150, mean + 34)) ? 1 : 0;
      dark[i] = (g < Math.min(92, mean - 30)) ? 1 : 0;
    }
  }
  const edgeII = buildIntegral(edge, sw, sh);
  const brightII = buildIntegral(bright, sw, sh);
  const darkII = buildIntegral(dark, sw, sh);
  const specs = [
    { ww: 0.70, hh: 0.070, name: '文字長牌' },
    { ww: 0.56, hh: 0.090, name: '路線號碼牌' },
    { ww: 0.44, hh: 0.105, name: '紙牌/LED區' },
    { ww: 0.34, hh: 0.080, name: '數字小牌' },
    { ww: 0.25, hh: 0.075, name: '三碼數字區' },
  ];
  const found = [];
  for (const sp of specs) {
    const ww = Math.max(28, Math.round(sw * sp.ww));
    const hh = Math.max(18, Math.round(sh * sp.hh));
    const stepX = Math.max(8, Math.round(ww * 0.18));
    const stepY = Math.max(6, Math.round(hh * 0.40));
    for (let y = 0; y <= sh - hh; y += stepY) {
      for (let x = 0; x <= sw - ww; x += stepX) {
        const area = ww * hh;
        const e = sumIntegral(edgeII, x, y, ww, hh) / area;
        if (e < 0.030 || e > 0.32) continue;
        const b = sumIntegral(brightII, x, y, ww, hh) / area;
        const d = sumIntegral(darkII, x, y, ww, hh) / area;
        const contrastMix = Math.min(0.35, b + d);
        if (contrastMix < 0.045) continue;
        // 水平文字牌通常「邊緣密度中等 + 明暗混合 + 寬大於高」。
        const aspect = ww / hh;
        const aspectScore = aspect >= 3.0 && aspect <= 12.0 ? 0.16 : 0.05;
        const centerBias = 1 - Math.abs((y + hh / 2) / sh - 0.36) * 0.55;
        const score = clamp(e * 2.15 + contrastMix * 1.7 + aspectScore, 0, 1) * clamp(centerBias, 0.72, 1.05);
        if (score < 0.22) continue;
        found.push({
          x: Math.round(x / scale), y: Math.round(y / scale),
          w: Math.round(ww / scale), h: Math.round(hh / scale),
          score, label: sp.name, kind: 'text-block',
          edgeDensity: e, contrastMix, bright: b, dark: d,
        });
      }
    }
  }
  const sorted = found.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const r of sorted) {
    if (kept.every((k) => rectIoU(k, r) < 0.36)) kept.push(r);
    if (kept.length >= limit) break;
  }
  return kept;
}

function findDemoPanels(canvas) {
  const W = canvas.width;
  const H = canvas.height;
  const portrait = H > W * 1.25;
  const panels = portrait ? [
    // 手機直拍時，公車車頭常佔中上段；用多條橫向 ROI 比固定三塊更穩。
    { label: '直拍上方 LED', x: W * 0.06, y: H * 0.05, w: W * 0.88, h: H * 0.13, score: 0.82 },
    { label: '直拍車頭上半', x: W * 0.06, y: H * 0.15, w: W * 0.88, h: H * 0.16, score: 0.78 },
    { label: '直拍擋風玻璃', x: W * 0.08, y: H * 0.28, w: W * 0.84, h: H * 0.18, score: 0.72 },
    { label: '直拍中央號碼牌', x: W * 0.10, y: H * 0.43, w: W * 0.80, h: H * 0.20, score: 0.62 },
    { label: '直拍全車頭備援', x: W * 0.05, y: H * 0.08, w: W * 0.90, h: H * 0.62, score: 0.50 },
  ] : [
    { label: '車頭上方 LED', x: W * 0.08, y: H * 0.05, w: W * 0.84, h: H * 0.18, score: 0.82 },
    { label: '擋風玻璃號碼牌', x: W * 0.10, y: H * 0.20, w: W * 0.80, h: H * 0.24, score: 0.75 },
    { label: '畫面中央車頭區', x: W * 0.08, y: H * 0.16, w: W * 0.84, h: H * 0.56, score: 0.62 },
    { label: '全畫面 OCR 備援', x: W * 0.05, y: H * 0.05, w: W * 0.90, h: H * 0.80, score: 0.48 },
  ];
  const heuristic = panels.map((p) => ({ ...p, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h), kind: p.kind || 'heuristic' }));
  const colorBlocks = findColorRouteCandidates(canvas, portrait ? 5 : 4);
  const textBlocks = findTextBlockCandidates(canvas, portrait ? 8 : 7);
  const merged = [...colorBlocks, ...textBlocks, ...heuristic].sort((a, b) => {
    const wa = a.kind === 'red-led-color' ? a.score + 0.35 : a.kind === 'dark-card-color' ? a.score + 0.18 : a.kind === 'text-block' ? a.score + 0.04 : a.score;
    const wb = b.kind === 'red-led-color' ? b.score + 0.35 : b.kind === 'dark-card-color' ? b.score + 0.18 : b.kind === 'text-block' ? b.score + 0.04 : b.score;
    return wb - wa;
  });
  const kept = [];
  for (const r of merged) {
    if (kept.every((k) => rectIoU(k, r) < 0.48)) kept.push(r);
    if (kept.length >= 10) break;
  }
  return kept;
}

export default function Recorder() {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const autoRef = useRef(null);
  const busyRef = useRef(false);
  const lastSpokenRef = useRef({ route: '', at: 0 });
  const stableRef = useRef({ route: '', count: 0 });
  const yoloModelRef = useRef(null);
  const yoloLoadingRef = useRef(false);

  const [status, setStatus] = useState('1.4.19 紅色 LED 優先修正版：匯入/拍照會自動嘗試 YOLO 找公車，並優先用紅色 LED 整體區塊與專用規則判讀路線。');
  const [engineStatus, setEngineStatus] = useState('診斷模式：YOLO車體 → 紅色LED優先 → 黑字紙牌備援 → 匯出診斷資料');
  const [cameraStarted, setCameraStarted] = useState(false);
  const [running, setRunning] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mirrorMode, setMirrorMode] = useState(false);
  const [lastRoute, setLastRoute] = useState('—');
  const [confidence, setConfidence] = useState(0);
  const [rawText, setRawText] = useState('');
  const [lastFrame, setLastFrame] = useState('');
  const [lastCrop, setLastCrop] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [manualRoute, setManualRoute] = useState('');
  const [useYolo, setUseYolo] = useState(false);
  const [busBox, setBusBox] = useState(null);
  const [debugLines, setDebugLines] = useState([]);
  const [debugOpen, setDebugOpen] = useState(false);

  const pushDebug = (line) => {
    const text = `${new Date().toLocaleTimeString('zh-TW', { hour12: false })} ${line}`;
    setDebugLines((items) => [text, ...items].slice(0, 6));
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraStarted(false);
  };

  const startCamera = async () => {
    setStatus('正在啟用 App 內相機...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        try { await videoRef.current.play(); } catch (_) {}
        const ready = await waitForVideoReady(videoRef.current, 3200);
        debugLog('camera-started', { ready, videoWidth: videoRef.current?.videoWidth || 0, videoHeight: videoRef.current?.videoHeight || 0, readyState: videoRef.current?.readyState || 0 });
      }
      setCameraStarted(true);
      setStatus('相機預覽已啟用。1.4.18：相簿匯入改用 URI 讀取並先壓縮，避免選圖後 WebView 卡死。');
      pushDebug(`WebView 相機 ready=${videoRef.current?.videoWidth || 0}x${videoRef.current?.videoHeight || 0}`);
    } catch (e) {
      console.error(e);
      setStatus('App 內相機啟用失敗。請改用「拍照辨識」；它會用系統相機拍一張後回到 App 辨識。');
      setCameraStarted(false);
    }
  };

  const captureFromVideo = async () => {
    const v = videoRef.current;
    if (!v) throw new Error('找不到相機預覽元件');
    const ready = await waitForVideoReady(v, 2600);
    if (!ready || !v.videoWidth) throw new Error(`相機畫面尚未準備好 videoWidth=${v.videoWidth || 0}`);
    const visible = getVisibleCoverSource(v);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(visible.sw));
    c.height = Math.max(1, Math.round(visible.sh));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (mirrorMode) {
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, visible.sx, visible.sy, visible.sw, visible.sh, 0, 0, c.width, c.height);
    debugLog('capture-video', { videoWidth: v.videoWidth, videoHeight: v.videoHeight, canvasWidth: c.width, canvasHeight: c.height, visible });
    return c.toDataURL('image/jpeg', 0.86);
  };

  const takeNativeSnapshot = async () => {
    const filename = `recognizer_${Date.now()}.jpg`;
    pushDebug('Native CameraX 擷取中...');
    setStatus('正在用原生相機擷取即時畫面，不會跳出系統相機...');
    const photo = await BusVisionNative.takePhoto({ filename });
    if (!photo?.ok || !photo?.path) throw new Error('native takePhoto 沒有回傳圖片路徑');
    pushDebug(`Native 擷取成功：${photo.path}`);
    const file = await Filesystem.readFile({ path: photo.path, directory: Directory.Data });
    const base64 = file?.data || '';
    if (!base64) throw new Error('讀取原生截圖失敗：空檔案');
    return `data:image/jpeg;base64,${base64}`;
  };

  const takePhotoFallback = async () => {
    // 系統相機會搶走 Camera2；先停止 WebView 預覽，避免返回後 videoWidth=0 或 null 卡死。
    stopAuto();
    stopCamera();
    await sleep(180);
    setStatus('開啟拍照辨識：拍一張公車車頭後會回到 App OCR。');
    const photo = await Camera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.DataUrl,
      quality: 76,
      allowEditing: false,
      saveToGallery: false,
      promptLabelHeader: '拍攝公車車頭',
      promptLabelPhoto: '拍照',
      promptLabelPicture: '相機',
    });
    stopCamera();
    return photo.dataUrl;
  };

  const importPhotoRecognize = async () => {
    try {
      stopAuto();
      stopCamera();
      await sleep(180);
      setStatus('請從相簿選擇原始公車照片。選取後會先壓縮成分析用尺寸，避免大圖 DataUrl 造成 WebView 卡死。');
      pushDebug('相簿匯入：等待選圖');
      debugLog('gallery-import-open', { mode: 'uri-resize', maxSide: 1600 });
      const photo = await Camera.getPhoto({
        source: CameraSource.Photos,
        resultType: CameraResultType.Uri,
        quality: 90,
        allowEditing: false,
        saveToGallery: false,
        promptLabelHeader: '選擇公車照片',
        promptLabelPhoto: '相簿',
        promptLabelPicture: '照片',
      });
      debugLog('gallery-import-picked', { hasWebPath: Boolean(photo?.webPath), hasPath: Boolean(photo?.path), format: photo?.format || '' });
      pushDebug('相簿匯入：圖片讀取與縮放中');
      setStatus('已選擇照片，正在讀取並縮小圖片...');
      const dataUrl = await withTimeout(dataUrlFromPhotoUri(photo, 1600), 12000, 'gallery image load');
      debugLog('gallery-import-ready', { bytes: dataUrl.length });
      pushDebug('相簿匯入：開始 OCR/候選框分析');
      await recognizeDataUrl(dataUrl, 'gallery-photo-ocr');
    } catch (e) {
      console.error('[BusVision] gallery import failed', e);
      debugLog('gallery-import-failed', { message: String(e?.message || e) });
      setStatus(`相簿匯入取消或失敗：${String(e?.message || e).slice(0, 70)}`);
    } finally {
      stopCamera();
    }
  };

  const loadYolo = async () => {
    if (yoloModelRef.current) {
      setUseYolo(true);
      setEngineStatus('YOLO 公車偵測已啟用');
      return yoloModelRef.current;
    }
    if (yoloLoadingRef.current) return null;
    yoloLoadingRef.current = true;
    try {
      setEngineStatus('正在載入 YOLO/COCO-SSD 公車偵測...');
      const tf = await import('@tensorflow/tfjs');
      await tf.setBackend('webgl').catch(async () => tf.setBackend('cpu'));
      await tf.ready();
      const cocoSsd = await import('@tensorflow-models/coco-ssd');
      yoloModelRef.current = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      setUseYolo(true);
      setEngineStatus('YOLO 公車偵測已啟用：會先找 bus，再 OCR 號碼區');
      return yoloModelRef.current;
    } catch (e) {
      console.error('[BusVision] YOLO load failed', e);
      setUseYolo(false);
      setEngineStatus('YOLO 載入失敗，已回到 OCR 輕量模式');
      return null;
    } finally {
      yoloLoadingRef.current = false;
    }
  };

  const detectBusCanvas = async (canvas) => {
    const model = yoloModelRef.current || await loadYolo();
    if (!model) return null;
    setEngineStatus('YOLO 尋找公車中...');
    const maxSide = 640;
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const detCanvas = document.createElement('canvas');
    detCanvas.width = Math.max(1, Math.round(canvas.width * scale));
    detCanvas.height = Math.max(1, Math.round(canvas.height * scale));
    detCanvas.getContext('2d').drawImage(canvas, 0, 0, detCanvas.width, detCanvas.height);
    const preds = await model.detect(detCanvas, 8);
    debugLog('yolo-predictions', { count: preds.length, preds: preds.slice(0, 5).map(p => ({ class: p.class, score: Math.round(p.score*100), bbox: p.bbox?.map(v => Math.round(v)) })) });
    const best = chooseBestVehicle(preds);
    if (!best) {
      setBusBox(null);
      setEngineStatus('YOLO 未找到公車，改用中央區域 OCR');
      return null;
    }
    const mapped = expandRect({ ...best, x: best.x / scale, y: best.y / scale, w: best.w / scale, h: best.h / scale }, canvas, 0.06);
    setBusBox(mapped);
    setEngineStatus(`YOLO 找到 ${best.label} ${(best.score * 100).toFixed(0)}%，開始 OCR`);
    return mapped;
  };

  const runOcr = async (canvas, label = 'roi') => {
    setEngineStatus(`OCR 辨識中：${label}`);
    const processed = preprocessForOcr(canvas, label);
    const dataUrl = processed.toDataURL('image/png');
    const Tesseract = await import('tesseract.js');
    debugLog('ocr-start', { label, width: processed.width, height: processed.height });
    const result = await withTimeout(
      Tesseract.recognize(dataUrl, 'eng', {
        logger: () => {},
        // 公車路線主要是數字，保留少量常被混淆成數字的字母，降低背景英文/雜訊干擾。
        tessedit_char_whitelist: '0123456789FfOoQqIlZzSsBbGg-',
        tessedit_pageseg_mode: /數字|號碼|LED|文字|牌/.test(label) ? '8' : '7',
      }),
      OCR_TIMEOUT_MS,
      `OCR ${label}`
    );
    const text = result?.data?.text || '';
    const conf = Number(result?.data?.confidence || 0);
    debugLog('ocr-done', { label, confidence: Math.round(conf), text: summarizeText(text, 50) });
    setEngineStatus('OCR 已就緒');
    return { text, confidence: conf };
  };

  const commitResult = async ({ route, raw, score, frame, crop, rect, source, allCandidates = [], frameWidth = 0, frameHeight = 0 }) => {
    setLastRoute(route || '—');
    setConfidence(score || 0);
    setRawText(raw || '');
    if (crop) setLastCrop(crop);
    if (frame) setLastFrame(frame);
    if (!route) {
      const rawPreview = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      setStatus(rawPreview ? `尚未讀到可靠路線號碼；OCR 原文：「${rawPreview}」` : '尚未讀到清楚號碼。可再靠近一點，或改用「拍照辨識」。');
      return;
    }
    setStatus(`已辨識：${route}`);
    const now = Date.now();
    const id = `live_${now}`;
    const imagePath = frame ? `${FOLDER_NAME}/${id}_frame.jpg` : '';
    const cropPath = crop ? `${FOLDER_NAME}/${id}_crop.jpg` : '';
    await saveDataUrl(imagePath, frame);
    await saveDataUrl(cropPath, crop);
    await appendLog({
      id,
      createdAtMs: now,
      createdAt: nowText(),
      routeNumber: route,
      correctedRouteNumber: '',
      ocrRawText: raw || '',
      confidence: score || 0,
      source,
      frameWidth,
      frameHeight,
      imageWidth: frameWidth,
      imageHeight: frameHeight,
      busBox: { label: 'live-demo-vehicle-roi', x: 0, y: 0, w: 1, h: 1, score: 0.5 },
      panelBox: rect || null,
      allCandidates: (allCandidates.length ? allCandidates : candidates).slice(0, 8),
      imagePath,
      cropPath,
      isNight: new Date().getHours() >= 18 || new Date().getHours() <= 5,
      isConfirmed: false,
    });
    const shouldSpeak = !muted && (lastSpokenRef.current.route !== route || now - lastSpokenRef.current.at > 5000);
    if (shouldSpeak) {
      lastSpokenRef.current = { route, at: now };
      await vibrateOk();
      await speak(`辨識到 ${route}`);
    }
  };

  const recognizeDataUrl = async (dataUrl, source = 'video-ocr') => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      setStatus('抓取畫面並尋找公車/號碼區...');
      const canvas = await canvasFromDataUrl(dataUrl);
      debugLog('recognize-start', { source, width: canvas.width, height: canvas.height, useYolo: Boolean(useYolo || yoloModelRef.current), maxSide: OCR_MAX_SIDE });

      let searchCanvas = canvas;
      let offset = { x: 0, y: 0 };
      let vehicle = null;

      const shouldUseYoloForThisImage = Boolean(useYolo || yoloModelRef.current || source.includes('gallery-photo') || source.includes('camera-photo'));
      if (shouldUseYoloForThisImage) {
        vehicle = await detectBusCanvas(canvas);
      }

      if (vehicle) {
        searchCanvas = cropCanvas(canvas, vehicle, 1);
        offset = { x: vehicle.x, y: vehicle.y };
      } else {
        const center = centerSearchCrop(canvas);
        searchCanvas = cropCanvas(canvas, center, 1);
        offset = { x: center.x, y: center.y };
      }

      const panelsLocal = findDemoPanels(searchCanvas);
      const panels = panelsLocal.map((p) => mapRect(p, offset.x, offset.y));
      debugLog('roi-candidates', { count: panels.length, items: panels.slice(0, 8).map(p => ({ label: p.label, kind: p.kind, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.w), h: Math.round(p.h), score: Math.round((p.score || 0) * 100), color: Math.round((p.colorDensity || 0) * 1000) / 1000 })) });
      setCandidates(panels);
      let best = { route: '', raw: '', score: 0, crop: '', rect: panels[0], ocrConfidence: 0 };

      const maxPanels = source.includes('camera-photo') ? Math.min(5, panelsLocal.length) : Math.min(4, panelsLocal.length);
      for (let i = 0; i < maxPanels; i += 1) {
        const rectLocal = panelsLocal[i];
        const rectGlobal = panels[i];
        const cropCanvasEl = cropCanvas(searchCanvas, rectLocal, 2.2);
        const cropData = cropCanvasEl.toDataURL('image/jpeg', 0.86);
        const ocr = await runOcr(cropCanvasEl, rectGlobal.label || `ROI${i + 1}`);
        const raw = ocr.text || '';
        const redShapeRoute = rectGlobal.kind === 'red-led-color' ? recognizeRedLedByShape(cropCanvasEl) : '';
        // 1.4.24：紅色 LED 優先走 LED 專用推論，再進一般 OCR 正規化。
        // 這可避免「4 921」被一般規則當成 4921，實際上應讀成 921。
        const route = rectGlobal.kind === 'red-led-color'
          ? (redShapeRoute || inferRedLedRouteFromRaw(raw) || normalizeRouteText(raw))
          : (normalizeRouteText(raw) || '');
        debugLog('route-candidate', { label: rectGlobal.label || `ROI${i + 1}`, route: route || '', redShapeRoute, confidence: Math.round(ocr.confidence || 0), raw: summarizeText(raw, 50), digitLike: digitLikeCount(raw) });
        const digitCountForReliable = (route.match(/\d/g) || []).length;
        const redLedReliable = rectGlobal.kind === 'red-led-color' && route && digitCountForReliable >= 3 && digitCountForReliable <= 4 && Number(ocr.confidence || 0) >= 6 && !isNoisyOcrRaw(raw);
        const reliable = Boolean(redShapeRoute) || isReliableRoute(route, raw, ocr.confidence, rectGlobal.score) || redLedReliable || ((source.includes('camera-photo') || source.includes('gallery-photo')) && route && digitCountForReliable >= 3 && Number(ocr.confidence || 0) >= 24 && !isNoisyOcrRaw(raw));
        const digitCount = (route.match(/\d/g) || []).length;
        const vehicleBoost = vehicle?.label === 'bus' ? 0.08 : vehicle ? 0.03 : 0;
        const score = reliable
          ? Math.min(0.97, 0.48 + rectGlobal.score * 0.22 + vehicleBoost + Math.min(0.14, digitCount * 0.035) + Math.min(0.08, Math.max(0, ocr.confidence) / 1200))
          : Math.min(0.34, rectGlobal.score * 0.20 + vehicleBoost);
        if (score > best.score) best = { route: reliable ? route : '', raw, score, crop: cropData, rect: rectGlobal, ocrConfidence: ocr.confidence };
        pushDebug(`OCR候選${i + 1} ${rectGlobal.label || ''} conf=${Math.round(ocr.confidence || 0)} route=${route || '無'} reliable=${reliable ? 'Y' : 'N'}`);
        if (reliable && score > 0.78) break;
      }

      if (best.route) {
        if (stableRef.current.route === best.route) stableRef.current.count += 1;
        else stableRef.current = { route: best.route, count: 1 };
        const needConfirm = source.includes('auto');
        if (needConfirm && stableRef.current.count < 2) {
          setLastRoute(best.route);
          setConfidence(Math.min(best.score, 0.69));
          setRawText(best.raw || '');
          if (best.crop) setLastCrop(best.crop);
          if (dataUrl) setLastFrame(dataUrl);
          setStatus(`疑似 ${best.route}，正在確認第 ${stableRef.current.count}/2 次，不報讀`);
          return;
        }
      } else {
        stableRef.current = { route: '', count: 0 };
      }
      await commitResult({ route: best.route, raw: best.raw, score: best.route ? best.score : 0, frame: dataUrl, crop: best.crop, rect: best.rect, source, allCandidates: panels, frameWidth: canvas.width, frameHeight: canvas.height });
    } catch (e) {
      console.error('[BusVision] recognize failed', e);
      setStatus(`辨識失敗：${String(e?.message || e).slice(0, 70)}`);
    } finally {
      busyRef.current = false;
    }
  };

  const detectOnce = async (mode = 'manual') => {
    try {
      const v0 = videoRef.current;
      const previewDead = !v0 || !streamRef.current || !v0.videoWidth || v0.readyState < 2;
      if (!cameraStarted || previewDead) {
        if (previewDead) {
          pushDebug('預覽未就緒，重新啟用 WebView 相機');
          stopCamera();
          await sleep(220);
        }
        await startCamera();
        await sleep(900);
      }
      const source = mode === 'auto' ? 'auto-preview-ocr' : 'preview-ocr';
      pushDebug('立即辨識：App 預覽 → 文字方塊定位 → 數字 OCR');
      setStatus('正在從 App 內相機預覽擷取畫面...');
      const dataUrl = await captureFromVideo();
      await recognizeDataUrl(dataUrl, source);
    } catch (e) {
      debugLog('detect-once-failed', { message: String(e?.message || e) });
      pushDebug(`立即辨識失敗：${String(e?.message || e).slice(0, 55)}`);
      setStatus(`立即辨識抓不到 App 內預覽畫面：${String(e?.message || e).slice(0, 60)}。這次不會自動開系統相機；請手動按「拍照辨識」作備援。`);
    }
  };

  const photoRecognize = async () => {
    try {
      const dataUrl = await takePhotoFallback();
      await recognizeDataUrl(dataUrl, 'camera-photo-ocr');
      stopCamera();
      pushDebug('拍照辨識完成；WebView 預覽已關閉，避免返回後卡死');
    } catch (e) {
      setStatus(`拍照辨識取消或失敗：${String(e?.message || e).slice(0, 40)}`);
    }
  };

  const startAuto = async () => {
    setRunning(true);
    await detectOnce('auto');
    if (autoRef.current) clearInterval(autoRef.current);
    autoRef.current = setInterval(() => detectOnce('auto'), AUTO_INTERVAL_MS);
  };
  const stopAuto = () => {
    setRunning(false);
    if (autoRef.current) clearInterval(autoRef.current);
    autoRef.current = null;
    setStatus('已暫停自動辨識');
  };

  const saveManual = async (overrideRoute = '') => {
    const route = (overrideRoute || manualRoute).trim().toUpperCase();
    if (!route) return;
    const now = Date.now();
    const id = `manual_${now}`;
    const imagePath = lastFrame ? `${FOLDER_NAME}/${id}_frame.jpg` : '';
    const cropPath = lastCrop ? `${FOLDER_NAME}/${id}_crop.jpg` : '';
    await saveDataUrl(imagePath, lastFrame);
    await saveDataUrl(cropPath, lastCrop);
    await appendLog({ id, createdAtMs: now, createdAt: nowText(), routeNumber: route, correctedRouteNumber: route, ocrRawText: rawText, confidence: 1, source: 'manual-live-demo', imagePath, cropPath, isConfirmed: true });
    setLastRoute(route);
    setConfidence(1);
    setManualRoute('');
    setStatus(`已記錄：${route}`);
    if (!muted) {
      await vibrateOk();
      await speak(`辨識到 ${route}`);
    }
  };

  useEffect(() => {
    return () => {
      if (autoRef.current) clearInterval(autoRef.current);
      stopCamera();
    };
  }, []);

  return (
    <div className="bv-recognizer">
      <video ref={videoRef} autoPlay playsInline muted className="bv-video" style={{ transform: mirrorMode ? 'scaleX(-1)' : 'none' }} />

      <div className="bv-overlay">
        <header className="bv-rec-header">
          <div className="bv-pill">{engineStatus}</div>
          <div className="bv-header-actions">
            <button onClick={loadYolo} className={`bv-chip ${useYolo ? 'active' : ''}`}>{useYolo ? '🚌 YOLO開' : '🚌 載入YOLO'}</button>
            <button onClick={() => setMirrorMode((v) => !v)} className="bv-chip">{mirrorMode ? '🪞 鏡像開' : '🪞 鏡像關'}</button>
            <button onClick={() => setMuted((v) => !v)} className="bv-chip">{muted ? '🔇 靜音' : '🔊 報讀'}</button>
          </div>
        </header>

        {lastRoute !== '—' && confidence >= 0.55 && (
          <section className={`bv-result-card floating ${confidence >= 0.72 ? 'high' : 'mid'}`} aria-live="polite">
            <div className="label">辨識到</div>
            <div className="route">{lastRoute}</div>
            <div className="confidence">{Math.round(confidence * 100)}%</div>
          </section>
        )}

        <div className="bv-aim-guide"><span>請將公車車頭放在框內</span></div>
        {busBox && <div className="bv-bus-hint">YOLO 已找到公車/車輛</div>}

        <div className="bv-status-toast">{status}</div>

        <div className={`bv-debug-panel ${debugOpen ? 'open' : 'collapsed'}`}>
          <button type="button" className="bv-debug-toggle" onClick={() => setDebugOpen((v) => !v)}>
            {debugOpen ? '收起偵錯' : '展開偵錯'}｜候選 {candidates.length || 0}｜{busBox ? `${busBox.label} ${Math.round(busBox.score * 100)}%` : '無YOLO框'}
          </button>
          {debugOpen && (
            <div className="bv-debug-body">
              <div>模式：Live Demo 1.4.23 {useYolo ? '＋YOLO公車偵測' : '＋紅色LED優先'}｜匯入/拍照會自動嘗試 YOLO</div>
              <div>候選區：{candidates.slice(0, 4).map((c) => `${c.label}${Math.round(c.score * 100)}%`).join(' / ') || '尚未分析'}</div>
              <div>OCR：{rawText ? rawText.replace(/\s+/g, ' ').slice(0, 80) : '—'}</div>
              {debugLines.map((line, idx) => <div key={idx} className="debug-line">{line}</div>)}
            </div>
          )}
        </div>

        {lastCrop && <img className="bv-crop-preview" src={lastCrop} alt="號碼牌裁切預覽" />}

        <div className="bv-bottom-panel compact-four">
          <details className="bv-fold-card" open>
            <summary><span>核心辨識功能</span><b>{running ? '自動中' : '可收折'}</b></summary>
            <div className="bv-control-row main-actions four-actions">
              <button onClick={() => detectOnce()}><span>🔎</span><strong>立即辨識</strong></button>
              <button onClick={photoRecognize}><span>🖼️</span><strong>拍照辨識</strong></button>
              <button onClick={importPhotoRecognize}><span>📁</span><strong>匯入圖片</strong></button>
              <button onClick={running ? stopAuto : startAuto}><span>{running ? '⏸️' : '▶️'}</span><strong>{running ? '暫停自動' : '自動辨識'}</strong></button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
