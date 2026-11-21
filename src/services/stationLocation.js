import { Geolocation } from '@capacitor/geolocation';
import { loadStationRecognitionContext, loadTransitFeed } from './transitApi.js';
import { findNearbyStation, listNearbyStations } from './nearbyStation.js';

async function locate() {
  let permission = await Geolocation.checkPermissions();
  if (permission.location !== 'granted') {
    permission = await Geolocation.requestPermissions({ permissions: ['location'] });
    if (permission.location !== 'granted' && permission.coarseLocation !== 'granted')
      return { kind: 'denied' };
  }

  const { coords } = await Geolocation.getCurrentPosition({
    enableHighAccuracy: true, maximumAge: 15000, timeout: 12000,
  });
  const cities = ['taipei', 'newtaipei'];
  const feeds = await Promise.all(cities.map(async city => ({
    city, rows: (await loadTransitFeed(city, 'stops')).rows,
  })));
  return {coords, feeds};
}

export async function locateNearbyStations() {
  const location = await locate();
  return location.kind ? location : listNearbyStations(location.coords, location.feeds);
}

export async function locateNearbyStation() {
  const location = await locate();
  if (location.kind) return location;
  const nearest = findNearbyStation(location.coords, location.feeds);
  if (nearest.kind !== 'found') return nearest;

  const context = nearest.ambiguous
    ? { name: nearest.stop.name, routes: [] }
    : await loadStationRecognitionContext(nearest.city, nearest.stop);
  return { kind: 'found', context: { ...context, source: 'gps',
    distance: nearest.distance, ambiguous: nearest.ambiguous, selectedAt: Date.now() } };
}
