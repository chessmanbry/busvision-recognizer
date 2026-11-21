// Measure WebView frame capture through native OCR; keep timing only.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
const adbPath = process.env.ADB || `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const serial = process.argv[2];
if (!serial) throw new Error('Usage: node scripts/benchmark-public-buses.mjs SERIAL');
const pkg = 'com.chessman.busvision2.recognizer';
const adb = (...args) => execFileSync(adbPath, ['-s', serial, ...args], { timeout: 30000, maxBuffer: 12e6 });
adb('shell','am','start','-W','-n',`${pkg}/com.chessman.busvision2.MainActivity`);
const pid = adb('shell','pidof',pkg).toString().trim().split(' ')[0];
const port = adb('forward','tcp:0',`localabstract:webview_devtools_remote_${pid}`).toString().trim();
let ws; let seq=0; const pending=new Map();
function call(method,params={}) {return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout'));},60000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}

try {
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page' && t.url.startsWith('https://localhost')).webSocketDebuggerUrl);
 await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
 await new Promise(r=>setTimeout(r,1500));
 const measured=await evaluate(`(async()=>{
 const toggle=document.querySelector('.bv-auto-toggle');
 if(toggle?.textContent.includes('開始')) toggle.click();
 for(let i=0;i<40 && !document.querySelector('video')?.videoWidth;i++) await new Promise(r=>setTimeout(r,200));
 if(toggle?.textContent.includes('暫停')) toggle.click();
 await new Promise(r=>setTimeout(r,1500));
 const video=document.querySelector('video');
 if(!video?.videoWidth) throw Error('camera unavailable');
 const canvas=document.createElement('canvas'); canvas.width=video.videoWidth; canvas.height=video.videoHeight;
 const times=[];
 for(let i=0;i<12;i++){
   const start=performance.now();
   canvas.getContext('2d').drawImage(video,0,0);
   const image=canvas.toDataURL('image/jpeg',.92);
   await window.Capacitor.nativePromise('BusVisionNative','recognizeText',{image});
   times.push(Math.round(performance.now()-start));
 }
 return {width:canvas.width,height:canvas.height,times};
 })()`);
 console.log(JSON.stringify(measured));
}finally{
 if(ws?.readyState===1) await evaluate("location.reload()").catch(()=>{});
 ws?.close();for(const p of pending.values())clearTimeout(p.timer);adb('forward','--remove',`tcp:${port}`);
}
