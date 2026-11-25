export function parseFeedTime(value) {
  if (typeof value !== "string") return NaN;
  const match = value.match(
    /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/,
  );
  return match
    ? Date.parse(
        `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+08:00`,
      )
    : NaN;
}
export function etaLabel(value) {
  if (value === null || value === undefined || String(value).trim() === "")
    return { text: "暫無預估", kind: "unknown" };
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return { text: "暫無預估", kind: "unknown" };
  if (seconds < 0)
    return {
      text:
        {
          "-1": "尚未發車",
          "-2": "交管不停靠",
          "-3": "末班已過",
          "-4": "今日未營運",
        }[String(seconds)] || "暫無預估",
      kind: "inactive",
    };
  return seconds < 60
    ? { text: "即將到站", kind: "soon" }
    : {
        text: String(Math.ceil(seconds / 60)),
        unit: "分",
        kind: seconds < 300 ? "soon" : "normal",
      };
}
export function selectArrival(rows, routeId, stop) {
  // Stop IDs identify direction; GoBack 2/3 are status values, not new directions.
  return rows.find(
    (r) =>
      String(r.RouteID) === String(routeId) &&
      String(r.StopID) === String(stop.id) &&
      (!["0", "1"].includes(String(r.GoBack)) ||
        String(r.GoBack) === stop.direction),
  );
}
export function isFeedFresh(updatedAt, now = Date.now()) {
  return (
    Number.isFinite(updatedAt) &&
    now - updatedAt >= -60000 &&
    now - updatedAt <= 120000
  );
}
export function isNearCampus(stop) {
  const lat = Number(stop.latitude),
    lon = Number(stop.longitude);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.hypot((lat - 24.9468) * 111, (lon - 121.372) * 101) <= 1.2
  );
}
export function normalizeRoutes(rows, city, nearbyIds = new Set()) {
  const seen = new Set();
  return rows
    .filter((r) => {
      const id = JSON.stringify([String(r.Id), String(r.pathAttributeId || "")]);
      if (!r.nameZh || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((r) => ({
      id: String(r.Id),
      city,
      pathId: String(r.pathAttributeId || ""),
      name: r.pathAttributeName?.trim() || r.nameZh,
      departure: r.departureZh || "",
      destination: r.destinationZh || "",
      officialId: r.NId || "",
      nearby: nearbyIds.has(String(r.Id)),
    }));
}
export function normalizeStops(rows, routeId) {
  const seen = new Set();
  return rows
    .filter((s) => {
      const key = JSON.stringify([s.Id, s.goBack, s.seqNo]);
      if (
        String(s.routeId) !== String(routeId) ||
        !["0", "1"].includes(String(s.goBack)) ||
        seen.has(key)
      )
        return false;
      seen.add(key);
      return true;
    })
    .map((s) => ({
      id: String(s.Id),
      routeId: String(s.routeId),
      direction: String(s.goBack),
      name: s.nameZh,
      order: Number(s.seqNo) || 0,
      address: s.address || "",
      locationId: String(s.stopLocationId || ""),
      lat: Number(s.latitude),
      lon: Number(s.longitude),
      nearby: isNearCampus(s),
    }))
    .sort((a, b) => a.order - b.order);
}

// The route ID identifies the main line. Vehicle events and PathDetail use the branch ID.
export function buildPatterns(routes, rawStops, details) {
  const stopsByRoute = Map.groupBy(rawStops, row => String(row.routeId));
  const paths = Map.groupBy(details, row => String(row.PathAttributeId ?? row.pathAttributeId));
  const families = Map.groupBy(routes, route => route.id);
  return routes.map(route => {
    const rows = stopsByRoute.get(route.id) || [];
    const path = paths.get(route.pathId);
    let stops = [];
    if (path?.length) {
      const byId = Map.groupBy(rows, row => String(row.Id));
      for (const item of path) {
        const variants = byId.get(String(item.StopId ?? item.stopId ?? item.StopID)) || [];
        const sequence = Number(item.SequenceNo ?? item.sequenceNo);
        const raw = variants.length === 1 ? variants[0] : variants.find(s => Number(s.seqNo) === sequence);
        if (!raw || !Number.isFinite(sequence)) continue;
        const [stop] = normalizeStops([{...raw, seqNo:sequence}], route.id);
        if (stop) stops.push(stop);
      }
    } else if (families.get(route.id).length === 1) {
      stops = normalizeStops(rows, route.id);
    }
    stops.sort((a,b) => a.order-b.order);
    for (const visits of Map.groupBy(stops, s=>s.direction).values()) {
      const terminal=visits.at(-1)?.name || '';
      const endpoints=[...new Set([route.departure,route.destination])].filter(name=>name && terminal.includes(name));
      const destination=endpoints.length===1 ? endpoints[0] : terminal;
      visits.forEach((stop,i)=>Object.assign(stop,{destination,next:visits[i+1]?.name || ''}));
    }
    return {route, stops};
  });
}

export function stopDirection(stops, stop) {
  if (stop.destination) return {destination:stop.destination,next:stop.next};
  const ordered = stops.filter(s => s.direction === stop.direction);
  const index = ordered.findIndex(s => s.id === stop.id && s.order === stop.order);
  if (index < 0) return {destination:'', next:''};
  return {destination:ordered.at(-1)?.name || '', next:ordered[index+1]?.name || ''};
}

export function enteringAtStop(rows, services, feedTime, now) {
  if (!isFeedFresh(feedTime, now)) return [];
  const latest = new Map();
  for (const row of rows) {
    const at = parseFeedTime(row.DataTime);
    const vehicle = row.BusID || row.CarID;
    if (!vehicle || !Number.isFinite(at) || at > now || now-at >= 45000) continue;
    const prior = latest.get(vehicle);
    if (!prior || at > prior.at || (at === prior.at && String(row.CarOnStop) !== '1'))
      latest.set(vehicle, {row, at});
  }
  const arrivals = [];
  for (const {row,at} of latest.values()) {
    if (String(row.CarOnStop) !== '1' || String(row.DutyStatus) === '2' || String(row.BusStatus) === '99') continue;
    for (const service of services) {
      if (service.pathId === String(row.RouteID) && service.stopId === String(row.StopID) &&
          service.direction === String(row.GoBack))
        arrivals.push({name:service.name, until:Math.min(at+45000, feedTime+120000)});
    }
  }
  return arrivals;
}
