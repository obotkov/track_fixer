// Track model: normalisation, derived series, statistics, diagnostics and edits.
// Points are plain objects { lat, lng, t(ms epoch), ele, hr, cad, pw, temp, fixed? }.
// Edits never mutate a point in place — they return new arrays so history can share objects.

export const THRESH = {
  pauseKmh: 3,        // below this a segment counts as standing still
  anomalyKmh: 65,     // above this a segment is a GPS glitch, not riding
  jumpM: 250,         // a single segment longer than this is a signal-loss jump
  minPauseSec: 5,
};

const R = 6371000, RAD = Math.PI / 180;
const CHANNELS = ['ele', 'hr', 'cad', 'pw', 'temp'];

export function hav(a, b) {
  const dla = (b.lat - a.lat) * RAD, dlo = (b.lng - a.lng) * RAD;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const lerp = (x, y, u) => (x == null ? y : y == null ? x : x + (y - x) * u);
const num = v => (v == null || v === '' || !Number.isFinite(+v) ? null : +v);

function fillLinear(pts, key) {
  let prev = -1;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][key] == null) continue;
    if (prev === -1) for (let k = 0; k < i; k++) pts[k][key] = pts[i][key];
    else if (i - prev > 1) {
      const a = pts[prev][key], b = pts[i][key];
      for (let k = prev + 1; k < i; k++) pts[k][key] = a + (b - a) * (k - prev) / (i - prev);
    }
    prev = i;
  }
  if (prev >= 0) for (let k = prev + 1; k < pts.length; k++) pts[k][key] = pts[prev][key];
}

/** Clean parsed points: drop invalid coordinates and duplicates, fill gaps in time and elevation. */
export function normalize(raw) {
  const pts = [];
  for (const p of raw) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || (p.lat === 0 && p.lng === 0)) continue;
    const q = { lat: p.lat, lng: p.lng, t: Number.isFinite(p.t) ? p.t : null,
      ele: num(p.ele), hr: num(p.hr), cad: num(p.cad), pw: num(p.pw), temp: num(p.temp) };
    const last = pts[pts.length - 1];
    if (last && last.lat === q.lat && last.lng === q.lng && last.t === q.t) continue;
    pts.push(q);
  }
  if (pts.length < 2) throw new Error('В файле нет трека: найдено меньше двух точек с координатами.');

  const has = { time: false, ele: false, hr: false, cad: false, pw: false, temp: false };
  for (const p of pts) {
    if (p.t != null) has.time = true;
    for (const c of CHANNELS) if (p[c] != null) has[c] = true;
  }
  if (has.ele) fillLinear(pts, 'ele'); else pts.forEach(p => { p.ele = 0; });
  if (has.time) {
    fillLinear(pts, 't');
    for (let i = 1; i < pts.length; i++) if (pts[i].t < pts[i - 1].t) pts[i].t = pts[i - 1].t;
  } else {
    // No timestamps (a planned route): assume a steady 20 km/h so speed-based tools still work.
    let t = Math.floor(Date.now() / 60000) * 60000;
    pts[0].t = t;
    for (let i = 1; i < pts.length; i++) { t += hav(pts[i - 1], pts[i]) / (20 / 3.6) * 1000; pts[i].t = Math.round(t); }
  }
  return { pts, has };
}

/** Per-point series derived from geometry and time. */
export function derive(pts) {
  const n = pts.length;
  const d = new Float64Array(n), seg = new Float64Array(n), sp = new Float64Array(n), gain = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dd = hav(pts[i - 1], pts[i]);
    d[i] = d[i - 1] + dd;
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    seg[i] = dt > 0 ? dd / dt * 3.6 : dd > 5 ? Infinity : 0;
  }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2), dt = (pts[b].t - pts[a].t) / 1000;
    sp[i] = dt > 0 ? (d[b] - d[a]) / dt * 3.6 : 0;
  }
  // Climb with a 2 m hysteresis so barometer noise does not inflate the total.
  let ref = pts[0].ele, g = 0, loss = 0;
  for (let i = 0; i < n; i++) {
    const e = pts[i].ele;
    if (e - ref > 2) { g += e - ref; ref = e; } else if (ref - e > 2) { loss += ref - e; ref = e; }
    gain[i] = g;
  }
  return { n, d, seg, sp, gain, gainTotal: g, loss };
}

export function trackStats(pts, D) {
  const n = D.n;
  let move = 0, max = 0, hrS = 0, hrN = 0, cadS = 0, cadN = 0, pwS = 0, pwT = 0;
  for (let i = 1; i < n; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000, v = D.seg[i];
    if (dt > 0 && Number.isFinite(v) && v >= THRESH.pauseKmh) {
      move += dt;
      const w = pts[i].pw;
      if (w != null) { const tt = Math.min(dt, 30); pwS += w * tt; pwT += tt; }
      const c = pts[i].cad;
      if (c != null && c > 0) { cadS += c; cadN++; }
    }
    if (Number.isFinite(D.sp[i]) && D.sp[i] > max) max = D.sp[i];
  }
  for (const p of pts) if (p.hr != null && p.hr > 0) { hrS += p.hr; hrN++; }
  const dist = D.d[n - 1];
  return {
    n, dist, move, total: (pts[n - 1].t - pts[0].t) / 1000,
    gain: D.gainTotal, loss: D.loss, max,
    avg: move > 0 ? dist / move * 3.6 : 0,
    hr: hrN ? hrS / hrN : null, cad: cadN ? cadS / cadN : null,
    pw: pwT ? pwS / pwT : null,
    kcal: pwT ? pwS / 1000 : null, // mechanical kJ ≈ burned kcal for cycling
  };
}

