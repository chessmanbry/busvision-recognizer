import {registerPlugin} from '@capacitor/core';
const native = registerPlugin('BusVisionNative');

// The detector and OCR both read the same stream as the preview.
export async function openZoomCamera(current) {
  const {max} = await native.startZoomCamera();
  const canvas = document.createElement('canvas');
  let seq, stream, stopped=false, extension=1, timer, lens='';
  async function paint() {
    const f=await native.zoomFrame({after:seq ?? -1});
    if(!current() || stopped || !f.jpeg || f.seq===seq)return;
    const img=new Image(); img.src='data:image/jpeg;base64,'+f.jpeg;
    await img.decode();
    if(!current() || stopped)return;
    seq=f.seq; lens=f.lens;
    const sideways=f.rotation%180!==0;
    const w=sideways?img.height:img.width,h=sideways?img.width:img.height;
    if(canvas.width!==w || canvas.height!==h){canvas.width=w;canvas.height=h;}
    const ctx=canvas.getContext('2d');
    ctx.save();ctx.translate(w/2,h/2);ctx.rotate(f.rotation*Math.PI/180);
    ctx.scale(extension,extension);ctx.drawImage(img,-img.width/2,-img.height/2);ctx.restore();
  }
  async function loop(){
    try{await paint();}catch{/* A subsequent frame can recover. */}
    if(current() && !stopped)timer=setTimeout(loop,95);
  }
  function close(){stopped=true;clearTimeout(timer);stream?.getTracks().forEach(t=>t.stop());void native.stopZoomCamera().catch(()=>{});}
  try{
    for(let i=0;i<80 && current() && seq==null;i++){await paint();if(seq==null)await new Promise(r=>setTimeout(r,50));}
    if(seq==null)throw Error('No native camera frames');
    stream=canvas.captureStream(15);void loop();
    return {stream,max,close,layout:options=>native.layoutZoomPreview(options),get lens(){return lens;},async zoom(value){
      const hw=Math.min(max,value);
      await native.setCameraRatio({ratio:hw});extension=value/hw;
    }};
  }catch(e){close();throw e;}
}
