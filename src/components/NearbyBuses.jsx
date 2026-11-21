import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  BusFront,
  ChevronRight,
  MapPin,
  RefreshCw,
  Search,
  WifiOff,
} from "lucide-react";
import snapshot from "../data/taipeiRoutes.json";
import {
  loadArrivals,
  loadCityCatalog,
  loadRouteStops,
  loadStationRecognitionContext,
} from "../services/transitApi.js";
import {
  etaLabel,
  isFeedFresh,
  selectArrival,
} from "../services/transitData.js";
import { saveRecognitionContext, clearRecognitionContext } from "../services/recognitionContext.js";
import { saveWaitingTarget } from "../services/waitingTarget.js";
const cityNames = { taipei: "臺北市", newtaipei: "新北市" };
const order = new Intl.Collator("zh-Hant", { numeric: true });
export default function NearbyBuses({ onStartRecognition }) {
  const [routes, setRoutes] = useState(snapshot.routes),
    [scope, setScope] = useState("nearby"),
    [query, setQuery] = useState(""),
    [city, setCity] = useState("all"),
    [selected, setSelected] = useState(null),
    [limit, setLimit] = useState(60),
    [indexStatus, setIndexStatus] = useState("正在更新雙北路線…");
  useEffect(() => {
    let active = true;
    Promise.allSettled(["taipei", "newtaipei"].map(loadCityCatalog)).then(
      (results) => {
        if (!active) return;
        setRoutes((previous) =>
          results.flatMap((r, i) =>
            r.status === "fulfilled"
              ? r.value.routes
              : previous.filter((v) => v.city === ["taipei", "newtaipei"][i]),
          ),
        );
        setIndexStatus(
          results.every((r) => r.status === "fulfilled")
            ? "雙北路線已更新"
            : `部分資料連線失敗，使用 ${snapshot.updatedAt} 路線備份`,
        );
      },
    );
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => setLimit(60), [scope, query, city]);
  if (selected)
    return (
      <RouteDetail
        key={`${selected.city}:${selected.id}`}
        route={selected}
        onBack={() => setSelected(null)}
        onStartRecognition={onStartRecognition}
      />
    );
  const list = routes
    .filter(
      (r) =>
        (scope !== "nearby" || r.nearby) &&
        (city === "all" || r.city === city) &&
        `${r.name} ${r.departure} ${r.destination}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    )
    .sort((a, b) => order.compare(a.name, b.name));
  return (
    <section className="transit-page route-browser">
      <header className="page-heading">
        <div className="eyebrow">
          <BusFront size={14} /> TAIPEI · NEW TAIPEI
        </div>
        <h1>公車，隨時查。</h1>
        <p>雙北路線與即時到站資訊</p>
      </header>
      <div className="scope-tabs" role="group" aria-label="查詢範圍">
        <button
          className={scope === "nearby" ? "selected" : ""}
          onClick={() => setScope("nearby")}
        >
          北大周邊 <small>{routes.filter((r) => r.nearby).length}</small>
        </button>
        <button
          className={scope === "all" ? "selected" : ""}
          onClick={() => setScope("all")}
        >
          雙北全部 <small>{routes.length}</small>
        </button>
      </div>
      <div className="transit-search">
        <Search size={18} />
        <input
          aria-label="搜尋公車路線"
          placeholder="路線號碼、起點或終點"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="route-list-caption">
        <span>
          {scope === "nearby"
            ? "三峽校區中心約 1.2 公里內有站牌"
            : "依主管機關區分，可跨市行駛"}
        </span>
        <select
          aria-label="選擇城市"
          value={city}
          onChange={(e) => setCity(e.target.value)}
        >
          <option value="all">雙北</option>
          <option value="taipei">臺北市</option>
          <option value="newtaipei">新北市</option>
        </select>
      </div>
      <div className="catalog-status">
        {indexStatus} · {list.length} 條
      </div>
      <div className="route-picker-list">
        {list.slice(0, limit).map((r) => (
          <button
            className="route-picker"
            key={`${r.city}:${r.id}`}
            onClick={() => setSelected(r)}
          >
            <div>
              <strong>{r.name}</strong>
              <small>{cityNames[r.city]}</small>
              <p>
                {r.departure} <span>↔</span> {r.destination}
              </p>
            </div>
            <ChevronRight size={20} />
          </button>
        ))}
      </div>
      {list.length > limit && (
        <button className="load-more" onClick={() => setLimit((n) => n + 60)}>
          顯示更多路線（還有 {list.length - limit} 條）
        </button>
      )}
      {!list.length && (
        <div className="bv-empty">找不到路線，請換個關鍵字或改查雙北全部。</div>
      )}
      <footer className="transit-footnote">
        點選路線後可切換去程、返程並查看沿途站牌。北大周邊依站牌直線距離篩選，包含支線及跳蛙公車，並非步行距離或熱門排名。
        <br />
        資料來源：大臺北公車官方開放資料。
      </footer>
    </section>
  );
}
function RouteDetail({ route, onBack, onStartRecognition }) {
  const [selecting, setSelecting] = useState(null),
    [contextError, setContextError] = useState("");
  async function useStop(stop) {
    if (selecting) return;
    setSelecting(stop.id);
    setContextError("");
    try {
      const context = await loadStationRecognitionContext(route.city, stop);
      if (mounted.current) {
        saveRecognitionContext(context);
        onStartRecognition();
      }
    } catch {
      if (mounted.current) setContextError("站點路線暫時無法載入，請重試。");
    } finally {
      if (mounted.current) setSelecting(null);
    }
  }
  const [direction, setDirection] = useState("0"),
    [stops, setStops] = useState([]),
    [feed, setFeed] = useState(null),
    [error, setError] = useState(""),
    [stopError, setStopError] = useState(""),
    [loading, setLoading] = useState(true),
    [stopsLoading, setStopsLoading] = useState(true),
    [now, setNow] = useState(Date.now());
  const busy = useRef(false),
    mounted = useRef(false);
  async function refresh() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const value = await loadArrivals(route.city);
      if (mounted.current) {
        setFeed(value);
        setError("");
        setNow(Date.now());
      }
    } catch {
      if (mounted.current) setError("到站資料連線失敗，請重試。");
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }
  async function refreshStops() {
    setStopsLoading(true);
    try {
      const value = await loadRouteStops(route.city, route.id);
      if (mounted.current) {
        setStops(value);
        setStopError("");
      }
    } catch {
      if (mounted.current) setStopError("站牌資料連線失敗，請重試。");
    } finally {
      if (mounted.current) setStopsLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshStops();
    const timer = setInterval(() => {
        if (!document.hidden) void refresh();
      }, 30000),
      age = setInterval(() => setNow(Date.now()), 10000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      clearInterval(age);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [route.city, route.id]);
  const fresh = feed && !error && isFeedFresh(feed.updatedAt, now),
    visibleStops = stops.filter((s) => s.direction === direction);
  return (
    <section className="transit-page route-detail">
      <div className="route-detail-title">
        <button onClick={onBack} aria-label="返回路線列表">
          <ArrowLeft size={22} />
        </button>
        <div>
          <h1>{route.name}</h1>
          <small>
            {cityNames[route.city]} · {route.departure} ↔ {route.destination}
          </small>
        </div>
      </div>
      <div
        className="route-direction-tabs"
        role="group"
        aria-label="選擇公車方向"
      >
        {["0", "1"].map((d) => (
          <button
            key={d}
            aria-pressed={direction === d}
            className={direction === d ? "selected" : ""}
            onClick={() => setDirection(d)}
          >
            <small>{d === "0" ? "去程" : "返程"}</small>
            <strong>
              往 {d === "0" ? route.destination : route.departure}
            </strong>
          </button>
        ))}
      </div>
      <div className="feed-status">
        <span className={fresh ? "live-dot" : "idle-dot"} />
        <span>
          {loading
            ? "更新到站資訊…"
            : error
              ? "連線中斷"
              : fresh
                ? "官方動態"
                : "資料待更新"}
          {feed &&
            ` · ${new Date(feed.updatedAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}`}
        </span>
        <button
          aria-label="更新到站時間"
          onClick={() => {
            void refresh();
            if (stopError) void refreshStops();
          }}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? "spinning" : ""} />
        </button>
      </div>
      {contextError && (
        <div role="alert" className="transit-alert">
          {contextError}
        </div>
      )}
      {(error || stopError) && (
        <div className="transit-alert" role="alert">
          <WifiOff size={18} />
          {stopError || error}
        </div>
      )}
      {feed && !fresh && !error && (
        <div className="transit-alert">資料已過期，暫不顯示預估分鐘。</div>
      )}
      {stopsLoading ? (
        <div className="bv-empty">正在載入沿途站牌…</div>
      ) : !visibleStops.length ? (
        <div className="bv-empty">官方未提供此方向站牌，請切換另一方向。</div>
      ) : (
        <ol
          className="stop-timeline"
          aria-label={direction === "0" ? "去程站牌" : "返程站牌"}
        >
          {visibleStops.map((stop, i) => {
            const arrival = feed
                ? selectArrival(feed.rows, route.id, stop)
                : null,
              eta = fresh
                ? etaLabel(arrival?.EstimateTime)
                : { text: loading ? "更新中" : "暫無預估", kind: "unknown" };
            return (
              <li key={stop.id} className={stop.nearby ? "campus-stop" : ""}>
                <div className={`stop-eta ${eta.kind}`}>
                  {eta.text}
                  {eta.unit && ` ${eta.unit}`}
                </div>
                <div className="timeline-dot" />
                <div className="stop-description">
                  <strong>{stop.name}</strong>
                  {stop.nearby && (
                    <small>
                      <MapPin size={11} />
                      北大周邊
                    </small>
                  )}
                  <span>
                    {i + 1} 站{stop.address ? ` · ${stop.address}` : ""}
                  </span>
                  <button className="use-stop wait-target-button" onClick={() => { clearRecognitionContext(); saveWaitingTarget(route, stop); onStartRecognition(); }}
                    aria-label={`等 ${route.name}，往 ${direction === '0' ? route.destination : route.departure}，在 ${stop.name} 上車`}>
                    我要搭這班
                  </button>
                  <button
                    className="use-stop"
                    disabled={!!selecting}
                    onClick={() => useStop(stop)}
                  >
                    {selecting === stop.id ? "正在準備…" : "設為辨識站點"}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <a
        className="official-route-link"
        href={`https://ebus.gov.taipei/EBus/VsSimpleMap?gb=${direction}&routeid=${route.officialId}`}
        target="_blank"
        rel="noreferrer"
      >
        官方路線圖 <ArrowUpRight size={16} />
      </a>
      <footer className="transit-footnote">
        預估每 30
        秒更新，請核對搭乘方向；公車位置與實際到站時間可能因路況變動。部分支線共用主路線站序，請以官方路線圖及車頭目的地為準。
      </footer>
    </section>
  );
}
