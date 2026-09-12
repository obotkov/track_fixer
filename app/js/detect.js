// Automatic GPS outlier detection: the rules and their settings.
// Defaults come from /config/detect.json (edit it on the server to change them for everyone);
// a visitor's own tweaks from the settings dialog are stored in localStorage on top of it.
import { THRESH, medianSpacing } from './track.js';

export const DEFAULTS = {
  showOnMap: true,
  speed: { enabled: true, maxKmh: 65 },
  jump: { enabled: true, maxM: 250, vsMedian: 25 },
  spike: { enabled: true, minM: 30, maxAngleDeg: 60 },
  mergeGapPoints: 4,
  pause: { maxKmh: 3, minSec: 5 },
};

const KEY = 'trackfix.detect.v1';
const clone = o => JSON.parse(JSON.stringify(o));
let base = clone(DEFAULTS);   // DEFAULTS overlaid with detect.json
export let CFG = clone(DEFAULTS);

/** Copy known keys of the same type from src; a broken file or stale storage can't break detection. */
function merge(into, src) {
  if (!src || typeof src !== 'object') return into;
  for (const k of Object.keys(into)) {
    const v = src[k];
    if (into[k] && typeof into[k] === 'object') merge(into[k], v);
    else if (typeof v === typeof into[k] && (typeof v !== 'number' || Number.isFinite(v))) into[k] = v;
  }
  return into;
}

// Thresholds shared with stats and edits (moving time, pauses, "suspicious" max speed).
function apply() {
  THRESH.anomalyKmh = CFG.speed.maxKmh;
  THRESH.pauseKmh = CFG.pause.maxKmh;
  THRESH.minPauseSec = CFG.pause.minSec;
}

export async function loadConfig() {
  try {
    const r = await fetch('config/detect.json', { cache: 'no-cache' });
    if (r.ok) base = merge(clone(DEFAULTS), await r.json());
  } catch { /* offline or missing file: built-in defaults */ }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY)); } catch { /* storage blocked */ }
  CFG = merge(clone(base), saved);
  apply();
}

export function setConfig(next) {
  CFG = merge(clone(base), next);
  apply();
  try { localStorage.setItem(KEY, JSON.stringify(CFG)); } catch { /* storage blocked */ }
}

export function resetConfig() {
  CFG = clone(base);
  apply();
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

const SPEED = 1, JUMP = 2, SPIKE = 4;

/**
 * Stretches of the track that break a rule. Flags are per segment (i-1 → i); flagged segments close
 * to each other are merged, and each stretch [a, b] is bounded by clean anchor points.
 */
export function findAnomalies(pts, D, cfg = CFG) {
  const n = D.n, flags = new Uint8Array(n), out = new Float64Array(n);
  const len = i => D.d[i] - D.d[i - 1];
  if (cfg.speed.enabled) {
    for (let i = 1; i < n; i++) if (D.seg[i] > cfg.speed.maxKmh && len(i) > 5) flags[i] |= SPEED;
  }
  if (cfg.jump.enabled) {
    const lim = Math.max(cfg.jump.maxM, medianSpacing(D) * cfg.jump.vsMedian);
    for (let i = 1; i < n; i++) if (len(i) > lim) flags[i] |= JUMP;
  }
  if (cfg.spike.enabled) {
    // A point that flies off and comes back forms a sharp V: both legs long, small angle at the point.
    // Ordinary corners stay near 90° or have short legs.
    const cosMax = Math.cos(cfg.spike.maxAngleDeg * Math.PI / 180);
    for (let i = 1; i < n - 1; i++) {
      const d1 = len(i), d2 = len(i + 1), off = Math.min(d1, d2);
      if (off <= cfg.spike.minM) continue;
      const P = pts[i], A = pts[i - 1], B = pts[i + 1], kx = Math.cos(P.lat * Math.PI / 180);
      const ax = (A.lng - P.lng) * kx, ay = A.lat - P.lat, bx = (B.lng - P.lng) * kx, by = B.lat - P.lat;
      const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
      if (cos > cosMax) { flags[i] |= SPIKE; flags[i + 1] |= SPIKE; out[i] = off; }
    }
  }

  const runs = [];
  let cur = null;
  for (let i = 1; i < n; i++) {
    if (!flags[i]) continue;
    if (cur && i - cur.last <= cfg.mergeGapPoints) cur.last = i;
    else { cur = { first: i, last: i }; runs.push(cur); }
  }
  return runs.map(r => {
    let maxV = 0, maxLen = 0, maxOut = 0, all = 0;
    for (let i = r.first; i <= r.last; i++) {
      all |= flags[i];
      if (flags[i] && Number.isFinite(D.seg[i]) && D.seg[i] > maxV) maxV = D.seg[i];
      maxLen = Math.max(maxLen, len(i));
      maxOut = Math.max(maxOut, out[i]);
    }
    const kind = all & SPEED && maxV > 0 ? 'speed' : all & (JUMP | SPEED) ? 'jump' : 'spike';
    return { a: r.first - 1, b: r.last, kind, maxV, maxLen, maxOut };
  });
}

const fmtM = m => (m < 1000 ? Math.round(m) + ' м' : (m / 1000).toFixed(1) + ' км');

export function describe(r) {
  if (r.kind === 'speed') return `Скорость до ${Math.round(r.maxV)} км/ч на ${r.b - r.a + 1} точках — похоже на потерю сигнала и прямую «врезку» в маршрут.`;
  if (r.kind === 'jump') return `Скачок ${fmtM(r.maxLen)} между соседними точками — похоже на потерю сигнала.`;
  return `Острый выброс: трек уходит в сторону на ${fmtM(r.maxOut)} и сразу возвращается.`;
}

export function shortLabel(r) {
  return r.kind === 'speed' ? `Выброс: скорость ${Math.round(r.maxV)} км/ч`
    : r.kind === 'jump' ? `Выброс: скачок ${fmtM(r.maxLen)}`
    : `Выброс: отлёт ${fmtM(r.maxOut)}`;
}