export function medianSpacing(D) {
  const arr = [], step = Math.max(1, Math.floor(D.n / 4000));
  for (let i = 1; i < D.n; i += step) { const l = D.d[i] - D.d[i - 1]; if (l > 0.5) arr.push(l); }
  if (!arr.length) return 5;
  arr.sort((a, b) => a - b);
  return arr[arr.length >> 1];
}

/** Runs of impossible speed or single long jumps. Each run is [a, b] with good anchor points at both ends. */
export function findAnomalies(pts, D) {
  const jump = Math.max(THRESH.jumpM, medianSpacing(D) * 25), runs = [];
  let cur = null;
  for (let i = 1; i < D.n; i++) {
    const len = D.d[i] - D.d[i - 1], v = D.seg[i];
    if (!((v > THRESH.anomalyKmh && len > 5) || len > jump)) continue;
    if (cur && i - cur.last <= 4) cur.last = i;
    else { cur = { first: i, last: i }; runs.push(cur); }
  }
  return runs.map(r => {
    let maxV = 0, maxLen = 0;
    for (let i = r.first; i <= r.last; i++) {
      const v = D.seg[i];
      if (Number.isFinite(v) && v > maxV) maxV = v;
      maxLen = Math.max(maxLen, D.d[i] - D.d[i - 1]);
    }
    const a = r.first - 1, b = r.last;
    return { a, b, kind: maxV > THRESH.anomalyKmh ? 'speed' : 'jump', maxV, maxLen };
  });
}

export function findPauses(pts, D) {
  const out = [];
  let a = -1;
  for (let i = 1; i <= D.n; i++) {
    const slow = i < D.n && D.seg[i] < THRESH.pauseKmh;
    if (slow && a < 0) a = i - 1;
    if (!slow && a >= 0) {
      const b = i - 1, sec = (pts[b].t - pts[a].t) / 1000;
      if (sec >= THRESH.minPauseSec) out.push({ a, b, sec });
      a = -1;
    }
  }
  return out;
}

export function kmSplits(pts, D) {
  const n = D.n, total = D.d[n - 1], out = [];
  let s = 0;
  for (let km = 1; (km - 1) * 1000 < total && km < 5000; km++) {
    let i = s;
    while (i < n - 1 && D.d[i] < km * 1000) i++;
    if (i === s) continue;
    const dd = (D.d[i] - D.d[s]) / 1000;
    if (dd < 0.02) break;
    let mt = 0;
    for (let k = s + 1; k <= i; k++) {
      const dt = (pts[k].t - pts[k - 1].t) / 1000;
      if (dt > 0 && Number.isFinite(D.seg[k]) && D.seg[k] >= THRESH.pauseKmh) mt += dt;
    }
    out.push({ km: dd > 0.95 ? String(km) : km + ' · ' + dd.toFixed(2), v: mt > 0 ? dd / (mt / 3600) : 0, gain: D.gain[i] - D.gain[s] });
    s = i;
    if (i >= n - 1) break;
  }
  return out;
}

/* ───────────── edits ───────────── */

export const cutRange = (pts, a, b) => pts.slice(0, a).concat(pts.slice(b + 1));
export const keepRange = (pts, a, b) => pts.slice(a, b + 1);
export const dropHead = (pts, a) => pts.slice(a);
export const splitAt = (pts, a) => ({ head: pts.slice(0, a + 1), tail: pts.slice(a) });
export const shiftTime = (pts, delta) => pts.map(p => ({ ...p, t: p.t + delta }));

/** Append tail to head; if the tail starts before head ends (a different ride), shift it to continue. */
export function mergeTracks(head, tail) {
  const last = head[head.length - 1];
  let t2 = tail;
  if (t2.length && t2[0].lat === last.lat && t2[0].lng === last.lng && t2[0].t === last.t) t2 = t2.slice(1);
  if (!t2.length) return { pts: head.slice(), shift: 0 };
  const shift = t2[0].t <= last.t ? last.t - t2[0].t + 1000 : 0;
  if (shift) t2 = t2.map(p => ({ ...p, t: p.t + shift }));
  return { pts: head.concat(t2), shift };
}

export function smoothRange(pts, a, b, win) {
  const w = Math.floor(win / 2), n = pts.length, out = pts.slice();
  for (let i = a; i <= b; i++) {
    let la = 0, lo = 0, c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { la += pts[k].lat; lo += pts[k].lng; c++; }
    out[i] = { ...pts[i], lat: la / c, lng: lo / c };
  }
  return out;
}

