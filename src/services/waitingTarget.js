const KEY = 'busvision.waitingTarget.v1';
export function readWaitingTarget(now = Date.now()) {
  try {
    const t = JSON.parse(localStorage.getItem(KEY));
    return t && ['taipei', 'newtaipei'].includes(t.city) && t.routeId && t.routeName && t.stop?.id && ['0','1'].includes(t.stop.direction) && now >= t.createdAt && now - t.createdAt < 2 * 60 * 60 * 1000 ? t : null;
  } catch { return null; }
}
export function saveWaitingTarget(route, stop) {
  const target = { city: route.city, routeId: route.id, routeName: route.name, destination: stop.direction === '0' ? route.destination : route.departure, stop: {id: stop.id, name: stop.name, direction: stop.direction}, createdAt: Date.now() };
  localStorage.setItem(KEY, JSON.stringify(target));
  return target;
}
export function clearWaitingTarget() { localStorage.removeItem(KEY); }
export function matchesTarget(route, target) {
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s/g, '').toUpperCase();
  return !!target && normalize(route) === normalize(target.routeName);
}
// Two positive frames acquire; sustained misses lose; cooldown prevents repeated cues.
export function createAlignmentTracker() {
  let hits = 0, aligned = false, lastSeen = 0, lastCue = -Infinity;
  return (detected, now) => {
    let cue = null;
    if (detected) {
      hits++; lastSeen = now;
      if (!aligned && hits >= 2) {
        aligned = true;
        if (now - lastCue >= 15000) { cue = 'acquired'; lastCue = now; }
      }
    } else {
      hits = 0;
      if (aligned && now - lastSeen >= 5000) {
        aligned = false; cue = 'lost';
      }
    }
    return {aligned, cue};
  };
}
