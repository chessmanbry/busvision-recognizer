// Paired OCR microbenchmark in the installed debug App's WebView. Does not alter logs/photos.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const adbPath = process.env.ADB || `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const serial = process.argv[2];
if (!serial) throw new Error('Usage: node scripts/replay-android-recognition.mjs SERIAL');
const replayFrame = process.argv.includes('--frame');
const pkg = 'com.chessman.busvision2.recognizer';
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { timeout: 30000, maxBuffer: 12e6 });
const rows = JSON.parse(adb('exec-out','run-as',pkg,'cat','files/BusData/recognition_logs.json').toString());
const selected = rows.filter(r => /^BusData\/live_\d+_crop\.jpg$/.test(r.cropPath || '') && r.source === 'gallery-photo-ocr').filter(r => String(r.routeNumber) === '932').slice(-1);
if (!selected.length) throw new Error('No existing gallery crop samples');
adb('shell','am','start','-W','-n',`${pkg}/com.chessman.busvision2.MainActivity`);
const pid = adb('shell','pidof',pkg).toString().trim().split(' ')[0];
const port = adb('forward','tcp:0',`localabstract:webview_devtools_remote_${pid}`).toString().trim();
let ws; let seq=0; const pending=new Map();
function call(method,params={}) {return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout'));},60000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
const results=[];
try {
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const target=targets.find(t=>t.type==='page' && /^https?:\/\/localhost(?:\/|$)/.test(t.url));
 if(!target)throw new Error('App target missing');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
 await evaluate(`(()=>{const b=[...document.querySelectorAll('.bv-nav button')].find(b=>b.textContent.trim()==='辨識');b.click();})()`);
 await new Promise(r=>setTimeout(r,500));
 const base64=adb('exec-out','run-as',pkg,'cat',`files/${replayFrame ? selected[0].imagePath : selected[0].cropPath}`).toString('base64');
 await evaluate(`(()=>{window.__bvOriginalNative=window.Capacitor.nativePromise;window.Capacitor.nativePromise=function(plugin,method,options){if(plugin==='Camera'&&method==='getPhoto')return Promise.resolve({webPath:'data:image/jpeg;base64,${base64}',format:'jpeg'});if(plugin==='Filesystem'&&method==='writeFile')return Promise.resolve({uri:'test-replay-not-saved'});if(plugin==='TextToSpeech'&&method==='speak')return Promise.resolve();return window.__bvOriginalNative.apply(this,arguments);};})()`);
 for(let i=0;i<2;i++){
  const before=await evaluate(`JSON.parse(localStorage.getItem('busvision.recognition.timings.v1')||'[]').at(-1)?.at||''`);
  const started=Date.now();
  await evaluate(`(()=>{if(document.visibilityState!=='visible')throw new Error('Keep phone unlocked and BusVision visible');[...document.querySelectorAll('.four-actions button')].find(b=>b.textContent.includes('匯入圖片')).click();})()`);
  let result;
  for(let j=0;j<80;j++){await new Promise(r=>setTimeout(r,500));result=await evaluate(`(()=>{const rows=JSON.parse(localStorage.getItem('busvision.recognition.timings.v1')||'[]');return rows.at(-1)?.at!==${JSON.stringify(before)}?{timing:rows.at(-1),status:document.querySelector('.bv-status-toast')?.textContent,route:document.querySelector('.bv-result-card .route')?.textContent}:null;})()`);if(result)break;}
  if(!result)throw new Error('No completed recognition within 40 seconds');
  await new Promise(r=>setTimeout(r,100));
  Object.assign(result,await evaluate(`({status:document.querySelector('.bv-status-toast')?.textContent,route:document.querySelector('.bv-result-card .route')?.textContent||null})`));
  results.push({expected:'932',exactMatch:result.route==='932',iteration:i+1,wallMs:Date.now()-started,...result});console.log(JSON.stringify(results.at(-1)));
 }
}finally{
 if(ws?.readyState===1){await evaluate(`(()=>{if(window.__bvOriginalNative){window.Capacitor.nativePromise=window.__bvOriginalNative;delete window.__bvOriginalNative;}location.reload();})()`).catch(()=>{});}
 ws?.close();for(const p of pending.values())clearTimeout(p.timer);adb('forward','--remove',`tcp:${port}`);
 mkdirSync('test-results/iteration-rc29',{recursive:true});writeFileSync(`test-results/iteration-rc29/pipeline-replay-${replayFrame?'frame':'crop'}.json`,JSON.stringify({date:new Date().toISOString(),scope:`controlled replay of existing 932 ${replayFrame?'frame':'crop'} through production gallery pipeline; native picker, speech and persistence stubbed; 932 visually checked by assistant, not independently double annotated; photos not exported`,results},null,2));
}
