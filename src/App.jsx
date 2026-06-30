import React, { useEffect, useState } from 'react';
import Recorder from './components/Recorder';
import RecognitionLogs from './components/RecognitionLogs';
import './index.css';
import { ScreenOrientation } from '@capacitor/screen-orientation';

function App() {
  const [mode, setMode] = useState('home');

  useEffect(() => {
    ScreenOrientation.lock({ orientation: 'portrait' }).catch(() => {});
  }, []);

  const navItems = [
    { id: 'home', icon: '🏠', label: '首頁' },
    { id: 'recognize', icon: '🚌', label: '辨識' },
    { id: 'logs', icon: '📋', label: '辨識紀錄' },
  ];

  return (
    <div className="bv-shell">
      <main className="bv-main">
        {mode === 'home' && (
          <section className="bv-home">
            <div className="bv-home-card">
              <div className="bv-maid-avatar">🚌</div>
              <h1>BusVision 辨識器</h1>
              <p>穩定版介面：只保留立即辨識、拍照辨識、匯入圖片、自動辨識四個核心功能。相機會在需要時自動準備，不另外放啟用相機按鈕。</p>
              <button className="primary" onClick={() => setMode('recognize')}>進入即時辨識</button>
              <button onClick={() => setMode('logs')}>查看辨識紀錄</button>
            </div>
          </section>
        )}
        {mode === 'recognize' && <Recorder />}
        {mode === 'logs' && <RecognitionLogs />}
      </main>
      <nav className="bv-nav" aria-label="主要功能">
        {navItems.map((it) => (
          <button key={it.id} onClick={() => setMode(it.id)} className={mode === it.id ? 'active' : ''}>
            <span className="icon">{it.icon}</span>
            <span>{it.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default App;
