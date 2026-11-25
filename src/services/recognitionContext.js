const KEY = "busvision.station.context.v1";
export const CONTEXT_TTL_MS = 30 * 60 * 1000;
export function readRecognitionContext(
  storage = globalThis.localStorage,
  now = Date.now(),
) {
  try {
    const v = JSON.parse(storage.getItem(KEY) || "null");
    return v &&
      typeof v.name === "string" &&
      Array.isArray(v.routes) &&
      v.routes.length &&
      Number.isFinite(v.selectedAt) &&
      now - v.selectedAt >= 0 &&
      now - v.selectedAt < CONTEXT_TTL_MS
      ? v
      : null;
  } catch {
    return null;
  }
}
export function saveRecognitionContext(
  value,
  storage = globalThis.localStorage,
) {
  storage.setItem(KEY, JSON.stringify({ ...value, selectedAt: Date.now() }));
}
export function clearRecognitionContext(storage = globalThis.localStorage) {
  try {
    storage.removeItem(KEY);
  } catch {
    /* optional */
  }
}
const canonical = (v) =>
  String(v)
    .normalize("NFKC")
    .replace(/[\s路]/g, "")
    .toUpperCase();
export function routeMatchesContext(route, context) {
  return (
    !context || context.routes.some((r) => canonical(r) === canonical(route))
  );
}
export function sameBoardingStop(raw, selected, sameCity) {
  if (sameCity && selected.routeId && String(raw.routeId) === selected.routeId &&
      selected.direction != null && String(raw.goBack) !== selected.direction) return false;
  if (sameCity && selected.id && String(raw.Id) === selected.id) return true;
  const locationId = String(raw.stopLocationId || "");
  if (sameCity && selected.locationId && selected.locationId !== "0" &&
      locationId && locationId !== "0") {
    return locationId === selected.locationId;
  }
  const lat = Number(raw.latitude),
    lon = Number(raw.longitude);
  return (
    raw.nameZh === selected.name &&
    Math.hypot((lat - selected.lat) * 111000, (lon - selected.lon) * 101000) <=
      3
  );
}
