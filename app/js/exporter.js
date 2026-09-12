// GPX 1.1 writer. Heart rate, cadence and temperature go to Garmin TrackPointExtension,
// power to <power> — the pair Strava, Garmin Connect and most analysers read.

const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const iso = t => new Date(t).toISOString().replace('.000Z', 'Z');

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

export function downloadFile(text, filename, type = 'application/gpx+xml') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
