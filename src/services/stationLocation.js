import {stopDirection} from './transitData.js';
import { Geolocation } from '@capacitor/geolocation';
import { cityPatterns, loadStationRecognitionContext, loadTransitFeed } from './transitApi.js';
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
  if (location.kind) return location;
  const result = listNearbyStations(location.coords, location.feeds);
  return result.stations ? {...result, stations:await withServices(result.stations)} : result;
}

export async function locateNearbyStation() {
  const location = await locate();
  if (location.kind) return location;
  const nearest = findNearbyStation(location.coords, location.feeds);
  if (nearest.kind !== 'found') return nearest;

  const choices = await withServices(listNearbyStations(location.coords, location.feeds).stations);
  const context = nearest.ambiguous
    ? { name: nearest.stop.name, routes: [] }
    : await loadStationRecognitionContext(nearest.city, nearest.stop);
  return { kind: 'found', context: { ...context, choices, source: 'gps',
    distance: nearest.distance, ambiguous: nearest.ambiguous, selectedAt: Date.now() } };
}

async function withServices(stations) {
  const catalogs = new Map(await Promise.all(['taipei','newtaipei'].map(async city => [city,await cityPatterns(city)])));
  return stations.map(station => {
    const services = [];
    for (const member of station.services) {
      for (const {route,stops} of catalogs.get(member.city)) {
        if (route.id !== member.id) continue;
        for (const stop of stops.filter(s => s.id === member.stopId && s.direction === member.direction)) {
          services.push({route, stop, ...stopDirection(stops,stop)});
        }
      }
    }
    return {...station,services};
  });
}
