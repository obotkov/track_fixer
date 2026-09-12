// Network services: bike routing (FOSSGIS OSRM) and terrain elevation (open-meteo, open-elevation fallback).
// Only coordinates of the edited stretch are sent — never the file itself.

const ROUTER = 'https://routing.openstreetmap.de/routed-bike/route/v1/driving/';

export async function routeByBike(path) {
  let via = path;
  if (via.length > 60) { const step = (via.length - 1) / 59; via = Array.from({ length: 60 }, (_, k) => path[Math.round(k * step)]); }
  const coords = via.map(p => p.lng.toFixed(6) + ',' + p.lat.toFixed(6)).join(';');
  const r = await fetch(ROUTER + coords + '?overview=full&geometries=geojson');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error(j.message || 'маршрут не найден');
  return j.routes[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
}

async function openMeteo(chunk) {
  const lat = chunk.map(p => p.lat.toFixed(5)).join(','), lng = chunk.map(p => p.lng.toFixed(5)).join(',');
  const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
  if (!r.ok) throw new Error('open-meteo HTTP ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j.elevation) || j.elevation.length !== chunk.length) throw new Error('open-meteo: неверный ответ');
  return j.elevation;
}

async function openElevation(chunk) {
  const r = await fetch('https://api.open-elevation.com/api/v1/lookup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: chunk.map(p => ({ latitude: p.lat, longitude: p.lng })) }),
  });
  if (!r.ok) throw new Error('open-elevation HTTP ' + r.status);
  const j = await r.json();
  return j.results.map(x => x.elevation);
}

/** Elevation for up to a few thousand coordinates, 100 per request, three requests in flight. */
export async function fetchElevations(coords, onProgress) {
  const chunks = [];
  for (let i = 0; i < coords.length; i += 100) chunks.push(coords.slice(i, i + 100));
  const out = new Array(chunks.length);
  let next = 0, done = 0, source = 'Copernicus DEM (open-meteo)';
  const one = async k => {
    try { out[k] = await openMeteo(chunks[k]); }
    catch {
      try { out[k] = await openMeteo(chunks[k]); }
      catch { out[k] = await openElevation(chunks[k]); source = 'SRTM (open-elevation)'; }
    }
    onProgress?.(++done, chunks.length);
  };
  await Promise.all([0, 1, 2].map(async () => { while (next < chunks.length) await one(next++); }));
  return { elevations: out.flat(), source };
}
