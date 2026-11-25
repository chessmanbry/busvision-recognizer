import { sameBoardingStop } from './recognitionContext.js';

export const GPS_CONTEXT_TTL_MS = 3 * 60 * 1000;
const MAX_DISTANCE_METERS = 120;
const MAX_ACCURACY_METERS = 70;

function nearbyRows(coords, feeds, radius) {
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
      if (distance > radius) continue;
      nearby.push({
        city, row, distance,
        stop: { name: row.nameZh.trim(), id: String(row.Id), address: row.address || '',
          routeId: String(row.routeId), direction:String(row.goBack), locationId: String(row.stopLocationId || ''), lat, lon },
      });
    }
  }
  nearby.sort((a, b) => a.distance - b.distance);
  return {kind:'found', nearby};
}

export function listNearbyStations(coords, feeds) {
  const result = nearbyRows(coords, feeds, 500);
  if (!result.nearby) return result;
  const stations = [];
  for (const item of result.nearby) {
    let station = stations.find(s => sameBoardingStop(item.row, s.stop, s.city === item.city));
    if (!station) {
      if (stations.length >= 12) continue;
      station = {...item, distance: Math.round(item.distance), services: []};
      stations.push(station);
    }
    const id = String(item.row.routeId), direction = String(item.row.goBack);
    if (!station.services.some(s => s.city === item.city && s.id === id && s.direction === direction && s.stopId === item.stop.id))
      station.services.push({city:item.city, id, direction,stopId:item.stop.id});
  }
  return {kind:stations.length ? 'found' : 'none', stations};
}

export function findNearbyStation(coords, feeds) {
  const result = nearbyRows(coords, feeds, MAX_DISTANCE_METERS);
  if (!result.nearby) return result;
  const {nearby} = result;
  const {accuracy} = coords;
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
