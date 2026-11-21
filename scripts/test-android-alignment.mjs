// Public image pipeline benchmark in the installed debug App's WebView. Does not alter logs/photos.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const adbPath = process.env.ADB || `${homedir()}/Library/Android/sdk/platform-tools/adb`;
const serial = process.argv[2];
const checkReader = process.argv.includes('--check-reader');
const moving = process.argv.includes('--moving');
const outputDir = moving ? 'test-results/iteration-rc35/moving' : 'test-results/iteration-rc34';
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

const results=[];
try {
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 ws=new WebSocket(targets.find(t=>t.type==='page' && t.url.startsWith('https://localhost')).webSocketDebuggerUrl);
 await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});
 await new Promise(r=>setTimeout(r,1500));
 const previousTarget = await evaluate("localStorage.getItem('busvision.waitingTarget.v1')");
 globalThis.previousTarget = previousTarget;
 globalThis.previousHaptics = await evaluate("localStorage.getItem('busvision.hapticsOff')");
 globalThis.previousVoice = await evaluate("localStorage.getItem('busvision.appVoiceOff')");
 await evaluate("localStorage.setItem('busvision.hapticsOff','false');localStorage.setItem('busvision.appVoiceOff','false');");
 await evaluate(`localStorage.setItem('busvision.waitingTarget.v1',JSON.stringify({city:'taipei',routeId:'test-unmatched-feed',routeName:'208',destination:'測試方向',stop:{id:'test-stop',name:'測試站',direction:'0'},createdAt:Date.now()}));location.reload();`);
 await new Promise(r=>setTimeout(r,2000));
 await evaluate(`(()=>{window.__draw=CanvasRenderingContext2D.prototype.drawImage;window.__native=Capacitor.nativePromise;window.__cues=[];Capacitor.nativePromise=function(p,m,o){if(p==='TextToSpeech'&&m==='speak'){window.__cues.push({p,text:o.text,at:Date.now()});return Promise.resolve();}if(p==='Haptics'){window.__cues.push({p,at:Date.now()});return Promise.resolve();}if(p==='Filesystem'&&m==='writeFile')return Promise.resolve({uri:'replay-not-saved'});return window.__native.apply(this,arguments);};CanvasRenderingContext2D.prototype.drawImage=function(input,...args){if (input instanceof HTMLVideoElement && window.__image && ${moving}) {
 const c = window.__scene ||= document.createElement('canvas');
 c.width=input.videoWidth;c.height=input.videoHeight;
 const ctx=c.getContext('2d'), w=c.width, h=c.height;
 const drift=.08*Math.sin(performance.now()/370);
 ctx.fillStyle='#242831';ctx.fillRect(0,0,w,h);
 window.__draw.call(ctx,window.__image,w*drift,h*.07,w,h*.86);
 for(let i=0;i<8;i++){ctx.fillStyle=i%2?'#ff3010':'#fff7c1';ctx.beginPath();ctx.arc(w*(i+.5)/8,h*.85,w*.013,0,7);ctx.fill();}
 return window.__draw.call(this,c,...args);
} return window.__draw.call(this,input instanceof HTMLVideoElement && window.__image ? window.__image:input,...args);};})()`);
 for(const sample of rows){
  const data=readFileSync('test-assets/public-buses/'+sample.file).toString('base64');
  await evaluate(`(async()=>{window.__image=new Image();window.__image.src='data:image/jpeg;base64,${data}';await window.__image.decode();const b=document.querySelector('.bv-auto-toggle');if(b?.textContent.includes('開始'))b.click();})()`);
  await new Promise(r=>setTimeout(r,9000));
  results.push({file:sample.file,...await evaluate(`({alignment:document.querySelector('.bv-alignment-text')?.textContent,guide:document.querySelector('.bv-aim-guide')?.className,cues:window.__cues,route:document.querySelector('.bv-result-card .route')?.textContent})`)});
  console.log(JSON.stringify(results.at(-1)));
  mkdirSync(outputDir,{recursive:true});const shot=await call('Page.captureScreenshot',{format:'png'});writeFileSync(`${outputDir}/alignment-${sample.file}.png`,Buffer.from(shot.data,'base64'));
 }
 await evaluate(`(()=>{const c=document.createElement('canvas');c.width=640;c.height=480;window.__image=c;window.__cues=[];const b=document.querySelector('.bv-auto-toggle');if(b?.textContent.includes('開始'))b.click();})()`);
 await new Promise(r=>setTimeout(r,9000));
 results.push({file:'blank',...await evaluate(`({alignment:document.querySelector('.bv-alignment-text')?.textContent,guide:document.querySelector('.bv-aim-guide')?.className,cues:window.__cues})`)});
 console.log(JSON.stringify(results.at(-1)));
 if (!results[1]?.cues?.some(c=>c.text?.includes('你要的 208')) || results[1]?.cues?.filter(c=>c.p==='Haptics').length !== 3) process.exitCode=1;
 if (!results.slice(0,3).some(r=>r.guide?.includes('bv-aim-bus')) || !results.at(-1).guide?.includes('bv-aim-searching')) process.exitCode=1;
}finally{
 if(ws?.readyState===1)await evaluate(`(()=>{if(window.__draw)CanvasRenderingContext2D.prototype.drawImage=window.__draw;if(window.__native)Capacitor.nativePromise=window.__native;delete window.__image;${['hapticsOff','appVoiceOff'].map((key,i)=>{const v=i?globalThis.previousVoice:globalThis.previousHaptics;return v === null ? `localStorage.removeItem('busvision.${key}');` : `localStorage.setItem('busvision.${key}',${JSON.stringify(v)});`;}).join('')}${globalThis.previousTarget ? `localStorage.setItem('busvision.waitingTarget.v1',${JSON.stringify(globalThis.previousTarget)});` : `localStorage.removeItem('busvision.waitingTarget.v1');`}location.reload();})()`).catch(()=>{});
 ws?.close();for(const p of pending.values())clearTimeout(p.timer);adb('forward','--remove',`tcp:${port}`);
 mkdirSync(outputDir,{recursive:true});writeFileSync(outputDir+'/alignment-replay.json',JSON.stringify({moving,scope:'Real bundled detector in phone WebView; video canvas fed licensed still photos. Speech and haptics recorded, not physical field test.',results},null,2));
}
