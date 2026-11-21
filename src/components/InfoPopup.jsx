import {useRef} from 'react';
export default function InfoPopup({children}) {
  const dialog = useRef(null);
  return <><button className="bv-chip" onClick={() => dialog.current.showModal()}>候車與辨識資訊</button>
    <dialog className="bv-info-dialog" ref={dialog} aria-labelledby="bv-info-title">
      <header><h2 id="bv-info-title">候車與辨識資訊</h2>
        <button autoFocus aria-label="關閉候車與辨識資訊" onClick={() => dialog.current.close()}>×</button></header>
      {children}
    </dialog></>;
}
