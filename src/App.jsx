import { useEffect, useState } from "react";
import { ScanLine, BusFront, History } from "lucide-react";
import Recorder from "./components/Recorder";
import RecognitionLogs from "./components/RecognitionLogs";
import NearbyBuses from "./components/NearbyBuses";
import "./index.css";
import { ScreenOrientation } from "@capacitor/screen-orientation";
import { Capacitor } from "@capacitor/core";
export default function App() {
  const [mode, setMode] = useState("recognize");
  const autoStartOnEntry = Capacitor.isNativePlatform();
  useEffect(() => {
    ScreenOrientation.lock({ orientation: "portrait" }).catch(() => {});
  }, []);
  const items = [
    { id: "recognize", icon: ScanLine, label: "辨識" },
    { id: "nearby", icon: BusFront, label: "公車查詢" },
    { id: "logs", icon: History, label: "辨識紀錄" },
  ];
  return (
    <div className="bv-shell">
      <header className="brand-header">
        <ScanLine size={25} aria-hidden="true" />
        <strong>
          BUS<span>VISION</span>
        </strong>
        <small>公車路線辨識器</small>
      </header>
      <main className="bv-main">
        {mode === "recognize" && <Recorder autoStartOnEntry={autoStartOnEntry} />}
        {mode === "nearby" && (
          <NearbyBuses onStartRecognition={() => setMode("recognize")} />
        )}
        {mode === "logs" && <RecognitionLogs />}
      </main>
      <nav className="bv-nav" aria-label="主要功能">
        {items.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={mode === id ? "active" : ""}
            aria-current={mode === id ? "page" : undefined}
          >
            <Icon size={22} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
