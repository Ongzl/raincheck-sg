// Decoder for Google's encoded polyline format. OneMap, ORS and OSRM use precision 5; Transitous uses 7.
// Uses plain arithmetic instead of bitwise ops: at precision 7, Singapore's longitude (~103.85 x 1e7, doubled
// by the zig-zag encoding) is larger than 2^31 and would overflow JavaScript's 32-bit bitwise operators.
// Returns [[lat, lon], ...].
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let scale = 1;
      let byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        result += (byte % 32) * scale;
        scale *= 32;
      } while (byte >= 32 && index < str.length);
      const delta = result % 2 ? -(result + 1) / 2 : result / 2;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    points.push([lat / factor, lon / factor]);
  }
  return points;
}
