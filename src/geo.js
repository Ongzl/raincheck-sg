// Small geometry helpers. Points are [lat, lon].

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function distanceM([lat1, lon1], [lat2, lon2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Nearest item to `point`; `getPoint(item)` returns [lat, lon]. Returns { item, distance } or null. */
export function nearest(point, items, getPoint) {
  let best = null;
  for (const item of items) {
    const d = distanceM(point, getPoint(item));
    if (!best || d < best.distance) best = { item, distance: d };
  }
  return best;
}

/**
 * Sample a polyline roughly every `stepM` metres, always keeping both ends.
 * Returns [{ point, fraction }] where fraction is the share of total length travelled (0..1),
 * used to interpolate the time someone is at that point.
 */
export function samplePath(points, stepM = 150) {
  if (!points.length) return [];
  if (points.length === 1) return [{ point: points[0], fraction: 0 }];
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distanceM(points[i - 1], points[i]));
  const total = cumulative.at(-1) || 1;
  const samples = [{ point: points[0], fraction: 0 }];
  let next = stepM;
  for (let i = 1; i < points.length; i++) {
    if (cumulative[i] >= next) {
      samples.push({ point: points[i], fraction: cumulative[i] / total });
      next = cumulative[i] + stepM;
    }
  }
  const last = points.at(-1);
  if (samples.at(-1).point !== last) samples.push({ point: last, fraction: 1 });
  return samples;
}
