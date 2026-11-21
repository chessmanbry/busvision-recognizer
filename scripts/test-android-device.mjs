import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const observe = Number(option('--observe', '0'));
if (!Number.isInteger(observe) || observe < 0 || observe > 600) throw new Error('--observe must be 0–600 seconds');
const sdkAdb = path.join(homedir(), 'Library/Android/sdk/platform-tools/adb');
const adbPath = process.env.ADB || (existsSync(sdkAdb) ? sdkAdb : 'adb');
const pkg = 'com.chessman.busvision2.recognizer';
const component = `${pkg}/com.chessman.busvision2.MainActivity`;
const report = { startedAt: new Date().toISOString(), checks: [], measurements: {}, limits: ['啟動時間不是辨識時間。','未使用帶真值的固定公車照片，不能計算辨識正確率。','未測相機權限拒絕、系統拍照／相簿、語音實際出聲、長時間熱降頻。'] };
const out = path.resolve(option('--out', `test-results/android-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const delay = ms => new Promise(r => setTimeout(r, ms));
let serial, socket, port;
async function adb(...a) { return (await exec(adbPath, serial ? ['-s', serial, ...a] : a, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
function check(name, passed, detail = '') { report.checks.push({ name, passed, detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name} ${detail}`); }
let captureStartedAt = 0;
let seq = 0; const pending = new Map(); const events = [];
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}
async function waitFor(expression) {
  for (let i = 0; i < 30; i++) { if (await evaluate(expression)) return true; await delay(200); }
  return false;
}
async function clickText(text, scope = 'button') {
  const clicked = await evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!b || b.disabled) return false; b.click(); return true; })()`);
  if (!clicked) throw new Error(`找不到可操作的按鈕：${text}`);
}
async function checkDisclosureAccessibility() {
  const focusToggle = "document.querySelector('#bv-actions-toggle').focus()";
  const actionNames = ['立即辨識', '拍照辨識', '匯入圖片'];
  const actionButtons = async () => {
    const { nodes } = await cdp('Accessibility.getFullAXTree');
    return nodes.filter(n => !n.ignored && n.role?.value === 'button' && actionNames.includes(n.name?.value));
  };
  check('折疊時隱藏三個次要操作於無障礙樹', (await actionButtons()).length === 0);
  await evaluate(focusToggle);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  check('Enter 展開選單並留在原焦點', await waitFor("document.activeElement.id === 'bv-actions-toggle' && document.activeElement.getAttribute('aria-expanded') === 'true'"));
  if (await evaluate("document.querySelector('#bv-actions-toggle').getAttribute('aria-expanded') === 'false'")) {
    await clickText('辨識操作', '#bv-actions-toggle');
  }
  const expanded = await actionButtons();
  const expandedNames = expanded.map(n => n.name.value).join('|');
  check('展開後無障礙樹依序包含三個有名稱的按鈕', expandedNames === actionNames.join('|'), expandedNames);
  await evaluate(focusToggle);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  check('展開後 Tab 可到第一個操作', await evaluate("document.activeElement.textContent.trim() === '立即辨識'"));
  check('200% 文字尺寸下操作可捲動到達', await evaluate(`(() => {
    const root = document.documentElement;
    const panel = document.querySelector('.bv-overlay');
    const item = document.querySelector('.bv-debug-toggle');
    root.style.fontSize = '200%';
    try {
      item.scrollIntoView({block:'nearest'});
      const rect = item.getBoundingClientRect(), bounds = panel.getBoundingClientRect();
      return panel.scrollWidth <= panel.clientWidth + 1 && rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1;
    } finally {
      root.style.fontSize = '';
      panel.scrollTop = 0;
    }
  })()`));
  await clickText('辨識操作', '#bv-actions-toggle');
  check('收合後次要操作退出無障礙樹', (await actionButtons()).length === 0);
}
async function checkMockLocation() {
  // Mock only the GPS and permission response. The official station and route feeds stay live.
  await evaluate(`(() => {
    window.__bvLocationBridge = window.Capacitor.nativePromise;
    window.Capacitor.nativePromise = function (plugin, method, args) {
      if (plugin === 'Geolocation' && method === 'checkPermissions')
        return Promise.resolve({ location: 'granted', coarseLocation: 'granted' });
      if (plugin === 'Geolocation' && method === 'getCurrentPosition')
        return Promise.resolve({ timestamp: Date.now(), coords: { latitude: 24.94489, longitude: 121.37368, accuracy: 3 } });
      return window.__bvLocationBridge.call(this, plugin, method, args);
    };
  })()`);
  try {
    await clickText('附近站牌', '.bv-location-toggle');
    check('模擬 GPS 座標對應官方臺北大學正門站牌',
      await waitFor("document.querySelector('.bv-location-toggle')?.textContent.includes('臺北大學正門')"));
    check('附近實體站位載入行經路線數',
      await waitFor("/[1-9]\\d* 條路線/.test(document.querySelector('.bv-station-location small')?.textContent)"));
    check('附近站名會通知螢幕閱讀器',
      await evaluate("document.querySelector('[role=status]')?.textContent.includes('附近站牌：臺北大學正門')"));
  } finally {
    await evaluate("window.Capacitor.nativePromise = window.__bvLocationBridge; delete window.__bvLocationBridge; location.reload();");
  }
}
async function checkAutoRecognition(label, since) {
  check(`${label}開啟相機並進入自動辨識`, await waitFor("document.querySelector('.bv-video.ready')?.videoWidth > 0 && [...document.querySelectorAll('.bv-auto-toggle')].some(b => b.textContent.includes('暫停自動'))"));
  check(`${label}完成至少一輪影像辨識`, await waitFor(`JSON.parse(localStorage.getItem('busvision.recognition.timings.v1') || '[]').some(r => r.source === 'auto-preview-ocr' && Date.parse(r.at) >= ${since} && !['error','cancelled'].includes(r.outcome))`));
}
try {
  const devices = (await adb('devices')).split('\n').filter(l => /\tdevice\s*$/.test(l)).map(l => l.split('\t')[0]);
  serial = option('--serial', devices.length === 1 ? devices[0] : undefined);
  if (!serial || !devices.includes(serial)) throw new Error('請連接並授權一支手機，或使用 --serial 指定裝置');
  report.device = { model: (await adb('shell', 'getprop', 'ro.product.model')).trim(), android: (await adb('shell', 'getprop', 'ro.build.version.release')).trim() };
  const info = await adb('shell', 'dumpsys', 'package', pkg);
  report.version = { name: info.match(/versionName=(\S+)/)?.[1], code: info.match(/versionCode=(\d+)/)?.[1] };
  if (!report.version.name) throw new Error('辨識器尚未安裝');
  if (!observe) await adb('shell', 'am', 'force-stop', pkg);
  const launchedAt = Date.now();
  const launch = await adb('shell', 'am', 'start', '-W', '-n', component);
  check('Android 啟動', /Status: ok/.test(launch));
  report.measurements.androidActivityStartMs = Number(launch.match(/TotalTime: (\d+)/)?.[1]) || 0;
  report.measurements.launchState = launch.match(/LaunchState: (.+)/)?.[1] || 'unknown';
  let pid;
  for (let i = 0; i < 20; i++) {
    pid = (await adb('shell', 'pidof', pkg)).trim().split(' ')[0];
    if (pid && (await adb('shell', 'cat', '/proc/net/unix')).includes(`webview_devtools_remote_${pid}`)) break;
    await delay(250);
  }
  if (!/^\d+$/.test(pid)) throw new Error('App 行程未啟動');
  port = (await adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`)).trim();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === 'page' && /^https?:\/\/localhost(?:\/|$)/.test(t.url));
  if (!target) throw new Error('找不到 App WebView；需要 debug APK，且手機保持解鎖');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    else if (msg.method === 'Runtime.exceptionThrown') events.push({ type: 'exception', message: msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text });
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.timestamp >= captureStartedAt) {
      const values = msg.params.args.map(a => a.value ?? a.description ?? '');
      const text = values.join(' ');
      if (text.includes('BusVisionRecognizer') || text.includes('[BusVision]')) events.push({ type: msg.params.type, timestamp: msg.params.timestamp, message: text });
    }
  });
  captureStartedAt = Date.now();
  await cdp('Runtime.enable');
  const ready = await waitFor("!!document.querySelector('.bv-nav button')");
  check('React 畫面可操作', ready);
  if (!ready) throw new Error('WebView 未顯示主畫面');
  if (!observe) {
    check('直接進入辨識、已移除首頁', await evaluate("!!document.querySelector('.bv-recognizer') && !document.querySelector('.bv-home')"));
    if (args.includes('--expect-auto-start')) {
      await checkAutoRecognition('冷啟動後', launchedAt);
      await clickText('暫停自動', '.bv-auto-toggle');
      check('可暫停自動辨識', await waitFor("[...document.querySelectorAll('.bv-auto-toggle')].some(b => b.textContent.trim() === '開始自動辨識')"));
    }
    await clickText('辨識紀錄', '.bv-nav button');
    check('紀錄頁載入', await waitFor("!!document.querySelector('.bv-log-page') && !document.body.innerText.includes('讀取中')"));
    check('紀錄讀取無錯誤', await evaluate("!document.body.innerText.includes('讀取紀錄失敗')"));
    const returnedFromLogsAt = Date.now();
    await clickText('辨識', '.bv-nav button');
    check('辨識頁控制已載入', await waitFor("!!document.querySelector('.bv-actions-toggle') && !!document.querySelector('.bv-auto-toggle')"));
    if (args.includes('--expect-auto-start')) await checkAutoRecognition('從紀錄切回辨識後', returnedFromLogsAt);
    const voicePressed = await evaluate("document.querySelector('[aria-label=\"App 語音報讀\"]').getAttribute('aria-pressed')");
    await clickText('報讀', '.bv-header-actions button');
    check('App 語音報讀有可讀的切換狀態', await evaluate(`document.querySelector('[aria-label="App 語音報讀"]').getAttribute('aria-pressed') !== ${JSON.stringify(voicePressed)}`));
    await clickText('報讀', '.bv-header-actions button');
    await checkDisclosureAccessibility();
    await clickText('鏡像關', '.bv-header-actions button');
    check('鏡像切換', await waitFor("[...document.querySelectorAll('.bv-header-actions button')].some(b => b.textContent.includes('鏡像開'))"));
    await clickText('鏡像開', '.bv-header-actions button');
    if (args.includes('--expect-auto-start')) {
      check('切背景前相機仍在運作', await evaluate("document.querySelector('.bv-video.ready')?.videoWidth > 0"));
    }
    await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME'); await delay(1000);
    await adb('shell', 'am', 'start', '-W', '-n', component);
    check('切背景後恢復', await waitFor("document.visibilityState === 'visible' && !!document.querySelector('.bv-recognizer')"));
    if (args.includes('--expect-auto-start')) {
      check('回前景維持暫停且釋放相機', await evaluate("!document.querySelector('.bv-video').srcObject && ![...document.querySelectorAll('.bv-auto-toggle')].some(b => b.textContent.includes('暫停自動'))"));
    }
    await clickText('公車查詢', '.bv-nav button');
    check('北大周邊擴充路線', await waitFor("document.querySelectorAll('.route-picker').length > 8"));
    await delay(6000);
    check('雙北路線官方資料更新', await waitFor("document.querySelector('.catalog-status')?.textContent.includes('雙北路線已更新')"));
    await clickText('雙北全部','.scope-tabs button');
    check('雙北完整路線索引', await evaluate("Number(document.querySelector('.scope-tabs button:last-child small').textContent)>1000"));
    await evaluate("(()=>{const input=document.querySelector('.transit-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'932');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    check('搜尋路線',await waitFor("document.querySelectorAll('.route-picker').length>0 && document.querySelectorAll('.route-picker').length<10"));
    await evaluate("[...document.querySelectorAll('.route-picker')].find(b=>b.querySelector('strong').textContent==='932').click()");
    check('路線詳細站牌',await waitFor("document.querySelectorAll('.stop-timeline li').length>3"));
    await delay(4000);
    check('新北官方到站資料', await waitFor("!!document.querySelector('.live-dot')"));
    const outbound=await evaluate("[...document.querySelectorAll('.stop-description>strong')].map(e=>e.textContent).join('|')");
    await clickText('返程','.route-direction-tabs button');
    check('返程按鈕選取',await waitFor("document.querySelectorAll('.route-direction-tabs button')[1].getAttribute('aria-pressed')==='true'"));
    check('返程確實更換站序',await evaluate(`[...document.querySelectorAll('.stop-description>strong')].map(e=>e.textContent).join('|')!==${JSON.stringify(outbound)}`));
    report.transit=await evaluate("({status:document.querySelector('.feed-status')?.innerText,direction:document.querySelector('.route-direction-tabs .selected')?.textContent,stops:document.querySelectorAll('.stop-timeline li').length})");
    check('畫面沒有水平溢出',await evaluate("document.documentElement.scrollWidth<=Math.ceil(visualViewport.width)&&document.querySelector('.transit-page').scrollWidth<=Math.ceil(visualViewport.width)"));
    await mkdir(out,{recursive:true});
    const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(out,'route-detail.png'),Buffer.from(shot.data,'base64'));
    if (args.includes('--check-waiting')) {
      await clickText('我要搭這班', '.wait-target-button');
      check('候車目標帶回辨識', await waitFor("!!document.querySelector('.bv-wait-target')"));
      const saved = await evaluate("JSON.parse(localStorage.getItem('busvision.waitingTarget.v1'))");
      check('保存所選路線與返程', saved?.routeName === '932' && saved?.stop.direction === '1');
      check('候車目標有取消按鈕', await evaluate("document.querySelector('.bv-wait-target button').textContent.includes('取消')"));
      await clickText('候車與辨識資訊', '.bv-quick button');
      check('候車資訊彈窗開啟',await waitFor("document.querySelector('.bv-info-dialog').open"));
      await evaluate("document.querySelector('.bv-info-dialog header button').click()");
      check('關閉資訊保留目標',await evaluate("!document.querySelector('.bv-info-dialog').open && !!localStorage.getItem('busvision.waitingTarget.v1')"));
      await evaluate("document.querySelector('.bv-quick button').click()");
      check('相機切換兩倍取景',await waitFor("document.querySelector('.bv-video').dataset.zoom==='2'"));
      await clickText('候車與辨識資訊', '.bv-quick button');
      await clickText('取消候車目標', '.bv-wait-target button');
      check('可取消候車目標', await waitFor("!document.querySelector('.bv-wait-target') && !localStorage.getItem('busvision.waitingTarget.v1')"));
      await clickText('公車查詢', '.bv-nav button');
      await clickText('雙北全部', '.scope-tabs button');
      await evaluate("(()=>{const input=document.querySelector('.transit-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'932');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await waitFor("[...document.querySelectorAll('.route-picker strong')].some(e=>e.textContent==='932')");
      await evaluate("[...document.querySelectorAll('.route-picker')].find(b=>b.querySelector('strong').textContent==='932').click()");
      await waitFor("document.querySelectorAll('.stop-timeline li').length>3");
      await clickText('返程','.route-direction-tabs button');
    }
    const selectedStationAt = Date.now();
    await evaluate("[...document.querySelectorAll('.stop-timeline li')].find(e=>e.querySelector('.stop-description>strong')?.textContent==='臺北大學正門').querySelector('.use-stop:not(.wait-target-button)').click()");
    check('站點行經路線帶回辨識',await waitFor("!!document.querySelector('.station-context') && !!document.querySelector('.bv-recognizer')"));
    if (args.includes('--expect-auto-start')) await checkAutoRecognition('設定站點後', selectedStationAt);
    report.stationContext=await evaluate("JSON.parse(localStorage.getItem('busvision.station.context.v1'))");
    check('站點包括 932 且不虛構 332',report.stationContext?.routes.includes('932')&&!report.stationContext?.routes.includes('332'));
    await clickText('清除','.station-context button');
    check('站點輔助可清除',await waitFor("!document.querySelector('.station-context')"));
    await clickText('公車查詢','.bv-nav button');await clickText('雙北全部','.scope-tabs button');
    await evaluate("(()=>{const input=document.querySelector('.transit-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'208');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await waitFor("[...document.querySelectorAll('.route-picker strong')].some(e=>e.textContent==='208')");
    await evaluate("[...document.querySelectorAll('.route-picker')].find(b=>b.querySelector('strong').textContent==='208').click()");
    await delay(4000);
    check('臺北市站牌與到站資料',await waitFor("document.querySelectorAll('.stop-timeline li').length>3 && !!document.querySelector('.live-dot')"));
    const returnedFromQueryAt = Date.now();
    await clickText('辨識','.bv-nav button');
    if (args.includes('--expect-auto-start')) await checkAutoRecognition('從查詢切回辨識後', returnedFromQueryAt);
    if (args.includes('--mock-location')) await checkMockLocation();
  } else {
    console.log(`開始觀察 ${observe} 秒：請在手機自行操作辨識。腳本不會點按、改路線或清除紀錄。`);
    for (let elapsed = 0; elapsed < observe; elapsed++) { await delay(1000); if ((elapsed + 1) % 10 === 0) console.log(`已觀察 ${elapsed + 1}/${observe} 秒`); }
  }
  report.events = events;
  check('觀察期間無 JavaScript 例外', !events.some(e => e.type === 'exception'));
  const memory = await adb('shell', 'dumpsys', 'meminfo', pkg);
  report.measurements.appProcessPssKb = Number(memory.match(/TOTAL PSS:\s*(\d+)/)?.[1]) || null;
  report.measurements.memoryScope = '僅 App 主行程快照，未包含獨立 WebView renderer，也不是記憶體洩漏測試';
  check('App 行程存活', !!(await adb('shell', 'pidof', pkg)).trim());
} catch (error) { check('測試執行', false, error.message); report.events = events; process.exitCode = 1; }
finally {
  socket?.close(); for (const p of pending.values()) clearTimeout(p.timer);
  if (port) await adb('forward', '--remove', `tcp:${port}`).catch(() => {});
  report.finishedAt = new Date().toISOString();
  report.recognitionSamples = (report.events || []).flatMap(e => {
    const match = e.message.match(/\[BusVisionRecognizer\] recognize-result (\{.*\})/);
    if (!match) return [];
    try { return [{ timestamp: e.timestamp, ...JSON.parse(match[1]) }]; } catch { return []; }
  });
  const times = report.recognitionSamples.map(s => s.elapsedMs).filter(Number.isFinite).sort((a,b) => a-b);
  report.recognitionSummary = { samples: times.length, medianPipelineMs: times.length ? (times[Math.floor((times.length-1)/2)] + times[Math.ceil((times.length-1)/2)]) / 2 : null, scope: 'recognize-result 影像分析流程；不含選圖等待、保存、實際語音開始，不代表正確率' };

  if (report.checks.some(c => !c.passed)) process.exitCode = 1;
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  const md = `# Android 手機測試報告\n\n時間：${report.startedAt}\n裝置：${report.device?.model || '未知'}，Android ${report.device?.android || '未知'}\n版本：${report.version?.name || '未知'}\n\n${report.checks.map(c => `- ${c.passed ? '通過' : '失敗'}：${c.name}${c.detail ? ` — ${c.detail}` : ''}`).join('\n')}\n\n## 量測\n\n${Object.entries(report.measurements).map(([k,v]) => `- ${k}: ${v}`).join('\n')}\n\n## 限制\n\n${report.limits.map(s => `- ${s}`).join('\n')}\n- 辨識事件與原始耗時請看 report.json 的 events；沒有事件表示沒有量到，不能當成零延遲。\n- 不清除資料、不修改辨識紀錄、不匯出照片。基本模式會重新啟動 App，請勿在保存或匯出途中執行。\n`;
  await writeFile(path.join(out, 'report.md'), md);
  console.log(`報告：${out}`);
}
