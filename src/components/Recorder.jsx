import { ScanLine, Camera as CameraIcon, ImagePlus, Play, Pause } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import '@tensorflow/tfjs-backend-webgl';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { App } from '@capacitor/app';
import { getOcrDimensions } from '../services/ocrSizing.js';
import { recordRecognitionTelemetry } from '../services/recognitionTelemetry.js';
import { appendLog } from '../services/recognitionStorage.js';
import { extractLiteralRouteText } from '../services/routeText.js';
import {runNativePipeline} from '../services/nativeRecognitionPipeline.js';
import {canUseNativeOcr,recognizeNativeText} from '../services/nativeOcr.js';
import {literalRouteCandidates} from '../services/nativeRouteSelection.js';
import { createVehicleDetector } from './vehicleDetector.js';

import {readRecognitionContext,clearRecognitionContext,routeMatchesContext} from '../services/recognitionContext.js';

const FOLDER_NAME = 'BusData';
const AUTO_INTERVAL_MS = 6500;
const AUTO_CONFIRM_INTERVAL_MS = 500;
const VEHICLE_MIN_BUS_SCORE = 0.38;
const VEHICLE_TIMEOUT_MS = 8000;
const MIN_ROUTE_CROP_W = 72;
const MIN_ROUTE_CROP_H = 24;
const OCR_TIMEOUT_MS = 9000;
const OCR_MAX_SIDE = 1280;
const RECOGNITION_BUDGET_MS = 12000;
const VEHICLE_STAGE_BUDGET_MS = 4000;
const RAW_NOISE_DIGITLIKE_LIMIT = 38;
const RAW_NOISE_LENGTH_LIMIT = 140;
const RED_ROUTE_LABEL = '紅色LED路線';

