import {isFeedFresh, selectArrival} from "./transitData.js";
import { sameBoardingStop } from "./recognitionContext.js";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { gunzipSync, strFromU8 } from "fflate";
import {
  parseFeedTime,
  normalizeRoutes,
  normalizeStops,
  isNearCampus,
} from "./transitData.js";
const folders = { taipei: "blobbus", newtaipei: "ntpcbus" };
const files = {
  routes: "GetRoute.gz",
  stops: "GetStop.gz",
  arrivals: "GetEstimateTime.gz",
};
const cache = new Map(),
  pending = new Map();
export async function loadTransitFeed(city, kind) {
  if (!folders[city] || !files[kind]) throw new Error("不支援的資料來源");
  const key = `${city}:${kind}`,
    saved = cache.get(key),
    ttl = kind === "arrivals" ? 15000 : 86400000;
  if (saved && Date.now() - saved.fetchedAt < ttl) return saved;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const route = `/${folders[city]}/${files[kind]}`,
      url = `https://tcgbusfs.blob.core.windows.net${route}`;
    let bytes;
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.get({
        url,
        responseType: "arraybuffer",
        connectTimeout: 8000,
        readTimeout: 12000,
      });
      if (response.status !== 200 || typeof response.data !== "string")
        throw new Error("官方服務暫時無法使用");
      bytes = Uint8Array.from(atob(response.data), (c) => c.charCodeAt(0));
    } else {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(
          import.meta.env.DEV ? `/transit-api${route}` : url,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("官方服務暫時無法使用");
        bytes = new Uint8Array(await response.arrayBuffer());
      } finally {
        clearTimeout(timer);
      }
    }
    if (bytes.length > 8e6) throw new Error("資料大小異常");
    const json = JSON.parse(
      strFromU8(
        bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : bytes,
      ),
    );
    if (!Array.isArray(json.BusInfo)) throw new Error("官方資料格式不符");
    const updatedAt = parseFeedTime(json.EssentialInfo?.UpdateTime);
    if (!Number.isFinite(updatedAt)) throw new Error("缺少資料更新時間");
    const value = { rows: json.BusInfo, updatedAt, fetchedAt: Date.now() };
    cache.set(key, value);
    return value;
  })().finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}
export const loadArrivals = (city = "newtaipei") =>
  loadTransitFeed(city, "arrivals");
export async function loadRouteStops(city, routeId) {
  const feed = await loadTransitFeed(city, "stops");
  return normalizeStops(feed.rows, routeId);
}
export async function loadCityCatalog(city) {
  const [routes, stops] = await Promise.all([
    loadTransitFeed(city, "routes"),
    loadTransitFeed(city, "stops"),
  ]);
  const nearbyIds = new Set(
    stops.rows.filter(isNearCampus).map((s) => String(s.routeId)),
  );
  return {
    routes: normalizeRoutes(routes.rows, city, nearbyIds),
    updatedAt: routes.updatedAt,
  };
}
export async function loadStationRecognitionContext(city, stop) {
  const cities = await Promise.all(
    ["taipei", "newtaipei"].map(async (source) => {
      const [routes, stops] = await Promise.all([
        loadTransitFeed(source, "routes"),
        loadTransitFeed(source, "stops"),
      ]);
      const ids = new Set(
        stops.rows
          .filter((s) => sameBoardingStop(s, stop, source === city))
          .map((s) => String(s.routeId)),
      );
      return normalizeRoutes(routes.rows, source)
        .filter((r) => ids.has(r.id))
        .map((r) => r.name);
    }),
  );
  const routes = [...new Set(cities.flat())];
  if (!routes.length) throw new Error("無法取得本站行經路線");
  return {
    name: stop.name,
    address: stop.address,
    city,
    stopId: stop.id,
    routes,
  };
}

export async function loadBoardingCandidates(target) {
  const anchorRows = (await loadTransitFeed(target.city,'stops')).rows;
  const anchor = anchorRows.find(r=>String(r.Id)===target.stop.id && String(r.routeId)===target.routeId && String(r.goBack)===target.stop.direction);
  if (!anchor) return null;
  const stop = {name:anchor.nameZh, locationId:String(anchor.stopLocationId || ''), lat:Number(anchor.latitude), lon:Number(anchor.longitude)};
  const routes=new Set(), due=new Set();
  let expires=Infinity;
  await Promise.all(['taipei','newtaipei'].map(async city=>{
    const [catalog,stops,arrivals]=await Promise.all(['routes','stops','arrivals'].map(kind=>loadTransitFeed(city,kind)));
    if (!isFeedFresh(arrivals.updatedAt)) throw Error('stale arrivals');
    expires=Math.min(expires,arrivals.updatedAt+120000);
    const names=new Map(catalog.rows.map(r=>[String(r.Id),r.nameZh]));
    // Direction codes are per route. Match the physical boarding point, then use each stop's own direction.
    for(const row of stops.rows.filter(r=>sameBoardingStop(r,stop,city===target.city))){
      const id=String(row.routeId), name=names.get(id);
      if (!name) throw Error('incomplete station catalog');
      routes.add(name);
      const raw=selectArrival(arrivals.rows,id,{id:String(row.Id),direction:String(row.goBack)})?.EstimateTime;
      if(raw!=null && String(raw).trim() && Number(raw)>=0 && Number(raw)<=180) due.add(name);
    }
  }));
  return {routes:[...routes],due:[...due],expires};
}
