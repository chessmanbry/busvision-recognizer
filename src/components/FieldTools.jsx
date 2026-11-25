import {useEffect,useState} from 'react';
import {fieldStatus,startField,stopField,listFieldSessions,viewField,exportField,deleteField} from '../services/fieldSession.js';

const labels = {capture:'取像',ocr:'OCR 候選',confirmed:'確認車號',request:'報讀或裝置請求',problem:'錯誤',no_result:'本輪沒有確認車號',camera:'相機掃描中',bus_entry:'公車進入畫面',photo:'燈牌照片',video:'公車短片',session_start:'開始場次',session_stop:'結束場次'};
export default function FieldTools({onScan}) {
  const [sessions,setSessions]=useState([]),[photos,setPhotos]=useState(false),[video,setVideo]=useState(false);
  const [rows,setRows]=useState(null),[remove,setRemove]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const active=fieldStatus().current;
  useEffect(()=>{
    listFieldSessions().then(setSessions).catch(e=>setMessage(String(e)));
    const error=()=>setMessage(fieldStatus().failure);
    window.addEventListener('field-error',error);return ()=>window.removeEventListener('field-error',error);
  },[]);
  async function act(operation) {
    setBusy(true);setMessage('');
    try {await operation();setSessions(await listFieldSessions());}
    catch(e){setMessage(String(e.message || e));}
    finally{setBusy(false);}
  }
  return <section className="transit-page"><h1>外測工具</h1>
    <p role="status">{message || fieldStatus().failure || (active?'場次記錄中':'可開始新場次')}</p>
    <fieldset disabled={busy}><legend>場次設定</legend>
    <label><input type="checkbox" checked={active?.photos ?? photos} disabled={!!active} onChange={e=>setPhotos(e.target.checked)}/> 儲存燈牌照片（最多 24 張）</label><br/>
    <label><input type="checkbox" checked={active?.video ?? video} disabled={!!active} onChange={e=>setVideo(e.target.checked)}/> 儲存進入畫面的無聲短片（最多 8 段）</label>
    </fieldset>
    <button className="use-stop" disabled={busy} onClick={()=>act(async()=>{if(active) await stopField();else {await startField({photos,video});onScan();}})}>{active?'結束場次':'開始場次並開啟相機'}</button>
    <h2>已存場次</h2>
    {sessions.map(s=><article key={s.id}><h3>{new Date(s.startedAt).toLocaleString('zh-TW',{hour12:false})}</h3>
      <p>{active?.id===s.id?'記錄中':s.endedAt?'已結束':'保留至最後寫入事件'}</p>
      <button disabled={busy} onClick={()=>act(async()=>setRows({id:s.id,items:await viewField(s.id)}))}>查看事件</button>
      <button disabled={busy || active?.id===s.id} onClick={()=>act(()=>exportField(s.id))}>匯出場次</button>
      <button disabled={busy || active?.id===s.id} onClick={()=>setRemove(s.id)}>刪除場次</button>
      {remove===s.id && <div role="group" aria-label="確認刪除這一場的事件及影像"><button onClick={()=>setRemove('')}>保留</button>
        <button disabled={busy} onClick={()=>act(async()=>{await deleteField(s.id);setRemove('');setRows(null);})}>確認刪除本場資料</button></div>}
      {rows?.id===s.id && <ol aria-label="最近一百筆事件">{rows.items.map(row=><li key={row.seq}>{new Date(row.at).toLocaleTimeString('zh-TW')} {labels[row.kind] || row.kind} {[row.route,row.direction,row.stage,row.action,row.candidates?.join('、')].filter(Boolean).join(' ')}</li>)}</ol>}
    </article>)}
  </section>;
}
