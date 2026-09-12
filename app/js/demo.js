// Demo ride (Krylatskoye loop, Moscow) with two typical recording faults:
// a GPS glitch that "cuts" into the route at an impossible speed, and a stop.
import { hav } from './track.js';

export function buildDemoRaw() {
  const wp = [[55.7570, 37.4180], [55.7605, 37.4120], [55.7660, 37.4090], [55.7720, 37.4105], [55.7775, 37.4160], [55.7800, 37.4250], [55.7790, 37.4350], [55.7745, 37.4420], [55.7690, 37.4460], [55.7630, 37.4450], [55.7580, 37.4400], [55.7545, 37.4330], [55.7540, 37.4240], [55.7570, 37.4180]];
  const out = [], N = 38;
  let s = 0;
  for (let i = 0; i < wp.length - 1; i++) {
    for (let k = 0; k < N; k++) {
      const t = k / N, a = wp[i], b = wp[i + 1];
      const j = (Math.sin(s * 0.61) * 1.1 + Math.cos(s * 1.73) * 0.7) * 0.000045;
      out.push({ lat: a[0] + (b[0] - a[0]) * t + j, lng: a[1] + (b[1] - a[1]) * t + j * 1.6 });
      s++;
    }
  }
  out.push({ lat: wp[wp.length - 1][0], lng: wp[wp.length - 1][1] });

  // Glitch: 40 points fly off to a phantom point and back.
  const g0 = Math.round(out.length * 0.42), g1 = g0 + 40, P = { lat: 55.7690, lng: 37.4255 };
  const A = { ...out[g0] }, B = { ...out[g1] };
  for (let i = g0; i <= g1; i++) {
    const t = (i - g0) / (g1 - g0), u = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const f = t < 0.5 ? A : P, g = t < 0.5 ? P : B;
    out[i] = { lat: f.lat + (g.lat - f.lat) * u, lng: f.lng + (g.lng - f.lng) * u, bad: true };
  }
  // Stop: 13 points jitter in place.
  const p0 = Math.round(out.length * 0.72), anchor = { ...out[p0] };
  for (let i = p0; i < p0 + 13; i++) {
    out[i] = { lat: anchor.lat + Math.sin(i * 2.1) * 0.000012, lng: anchor.lng + Math.cos(i * 1.7) * 0.000012, pause: true };
  }

  let d = 0, t = Date.UTC(2026, 8, 8, 6, 14, 0);   // 09:14 Moscow time
  return out.map((p, i) => {
    if (i > 0) d += hav(out[i - 1], p);
    const sp = p.pause ? 0.5 : p.bad ? 95 + 6 * Math.sin(i * 0.9) : 26 + 6 * Math.sin(d / 1300) + 1.6 * Math.sin(d / 430);
    if (i > 0) t += hav(out[i - 1], p) / 1000 / sp * 3600 * 1000;
    return {
      lat: p.lat, lng: p.lng, t: Math.round(t),
      ele: 142 + 24 * Math.sin(d / 2300) + 7 * Math.sin(d / 700) + (p.bad ? 11 * Math.sin(i * 2.3) : 0),
      hr: Math.round(p.pause ? 118 + 4 * Math.sin(i * 0.5) : 134 + 16 * Math.sin(d / 1800 + 1) + 3 * Math.sin(d / 520)),
      pw: Math.round(p.pause ? 0 : 185 + 55 * Math.sin(d / 1100) + 14 * Math.sin(d / 320)),
      cad: Math.round(p.pause ? 0 : 82 + 8 * Math.sin(d / 700) + 2 * Math.cos(i * 0.4)),
    };
  });
}
