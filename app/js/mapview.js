// Leaflet map: the track on a canvas renderer (fast for 50k+ points), overlays on SVG above it.
const C = { track: '#416180', dark: '#1d2d3d', ghost: '#98989b', partB: '#7a7a7d' };
const ll = p => [p.lat, p.lng];

export class MapView {
  constructor(el, handlers) {
    const L = window.L;
    this.L = L;
    this.el = el;
    this.map = L.map(el, { zoomControl: true, preferCanvas: true, center: [55.76, 37.62], zoom: 11 });
    L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.map.createPane('tfTop').style.zIndex = 450;
    this.top = L.svg({ pane: 'tfTop' });
    this.base = L.layerGroup().addTo(this.map);
    this.selL = L.layerGroup().addTo(this.map);
    this.draftL = L.layerGroup().addTo(this.map);
    this.editL = L.layerGroup().addTo(this.map);
    this.hoverL = L.layerGroup().addTo(this.map);

    this.map.on('click', e => handlers.click(e.latlng));
    this.map.on('mousedown', e => { if (e.originalEvent.button === 0) handlers.down(e.latlng); });
    this.map.on('mousemove', e => handlers.move(e.latlng));
    this.map.on('mouseup', () => handlers.up());
    window.addEventListener('mouseup', () => handlers.up());
    if (window.ResizeObserver) new ResizeObserver(() => this.map.invalidateSize()).observe(el);
  }

  fit(pts) {
    this.map.invalidateSize();
    const b = this.L.latLngBounds(pts.map(ll));
    if (b.isValid()) this.map.fitBounds(b, { padding: [26, 26] });
  }

  sq(dark, draggable) {
    return this.L.divIcon({ className: '', iconSize: [12, 12], iconAnchor: [6, 6],
      html: '<div class="tf-sq' + (dark ? ' is-dark' : '') + (draggable ? ' is-drag' : '') + '"></div>' });
  }

  setBase({ pts, orig, partB, ghost }) {
    const L = this.L, g = this.base, off = { interactive: false };
    g.clearLayers();
    if (ghost) L.polyline(orig.map(ll), { ...off, color: C.ghost, weight: 2, dashArray: '5 5' }).addTo(g);
    if (partB) L.polyline(partB.map(ll), { ...off, color: C.partB, weight: 3, dashArray: '2 5' }).addTo(g);
    L.polyline(pts.map(ll), { ...off, color: C.track, weight: 4 }).addTo(g);
    // Edited stretches are drawn darker, joined to their neighbours.
    const runs = [];
    let run = null;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].fixed) {
        if (!run) { run = [ll(pts[Math.max(0, i - 1)])]; runs.push(run); }
        run.push(ll(pts[i]));
      } else if (run) { run.push(ll(pts[i])); run = null; }
    }
    runs.forEach(r => L.polyline(r, { ...off, color: C.dark, weight: 5 }).addTo(g));
    L.marker(ll(pts[0]), { icon: this.sq(true), interactive: false }).addTo(g);
    L.circleMarker(ll(pts[pts.length - 1]), { ...off, radius: 6, color: C.dark, weight: 2.5, fill: false }).addTo(g);
  }

  setSel(pts, sp) {
    const L = this.L, g = this.selL;
    g.clearLayers();
    if (!sp) return;
    const o = { interactive: false, renderer: this.top };
    L.polyline(pts.slice(sp.a, sp.b + 1).map(ll), { ...o, color: C.dark, weight: 13, opacity: 0.25, lineCap: 'round' }).addTo(g);
    [sp.a, sp.b].forEach(i => L.circleMarker(ll(pts[i]), { ...o, radius: 5, color: C.dark, weight: 2, fillColor: '#f2f2f3', fillOpacity: 1 }).addTo(g));
  }

  setDraft(pts, sp, draft, vertices) {
    const L = this.L, g = this.draftL;
    g.clearLayers();
    if (!sp || !draft.length) return;
    L.polyline([ll(pts[sp.a]), ...draft.map(ll), ll(pts[sp.b])], { interactive: false, renderer: this.top, color: C.dark, weight: 2.5, dashArray: '7 4' }).addTo(g);
    if (vertices) draft.forEach(p => L.marker(ll(p), { icon: this.sq(false), interactive: false }).addTo(g));
  }

  setEdit(pts, sp, on, onMove) {
    const g = this.editL;
    g.clearLayers();
    if (!on) return;
    const a = sp ? sp.a : 0, b = sp ? sp.b : pts.length - 1;
    const step = Math.max(1, Math.ceil((b - a + 1) / 60));
    const idx = [];
    for (let i = a; i <= b; i += step) idx.push(i);
    if (idx[idx.length - 1] !== b) idx.push(b);
    idx.forEach(i => {
      this.L.marker(ll(pts[i]), { icon: this.sq(false, true), draggable: true, autoPan: true })
        .on('dragend', ev => onMove(i, ev.target.getLatLng()))
        .addTo(g);
    });
  }

  setHover(p) {
    const L = this.L, g = this.hoverL;
    g.clearLayers();
    if (!p) return;
    const o = { interactive: false, renderer: this.top };
    L.circleMarker(ll(p), { ...o, radius: 9, color: C.dark, weight: 1.2, fill: false }).addTo(g);
    L.circleMarker(ll(p), { ...o, radius: 3.5, color: C.dark, fillColor: C.dark, fillOpacity: 1, weight: 0 }).addTo(g);
  }

  showRange(pts, sp) {
    const b = this.L.latLngBounds(pts.slice(sp.a, sp.b + 1).map(ll));
    if (b.isValid()) this.map.fitBounds(b.pad(0.6), { maxZoom: 17 });
  }

  setMode({ drawing, crosshair }) {
    if (drawing) this.map.dragging.disable(); else this.map.dragging.enable();
    this.el.classList.toggle('is-drawing', !!crosshair);
  }
}
