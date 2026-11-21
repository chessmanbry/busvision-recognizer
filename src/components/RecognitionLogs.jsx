import React, { useEffect, useMemo, useState } from 'react';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { readLogs, updateLog, clearLogs as clearStoredLogs } from '../services/recognitionStorage.js';

import { readRecognitionTelemetry } from '../services/recognitionTelemetry.js';

const FOLDER_NAME = 'BusData';
const DIAGNOSTIC_IMAGE_LIMIT = 12;
const DIAGNOSTIC_EXPORT_VERSION = '2.0.0-rc.35';

async function toSrc(path) {
  if (!path) return '';
  if (path.startsWith('data:')) return path;
  const uri = await Filesystem.getUri({ directory: Directory.Data, path });
  return Capacitor.convertFileSrc(uri.uri);
}


async function readImageBase64(path) {
  if (!path) return { ok: false, reason: 'empty-path' };
  try {
    const res = await Filesystem.readFile({ path, directory: Directory.Data });
    return { ok: true, path, mimeType: 'image/jpeg', base64: res.data || '' };
  } catch (err) {
    return { ok: false, path, reason: err?.message || String(err) };
  }
}

function compactLogForDiagnostics(item) {
  return {
    id: item.id,
    createdAtMs: item.createdAtMs,
    createdAt: item.createdAt,
    routeNumber: item.routeNumber,
    correctedRouteNumber: item.correctedRouteNumber,
    source: item.source,
    confidence: item.confidence,
    ocrConfidence: item.ocrConfidence ?? null,
    timings: item.timings || null,
    searchSource: item.searchSource || null,
    frameWidth: item.frameWidth || item.imageWidth || null,
    frameHeight: item.frameHeight || item.imageHeight || null,
    imagePath: item.imagePath,
    cropPath: item.cropPath,
    ocrRawText: item.ocrRawText,
    busBox: item.busBox,
    panelBox: item.panelBox,
    allCandidates: item.allCandidates || [],
    isNight: item.isNight,
    isConfirmed: item.isConfirmed,
  };
}

