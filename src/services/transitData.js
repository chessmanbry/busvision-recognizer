export function parseFeedTime(value) {
  if (typeof value !== "string") return NaN;
  const match = value.match(
    /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
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
      const id = String(r.Id);
      if (!r.nameZh || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((r) => ({
      id: String(r.Id),
      city,
      name: r.nameZh,
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
      const key = String(s.Id);
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
