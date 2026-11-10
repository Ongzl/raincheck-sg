// Ties weather + routing + verdict together. Used by the server and the accuracy-log script.
import { getAllWeather } from './weather.js';
import { getItineraries } from './routing.js';
import { buildVerdict } from './verdict.js';

/** from/to: { label, lat, lon }; departAt: epoch ms */
export async function runCheck({ from, to, departAt = Date.now() }) {
  const weather = await getAllWeather();
  const { provider, itineraries, note } = await getItineraries(from, to, departAt);
  const verdict = buildVerdict({ itineraries, weather, from, to, departAt, note });
  return { ...verdict, provider, _itineraries: itineraries };
}
