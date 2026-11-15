// Public image pipeline benchmark in the installed debug App's WebView. Does not alter logs/photos.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const adbPath = process.env.ADB || `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const serial = process.argv[2];
const checkReader = process.argv.includes('--check-reader');
const outputDir = checkReader ? 'test-results/iteration-rc32' : 'test-results/iteration-rc29';
if (!serial) throw new Error('Usage: node scripts/benchmark-public-buses.mjs SERIAL');
const pkg = 'com.chessman.busvision2.recognizer';
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { timeout: 30000, maxBuffer: 12e6 });
const rows = JSON.parse(readFileSync('test-assets/public-buses/manifest.json','utf8'));
const selected = rows;
adb('shell','am','start','-W','-n',`${pkg}/com.chessman.busvision2.MainActivity`);
const pid = adb('shell','pidof',pkg).toString().trim().split(' ')[0];
const port = adb('forward','tcp:0',`localabstract:webview_devtools_remote_${pid}`).toString().trim();
let ws; let seq=0; const pending=new Map();
function call(method,params={}) {return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout'));},60000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
const results=[];const events=[];
try {
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const target=targets.find(t=>t.type==='page' && /^https?:\/\/localhost(?:\/|$)/.test(t.url));
 if(!target)throw new Error('App target missing');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(m.method==='Runtime.consoleAPICalled'){const message=m.params.args.map(a=>a.value??a.description??'').join(' ');if(message.includes('BusVisionRecognizer'))events.push(message);}if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}};
 await call('Runtime.enable');
 await evaluate(`(()=>{const b=[...document.querySelectorAll('.bv-nav button')].find(b=>b.textContent.trim()==='辨識');b.click();})()`);
 await new Promise(r=>setTimeout(r,500));
 if (checkReader) {
  await evaluate(`(() => {
    const voice = document.querySelector('[aria-label="App 語音報讀"]');
    if (!voice) throw new Error('App voice control missing');
    window.__bvVoicePreference = voice.getAttribute('aria-pressed');
    if (window.__bvVoicePreference === 'true') voice.click();
  })()`);
 }
 await evaluate(`(()=>{window.__bvSavedContext=localStorage.getItem('busvision.station.context.v1');localStorage.removeItem('busvision.station.context.v1');window.__bvOriginalNative=window.Capacitor.nativePromise;window.Capacitor.nativePromise=function(plugin,method,options){if(plugin==='Camera'&&method==='getPhoto')return Promise.resolve({webPath:window.__bvTestImage,format:'jpeg'});if(plugin==='Filesystem'&&method==='writeFile')return Promise.resolve({uri:'test-replay-not-saved'});if(plugin==='TextToSpeech'&&method==='speak')return Promise.resolve();return window.__bvOriginalNative.apply(this,arguments);};})()`);
 for(let round=0;round<2;round++)for(const sample of selected){
  const base64=readFileSync(`test-assets/public-buses/${sample.file}`).toString('base64');
  await evaluate(`window.__bvTestImage='data:image/jpeg;base64,${base64}'`);
  const before=await evaluate(`JSON.parse(localStorage.getItem('busvision.recognition.timings.v1')||'[]').filter(r=>r.source==='gallery-photo-ocr').at(-1)?.at||''`),started=Date.now();
  await evaluate(`(()=>{if(document.visibilityState!=='visible')throw new Error('Keep phone unlocked and BusVision visible');const toggle=document.querySelector('#bv-actions-toggle');if(toggle?.getAttribute('aria-expanded')==='false')toggle.click();})()`);
  await evaluate(`(()=>{[...document.querySelectorAll('.bv-rec-action-list button, .four-actions button')].find(b=>b.textContent.includes('匯入圖片')).click();})()`);
  let result;
  for(let j=0;j<80;j++){await new Promise(r=>setTimeout(r,500));result=await evaluate(`(()=>{const rows=JSON.parse(localStorage.getItem('busvision.recognition.timings.v1')||'[]').filter(r=>r.source==='gallery-photo-ocr');return rows.length && rows.at(-1)?.at!==${JSON.stringify(before)}?{timing:rows.at(-1),status:document.querySelector('.bv-status-toast')?.textContent,route:document.querySelector('.bv-result-card .route')?.textContent||null}:null;})()`);if(result)break;}
  if(!result)throw new Error('No completed recognition within 40 seconds');
  await new Promise(r=>setTimeout(r,100));
  Object.assign(result,await evaluate(`({status:document.querySelector('.bv-status-toast')?.textContent,route:document.querySelector('.bv-result-card .route')?.textContent||null})`));
  if (checkReader && result.timing.outcome === 'recognized') {
   const { nodes } = await call('Accessibility.getFullAXTree');
   const statusNode = nodes.find(node => !node.ignored && node.role?.value === 'status');
   result.readerAnnouncement = await evaluate("document.querySelector('.bv-sr-only[role=status]')?.textContent");
   result.readerAnnouncementVerified = Boolean(statusNode && result.readerAnnouncement === `辨識到 ${result.route}`);
   if (!result.readerAnnouncementVerified) process.exitCode = 1;
  }
  results.push({file:sample.file,round:round+1,expected:sample.expectedRoute,exactMatch:result.route===sample.expectedRoute,wallMs:Date.now()-started,...result});console.log(JSON.stringify(results.at(-1)));
 }
}finally{
 if(ws?.readyState===1){await evaluate(`(()=>{if(window.__bvOriginalNative){window.Capacitor.nativePromise=window.__bvOriginalNative;delete window.__bvOriginalNative;}delete window.__bvTestImage;if(window.__bvSavedContext)localStorage.setItem('busvision.station.context.v1',window.__bvSavedContext);delete window.__bvSavedContext;if(window.__bvVoicePreference==='true')document.querySelector('[aria-label="App 語音報讀"]')?.click();delete window.__bvVoicePreference;location.reload();})()`).catch(()=>{});}
 ws?.close();for(const p of pending.values())clearTimeout(p.timer);adb('forward','--remove',`tcp:${port}`);
 if(checkReader && !results.some(r=>r.readerAnnouncementVerified))process.exitCode=1;
 mkdirSync(outputDir,{recursive:true});writeFileSync(`${outputDir}/public-photo-benchmark.json`,JSON.stringify({date:new Date().toISOString(),scope:'3 public licensed still images, 2 sequential rounds, production gallery pipeline; native picker, speech and persistence stubbed; station context disabled; assistant visual labels, no independent double annotation; not a representative accuracy or field latency study',results,events},null,2));
}
