import { sameBoardingStop } from './recognitionContext.js';

export const GPS_CONTEXT_TTL_MS = 3 * 60 * 1000;
const MAX_DISTANCE_METERS = 120;
const MAX_ACCURACY_METERS = 70;

export function findNearbyStation(coords, feeds) {
  const { latitude, longitude, accuracy } = coords;
  if (![latitude, longitude, accuracy].every(Number.isFinite) ||
      accuracy < 0 || accuracy > MAX_ACCURACY_METERS) return { kind: 'inaccurate' };

  const nearby = [];
  const longitudeScale = 111320 * Math.cos(latitude * Math.PI / 180);
  for (const { city, rows } of feeds) {
    for (const row of rows) {
      const lat = Number(row.latitude), lon = Number(row.longitude);
      if (!row.nameZh?.trim() || !row.latitude || !row.longitude ||
          !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const distance = Math.hypot((lat - latitude) * 111320, (lon - longitude) * longitudeScale);
      if (distance > MAX_DISTANCE_METERS) continue;
      nearby.push({
        city, row, distance,
        stop: { name: row.nameZh.trim(), id: String(row.Id), address: row.address || '',
          locationId: String(row.stopLocationId || ''), lat, lon },
      });
    }
  }
  nearby.sort((a, b) => a.distance - b.distance);
  const closest = nearby[0];
  if (!closest) return { kind: 'none' };

  // Nearby stops can be across the street. If GPS cannot tell them apart,
  // display the estimated nearest name but skip route weighting.
  const ambiguous = nearby.some(candidate =>
    candidate.distance - closest.distance <= Math.max(15, accuracy * 2) &&
    !sameBoardingStop(candidate.row, closest.stop, candidate.city === closest.city));
  return { kind: 'found', city: closest.city, stop: closest.stop,
    distance: Math.round(closest.distance), ambiguous };
}

// Session-only context. Coordinates are never stored here or sent to the transit API.
let currentStation = null;
export function setGpsStation(station) { currentStation = station; }
export function readGpsStation(now = Date.now()) {
  if (currentStation && now - currentStation.selectedAt >= GPS_CONTEXT_TTL_MS) currentStation = null;
  return currentStation;
}
