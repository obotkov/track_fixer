// Track writers: GPX 1.1, TCX (Garmin Training Center v2) and FIT (binary activity file).
import { derive, trackStats } from './track.js';

export const FORMATS = {
  gpx: { ext: 'gpx', mime: 'application/gpx+xml', label: 'GPX' },
  tcx: { ext: 'tcx', mime: 'application/vnd.garmin.tcx+xml', label: 'TCX' },
  fit: { ext: 'fit', mime: 'application/vnd.ant.fit', label: 'FIT' },
};

/** opts: { name, has, kcal } — kcal is the ride total for TCX/FIT summaries (power-based or the device's). */
export function buildExport(fmt, pts, opts) {
  if (fmt === 'tcx') return toTCX(pts, opts);
  if (fmt === 'fit') return toFIT(pts, opts);
  return toGPX(pts, opts);
}

const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const iso = t => new Date(t).toISOString().replace('.000Z', 'Z');

/* ───────────── GPX ───────────── */

// Heart rate, cadence and temperature go to Garmin TrackPointExtension, power to <power> —
// the pair Strava, Garmin Connect and most analysers read.
export function toGPX(pts, { name, has }) {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="TrackFix GPX — wild-loop.ru" xmlns="http://www.topografix.com/GPX/1/1"'
      + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
      + ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"'
      + ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd'
      + ' http://www.garmin.com/xmlschemas/TrackPointExtension/v1 http://www8.garmin.com/xmlschemas/TrackPointExtensionv1.xsd">',
    ' <metadata>' + (name ? '<name>' + esc(name) + '</name>' : '') + (has.time ? '<time>' + iso(pts[0].t) + '</time>' : '') + '</metadata>',
    ' <trk>' + (name ? '<name>' + esc(name) + '</name>' : '') + '<type>cycling</type><trkseg>',
  ];
  for (const p of pts) {
    let s = '  <trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lng.toFixed(7) + '">';
    if (has.ele) s += '<ele>' + p.ele.toFixed(1) + '</ele>';
    if (has.time) s += '<time>' + iso(p.t) + '</time>';
    const tpx = (p.temp != null ? '<gpxtpx:atemp>' + Math.round(p.temp) + '</gpxtpx:atemp>' : '')
      + (p.hr != null ? '<gpxtpx:hr>' + Math.round(p.hr) + '</gpxtpx:hr>' : '')
      + (p.cad != null ? '<gpxtpx:cad>' + Math.round(p.cad) + '</gpxtpx:cad>' : '');
    const pw = p.pw != null ? '<power>' + Math.round(p.pw) + '</power>' : '';
    if (tpx || pw) s += '<extensions>' + pw + (tpx ? '<gpxtpx:TrackPointExtension>' + tpx + '</gpxtpx:TrackPointExtension>' : '') + '</extensions>';
    out.push(s + '</trkpt>');
  }
  out.push(' </trkseg></trk>', '</gpx>', '');
  return out.join('\n');
}

/* ───────────── TCX ───────────── */

