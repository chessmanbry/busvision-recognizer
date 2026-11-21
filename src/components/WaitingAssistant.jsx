import { useCallback, useEffect, useRef, useState } from 'react';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { readWaitingTarget, clearWaitingTarget, matchesTarget, createAlignmentTracker } from '../services/waitingTarget.js';
import { loadArrivals } from '../services/transitApi.js';
import { selectArrival, isFeedFresh, etaLabel } from '../services/transitData.js';
import { createVehicleDetector } from './vehicleDetector.js';

export default function WaitingAssistant({ showNotice, videoRef, running, mutedRef, announce, speak, onAligned, onApproaching, resultHandlerRef }) {
  const [target, setTarget] = useState(readWaitingTarget);
  const [eta, setEta] = useState('更新中');
  const [alignment, setAlignment] = useState('準備車體偵測');
  const [haptics, setHaptics] = useState(() => localStorage.getItem('busvision.hapticsOff') !== 'true');
  const hapticsRef = useRef(haptics), lastTarget = useRef(0), lastFeedback = useRef(0);
  const busSeen = useRef(0);
  const feedback = useCallback(async (text, pulses, current) => {
    if (!current()) return;
    lastFeedback.current = Date.now();
    showNotice(text);
    if (mutedRef.current) announce(text);
    else void speak(text, current);
    for (let i = 0; i < pulses; i++) {
      if (!current() || !hapticsRef.current) break;
      await Haptics.impact({style: ImpactStyle.Light}).catch(() => {});
      if (i + 1 < pulses) await new Promise(resolve => setTimeout(resolve, 180));
    }
  }, [mutedRef, announce, speak, showNotice]);
  useEffect(() => {
    let active = true;
    resultHandlerRef.current = ({route, source, isCurrent}) => {
      const t = readWaitingTarget();
      if (!source.endsWith('preview-ocr') || !matchesTarget(route, t) || Date.now() - busSeen.current > 5000) return false;
      if (Date.now() - lastTarget.current >= 30000) {
        lastTarget.current = Date.now();
        void feedback(`你要的 ${route} 公車出現在畫面中了，請再確認往 ${t.destination || '所選方向'}。`, 2, () => active && isCurrent());
      }
      return true;
    };
    return () => { active = false; resultHandlerRef.current = null; };
  }, [resultHandlerRef, feedback]);
  useEffect(() => {
    let active = true, busy = false, warned = false;
    const current = () => active && !document.hidden;
    async function poll() {
      if (busy || !current()) return;
      const t = readWaitingTarget();
      if (!t) { onApproaching(false); setTarget(null); return; }
      busy = true;
      try {
        const feed = await loadArrivals(t.city);
        if (!current()) return;
        const arrival = selectArrival(feed.rows, t.routeId, t.stop);
        const fresh = isFeedFresh(feed.updatedAt);
        const label = fresh ? etaLabel(arrival?.EstimateTime) : {text:'資料已過期'};
        setEta(label.text + (label.unit || ''));
        const raw = arrival?.EstimateTime;
        const seconds = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
        onApproaching(fresh && seconds >= 0 && seconds <= 180);
        if (!warned && fresh && seconds >= 0 && seconds <= 180) {
          warned = true;
          void feedback(`${t.routeName} 預估三分鐘內到 ${t.stop.name}，可準備舉起手機辨識。`, 0, current);
        }
      } catch { if (current()) {onApproaching(false); setEta('暫無到站資料');} }
      finally { busy = false; }
    }
    if (target) void poll();
    const timer = setInterval(poll, 30000);
    return () => { active = false; clearInterval(timer); onApproaching(false); };
  }, [target, onApproaching, feedback]);
  useEffect(() => {
    busSeen.current = 0;
    if (!running) { const paused = setTimeout(() => {setAlignment('車體偵測已暫停'); onAligned('idle');}, 0); return () => clearTimeout(paused); }
    let active = true, timer;
    const current = () => active && !document.hidden;
    const track = createAlignmentTracker();
    const detector = createVehicleDetector(async () => {
      const tf = await import('@tensorflow/tfjs');
      await import('@tensorflow/tfjs-backend-webgl');
      if (!await tf.setBackend('webgl').catch(() => false)) await tf.setBackend('cpu');
      await tf.ready();
      const coco = await import('@tensorflow-models/coco-ssd');
      return coco.load({base:'lite_mobilenet_v2', modelUrl:'/models/bus/model.json'});
    });
    const preparing = setTimeout(() => {setAlignment('準備車體偵測'); onAligned('idle');}, 0);
    const detectionCanvas = document.createElement('canvas');
    async function tick() {
      if (!current()) return;
      try {
        const video = videoRef.current;
        if (video?.readyState >= 2 && video.videoWidth && !video.paused) {
          const canvas = detectionCanvas;
          const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          const predictions = await detector.predict(canvas, 8);
          if (!current()) return;
          const detected = predictions?.some(p => p.class === 'bus' && p.score >= .55);
          const result = track(!!detected, Date.now());
          if (result.aligned && detected) busSeen.current = Date.now();
          onAligned(result.aligned ? 'bus' : 'searching');
          setAlignment(result.aligned ? '畫面中有公車，正在讀號碼' : '尚未找到公車，請緩慢調整方向');
          if (result.cue && Date.now() - lastFeedback.current > 7000) {
            void feedback(result.cue === 'acquired' ? '畫面中有公車，請保持手機方向。' : '公車離開畫面，請重新對準。', result.cue === 'acquired' ? 1 : 0, current);
          }
        }
      } catch {
        if (current()) { onAligned('idle'); setAlignment('車體偵測暫不可用，號碼辨識仍可使用'); }
      } finally { if (active) timer = setTimeout(tick, 280); }
    }
    detector.load().then(() => { if (current()) void tick(); }).catch(() => {
      if (current()) { onAligned('idle'); setAlignment('車體偵測暫不可用，號碼辨識仍可使用'); }
    });
    return () => { active = false; clearTimeout(timer); clearTimeout(preparing); detector.dispose(); };
  }, [running, videoRef, onAligned, feedback]);
  return <section className="bv-waiting" aria-label="候車與對準提示">
    {target && <div className="bv-wait-target"><strong>等 {target.routeName} · 往 {target.destination || '所選方向'}</strong>
      <span>{target.stop.name} · {eta}</span>
      <button onClick={() => {clearWaitingTarget(); onApproaching(false); setTarget(null);}}>取消候車目標</button>
      <small>僅在此 App 提醒，未通知司機；路線號碼無法單獨確認方向。</small></div>}
    <div className="bv-alignment-text">{alignment}</div>
    <button aria-pressed={haptics} onClick={() => {hapticsRef.current = !hapticsRef.current; setHaptics(hapticsRef.current); localStorage.setItem('busvision.hapticsOff', String(!hapticsRef.current));}}>震動提示{haptics ? '開' : '關'}</button>
  </section>;
}
