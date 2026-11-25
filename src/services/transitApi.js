import {buildPatterns, enteringAtStop, stopDirection, isFeedFresh, selectArrival} from "./transitData.js";
import { sameBoardingStop } from "./recognitionContext.js";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { gunzipSync, strFromU8 } from "fflate";
import {
  parseFeedTime,
  normalizeRoutes,
  isNearCampus,
} from "./transitData.js";
const folders = { taipei: "blobbus", newtaipei: "ntpcbus" };
const files = {
  routes: "GetRoute.gz",
  stops: "GetStop.gz",
  arrivals: "GetEstimateTime.gz",
  events: "GetBusEvent.gz",
  paths: "GetPathDetail.gz",
};
const cache = new Map(),
  pending = new Map();
export async function loadTransitFeed(city, kind) {
  if (!folders[city] || !files[kind]) throw new Error("不支援的資料來源");
  const key = `${city}:${kind}`,
    saved = cache.get(key),
    ttl = ["arrivals","events"].includes(kind) ? 15000 : 86400000;
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
const patternCache = new Map();
export async function cityPatterns(city) {
  const [routes, stops, paths] = await Promise.all(["routes","stops","paths"].map(k => loadTransitFeed(city,k)));
  const key = [routes.fetchedAt,stops.fetchedAt,paths.fetchedAt].join("/");
  if (patternCache.get(city)?.key !== key) patternCache.set(city, {key,
    patterns:buildPatterns(normalizeRoutes(routes.rows,city), stops.rows, paths.rows)});
  return patternCache.get(city).patterns;
}
export async function loadRouteStops(city, routeId, pathId) {
  const patterns = (await cityPatterns(city)).filter(p => p.route.id === routeId);
  const pattern = patterns.find(p => p.route.pathId === pathId) || (patterns.length === 1 && patterns[0]);
  return pattern?.stops || [];
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
  const groups = await Promise.all(["taipei","newtaipei"].map(async source => {
    const services = [];
    for (const {route,stops} of await cityPatterns(source)) {
      const matches = stops.filter(s => sameBoardingStop({
        Id:s.id, routeId:route.id, goBack:s.direction, stopLocationId:s.locationId,
        latitude:s.lat, longitude:s.lon, nameZh:s.name
      },stop,source === city));
      if (new Set(matches.map(s => s.direction)).size > 1) continue;
      for (const s of matches) services.push({city:source, routeId:route.id, pathId:route.pathId,
        name:route.name, stopId:s.id, direction:s.direction, ...stopDirection(stops,s)});
    }
    return services;
  }));
  const services = groups.flat();
  if (!services.length) throw Error("無法取得本站行經路線");
  return {city, name:stop.name,address:stop.address,stopId:stop.id,services,
    routes:[...new Set(services.map(s=>s.name))]};
}

export async function loadBoardingCandidates(station) {
  const services = station.services || [];
  const now = Date.now(), entering = [], due = new Set();
  await Promise.all([...new Set(services.map(s=>s.city))].map(async city => {
    const local = services.filter(s=>s.city === city);
    const [events, estimates] = await Promise.all(["events","arrivals"].map(k=>loadTransitFeed(city,k).catch(()=>null)));
    if (events) entering.push(...enteringAtStop(events.rows,local,events.updatedAt,Date.now()));
    if (estimates && isFeedFresh(estimates.updatedAt)) for (const s of local) {
      const raw = selectArrival(estimates.rows,s.routeId,{id:s.stopId,direction:s.direction})?.EstimateTime;
      if (raw != null && String(raw).trim() && +raw >= 0 && +raw <= 180) due.add(s.name);
    }
  }));
  return {routes:station.routes,services,entering,due:[...due],expires:now+30000};
}
