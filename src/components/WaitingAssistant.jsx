import {useEffect,useRef,useState} from 'react';
import {Haptics,ImpactStyle} from '@capacitor/haptics';
import {associate,corroborateFragments,observe} from '../services/busEvidence.js';
import {readWaitingTarget,clearWaitingTarget} from '../services/waitingTarget.js';
import {loadBoardingCandidates} from '../services/transitApi.js';
import {readRecognitionContext} from '../services/recognitionContext.js';
import {runNativePipeline} from '../services/nativeRecognitionPipeline.js';
import {canUseNativeOcr,recognizeNativeText} from '../services/nativeOcr.js';
import {fieldEvent,fieldPhoto,fieldClip} from '../services/fieldSession.js';
import {createVehicleDetector} from './vehicleDetector.js';

function imageQuality(canvas, thumb) {
  const ctx=thumb.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(canvas,0,0,thumb.width,thumb.height);
  const {data}=ctx.getImageData(0,0,thumb.width,thumb.height);
  let edges=0;
  for(let i=4;i<data.length;i+=4) edges+=Math.abs(data[i]-data[i-4])+Math.abs(data[i+1]-data[i-3]);
  return edges;
}

export default function WaitingAssistant({videoRef,running,station,reportTrackedRoute,onAligned,onApproaching,sceneRef}) {
  const [alignment,setAlignment]=useState('準備車體偵測');
  const [target,setTarget]=useState(readWaitingTarget);
  const [haptics,setHaptics]=useState(()=>localStorage.getItem('busvision.hapticsOff')!=='true');
  const [eta,setEta]=useState('');
  const inventory=useRef(null);
  const stationKey=station?.selectedAt;
  useEffect(()=>{
    let active=true,busy=false;
    inventory.current=null;
    async function update(){
      if(busy || !active || document.hidden) return;
      const selected=readRecognitionContext(), waiting=readWaitingTarget();
      if(!waiting && target) setTarget(null);
      if(!selected?.services || selected.selectedAt!==stationKey) {setEta('');onApproaching(false);return;}
      busy=true;
      try {
        const data=await loadBoardingCandidates(selected);
        if(!active || readRecognitionContext()?.selectedAt!==stationKey)return;
        inventory.current={...data,stationKey};
        const live=[...new Set(data.entering.filter(e=>e.until>Date.now()).map(e=>e.name))];
        const due=data.due.filter(r=>!live.includes(r));
        setEta([live.length && '正在進站：'+live.join('、'),due.length && '預估三分鐘內：'+due.join('、')].filter(Boolean).join('。'));
        onApproaching(waiting ? [...live,...due].includes(waiting.routeName) : live.length>0);
      } catch {if(active){inventory.current=null;setEta('到站資料暫不可用');onApproaching(false);}}
      finally{busy=false;}
    }
    void update();
    const timer=setInterval(update,10000);
    return ()=>{active=false;clearInterval(timer);inventory.current=null;onApproaching(false);};
  },[stationKey,target,onApproaching]);

  useEffect(()=>{
    if(!running || !canUseNativeOcr())return;
    let active=true,tracks=[],queue=[],reading=false,timer;
    const current=()=>active && !document.hidden;
    const detector=createVehicleDetector(async()=>{
      const tf=await import('@tensorflow/tfjs');await import('@tensorflow/tfjs-backend-webgl');
      if(!await tf.setBackend('webgl').catch(()=>false)) await tf.setBackend('cpu');
      await tf.ready();const coco=await import('@tensorflow-models/coco-ssd');
      return coco.load({base:'lite_mobilenet_v2',modelUrl:'/models/bus/model.json'});
    });
    const snapshot=document.createElement('canvas'),small=document.createElement('canvas');
    const crop=document.createElement('canvas'),thumb=document.createElement('canvas');
    thumb.width=96;thumb.height=32;
    function resize(canvas,w,h){if(canvas.width!==w || canvas.height!==h){canvas.width=w;canvas.height=h;}}
    async function drain(){
      if(reading)return;
      reading=true;
      try{
        while(current() && queue.length){
          const item=queue.shift(),{bus,jpeg,at,side}=item;
          const valid=()=>current() && !bus.invalid && Date.now()-at<5500;
          if(!valid())continue;
          const start=performance.now();
          try{
            const result=await runNativePipeline(jpeg,{recognize:recognizeNativeText,context:null,isCurrent:valid,budgetMs:2000,sideSign:side});
            if(!valid())continue;
            const pick=result.selection;
            const tokens=[...new Set(pick.candidates.map(c=>c.route))];
            fieldEvent('ocr',{source:'bus-crop',capturedAt:at,candidates:tokens,ms:Math.round(performance.now()-start)});
            const token=pick.reliable && tokens.length===1 ? pick.best.route : '';
            const selected=readRecognitionContext();
            const data=inventory.current?.stationKey===selected?.selectedAt ? inventory.current : null;
            if(bus.stationKey!==selected?.selectedAt){bus.fragments=[];bus.previous=null;bus.stationKey=selected?.selectedAt;}
            const inferred=corroborateFragments(bus,token,data,at,Date.now());
            const fragment=selected?.routes.some(r=>r!==token && r.includes(token));
            const full=token.length>=2 && (!selected || selected.routes.includes(token)) && !(token.length===2 && fragment);
            const waiting=readWaitingTarget();
            const weakTarget=waiting && !pick.reliable && tokens.length===1 && tokens[0]===waiting.routeName &&
              /^\d{3,4}$/.test(tokens[0]) && pick.best.ocrConfidence>=.27 && pick.best.line.y/result.height<.3;
            const targetOutcome=waiting ? observe(bus,weakTarget?tokens[0]:token,waiting.routeName,null,at,weakTarget) : '';
            const route=inferred || (targetOutcome==='visual-match' ? waiting.routeName : '') || (full && bus.previous===token && at-bus.lastRead<3500 ? token : '');
            bus.previous=token;bus.lastRead=at;
            if(route){
              const destinations=[...new Set((selected?.services || []).filter(s=>s.name===route && s.destination).map(s=>s.destination))];
              const matches=destinations.filter(d=>result.lines.some(l=>Number(l.confidence)>=.6 &&
                l.text.replace(/\s/g,'').includes('往'+d)));
              reportTrackedRoute(route,matches.length===1?matches[0]:'');
            }else fieldEvent('no_result',{source:'bus-crop'});
          } catch(e){if(valid())fieldEvent('problem',{stage:'bus-crop-ocr',message:String(e).slice(0,120)});}
        }
      }finally{reading=false;}
    }
    async function tick(){
      try{
        const v=videoRef.current;
        if(!current() || !v?.videoWidth || v.paused || v.readyState<2)return;
        const at=Date.now(),scale=Math.min(1,1440/Math.max(v.videoWidth,v.videoHeight));
        resize(snapshot,Math.round(v.videoWidth*scale),Math.round(v.videoHeight*scale));
        snapshot.getContext('2d').drawImage(v,0,0,snapshot.width,snapshot.height);
        const factor=320/Math.max(snapshot.width,snapshot.height);
        resize(small,Math.round(snapshot.width*factor),Math.round(snapshot.height*factor));
        small.getContext('2d').drawImage(snapshot,0,0,small.width,small.height);
        const predictions=await detector.predict(small,8);
        if(!current())return;
        const boxes=(predictions||[]).filter(p=>p.class==='bus' && p.score>=.55).map(p=>p.bbox);
        const previous=tracks;
        const visible=associate(tracks,boxes,at);
        tracks=boxes.length ? visible : tracks.filter(t=>at-t.at<750);
        const crowded=visible.some(t=>t.crowded);
        sceneRef.current={crowded:visible.length>1,at};
        if(crowded){for(const t of previous)t.invalid=true;queue=[];}
        onAligned(boxes.length?'bus':'searching');
        setAlignment(crowded?'車體重疊，繼續辨識':boxes.length?'畫面中有公車，正在讀取燈牌':'尋找公車中');
        for(const bus of visible.filter(t=>!t.crowded)){
          const [x,y,w,h]=bus.box.map(n=>n/factor),side=w/h>1.45,band=side ? .91 : .72;
          if(w<12 || h<12)continue;
          resize(crop,Math.max(1,Math.min(1024,Math.round(w))),Math.max(1,Math.min(720,Math.round(h*band))));
          crop.getContext('2d').drawImage(snapshot,x,y,w,h*band,0,0,crop.width,crop.height);
          const quality=imageQuality(crop,thumb);
          if(!bus.entered){
            bus.entered=true;
            fieldEvent('bus_entry',{capturedAt:at,side});
            if(localStorage.getItem('busvision.hapticsOff')!=='true')void Haptics.impact({style:ImpactStyle.Light}).catch(()=>{});
            fieldClip(v.srcObject);
          }
          // Keep time order for fragment matching. Evict the least detailed pending image.
          const worst=queue.reduce((i,q,j)=>q.quality<queue[i].quality?j:i,0);
          if(queue.length>=3 && quality<=queue[worst].quality)continue;
          if(queue.length>=3)queue.splice(worst,1);
          const jpeg=crop.toDataURL('image/jpeg',.91);
          if(!bus.photoAt || (quality>bus.quality*1.15 && at-bus.photoAt>500)){
            fieldPhoto(jpeg);bus.photoAt=at;bus.quality=quality;
          }
          fieldEvent('capture',{source:'bus-crop',capturedAt:at,width:crop.width,height:crop.height});
          queue.push({bus,at,jpeg,side,quality});
        }
        void drain();
      }catch(e){if(current()){fieldEvent('problem',{stage:'bus-detection',message:String(e).slice(0,120)});setAlignment('車體偵測暫不可用');}}
      finally{if(active)timer=setTimeout(tick,160);}
    }
    detector.load().then(()=>{if(active)void tick();}).catch(()=>{if(active){setAlignment('車體偵測暫不可用');fieldEvent('problem',{stage:'vehicle-model'});}});
    return ()=>{active=false;queue=[];clearTimeout(timer);sceneRef.current=null;detector.dispose();};
  },[running,videoRef,reportTrackedRoute,onAligned,sceneRef]);
  return <section className="bv-waiting" aria-label="候車與對準提示">
    {target && <div className="bv-wait-target"><strong>等 {target.routeName} · {target.destination?'往 '+target.destination:'候車方向待確認'}</strong>
      <button onClick={()=>{clearWaitingTarget();setTarget(null);}}>取消候車目標</button></div>}
    <div>{eta}</div><div>{running?alignment:'車體偵測已暫停'}</div>
    <button aria-pressed={haptics} onClick={()=>{localStorage.setItem('busvision.hapticsOff',String(haptics));setHaptics(!haptics);}}>震動提示{haptics?'開':'關'}</button>
  </section>;
}
