// GPX / TCX / FIT readers. Everything runs locally in the browser.
import { normalize } from './track.js';

export const MAX_BYTES = 40 * 1024 * 1024;

export async function parseTrackFile(file) {
  if (file.size > MAX_BYTES) throw new Error('Файл больше 40 МБ.');
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isFit = u8.length > 12 && String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === '.FIT';

  // summary: totals the device wrote itself (calories, distance), when the format carries them.
  let raw, name = null, format, summary = {};
  if (isFit || ext === 'fit') {
    ({ raw, summary } = parseFIT(buf));
    format = 'FIT';
  } else {
    const text = decodeText(u8);
    const head = text.slice(0, 4000);
    const doc = parseXML(text);
    if (/<TrainingCenterDatabase/i.test(head) || ext === 'tcx') { raw = parseTCX(doc); summary = tcxSummary(doc); format = 'TCX'; }
    else if (/<gpx[\s>]/i.test(head) || ext === 'gpx') { ({ raw, name } = parseGPX(doc)); format = 'GPX'; }
    else throw new Error('Неизвестный формат. Поддерживаются GPX, FIT и TCX.');
  }
  if (!raw.length) throw new Error('В файле не найдено ни одной точки трека.');
  const { pts, has } = normalize(raw);
  return { pts, has, name, format, summary };
}

/* ───────────── XML ───────────── */

function decodeText(u8) {
  const head = new TextDecoder('ascii').decode(u8.subarray(0, 200));
  const m = /encoding=["']([\w-]+)["']/i.exec(head);
  try { return new TextDecoder(m ? m[1] : 'utf-8').decode(u8); } catch { return new TextDecoder('utf-8').decode(u8); }
}

function parseXML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Файл повреждён: не удалось разобрать XML.');
  return doc;
}

const first = (el, name) => el.getElementsByTagNameNS('*', name)[0] || null;
const txt = (el, name) => { const n = first(el, name); return n ? n.textContent.trim() : null; };
const fl = s => (s == null || s === '' ? null : parseFloat(s));
const time = s => { if (!s) return null; const v = Date.parse(s); return Number.isFinite(v) ? v : null; };

function parseGPX(doc) {
  let nodes = doc.getElementsByTagNameNS('*', 'trkpt');
  if (!nodes.length) nodes = doc.getElementsByTagNameNS('*', 'rtept');
  const raw = [];
  for (const el of nodes) {
    const p = { lat: fl(el.getAttribute('lat')), lng: fl(el.getAttribute('lon')), ele: fl(txt(el, 'ele')), t: time(txt(el, 'time')) };
    const ext = first(el, 'extensions');
    if (ext) {
      for (const x of ext.getElementsByTagName('*')) {
        if (x.children.length) continue;
        const k = x.localName.toLowerCase(), v = fl(x.textContent);
        if (v == null || Number.isNaN(v)) continue;
        if (k === 'hr' || k === 'heartrate') p.hr = v;
        else if (k === 'cad' || k === 'cadence') p.cad = v;
        else if (k === 'power' || k === 'watts') p.pw = v;
        else if (k === 'atemp' || k === 'temp' || k === 'temperature') p.temp = v;
      }
    }
    raw.push(p);
  }
  const trk = first(doc, 'trk') || first(doc, 'rte');
  const name = (trk && txt(trk, 'name')) || null;
  return { raw, name };
}

function parseTCX(doc) {
  const raw = [];
  for (const tp of doc.getElementsByTagNameNS('*', 'Trackpoint')) {
    const pos = first(tp, 'Position');
    const p = {
      lat: pos ? fl(txt(pos, 'LatitudeDegrees')) : null,
      lng: pos ? fl(txt(pos, 'LongitudeDegrees')) : null,
      t: time(txt(tp, 'Time')), ele: fl(txt(tp, 'AltitudeMeters')), cad: fl(txt(tp, 'Cadence')),
    };
    const hr = first(tp, 'HeartRateBpm');
    if (hr) p.hr = fl(txt(hr, 'Value'));
    const w = txt(tp, 'Watts');
    if (w != null) p.pw = fl(w);
    raw.push(p);
  }
  return raw;
}

/** Lap totals of a TCX activity: calories and distance the device recorded. */
function tcxSummary(doc) {
  const sum = {};
  for (const lap of doc.getElementsByTagNameNS('*', 'Lap')) {
    const own = name => [...lap.children].find(c => c.localName === name);
    const kcal = own('Calories'), dist = own('DistanceMeters');
    if (kcal) sum.calories = (sum.calories || 0) + fl(kcal.textContent);
    if (dist) sum.distance = (sum.distance || 0) + fl(dist.textContent);
  }
  return sum;
}