// One lap holding the whole ride; element order follows the TrainingCenterDatabase v2 schema.
export function toTCX(pts, { has, kcal }) {
  const D = derive(pts), s = trackStats(pts, D), t0 = iso(pts[0].t);
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"'
      + ' xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"'
      + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
      + ' xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">',
    ' <Activities>',
    '  <Activity Sport="Biking">',
    `   <Id>${t0}</Id>`,
    `   <Lap StartTime="${t0}">`,
    `    <TotalTimeSeconds>${s.total.toFixed(1)}</TotalTimeSeconds>`,
    `    <DistanceMeters>${s.dist.toFixed(1)}</DistanceMeters>`,
    `    <Calories>${Math.round(kcal || 0)}</Calories>`,
  ];
  if (s.hr != null) out.push(`    <AverageHeartRateBpm><Value>${Math.round(s.hr)}</Value></AverageHeartRateBpm>`);
  out.push('    <Intensity>Active</Intensity>');
  if (s.cad != null) out.push(`    <Cadence>${Math.min(254, Math.round(s.cad))}</Cadence>`);
  out.push('    <TriggerMethod>Manual</TriggerMethod>', '    <Track>');
  pts.forEach((p, i) => {
    let x = `     <Trackpoint><Time>${iso(p.t)}</Time><Position><LatitudeDegrees>${p.lat.toFixed(7)}</LatitudeDegrees>`
      + `<LongitudeDegrees>${p.lng.toFixed(7)}</LongitudeDegrees></Position>`;
    if (has.ele) x += `<AltitudeMeters>${p.ele.toFixed(1)}</AltitudeMeters>`;
    x += `<DistanceMeters>${D.d[i].toFixed(1)}</DistanceMeters>`;
    if (p.hr != null) x += `<HeartRateBpm><Value>${Math.round(p.hr)}</Value></HeartRateBpm>`;
    if (p.cad != null) x += `<Cadence>${Math.min(254, Math.round(p.cad))}</Cadence>`;
    const ext = (Number.isFinite(D.sp[i]) ? `<ns3:Speed>${(D.sp[i] / 3.6).toFixed(2)}</ns3:Speed>` : '')
      + (p.pw != null ? `<ns3:Watts>${Math.round(p.pw)}</ns3:Watts>` : '');
    if (ext) x += `<Extensions><ns3:TPX>${ext}</ns3:TPX></Extensions>`;
    out.push(x + '</Trackpoint>');
  });
  out.push('    </Track>', '   </Lap>', '  </Activity>', ' </Activities>', '</TrainingCenterDatabase>', '');
  return out.join('\n');
}

/* ───────────── FIT ───────────── */

const FIT_EPOCH = 631065600000;                  // 1989-12-31T00:00:00Z
const ENUM = 0x00, S8 = 0x01, U8 = 0x02, U16 = 0x84, S32 = 0x85, U32 = 0x86;
const SIZE = { [ENUM]: 1, [S8]: 1, [U8]: 1, [U16]: 2, [S32]: 4, [U32]: 4 };
const INVALID = { [ENUM]: 0xff, [S8]: 0x7f, [U8]: 0xff, [U16]: 0xffff, [S32]: 0x7fffffff, [U32]: 0xffffffff };
const RANGE = { [ENUM]: [0, 0xfe], [S8]: [-127, 126], [U8]: [0, 0xfe], [U16]: [0, 0xfffe], [S32]: [-0x7fffffff, 0x7ffffffe], [U32]: [0, 0xfffffffe] };
const CRC_TABLE = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];

