// Track-line chart geometry. X is the point index (≈ time for 1 s recordings), bucketed to ≤ 1200 columns.
export const W = 1200, H = 176;
export const xOf = (i, n) => (n > 1 ? i / (n - 1) * W : 0);

function range(arr, { zero = false, capMedian = 0, clipTop = false } = {}) {
  const v = arr.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const lo = zero ? 0 : v[0];
  let hi = v[v.length - 1];
  if (capMedian) hi = Math.min(hi, Math.max(v[v.length >> 1] * capMedian, lo + 10));
  if (clipTop) hi = Math.min(hi, v[Math.floor((v.length - 1) * 0.99)] * 1.1);
  return [lo, Math.max(hi, lo + 1)];
}

function line(xs, arr, rg) {
  if (!rg) return '';
  let s = '', pen = false;
  for (let k = 0; k < arr.length; k++) {
    const v = arr[k];
    if (v == null || !Number.isFinite(v)) { pen = false; continue; }
    const f = Math.min(1, Math.max(0, (v - rg[0]) / (rg[1] - rg[0])));
    s += (pen ? 'L' : 'M') + xs[k].toFixed(1) + ' ' + (166 - f * 148).toFixed(1);
    pen = true;
  }
  return s;
}

export function buildChart(pts, D, { ch, has, anoms, pauses }) {
  const n = D.n, B = Math.min(n, W);
  const xs = [], be = [], bs = [], bh = [], bp = [];
  for (let k = 0; k < B; k++) {
    const i0 = Math.floor(k * n / B), i1 = Math.max(i0, Math.floor((k + 1) * n / B) - 1);
    let e = 0, s = 0, sn = 0, h = 0, hn = 0, w = 0, wn = 0;
    for (let i = i0; i <= i1; i++) {
      const p = pts[i];
      e += p.ele;
      if (Number.isFinite(D.sp[i])) { s += D.sp[i]; sn++; }
      if (p.hr != null) { h += p.hr; hn++; }
      if (p.pw != null) { w += p.pw; wn++; }
    }
    xs.push(B === n ? xOf(i0, n) : k === 0 ? 0 : k === B - 1 ? W : xOf((i0 + i1) / 2, n));
    be.push(e / (i1 - i0 + 1));
    bs.push(sn ? s / sn : null);
    bh.push(hn ? h / hn : null);
    bp.push(wn ? w / wn : null);
  }

  let e0 = Infinity, e1 = -Infinity;
  for (const p of pts) { if (p.ele < e0) e0 = p.ele; if (p.ele > e1) e1 = p.ele; }
  const b0 = Math.min(...be), b1 = Math.max(...be);
  const yE = v => H - (v - b0) / Math.max(b1 - b0, 1) * 104;
  let area = '', elev = '';
  if (has.ele) {
    area = 'M0 ' + H;
    be.forEach((v, k) => { const p = xs[k].toFixed(1) + ' ' + yE(v).toFixed(1); area += ' L' + p; elev += (k ? ' L' : 'M') + p; });
    area += ' L' + W + ' ' + H + ' Z';
  }

  const band = (r, min) => ({ x: xOf(r.a, n), w: Math.max(min, xOf(r.b, n) - xOf(r.a, n)) });
  return {
    area, elev, e0, e1,
    // Speed is capped near 2.4× the median so a GPS glitch hits the ceiling instead of flattening the ride.
    speed: ch.sp ? line(xs, bs, range(bs, { zero: true, capMedian: 2.4 })) : '',
    hr: ch.hr && has.hr ? line(xs, bh, range(bh)) : '',
    pw: ch.pw && has.pw ? line(xs, bp, range(bp, { zero: true, clipTop: true })) : '',
    anomBands: anoms.map(r => band(r, 3)),
    pauseBands: pauses.map(r => band(r, 2)),
  };
}