/* ───────────── FIT (binary) ───────────── */

const FIT_EPOCH = 631065600000;         // 1989-12-31T00:00:00Z
const SEMI = 180 / 2 ** 31;             // semicircles → degrees
// base type → [size, DataView getter, invalid value]
const BT = {
  0: [1, 'getUint8', 0xff], 1: [1, 'getInt8', 0x7f], 2: [1, 'getUint8', 0xff],
  3: [2, 'getInt16', 0x7fff], 4: [2, 'getUint16', 0xffff],
  5: [4, 'getInt32', 0x7fffffff], 6: [4, 'getUint32', 0xffffffff],
  8: [4, 'getFloat32', null], 9: [8, 'getFloat64', null],
  10: [1, 'getUint8', 0], 11: [2, 'getUint16', 0], 12: [4, 'getUint32', 0], 13: [1, 'getUint8', 0xff],
};

function readField(dv, pos, size, bt, le) {
  const t = BT[bt & 0x1f];
  if (!t || t[0] !== size) return null;
  const v = dv[t[1]](pos, le);
  return v === t[2] || Number.isNaN(v) ? null : v;
}

function parseFIT(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf), raw = [], summary = {};
  let off = 0;
  // A .fit may hold several chained FIT files; read them all.
  while (off + 12 <= u8.length) {
    const hs = u8[off];
    if (hs < 12 || String.fromCharCode(u8[off + 8], u8[off + 9], u8[off + 10], u8[off + 11]) !== '.FIT') {
      if (off === 0) throw new Error('Не похоже на FIT-файл.');
      break;
    }
    const end = Math.min(off + hs + dv.getUint32(off + 4, true), u8.length);
    readFitRecords(dv, u8, off + hs, end, raw, summary);
    off = end + 2;
  }
  return { raw, summary };
}

function readFitRecords(dv, u8, pos, end, raw, summary) {
  const defs = [];
  let lastTs = null;
  while (pos < end) {
    const h = u8[pos++];
    let def, tsOverride = null;
    if (h & 0x80) {                               // compressed timestamp header
      def = defs[(h >> 5) & 3];
      if (lastTs != null) {
        const o = h & 0x1f, low = lastTs % 32;
        lastTs = lastTs - low + o + (o < low ? 32 : 0);
        tsOverride = lastTs;
      }
    } else if (h & 0x40) {                        // definition message
      const le = u8[pos + 1] === 0, gnum = dv.getUint16(pos + 2, le), nf = u8[pos + 4];
      pos += 5;
      const fields = [];
      let size = 0;
      for (let k = 0; k < nf; k++, pos += 3) { fields.push([u8[pos], u8[pos + 1], u8[pos + 2]]); size += u8[pos + 1]; }
      if (h & 0x20) { const nd = u8[pos++]; for (let k = 0; k < nd; k++, pos += 3) size += u8[pos + 1]; }
      defs[h & 0x0f] = { gnum, le, fields, size };
      continue;
    } else def = defs[h & 0x0f];

    if (!def) throw new Error('FIT-файл повреждён: сообщение без определения.');
    if (pos + def.size > end) break;
    const rec = def.gnum === 20 || def.gnum === 18 ? {} : null;     // 20 = record, 18 = session totals
    let p = pos;
    for (const [num, size, bt] of def.fields) {
      if (num === 253 || rec) {
        const v = readField(dv, p, size, bt, def.le);
        if (num === 253 && v != null) lastTs = v;
        if (rec && v != null) rec[num] = v;
      }
      p += size;
    }
    pos += def.size;
    if (!rec) continue;
    if (def.gnum === 18) {   // session: 11 total_calories (kcal), 9 total_distance (cm); summed over sessions
      if (rec[11] != null) summary.calories = (summary.calories || 0) + rec[11];
      if (rec[9] != null) summary.distance = (summary.distance || 0) + rec[9] / 100;
      continue;
    }
    const ts = rec[253] ?? tsOverride;
    const alt = rec[78] != null ? rec[78] / 5 - 500 : rec[2] != null ? rec[2] / 5 - 500 : null;
    raw.push({
      lat: rec[0] != null ? rec[0] * SEMI : null, lng: rec[1] != null ? rec[1] * SEMI : null,
      t: ts != null ? FIT_EPOCH + ts * 1000 : null, ele: alt,
      hr: rec[3] ?? null, cad: rec[4] ?? null, pw: rec[7] ?? null, temp: rec[13] ?? null,
    });
  }
}