export default function RecognitionLogs() {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await readLogs();
      setLogs(data.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)));
      setError('');
    } catch (error) {
      setError(`讀取紀錄失敗：${error?.message || error}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    readLogs().then((data) => {
      if (active) setLogs(data.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)));
    }).catch((error) => {
      if (active) setError(`讀取紀錄失敗：${error?.message || error}`);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return logs;
    return logs.filter((it) => String(it.routeNumber || '').includes(q) || String(it.correctedRouteNumber || '').includes(q) || String(it.ocrRawText || '').includes(q));
  }, [logs, query]);

  const saveCorrection = async () => {
    if (!editing) return;
    try {
      const next = await updateLog(editing.id, { correctedRouteNumber: editing.correctedRouteNumber || '', isConfirmed: true });
      setEditing(null);
      setLogs(next.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)));
      setError('');
    } catch (error) {
      setError(`修正紀錄失敗：${error?.message || error}`);
    }
  };

  const clearLogs = async () => {
    const ok = window.confirm('確定清空辨識紀錄？圖片檔案仍會保留在 App 資料夾內。');
    if (!ok) return;
    try {
      await clearStoredLogs();
      setLogs([]);
      setError('');
    } catch (error) {
      setError(`清空紀錄失敗：${error?.message || error}`);
    }
  };

  const exportLogs = async () => {
    const sorted = [...logs].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    const withImages = sorted.slice(0, DIAGNOSTIC_IMAGE_LIMIT);
    const imageBundles = [];

    for (const item of withImages) {
      const frame = await readImageBase64(item.imagePath);
      const crop = await readImageBase64(item.cropPath);
      imageBundles.push({
        id: item.id,
        routeNumber: item.routeNumber,
        correctedRouteNumber: item.correctedRouteNumber,
        source: item.source,
        frame,
        crop,
      });
    }

    const payload = {
      exportType: 'busvision-recognition-diagnostics',
      exportVersion: DIAGNOSTIC_EXPORT_VERSION,
      recognitionAttempts: readRecognitionTelemetry(),
      exportedAt: new Date().toISOString(),
      note: '此檔案包含辨識紀錄、候選框座標、OCR 原文，以及最近紀錄的完整影像與裁切影像 base64，供演算法除錯使用。',
      summary: {
        totalLogs: logs.length,
        exportedImageLogs: imageBundles.length,
        diagnosticImageLimit: DIAGNOSTIC_IMAGE_LIMIT,
        confirmedLogs: logs.filter((x) => x.isConfirmed).length,
      },
      logs: sorted.map(compactLogForDiagnostics),
      imageBundles,
    };

    const filename = `recognition_diagnostic_export_${Date.now()}.json`;
    await Filesystem.writeFile({ path: `${FOLDER_NAME}/${filename}`, directory: Directory.Data, encoding: Encoding.UTF8, data: JSON.stringify(payload, null, 2), recursive: true });
    try {
      const uri = await Filesystem.getUri({ directory: Directory.Data, path: `${FOLDER_NAME}/${filename}` });
      await Share.share({ title: 'BusVision 除錯資料包', text: 'BusVision recognition diagnostics with frame/crop images', url: uri.uri, dialogTitle: '匯出除錯資料包' });
    } catch {
      alert(`已匯出除錯資料包：${filename}`);
    }
  };

  const openPreview = async (item) => {
    const frameSrc = await toSrc(item.imagePath || item.cropPath);
    const cropSrc = await toSrc(item.cropPath || item.imagePath);
    setPreview({ item, frameSrc, cropSrc, showAll: true });
  };

  const boxStyle = (box, idx, selected = false) => {
    if (!box || !preview?.item) return {};
    const frameW = preview.item.frameWidth || preview.item.imageWidth || 0;
    const frameH = preview.item.frameHeight || preview.item.imageHeight || 0;
    if (!frameW || !frameH) return { display: 'none' };
    return {
      left: `${(box.x / frameW) * 100}%`,
      top: `${(box.y / frameH) * 100}%`,
      width: `${(box.w / frameW) * 100}%`,
      height: `${(box.h / frameH) * 100}%`,
      borderColor: selected ? '#ffd84d' : idx % 2 ? '#2ee59d' : '#ff5a66',
    };
  };

  return (
    <div className="bv-page bv-log-page">
      <header className="bv-topbar">
        <div>
          <div className="bv-title">辨識資料庫</div>
          <div className="bv-subtitle">每次辨識會留下原始 OCR、候選框、裁切圖；匯出按鈕會打包圖片與座標供除錯。</div>
        </div>
        <button className="bv-small-btn" onClick={load}>重新整理</button>
      </header>
      {error && <p role="alert">{error}</p>}

      <div className="bv-log-tools">
        <input aria-label="搜尋路線" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋 932 / F512 / OCR 原文" />
        <button onClick={() => exportLogs().catch((error) => setError(`匯出紀錄失敗：${error?.message || error}`))}>匯出除錯資料包</button>
        <button className="danger" onClick={clearLogs}>清空</button>
      </div>

      <div className="bv-stats-row">
        <div><strong>{logs.length}</strong><span>總紀錄</span></div>
        <div><strong>{logs.filter((x) => x.isConfirmed).length}</strong><span>已修正/確認</span></div>
        <div><strong>{logs.filter((x) => (x.confidence || 0) >= 0.7).length}</strong><span>高分候選</span></div>
      </div>

      {loading ? <div className="bv-empty">讀取中...</div> : filtered.length === 0 ? <div className="bv-empty">目前沒有辨識紀錄。</div> : (
        <div className="bv-log-list">
          {filtered.map((it) => (
            <article className="bv-log-card" key={it.id}>
              <div className="bv-log-main">
                <div className="bv-route-badge">{it.correctedRouteNumber || it.routeNumber || '未定'}</div>
                <div className="bv-log-meta">
                  <div className="time">{it.createdAt || ''}</div>
                  <div>OCR：{it.ocrRawText || '—'}</div>
                  <div>規則分數：{Math.round((it.confidence || 0) * 100)} / 100 來源：{it.source || 'auto'}</div>
                </div>
              </div>
              <div className="bv-log-actions">
                <button onClick={() => openPreview(it).catch((error) => setError(`讀取圖片失敗：${error?.message || error}`))}>看裁切</button>
                <button onClick={() => setEditing({ ...it, correctedRouteNumber: it.correctedRouteNumber || it.routeNumber || '' })}>修正</button>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing && (
        <div className="bv-modal" role="dialog" aria-modal="true">
          <div className="bv-modal-card">
            <h2>修正辨識結果</h2>
            <p>原始 OCR：{editing.ocrRawText || '—'}</p>
            <input autoFocus value={editing.correctedRouteNumber} onChange={(e) => setEditing({ ...editing, correctedRouteNumber: e.target.value })} />
            <div className="bv-modal-actions">
              <button onClick={() => setEditing(null)}>取消</button>
              <button className="primary" onClick={saveCorrection}>儲存修正</button>
            </div>
          </div>
        </div>
      )}

      {preview && (
        <div className="bv-modal" onClick={() => setPreview(null)}>
          <div className="bv-modal-card image wide" onClick={(e) => e.stopPropagation()}>
            <h2>候選框檢查</h2>
            <div className="bv-preview-frame">
              <img src={preview.frameSrc} alt="完整畫面與候選框" />
              {preview.item.panelBox && <div className="bv-box selected" style={boxStyle(preview.item.panelBox, 0, true)}>結果</div>}
              {(preview.showAll ? (preview.item.allCandidates || []) : []).slice(0, 10).map((b, idx) => (
                <div key={`${idx}-${b.x}-${b.y}`} className="bv-box" style={boxStyle(b, idx, false)}>{idx + 1}</div>
              ))}
            </div>
            <div className="bv-preview-info">
              結果框：{preview.item.panelBox?.label || '無'}｜候選數：{(preview.item.allCandidates || []).length}
            </div>
            {preview.cropSrc && <img className="bv-preview-crop" src={preview.cropSrc} alt="實際 OCR 裁切圖" />}
            <div className="bv-modal-actions">
              <button onClick={() => setPreview({ ...preview, showAll: !preview.showAll })}>{preview.showAll ? '只看結果框' : '顯示全部候選框'}</button>
              <button onClick={() => setPreview(null)}>關閉</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