/** Drop standing-still points and collapse their time so the ride reads as continuous. */
export function dropPauses(pts, D) {
  const out = [pts[0]];
  let offset = 0, removed = 0;
  for (let i = 1; i < D.n; i++) {
    if (D.seg[i] < THRESH.pauseKmh) { offset += pts[i].t - pts[i - 1].t; removed++; continue; }
    out.push(offset ? { ...pts[i], t: pts[i].t - offset } : pts[i]);
  }
  return { pts: out, removed, savedSec: offset / 1000 };
}

/** Insert a point into the nearest segment; time and sensors are interpolated. */
export function insertPoint(pts, ll) {
  const k = Math.cos(ll.lat * RAD), px = ll.lng * k, py = ll.lat;
  let best = 1, bd = Infinity, bu = 0;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1].lng * k, ay = pts[i - 1].lat, dx = pts[i].lng * k - ax, dy = pts[i].lat - ay;
    const L2 = dx * dx + dy * dy;
    const u = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
    const ex = ax + dx * u - px, ey = ay + dy * u - py, dist = ex * ex + ey * ey;
    if (dist < bd) { bd = dist; best = i; bu = u; }
  }
  const A = pts[best - 1], B = pts[best];
  const q = { lat: ll.lat, lng: ll.lng, t: Math.round(A.t + (B.t - A.t) * bu), fixed: true };
  for (const c of CHANNELS) q[c] = lerp(A[c], B[c], bu);
  return { pts: pts.slice(0, best).concat([q], pts.slice(best)), index: best };
}

export function movePoint(pts, i, ll) {
  const out = pts.slice();
  out[i] = { ...pts[i], lat: ll.lat, lng: ll.lng, fixed: true };
  return out;
}

/** Evenly spaced points along a polyline, first and last included. `s` is distance from start. */
export function resamplePath(path, spacing) {
  const cum = [0];
  let L = 0;
  for (let i = 1; i < path.length; i++) { L += hav(path[i - 1], path[i]); cum.push(L); }
  const count = Math.max(1, Math.round(L / spacing)), res = [];
  let j = 1;
  for (let k = 0; k <= count; k++) {
    const target = L * k / count;
    while (j < path.length - 1 && cum[j] < target) j++;
    const s0 = cum[j - 1], s1 = cum[j], u = s1 > s0 ? Math.min(1, Math.max(0, (target - s0) / (s1 - s0))) : 0;
    res.push({ lat: path[j - 1].lat + (path[j].lat - path[j - 1].lat) * u, lng: path[j - 1].lng + (path[j].lng - path[j - 1].lng) * u, s: target });
  }
  return { pts: res, L };
}

/**
 * Replace points strictly between anchors a and b with a new path (which starts at a and ends at b).
 * Time runs from a to b in proportion to distance. Sensors are either stretched from the original
 * segment (glitch points skipped) or interpolated between the anchors.
 */
export function replaceGeometry(pts, D, a, b, path, policy, spacing) {
  const A = pts[a], B = pts[b];
  const { pts: geo, L } = resamplePath(path, spacing);
  const src = [];
  for (let i = a; i <= b; i++) if (i === a || D.seg[i] <= THRESH.anomalyKmh) src.push(pts[i]);
  const mid = [];
  for (let j = 1; j < geo.length - 1; j++) {
    const u = L > 0 ? geo[j].s / L : j / (geo.length - 1);
    const q = { lat: geo[j].lat, lng: geo[j].lng, t: Math.round(A.t + (B.t - A.t) * u), fixed: true };
    if (policy === 'stretch' && src.length > 1) {
      const s = src[Math.round(u * (src.length - 1))];
      for (const c of CHANNELS) q[c] = s[c];
    } else for (const c of CHANNELS) q[c] = lerp(A[c], B[c], u);
    mid.push(q);
  }
  return { pts: pts.slice(0, a + 1).concat(mid, pts.slice(b)), added: mid.length, L };
}

/**
 * Write DEM elevations (samples [{i, ele}] sorted, covering a..b) onto points a..b, interpolated by distance.
 * With `blend`, the offset to the original elevation at both edges is spread across the range so the
 * corrected stretch joins the untouched parts without a step.
 */
export function applyElevation(pts, D, a, b, samples, blend) {
  const out = pts.slice(), last = samples.length - 1;
  const offA = blend ? pts[a].ele - samples[0].ele : 0, offB = blend ? pts[b].ele - samples[last].ele : 0;
  const span = D.d[b] - D.d[a];
  let k = 0;
  for (let i = a; i <= b; i++) {
    while (k + 1 < last && samples[k + 1].i <= i) k++;
    const s0 = samples[k], s1 = samples[Math.min(k + 1, last)];
    const d0 = D.d[s0.i], d1 = D.d[s1.i];
    const u = d1 > d0 ? Math.min(1, Math.max(0, (D.d[i] - d0) / (d1 - d0))) : 0;
    const ub = span > 0 ? (D.d[i] - D.d[a]) / span : 0;
    const e = s0.ele + (s1.ele - s0.ele) * u + offA + (offB - offA) * ub;
    out[i] = { ...pts[i], ele: Math.round(e * 10) / 10 };
  }
  return out;
}
