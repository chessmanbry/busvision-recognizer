import test from 'node:test';
import assert from 'node:assert/strict';
import { findNearbyStation, readGpsStation, setGpsStation, GPS_CONTEXT_TTL_MS } from '../src/services/nearbyStation.js';
import { selectNativeRoute } from '../src/services/nativeRouteSelection.js';

const coords = { latitude: 24.9468, longitude: 121.372, accuracy: 8 };
const stop = (nameZh, stopLocationId, latitude, longitude = coords.longitude) =>
  ({ Id: stopLocationId, nameZh, stopLocationId, latitude, longitude });
const feed = (...rows) => [{ city: 'newtaipei', rows }];

test('nearest interleaved stop records resolve to the boarding location', () => {
  const result = findNearbyStation(coords, feed(
    stop('正門', 12, 24.94685), stop('側門', 13, 24.9474), stop('正門', 12, 24.94686),
  ));
  assert.equal(result.stop.name, '正門');
  assert.equal(result.distance, 6);
  assert.equal(result.ambiguous, false);
});
test('uncertain or absent GPS matches do not imply an exact boarding stop', () => {
  const stops = feed(stop('正門', 12, 24.94685), stop('正門', 14, 24.94688));
  assert.equal(findNearbyStation(coords, stops).ambiguous, true);
  assert.equal(findNearbyStation({ ...coords, accuracy: 500 }, stops).kind, 'inaccurate');
  assert.equal(findNearbyStation({ ...coords, latitude: 24.9 }, stops).kind, 'none');
});
test('GPS expires and only adjusts ranking of visually plausible routes', () => {
  const context = { name: '正門', source: 'gps', routes: ['932'], selectedAt: 1000 };
  setGpsStation(context);
  assert.equal(readGpsStation(2000), context);
  assert.equal(readGpsStation(1000 + GPS_CONTEXT_TTL_MS), null);
  const line = text => ({ text, y: 120, h: 95, confidence: .9 });
  const offRoute = selectNativeRoute([line('208')], 1000, 1000, context);
  assert.equal(offRoute.best.route, '208');
  assert.equal(offRoute.reliable, true);
  const ambiguous = selectNativeRoute([line('208'), line('932')], 1000, 1000, context);
  assert.equal(ambiguous.best.route, '932');
  assert.equal(ambiguous.reliable, false);
  assert.equal(selectNativeRoute([{ ...line('932'), confidence: .1 }], 1000, 1000, context).reliable, false);
});