export function fitCrc(bytes, from = 0, to = bytes.length) {
  let crc = 0;
  for (let i = from; i < to; i++) {
    const b = bytes[i];
    let t = CRC_TABLE[crc & 0xf]; crc = ((crc >> 4) & 0x0fff) ^ t ^ CRC_TABLE[b & 0xf];
    t = CRC_TABLE[crc & 0xf]; crc = ((crc >> 4) & 0x0fff) ^ t ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

class Bytes {
  constructor(n) { this.buf = new Uint8Array(n); this.dv = new DataView(this.buf.buffer); this.p = 0; }
  need(k) {
    if (this.p + k <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.p + k));
    nb.set(this.buf); this.buf = nb; this.dv = new DataView(nb.buffer);
  }
  put(bt, v) {
    this.need(SIZE[bt]);
    const [lo, hi] = RANGE[bt];
    const x = v == null || !Number.isFinite(v) ? INVALID[bt] : Math.min(hi, Math.max(lo, Math.round(v)));
    if (bt === S8) this.dv.setInt8(this.p, x);
    else if (bt === U16) this.dv.setUint16(this.p, x, true);
    else if (bt === S32) this.dv.setInt32(this.p, x, true);
    else if (bt === U32) this.dv.setUint32(this.p, x, true);
    else this.dv.setUint8(this.p, x);
    this.p += SIZE[bt];
  }
  define(local, global, fields) {
    this.put(U8, 0x40 | local); this.put(U8, 0); this.put(U8, 0);   // header, reserved, little-endian
    this.put(U16, global); this.put(U8, fields.length);
    for (const [num, bt] of fields) { this.put(U8, num); this.put(U8, SIZE[bt]); this.put(U8, bt); }
  }
  message(local, fields, values) {
    this.put(U8, local);
    fields.forEach(([, bt], k) => this.put(bt, values[k]));
  }
}

/**
 * Activity FIT: file_id, timer start, one record per point, timer stop, lap, session, activity,
 * with header and file CRCs — what Strava and Garmin Connect expect from a device upload.
 */
export function toFIT(pts, { kcal }) {
  const D = derive(pts), s = trackStats(pts, D), n = pts.length;
  const ts = t => Math.floor((t - FIT_EPOCH) / 1000);
  const semi = deg => Math.round(deg * 2147483648 / 180);
  const t0 = ts(pts[0].t), t1 = ts(pts[n - 1].t);
  let maxHr = null;
  for (const p of pts) if (p.hr != null && (maxHr == null || p.hr > maxHr)) maxHr = p.hr;
  const w = new Bytes(256 + n * 32);
  w.p = 14;                                                           // header is written last

  const FILE_ID = [[0, ENUM], [1, U16], [2, U16], [4, U32]];         // type, manufacturer, product, time_created
  w.define(0, 0, FILE_ID);
  w.message(0, FILE_ID, [4, 255, 0, t0]);                            // 4 = activity, 255 = development

  const EVENT = [[253, U32], [0, ENUM], [1, ENUM]];                  // timestamp, event, event_type
  w.define(1, 21, EVENT);
  w.message(1, EVENT, [t0, 0, 0]);                                   // timer start

  // timestamp, lat, long, enhanced_altitude, distance, enhanced_speed, heart_rate, cadence, power, temperature
  const REC = [[253, U32], [0, S32], [1, S32], [78, U32], [5, U32], [73, U32], [3, U8], [4, U8], [7, U16], [13, S8]];
  w.define(2, 20, REC);
  pts.forEach((p, i) => w.message(2, REC, [
    ts(p.t), semi(p.lat), semi(p.lng), p.ele != null ? (p.ele + 500) * 5 : null, D.d[i] * 100,
    Number.isFinite(D.sp[i]) ? D.sp[i] / 3.6 * 1000 : null, p.hr, p.cad, p.pw, p.temp,
  ]));

  w.message(1, EVENT, [t1, 0, 4]);                                   // timer stop_all

  const LAP = [[253, U32], [0, ENUM], [1, ENUM], [2, U32], [7, U32], [8, U32], [9, U32]];
  w.define(3, 19, LAP);
  w.message(3, LAP, [t1, 9, 1, t0, s.total * 1000, s.move * 1000, s.dist * 100]);

  // timestamp, event, event_type, start_time, sport, sub_sport, elapsed, timer, distance, calories,
  // avg_speed, avg_hr, max_hr, avg_cadence, ascent, descent, first_lap_index, num_laps
  const SES = [[253, U32], [0, ENUM], [1, ENUM], [2, U32], [5, ENUM], [6, ENUM], [7, U32], [8, U32], [9, U32], [11, U16],
    [14, U16], [16, U8], [17, U8], [18, U8], [22, U16], [23, U16], [25, U16], [26, U16]];
  w.define(4, 18, SES);
  w.message(4, SES, [t1, 8, 1, t0, 2, 0, s.total * 1000, s.move * 1000, s.dist * 100, kcal,
    s.avg / 3.6 * 1000, s.hr, maxHr, s.cad, s.gain, s.loss, 0, 1]);

  const ACT = [[253, U32], [0, U32], [1, U16], [2, ENUM], [3, ENUM], [4, ENUM], [5, U32]];
  w.define(5, 34, ACT);
  const local = t1 - new Date(pts[n - 1].t).getTimezoneOffset() * 60;
  w.message(5, ACT, [t1, s.move * 1000, 1, 0, 26, 1, local]);        // 26 = activity event, 1 = stop

  const end = w.p;
  w.p = 0;
  w.put(U8, 14); w.put(U8, 0x20); w.put(U16, 2132); w.put(U32, end - 14);   // header size, protocol 2.0, profile 21.32
  for (const c of '.FIT') w.put(U8, c.charCodeAt(0));
  w.put(U16, fitCrc(w.buf, 0, 12));
  w.p = end;
  w.put(U16, fitCrc(w.buf, 0, end));
  return w.buf.slice(0, w.p);
}

export function downloadFile(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
