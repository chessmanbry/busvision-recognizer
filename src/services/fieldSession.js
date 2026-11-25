import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Capacitor } from '@capacitor/core';
import { zipSync, strToU8 } from 'fflate';

const root = 'BusVisionField';
const directory = Capacitor.getPlatform()==='android' ? Directory.Data : Directory.Documents;
const utf8 = {directory, encoding:Encoding.UTF8};
let current = null;
let pending = Promise.resolve();
let failure = '';
let clip = null;
const partName = part => 'events-' + String(part).padStart(5,'0') + '.jsonl';
const pathFor = (id,name) => root+'/'+id+'/'+name;
const writeJson = (path,obj) => Filesystem.writeFile({...utf8,path,data:JSON.stringify(obj)});
const readText = async path => (await Filesystem.readFile({...utf8,path})).data;
const reportError = error => {
  failure = '外測寫入失敗：'+String(error?.message || error);
  window.dispatchEvent(new Event('field-error'));
};
function enqueue(work) {
  const task = pending.then(work);
  pending = task.catch(reportError);
  return task;
}
export const fieldStatus = () => ({current, failure});
export function startField(options) {
  return enqueue(async () => {
    if (current) return;
    const id = new Date().toISOString().replace(/[:.]/g,'-');
    await Filesystem.mkdir({directory,path:root+'/'+id,recursive:true});
    const session = {id,startedAt:new Date().toISOString(),platform:Capacitor.getPlatform(),
      photos:!!options.photos,video:!!options.video,count:0,photoCount:0,clipCount:0};
    await writeJson(pathFor(id,'session.json'), session);
    await writeJson(root+'/current.json',{id,part:0});
    failure = '';
    current = session;
    fieldEvent('session_start');
  });
}
export function fieldEvent(kind, details={}) {
  const session = current;
  const row = {at:new Date().toISOString(),kind,...details};
  console.info('[BusVisionField] '+JSON.stringify(row));
  if (!session) return;
  void enqueue(async () => {
    const seq = session.count, part = Math.floor(seq/100);
    await Filesystem.appendFile({...utf8,path:pathFor(session.id,partName(part)),data:JSON.stringify({...row,seq})+'\n'});
    session.count++;
    if (seq && seq%100===0) await writeJson(root+'/current.json',{id:session.id,part});
  });
}
export async function stopField() {
  const session = current;
  if (!session) return;
  if (clip) await clip.finish();
  fieldEvent('session_stop');
  current = null;
  await enqueue(async () => {
    await writeJson(pathFor(session.id,'session.json'),{...session,endedAt:new Date().toISOString()});
  });
}
export function fieldPhoto(jpeg) {
  const session = current;
  if (!session?.photos || session.photoCount>=24) return;
  const file = 'sign-'+(++session.photoCount)+'.jpg';
  fieldEvent('photo',{file});
  void enqueue(()=>Filesystem.writeFile({directory,path:pathFor(session.id,file),data:jpeg.split(',')[1]}));
}
export function fieldClip(stream) {
  const session = current;
  if (!session?.video || session.clipCount>=8 || clip || !stream) return;
  if (!globalThis.MediaRecorder) {fieldEvent('problem',{stage:'video-unsupported'});return;}
  try {
    const recorder = new MediaRecorder(new MediaStream(stream.getVideoTracks()), {videoBitsPerSecond:1200000});
    const chunks = [];
    const file = 'bus-'+(++session.clipCount)+(recorder.mimeType.includes('mp4')?'.mp4':'.webm');
    let resolve;
    const stopped = new Promise(r=>{resolve=r;});
    const finish = () => {if(recorder.state!=='inactive') recorder.stop(); return stopped;};
    recorder.ondataavailable = e=>{if(e.data.size) chunks.push(e.data);};
    recorder.onerror = ()=>fieldEvent('problem',{stage:'video'});
    recorder.onstop = async () => {
      clearTimeout(timer);
      try {
        if (chunks.length) {
          const data = await new Blob(chunks).arrayBuffer();
          await enqueue(()=>Filesystem.writeFile({directory,path:pathFor(session.id,file),data:base64(new Uint8Array(data))}));
          fieldEvent('video',{file});
        }
      } catch (e) { reportError(e); }
      finally {clip=null;resolve();}
    };
    recorder.start();
    clip={finish};
    const timer=setTimeout(finish,2500);
  } catch {fieldEvent('problem',{stage:'video-start'});}
}
function base64(bytes) {
  let str='';
  for(let pos=0;pos<bytes.length;pos+=32768) str+=String.fromCharCode(...bytes.subarray(pos,pos+32768));
  return btoa(str);
}
export async function listFieldSessions() {
  await pending;
  await Filesystem.mkdir({directory,path:root,recursive:true}).catch(()=>{});
  const {files} = await Filesystem.readdir({directory,path:root});
  const sessions = await Promise.allSettled(files.filter(f=>f.type==='directory').sort((a,b)=>b.name.localeCompare(a.name)).map(async f=>
    JSON.parse(await readText(pathFor(f.name,'session.json')))));
  return sessions.filter(s=>s.status==='fulfilled').map(s=>s.value);
}
export async function viewField(id) {
  await pending;
  const {files} = await Filesystem.readdir({directory,path:root+'/'+id});
  const parts = files.map(f=>f.name).filter(n=>n.endsWith('.jsonl')).sort().slice(-2);
  const rows=(await Promise.all(parts.map(n=>readText(pathFor(id,n))))).join('').split('\n').filter(Boolean);
  return rows.slice(-100).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
}
export async function deleteField(id) {
  if (current?.id === id) throw Error('請先結束場次');
  await pending;
  await Filesystem.rmdir({directory,path:root+'/'+id,recursive:true});
}
export async function exportField(id) {
  await pending;
  const {files} = await Filesystem.readdir({directory,path:root+'/'+id});
  const archive = {};
  for (const f of files) {
    const path = pathFor(id,f.name);
    if (/\.jsonl?$/.test(f.name)) archive[f.name] = strToU8(await readText(path));
    else {
      const {data} = await Filesystem.readFile({directory,path});
      archive[f.name]=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
    }
  }
  const bytes=zipSync(archive,{level:0});
  const name='BusVision-'+id+'.zip';
  if (!Capacitor.isNativePlatform()) {
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'}));
    const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);return;
  }
  const {uri}=await Filesystem.writeFile({directory:Directory.Cache,path:name,data:base64(bytes)});
  try {await Share.share({files:[uri],title:'BusVision 外測紀錄'});}
  finally {await Filesystem.deleteFile({directory:Directory.Cache,path:name}).catch(()=>{});}
}