function nowText() { return new Date().toLocaleString('zh-TW', { hour12: false }); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dataUrlToBase64(dataUrl) { return String(dataUrl).split(',')[1] || ''; }

function digitLikeCount(text) {
  return (String(text || '').match(/\d/g) || []).length;
}

function normalizeRouteText(text) {
  const candidates = literalRouteCandidates(text);
  return candidates.length === 1 ? candidates[0] : '';
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
  // 沒有實際讀到數字時不報讀。
  if (realDigitsInRaw === 0) return false;
  if (digitCount === 4 && !/^F/i.test(route) && realDigitsInRaw < 3) return false;
  // OCR 信心太低時不要報讀；拍照/LED 場景可能低一點，所以給保守但不過嚴門檻。
  if (!Number.isFinite(ocrConfidence) || ocrConfidence < 24) return false;
  if ((panelScore || 0) < 0.50 && digitCount < 4) return false;
  return true;
}

async function ensureDir() {
  await Filesystem.mkdir({ path: FOLDER_NAME, directory: Directory.Data, recursive: true }).catch(() => {});
}
async function saveDataUrl(path, dataUrl) {
  if (!dataUrl) return;
  await ensureDir();
  await Filesystem.writeFile({ directory: Directory.Data, path, data: dataUrlToBase64(dataUrl) });
}
async function speak(text, isCurrent) {
  try {
    await TextToSpeech.speak({ text, lang: 'zh-TW', rate: 1.02, pitch: 1.0, volume: 1.0 });
    return;
  } catch {
    // Native speech may be unavailable in a browser.
  }
  try {
    if (isCurrent() && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-TW';
      u.rate = 1.02;
      window.speechSynthesis.speak(u);
    }
  } catch {
    // The visual recognition result remains available.
  }
}
async function vibrateOk() {
  await Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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
  catch { console.log(`[BusVisionRecognizer] ${label}`, payload); }
}

function releaseOcrWorker(workerPromise) {
  void workerPromise?.then((worker) => worker.terminate()).catch(() => {});
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
    .filter((p) => ['bus', 'truck'].includes(p.class) && p.score >= (p.class === 'bus' ? VEHICLE_MIN_BUS_SCORE : 0.62))
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
  const size = getOcrDimensions(src.width, src.height, OCR_MAX_SIDE);
  const c = document.createElement('canvas');
  c.width = size.width;
  c.height = size.height;
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
  const redMode = /紅色/.test(label) && redCount / totalPx > 0.018;
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
  const merged = [...colorBlocks.filter(r=>r.h<H*.4), ...textBlocks, ...heuristic].sort((a, b) => {
    const wa = a.kind === 'red-led-color' ? a.score + 0.35 : a.kind === 'dark-card-color' ? a.score + 0.18 : a.kind === 'text-block' ? a.score + 0.04 : a.score;
    const wb = b.kind === 'red-led-color' ? b.score + 0.35 : b.kind === 'dark-card-color' ? b.score + 0.18 : b.kind === 'text-block' ? b.score + 0.04 : b.score;
    return wb - wa;
  });
  const kept = [];
  for (const r of merged) {
    if (kept.every((k) => rectIoU(k, r) < 0.48)) kept.push(r);
    if (kept.length >= 10) break;
  }
  const top=heuristic[0];
  return [top,...kept.filter(r=>rectIoU(r,top)<.48)];
}

export default function Recorder({ autoStartOnEntry = false }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const cameraRequestRef = useRef(0);
  const autoRef = useRef(null);
  const activeRef = useRef(false);
  const liveScanRef = useRef(null);
  const photoActionRef = useRef(false);
  const recognitionRef = useRef(null);
  const ocrWorkerRef = useRef(null);
  const lastSpokenRef = useRef({ route: '', at: 0 });
  const stableRef = useRef({ route: '', count: 0 });
  const vehicleDetectorRef = useRef(null);
  const vehicleEnabledRef = useRef(false);
  const mutedRef = useRef(false);
  const mirrorRef = useRef(false);

  const [status, setStatus] = useState('對準公車車頭後辨識，或拍照、匯入照片。');
  const [engineStatus, setEngineStatus] = useState('號碼牌辨識待命');
  const [running, setRunning] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [stationDisplay,setStationDisplay] = useState(()=>readRecognitionContext());
  useEffect(()=>{const timer=setInterval(()=>setStationDisplay(readRecognitionContext()),10000);return()=>clearInterval(timer);},[]);
  const [muted, setMuted] = useState(false);
  const [mirrorMode, setMirrorMode] = useState(false);
  const [lastRoute, setLastRoute] = useState('—');
  const [confidence, setConfidence] = useState(0);
  const [rawText, setRawText] = useState('');
  const [lastCrop, setLastCrop] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [vehicleEnabled, setVehicleEnabled] = useState(false);
  const [busBox, setBusBox] = useState(null);
  const [debugLines, setDebugLines] = useState([]);
  const [debugOpen, setDebugOpen] = useState(false);

  const pushDebug = (line) => {
    const text = `${new Date().toLocaleTimeString('zh-TW', { hour12: false })} ${line}`;
    setDebugLines((items) => [text, ...items].slice(0, 6));
  };

  const stopCamera = () => {
    setPreviewReady(false);
    cameraRequestRef.current += 1;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  };

  const startCamera = async () => {
    const request = ++cameraRequestRef.current;
    setStatus('正在啟用 App 內相機...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      if (request !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
        const ready = await waitForVideoReady(videoRef.current, 3200);
        if (request !== cameraRequestRef.current) return;
        debugLog('camera-started', { ready, videoWidth: videoRef.current?.videoWidth || 0, videoHeight: videoRef.current?.videoHeight || 0, readyState: videoRef.current?.readyState || 0 });
      }
      setStatus('相機預覽已啟用');
      pushDebug(`WebView 相機 ready=${videoRef.current?.videoWidth || 0}x${videoRef.current?.videoHeight || 0}`);
    } catch (e) {
      if (request !== cameraRequestRef.current) return;
      console.error(e);
      setStatus('App 內相機啟用失敗。請改用「拍照辨識」；它會用系統相機拍一張後回到 App 辨識。');
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
    if (mirrorRef.current) {
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(v, visible.sx, visible.sy, visible.sw, visible.sh, 0, 0, c.width, c.height);
    debugLog('capture-video', { videoWidth: v.videoWidth, videoHeight: v.videoHeight, canvasWidth: c.width, canvasHeight: c.height, visible });
    return c.toDataURL('image/jpeg', 0.86);
  };

  const takePhoto = async () => {
    setStatus('開啟拍照辨識：拍一張公車車頭後會回到 App OCR。');
    const photo = await Camera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.DataUrl,
      quality: 76,
      width: 1600,
      height: 1600,
      allowEditing: false,
      saveToGallery: false,
      promptLabelHeader: '拍攝公車車頭',
      promptLabelPhoto: '拍照',
      promptLabelPicture: '相機',
    });
    return photo.dataUrl;
  };

  const selectPhoto = async () => {
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
    if (!activeRef.current) return null;
    debugLog('gallery-import-picked', { hasWebPath: Boolean(photo?.webPath), hasPath: Boolean(photo?.path), format: photo?.format || '' });
    pushDebug('相簿匯入：圖片讀取與縮放中');
    setStatus('已選擇照片，正在讀取並縮小圖片...');
    const dataUrl = await withTimeout(dataUrlFromPhotoUri(photo, 1600), 12000, 'gallery image load');
    if (activeRef.current) {
      debugLog('gallery-import-ready', { dataUrlChars: dataUrl.length });
      pushDebug('相簿匯入：開始 OCR/候選框分析');
    }
    return dataUrl;
  };

  const loadVehicleDetector = async (isCurrent) => {
    const detector = vehicleDetectorRef.current ??= createVehicleDetector(async () => {
      const tf = await import('@tensorflow/tfjs');
      const webglReady = await tf.setBackend('webgl').catch(() => false);
      if (!webglReady) await tf.setBackend('cpu');
      await tf.ready();
      const cocoSsd = await import('@tensorflow-models/coco-ssd');
      return cocoSsd.load({ base: 'lite_mobilenet_v2' });
    });
    const startedAt = performance.now();
    if (!vehicleEnabledRef.current) setEngineStatus('正在載入 COCO-SSD 公車偵測...');
    try {
      const model = await withTimeout(detector.load(), VEHICLE_TIMEOUT_MS, 'COCO-SSD model load');
      if (!model || !isCurrent()) return null;
      vehicleEnabledRef.current = true;
      setVehicleEnabled(true);
      debugLog('vehicle-model-ready', { elapsedMs: Math.round(performance.now() - startedAt) });
      setEngineStatus('COCO-SSD 公車偵測已啟用');
      return detector;
    } catch (error) {
      debugLog('vehicle-model-failed', { elapsedMs: Math.round(performance.now() - startedAt), message: String(error) });
      if (isCurrent()) setEngineStatus('COCO-SSD 暫時無法使用，改用中央區域 OCR');
      return null;
    }
  };

  const detectBusCanvas = async (canvas, isCurrent) => {
    const detector = await loadVehicleDetector(isCurrent);
    if (!detector) return null;
    setEngineStatus('COCO-SSD 尋找公車中...');
    const maxSide = 640;
    const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
    const detCanvas = document.createElement('canvas');
    detCanvas.width = Math.max(1, Math.round(canvas.width * scale));
    detCanvas.height = Math.max(1, Math.round(canvas.height * scale));
    detCanvas.getContext('2d').drawImage(canvas, 0, 0, detCanvas.width, detCanvas.height);
    const startedAt = performance.now();
    let preds;
    try {
      const prediction = detector.predict(detCanvas, 8);
      if (!prediction) return null;
      preds = await withTimeout(prediction, VEHICLE_TIMEOUT_MS, 'COCO-SSD prediction');
    } catch (error) {
      debugLog('vehicle-prediction-failed', { elapsedMs: Math.round(performance.now() - startedAt), message: String(error) });
      if (isCurrent()) setEngineStatus('COCO-SSD 偵測失敗，改用中央區域 OCR');
      return null;
    }
    if (!isCurrent()) return null;
    debugLog('vehicle-predictions', { elapsedMs: Math.round(performance.now() - startedAt), count: preds.length, preds: preds.slice(0, 5).map(p => ({ class: p.class, score: Math.round(p.score * 100), bbox: p.bbox?.map(v => Math.round(v)) })) });
    const best = chooseBestVehicle(preds);
    if (!best) {
      setEngineStatus('COCO-SSD 未找到公車，改用中央區域 OCR');
      return null;
    }
    const mapped = expandRect({ ...best, x: best.x / scale, y: best.y / scale, w: best.w / scale, h: best.h / scale }, canvas, 0.06);
    setEngineStatus(`COCO-SSD 找到 ${best.label} ${(best.score * 100).toFixed(0)}%，開始 OCR`);
    return mapped;
  };

  const runOcr = async (canvas, label = 'roi', timeoutMs = OCR_TIMEOUT_MS) => {
    setEngineStatus(`OCR 辨識中：${label}`);
    const startedAt = performance.now();
    const reusedWorker = Boolean(ocrWorkerRef.current);
    const workerPromise = ocrWorkerRef.current ??= import('tesseract.js').then(({ createWorker }) =>
      createWorker('eng', undefined, { errorHandler: (error) => debugLog('ocr-worker-error', { message: String(error) }) }),
    );
    let result;
    let setupMs = 0, preprocessMs = 0, engineStartedAt = 0;
    try {
      result = await withTimeout(
        workerPromise.then((worker) => {
          if (ocrWorkerRef.current !== workerPromise) throw new Error('OCR worker released');
          setupMs = performance.now() - startedAt;
          const preprocessStartedAt = performance.now();
          const processed = preprocessForOcr(canvas, label);
          preprocessMs = performance.now() - preprocessStartedAt;
          engineStartedAt = performance.now();
          debugLog('ocr-start', { label, reusedWorker, width: processed.width, height: processed.height });
          return worker.recognize(processed);
        }),
        Math.max(1, timeoutMs),
        `OCR ${label}`
      );
    } catch (error) {
      if (ocrWorkerRef.current === workerPromise) {
        ocrWorkerRef.current = null;
        releaseOcrWorker(workerPromise);
      }
      debugLog('ocr-timeout-or-failed', { label, elapsedMs: Math.round(performance.now() - startedAt), message: String(error) });
      throw error;
    }
    const text = result?.data?.text || '';
    const conf = Number(result?.data?.confidence || 0);
    debugLog('ocr-done', { label, reusedWorker, setupMs: Math.round(setupMs), preprocessMs: Math.round(preprocessMs), engineMs: Math.round(performance.now() - engineStartedAt), elapsedMs: Math.round(performance.now() - startedAt), confidence: Math.round(conf), text: summarizeText(text, 50) });
    setEngineStatus('OCR 已就緒');
    return { text, confidence: conf, setupMs, preprocessMs, engineMs: performance.now() - engineStartedAt };
  };

  const commitResult = async ({ route, raw, score, ocrConfidence, frame, crop, rect, vehicle, source, allCandidates, frameWidth, frameHeight, timings, isCurrent }) => {
    setLastRoute(route || '—');
    setConfidence(score || 0);
    setRawText(raw || '');
    if (crop) setLastCrop(crop);
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
    const shouldSpeak = !mutedRef.current && (lastSpokenRef.current.route !== route || now - lastSpokenRef.current.at > 5000);
    if (shouldSpeak) {
      lastSpokenRef.current = { route, at: now };
      const canSpeak = () => !mutedRef.current && isCurrent();
      void vibrateOk().then(() => {
        if (canSpeak()) return speak(`辨識到 ${route}`, canSpeak);
      });
    }
    const saveStartedAt = performance.now();
    try {
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
        busBox: vehicle || null,
        searchSource: vehicle ? 'coco-ssd' : 'center',
        ocrConfidence,
        timings,
        panelBox: rect || null,
        allCandidates: allCandidates.slice(0, 8),
        imagePath,
        cropPath,
        isNight: new Date().getHours() >= 18 || new Date().getHours() <= 5,
        isConfirmed: false,
      });
      debugLog('recognize-save', { elapsedMs: Math.round(performance.now() - saveStartedAt) });
    } catch (error) {
      debugLog('recognize-save-failed', { message: String(error) });
      if (isCurrent()) setStatus(`已辨識：${route}，但紀錄儲存失敗`);
    }
  };

  const runNativeRecognition = async (dataUrl, source, autoSession, isCurrent) => {
    const startedAt=performance.now();
    const diagnostic={source,outcome:'cancelled',stage:'native-ocr',attempted:1};
    try {
      setStatus('正在讀取公車路線號碼…');setEngineStatus('手機原生文字辨識');
      const context=readRecognitionContext();
      const result=await runNativePipeline(dataUrl,{recognize:recognizeNativeText,context,isCurrent});
      diagnostic.attempted=result.attempted;
      if(!isCurrent())return;
      const selection=result.selection;
      diagnostic.ocrMs=Math.round(performance.now()-startedAt);
      diagnostic.pipelineMs=diagnostic.ocrMs;
      debugLog('native-ocr-result',{engine:result.engine,elapsedMs:diagnostic.ocrMs,lines:result.lines,selected:selection.best?.route||'',reliable:selection.reliable});
      setBusBox(null);setCandidates(selection.candidates.map(c=>({...c.line,label:c.route,score:c.score})));
      const best=selection.best;
      const frame=await canvasFromDataUrl(dataUrl);
      if(!isCurrent())return;
      const rect=best?{x:best.line.x*frame.width/result.width,y:best.line.y*frame.height/result.height,w:best.line.w*frame.width/result.width,h:best.line.h*frame.height/result.height,label:'原生文字區',score:best.score}:null;
      const crop=rect?cropCanvas(frame,rect,1).toDataURL('image/jpeg',.9):'';
      const raw=result.lines.map(l=>l.text).join(' ');
      setRawText(raw);setLastCrop(crop);
      if(!best||!selection.reliable){
        diagnostic.outcome=selection.rejected.length&&!best?'station-mismatch':best?'unconfirmed':'no-result';
        setLastRoute(best?.route||'—');setConfidence(best?.route?0.5:0);
        if(autoSession)stableRef.current={route:'',count:0};
        setStatus(best?`疑似 ${best.route}，尚未確認，暫不報讀。請再對準車頭號碼。`:selection.rejected.length?`讀到 ${[...new Set(selection.rejected)].join('、')}，與所選站點不符。可清除站點再試。`:'尚未讀到號碼，請讓車頭路線顯示器清楚出現在畫面內。');
        return;
      }
      if(autoSession){
        stableRef.current=stableRef.current.route===best.route?{route:best.route,count:stableRef.current.count+1}:{route:best.route,count:1};
        if(stableRef.current.count<2){diagnostic.outcome='unconfirmed';setLastRoute(best.route);setConfidence(.5);setStatus(`疑似 ${best.route}，正在做第二次確認，暫不報讀。`);return true;}
      }
      diagnostic.outcome='recognized';diagnostic.stage='commit';
      const timings={ocrMs:diagnostic.ocrMs,elapsedMs:diagnostic.pipelineMs,attempted:result.attempted,engine:result.engine};
      debugLog('recognize-result',{source,route:best.route,...timings});
      await commitResult({route:best.route,raw,score:Math.max(.72,best.score),ocrConfidence:best.ocrConfidence*100,frame:dataUrl,crop,rect,vehicle:null,source,allCandidates:selection.candidates.map(c=>({...c.line,label:c.route,score:c.score})),frameWidth:frame.width,frameHeight:frame.height,timings,isCurrent});
      diagnostic.stage='done';
    }catch(error){diagnostic.outcome='error';if(isCurrent()){setLastRoute('—');setConfidence(0);setStatus(`辨識暫時無法完成：${String(error?.message||error).slice(0,70)}。請再試一次。`);}debugLog('native-ocr-failed',{message:String(error)});}
    finally{diagnostic.totalMs=Math.round(performance.now()-startedAt);recordRecognitionTelemetry(diagnostic);if(isCurrent())setEngineStatus('手機辨識待命');}
  };

  const runRecognition = async (dataUrl, source, autoSession, isCurrent) => {
    if(canUseNativeOcr())return runNativeRecognition(dataUrl,source,autoSession,isCurrent);
    const startedAt = performance.now();
    const deadline = startedAt + RECOGNITION_BUDGET_MS;
    const stationContext=readRecognitionContext();
    const rejectedRoutes=new Set();
    const diagnostic = { source, outcome: 'cancelled', stage: 'decode', attempted: 0, ocrSetupMs: 0, preprocessMs: 0, ocrEngineMs: 0 };
    let budgetReached = false;
    try {
      setStatus('抓取畫面並尋找公車/號碼區...');
      const canvas = await canvasFromDataUrl(dataUrl);
      if (!isCurrent()) return;
      const decodeMs = Math.round(performance.now() - startedAt);
      diagnostic.decodeMs = decodeMs;
      diagnostic.stage = 'vehicle';

      let searchCanvas = canvas;
      let offset = { x: 0, y: 0 };
      let vehicle = null;

      const isPhoto = source === 'gallery-photo-ocr' || source === 'camera-photo-ocr';
      const useVehicleDetector = vehicleEnabledRef.current || isPhoto;
      debugLog('recognize-start', { source, width: canvas.width, height: canvas.height, useVehicleDetector, decodeMs });
      const vehicleStartedAt = performance.now();
      if (useVehicleDetector) {
        let vehicleStageActive = true;
        try {
          vehicle = await withTimeout(
            detectBusCanvas(canvas, () => isCurrent() && vehicleStageActive),
            Math.max(1, Math.min(VEHICLE_STAGE_BUDGET_MS, deadline - performance.now())),
            'vehicle stage'
          );
        } catch (error) {
          debugLog('vehicle-budget-fallback', { message: String(error) });
        } finally { vehicleStageActive = false; }
      }
      if (!isCurrent()) return;
      const vehicleMs = Math.round(performance.now() - vehicleStartedAt);
      diagnostic.vehicleMs = vehicleMs;
      diagnostic.stage = 'roi';
      setBusBox(vehicle);

      const roiStartedAt = performance.now();
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
      let best = { route: '', raw: '', score: 0, crop: null, rect: panels[0], ocrConfidence: null };

      const maxPanels = source.includes('camera-photo') ? Math.min(5, panelsLocal.length) : Math.min(4, panelsLocal.length);
      const roiMs = Math.round(performance.now() - roiStartedAt);
      diagnostic.roiMs = roiMs;
      diagnostic.stage = 'ocr';
      const ocrStartedAt = performance.now();
      let attempted = 0;
      for (let i = 0; i < maxPanels; i += 1) {
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 250) { budgetReached = true; break; }
        if (!isCurrent()) return;
        setStatus(`正在辨識候選 ${i + 1}/${maxPanels}，本輪最多約 12 秒`);
        const rectLocal = panelsLocal[i];
        const rectGlobal = panels[i];
        const cropCanvasEl = cropCanvas(searchCanvas, rectLocal, 2.2);
        attempted += 1;
        diagnostic.attempted = attempted;
        let ocr;
        try {
          ocr = await runOcr(cropCanvasEl, rectGlobal.label || `ROI${i + 1}`, Math.min(OCR_TIMEOUT_MS, Math.max(1, deadline - performance.now())));
        } catch (error) {
          if (!/timeout/i.test(String(error))) throw error;
          budgetReached = true;
          break;
        }
        diagnostic.ocrSetupMs += ocr.setupMs;
        diagnostic.preprocessMs += ocr.preprocessMs;
        diagnostic.ocrEngineMs += ocr.engineMs;
        if (!isCurrent()) return;
        const raw = ocr.text || '';
        const isRedLed = rectGlobal.kind === 'red-led-color';
        const literalRoute = extractLiteralRouteText(raw);
        const redShapeRoute = '';
        const route = isRedLed
          ? (literalRoute || normalizeRouteText(raw))
          : (normalizeRouteText(raw) || '');
        debugLog('route-candidate', { label: rectGlobal.label || `ROI${i + 1}`, route: route || '', redShapeRoute, confidence: Math.round(ocr.confidence || 0), raw: summarizeText(raw, 50), digitLike: digitLikeCount(raw) });
        const digitCountForReliable = (route.match(/\d/g) || []).length;
        const redLedReliable = rectGlobal.kind === 'red-led-color' && route && digitCountForReliable >= 3 && digitCountForReliable <= 4 && Number(ocr.confidence || 0) >= 6 && !isNoisyOcrRaw(raw);
        const visuallyReliable = Boolean(redShapeRoute) || isReliableRoute(route, raw, ocr.confidence, rectGlobal.score) || redLedReliable || (isPhoto && route && digitCountForReliable >= 3 && Number(ocr.confidence || 0) >= 24 && !isNoisyOcrRaw(raw));
        const mismatch=visuallyReliable&&!routeMatchesContext(route,stationContext);
        if(mismatch)rejectedRoutes.add(route);
        const reliable=visuallyReliable&&!mismatch;
        const digitCount = (route.match(/\d/g) || []).length;
        const vehicleBoost = vehicle?.label === 'bus' ? 0.08 : vehicle ? 0.03 : 0;
        const score = reliable
          ? Math.min(0.97, 0.48 + rectGlobal.score * 0.22 + vehicleBoost + Math.min(0.14, digitCount * 0.035) + Math.min(0.08, Math.max(0, ocr.confidence) / 1200))
          : Math.min(0.34, rectGlobal.score * 0.20 + vehicleBoost);
        if (score > best.score) best = { route: reliable ? route : '', raw, score, crop: cropCanvasEl, rect: rectGlobal, ocrConfidence: ocr.confidence };
        pushDebug(`OCR候選${i + 1} ${rectGlobal.label || ''} conf=${Math.round(ocr.confidence || 0)} route=${route || '無'} reliable=${reliable ? 'Y' : 'N'}`);
        if (reliable && score > 0.78) break;
      }

      if (!isCurrent()) return;
      const ocrMs = Math.round(performance.now() - ocrStartedAt);
      diagnostic.ocrMs = ocrMs;
      diagnostic.pipelineMs = Math.round(performance.now() - startedAt);
      diagnostic.outcome = budgetReached ? 'budget-reached' : best.route ? 'recognized' : 'no-result';
      const crop = best.crop?.toDataURL('image/jpeg', 0.86) || '';
      const timings = { decodeMs, vehicleMs, roiMs, ocrMs, ocrSetupMs: Math.round(diagnostic.ocrSetupMs), preprocessMs: Math.round(diagnostic.preprocessMs), ocrEngineMs: Math.round(diagnostic.ocrEngineMs), budgetReached, attempted, elapsedMs: Math.round(performance.now() - startedAt) };
      debugLog('recognize-result', { source, route: best.route, ...timings });
      if (autoSession && best.route) {
        if (stableRef.current.route === best.route) stableRef.current.count += 1;
        else stableRef.current = { route: best.route, count: 1 };
        if (stableRef.current.count < 2) {
          setLastRoute(best.route);
          setConfidence(Math.min(best.score, 0.69));
          setRawText(best.raw || '');
          if (crop) setLastCrop(crop);
          diagnostic.outcome = 'unconfirmed';
          setStatus(`疑似 ${best.route}，正在確認第 ${stableRef.current.count}/2 次，不報讀`);
          return true;
        }
      } else if (autoSession) {
        stableRef.current = { route: '', count: 0 };
      }
      diagnostic.stage = 'commit';
      await commitResult({ ...best, score: best.route ? best.score : 0, frame: dataUrl, crop, vehicle, source, allCandidates: panels, frameWidth: canvas.width, frameHeight: canvas.height, timings, isCurrent });
      if (budgetReached && !best.route && isCurrent()) setStatus('本輪等待已達上限，尚未讀到可靠路線。請靠近號碼牌或換一張照片重試。');
      if (!best.route && rejectedRoutes.size && isCurrent()) {
        diagnostic.outcome='station-mismatch';
        setStatus(`讀到 ${[...rejectedRoutes].join('、')}，與「${stationContext.name}」行經路線不符，暫不報讀。請核對站點或清除站點重試。`);
      }
      if (budgetReached && isCurrent()) setEngineStatus('本輪辨識已結束');
      diagnostic.stage = 'done';
    } catch (e) {
      diagnostic.outcome = 'error';
      console.error('[BusVision] recognize failed', e);
      if (isCurrent()) {
        if (autoSession) stableRef.current = { route: '', count: 0 };
        setEngineStatus('辨識暫時無法完成');
        setStatus(`辨識失敗：${String(e?.message || e).slice(0, 70)}`);
      }
    } finally {
      diagnostic.totalMs = performance.now() - startedAt;
      recordRecognitionTelemetry(diagnostic);
      debugLog('recognize-attempt', diagnostic);
    }
  };

  const recognizeDataUrl = async (dataUrl, source, autoSession, isCurrent) => {
    if (recognitionRef.current || !isCurrent()) return;
    const task = runRecognition(dataUrl, source, autoSession, isCurrent);
    recognitionRef.current = task;
    try {
      return await task;
    } finally {
      recognitionRef.current = null;
    }
  };

  const detectOnce = async (autoSession = null) => {
    const scan = { cancelled: false };
    const isCurrent = () => activeRef.current && !scan.cancelled && !photoActionRef.current && (!autoSession || autoRef.current === autoSession);
    if (!isCurrent() || liveScanRef.current || recognitionRef.current) return;
    liveScanRef.current = scan;
    try {
      const v0 = videoRef.current;
      const previewDead = !v0 || !streamRef.current || !v0.videoWidth || v0.readyState < 2;
      if (previewDead) {
        pushDebug('預覽未就緒，重新啟用 WebView 相機');
        stopCamera();
        const request = cameraRequestRef.current;
        await sleep(220);
        if (!isCurrent() || request !== cameraRequestRef.current) return;
        await startCamera();
        if (!isCurrent()) return;
        if (!streamRef.current) {
          if (autoSession) stopAuto({ showStatus: false });
          return;
        }
      }
      if (!isCurrent()) return;
      const source = autoSession ? 'auto-preview-ocr' : 'preview-ocr';
      pushDebug('立即辨識：App 預覽 → 文字方塊定位 → 數字 OCR');
      setStatus('正在從 App 內相機預覽擷取畫面...');
      const dataUrl = await captureFromVideo();
      if (!isCurrent()) return;
      return await recognizeDataUrl(dataUrl, source, autoSession, isCurrent);
    } catch (e) {
      if (!isCurrent()) return;
      if (autoSession) stableRef.current = { route: '', count: 0 };
      if (autoSession && (!videoRef.current?.videoWidth || videoRef.current.readyState < 2)) {
        stopAuto({ showStatus: false });
        stopCamera();
      }
      debugLog('detect-once-failed', { message: String(e?.message || e) });
      pushDebug(`立即辨識失敗：${String(e?.message || e).slice(0, 55)}`);
      setStatus(`立即辨識抓不到 App 內預覽畫面：${String(e?.message || e).slice(0, 60)}。這次不會自動開系統相機；請手動按「拍照辨識」作備援。`);
    } finally {
      liveScanRef.current = null;
    }
  };

  const recognizePhoto = async (readPhoto, source, label) => {
    if (!activeRef.current || photoActionRef.current) return;
    photoActionRef.current = true;
    if (liveScanRef.current) liveScanRef.current.cancelled = true;
    const isCurrent = () => activeRef.current;
    stopAuto();
    stopCamera();
    try {
      // 交還 WebView 相機資源後才啟動系統相機或相簿。
      await sleep(180);
      if (!isCurrent()) return;
      const dataUrl = await readPhoto();
      await recognitionRef.current;
      if (!isCurrent()) return;
      if (!dataUrl) throw new Error('沒有可讀取的照片');
      await recognizeDataUrl(dataUrl, source, null, isCurrent);
    } catch (e) {
      debugLog('photo-acquisition-failed', { source, message: String(e?.message || e) });
      if (isCurrent()) setStatus(`${label}取消或失敗：${String(e?.message || e).slice(0, 70)}`);
    } finally {
      photoActionRef.current = false;
    }
  };

  const startAuto = () => {
    if (!activeRef.current || document.hidden || autoRef.current || photoActionRef.current) return;
    const session = { timer: null };
    autoRef.current = session;
    stableRef.current = { route: '', count: 0 };
    setRunning(true);
    const tick = async () => {
      const startedAt = performance.now();
      const scanAgainSoon = liveScanRef.current || recognitionRef.current || await detectOnce(session);
      if (autoRef.current === session) {
        const delay = scanAgainSoon
          ? AUTO_CONFIRM_INTERVAL_MS
          : Math.max(AUTO_CONFIRM_INTERVAL_MS, AUTO_INTERVAL_MS - (performance.now() - startedAt));
        session.timer = setTimeout(tick, delay);
      }
    };
    void tick();
  };
  const stopAuto = ({ showStatus = true } = {}) => {
    setRunning(false);
    clearTimeout(autoRef.current?.timer);
    autoRef.current = null;
    stableRef.current = { route: '', count: 0 };
    if (showStatus) setStatus('已暫停自動辨識');
  };

  const toggleMute = () => {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
    if (mutedRef.current) {
      void TextToSpeech.stop().catch(() => {});
      window.speechSynthesis?.cancel();
    }
  };

  const toggleMirror = () => {
    mirrorRef.current = !mirrorRef.current;
    setMirrorMode(mirrorRef.current);
  };

  useEffect(() => {
    activeRef.current = true;
    // Release camera resources on backgrounding. Startup policy is set by App.
    const pausePreview = () => {
      if (!activeRef.current) return;
      if (liveScanRef.current) liveScanRef.current.cancelled = true;
      if (autoRef.current) stopAuto();
      stopCamera();
      void TextToSpeech.stop().catch(() => {});
      window.speechSynthesis?.cancel();
    };
    const onVisibility = () => { if (document.hidden) pausePreview(); };
    document.addEventListener('visibilitychange', onVisibility);
    const pauseListener = App.addListener('pause', pausePreview);
    // Defer until the first render settles and discard the timer on unmount.
    const entryTimer = autoStartOnEntry ? setTimeout(startAuto, 0) : null;
    return () => {
      activeRef.current = false;
      clearTimeout(entryTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      void pauseListener.then((listener) => listener.remove()).catch(() => {});
      clearTimeout(autoRef.current?.timer);
      autoRef.current = null;
      releaseOcrWorker(ocrWorkerRef.current);
      ocrWorkerRef.current = null;
      vehicleDetectorRef.current?.dispose();
      vehicleDetectorRef.current = null;
      stopCamera();
    };
  }, []);

  return (
    <div className="bv-recognizer">
      <video ref={videoRef} autoPlay playsInline muted onPlaying={() => setPreviewReady(true)} className={`bv-video ${previewReady ? 'ready' : ''}`} style={{ transform: mirrorMode ? 'scaleX(-1)' : 'none' }} />

      <div className="bv-overlay">
        <header className="bv-rec-header">
          <div className="bv-pill">{engineStatus}</div>
          <div className="bv-header-actions">
            <button hidden={canUseNativeOcr()} onClick={() => loadVehicleDetector(() => activeRef.current)} className={`bv-chip ${vehicleEnabled ? 'active' : ''}`}>{vehicleEnabled ? '車體定位開啟' : '車體定位'}</button>
            <button onClick={toggleMirror} className="bv-chip">{mirrorMode ? '鏡像開' : '鏡像關'}</button>
            <button onClick={toggleMute} className="bv-chip">{muted ? '靜音' : '報讀'}</button>
          </div>
        </header>

        {lastRoute !== '—' && confidence > 0 && (
          <section className={`bv-result-card floating ${confidence >= 0.72 ? 'high' : 'mid'}`} aria-live="polite">
            <div className="label">{confidence >= .72 ? '辨識到' : '待確認'}</div>
            <div className="route">{lastRoute}</div>
            <div className="confidence">規則分數 {Math.round(confidence * 100)} / 100</div>
          </section>
        )}

        <div className="bv-aim-guide"><span>請將公車車頭放在框內</span></div>
        {busBox && <div className="bv-bus-hint">已定位車輛範圍</div>}

        <div className="bv-status-toast" role="status">{status}</div>
        {stationDisplay&&<div className="station-context"><span>站點輔助：{stationDisplay.name}<small>{stationDisplay.routes.length} 條行經路線 · 30 分鐘內有效</small></span><button onClick={()=>{clearRecognitionContext();setStationDisplay(null);}}>清除</button></div>}

        <div className={`bv-debug-panel ${debugOpen ? 'open' : 'collapsed'}`}>
          <button type="button" className="bv-debug-toggle" onClick={() => setDebugOpen((v) => !v)}>
            {debugOpen ? '收起辨識詳情' : '辨識詳情'}
          </button>
          {debugOpen && (
            <div className="bv-debug-body">
              <div>{vehicleEnabled ? '已啟用 COCO-SSD 車體偵測' : '拍照及匯入會嘗試 COCO-SSD 車體偵測'}</div>
              <div>候選區：{candidates.slice(0, 4).map((c) => `${c.label}${Math.round(c.score * 100)}%`).join(' / ') || '尚未分析'}</div>
              <div>OCR：{rawText ? rawText.replace(/\s+/g, ' ').slice(0, 80) : '—'}</div>
              {debugLines.map((line, idx) => <div key={idx} className="debug-line">{line}</div>)}
            </div>
          )}
        </div>

        {lastCrop && <img className="bv-crop-preview" src={lastCrop} alt="號碼牌裁切預覽" />}

        <div className="bv-bottom-panel compact-four">
          <details className="bv-fold-card" open>
            <summary><span>對準車頭路線號碼</span><b>{running ? '自動辨識中' : '準備辨識'}</b></summary>
            <div className="bv-control-row main-actions four-actions">
              <button className="primary" onClick={() => detectOnce()}><ScanLine size={22}/><strong>立即辨識</strong></button>
              <button onClick={() => recognizePhoto(takePhoto, 'camera-photo-ocr', '拍照辨識')}><CameraIcon size={22}/><strong>拍照辨識</strong></button>
              <button onClick={() => recognizePhoto(selectPhoto, 'gallery-photo-ocr', '相簿匯入')}><ImagePlus size={22}/><strong>匯入圖片</strong></button>
              <button onClick={running ? stopAuto : startAuto}>{running ? <Pause size={22}/> : <Play size={22}/>}<strong>{running ? '暫停自動' : '自動辨識'}</strong></button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
