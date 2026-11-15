// Paired OCR microbenchmark in the installed debug App's WebView. Does not alter logs/photos.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const adbPath = process.env.ADB || `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const serial = process.argv[2];
if (!serial) throw new Error('Usage: node scripts/benchmark-android-ocr.mjs SERIAL');
const pkg = 'com.chessman.busvision2.recognizer';
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { timeout: 30000, maxBuffer: 12e6 });
const rows = JSON.parse(adb('exec-out','run-as',pkg,'cat','files/BusData/recognition_logs.json').toString());
const selected = rows.filter(r => /^BusData\/live_\d+_crop\.jpg$/.test(r.cropPath || '') && r.source === 'gallery-photo-ocr').slice(-6);
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
 ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
 // Return to Home to release production OCR/camera before running the isolated worker.
 await evaluate(`(()=>{const b=[...document.querySelectorAll('.bv-nav button')].find(b=>b.textContent.includes('公車查詢'));b?.click();})()`);
 await new Promise(r=>setTimeout(r,500));
 const old=readFileSync('scripts/fixtures/rc26-preprocess.js','utf8');
 const revised=old.replace('Math.max(1, shrink * (src.width < 520 ? 2.0 : 1.35))','Math.min(src.width < 520 ? 2.0 : 1.35, maxSide / Math.max(src.width, src.height))').replace('function preprocessForOcr','function revisedPreprocess');
 await evaluate(`(async()=>{const js=document.querySelector('script[type="module"]').src;const source=await(await fetch(js)).text();const file=source.match(/src-[A-Za-z0-9_-]+\\.js/)[0];const mod=await import('/assets/'+file);const createWorker=mod.createWorker||mod.default?.createWorker;if(!createWorker)throw new Error('Tesseract module unavailable');window.__bvBench={worker:await createWorker('eng')};})()`);
 await evaluate(`(()=>{const OCR_MAX_SIDE=1280;const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));${old}\n${revised}\nwindow.__bvBench.old=preprocessForOcr;window.__bvBench.new=revisedPreprocess;})()`);
 for(let round=0;round<Number(process.argv[3] || 2);round++)for(const row of selected){
   const base64=adb('exec-out','run-as',pkg,'cat',`files/${row.cropPath}`).toString('base64');
   const result=await evaluate(`(async()=>{if(document.visibilityState!=='visible')throw new Error('Keep BusVision visible and phone unlocked');const im=new Image();im.src='data:image/jpeg;base64,${base64}';await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;c.getContext('2d').drawImage(im,0,0);const out=[];for(const variant of ${JSON.stringify(round ? ['new','old'] : ['old','new'])}){const start=performance.now();const p=window.__bvBench[variant](c,${JSON.stringify(row.panelBox?.label || '')});const pre=performance.now();const r=await window.__bvBench.worker.recognize(p);out.push({variant,input:[p.width,p.height],preprocessMs:pre-start,ocrMs:performance.now()-pre,totalMs:performance.now()-start,text:r.data.text.trim(),confidence:r.data.confidence});}return {visibility:document.visibilityState,crop:[im.width,im.height],results:out};})()`);
   results.push({id:row.id,round,recordedRoute:row.routeNumber,confirmedRoute:row.correctedRouteNumber||null,...result});
   console.log(JSON.stringify(results.at(-1)));
 }
}finally{
 if(ws?.readyState===1)await evaluate('(async()=>{await window.__bvBench?.worker?.terminate();delete window.__bvBench;})()').catch(()=>{});
 ws?.close();for(const p of pending.values())clearTimeout(p.timer);
 adb('forward','--remove',`tcp:${port}`);
 mkdirSync('test-results/iteration-rc27',{recursive:true});
 writeFileSync('test-results/iteration-rc27/ocr-paired.json',JSON.stringify({date:new Date().toISOString(),scope:'same-device warm worker OCR microbenchmark, 6 existing gallery crops, alternating order, no ground-truth accuracy claim',results},null,2));
}
