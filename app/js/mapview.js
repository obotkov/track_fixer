// Leaflet map: the track on a canvas renderer (fast for 50k+ points), overlays on SVG above it.
const C = { track: '#416180', dark: '#1d2d3d', ghost: '#98989b', partB: '#7a7a7d', sel: '#e0322b', out: '#f08c00', paper: '#ffffff' };
const ll = p => [p.lat, p.lng];

export class MapView {
  constructor(el, handlers) {
    const L = window.L;
    this.L = L;
    this.el = el;
    // Fractional zoom lets fitBounds fill the frame instead of stopping a whole level short.
    this.map = L.map(el, { zoomControl: true, preferCanvas: true, zoomSnap: 0.25, center: [55.76, 37.62], zoom: 11 });
    L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.map.createPane('tfTop').style.zIndex = 450;
    this.top = L.svg({ pane: 'tfTop' });
    this.map.createPane('tfOut').style.zIndex = 440;   // detected outliers: above the track, below selection
    this.outR = L.svg({ pane: 'tfOut' });
    this.outL = L.layerGroup().addTo(this.map);
    this.base = L.layerGroup().addTo(this.map);
    this.selL = L.layerGroup().addTo(this.map);
    this.draftL = L.layerGroup().addTo(this.map);
    this.editL = L.layerGroup().addTo(this.map);
    this.hoverL = L.layerGroup().addTo(this.map);
    this.vx = new Map();
    this.mids = [];
    this.map.on('zoomend', () => this.updateMids());

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

  setBase({ pts, orig, partB, ghost, gaps = [], dotGaps = true }) {
    const L = this.L, g = this.base, off = { interactive: false };
    g.clearLayers();
    if (ghost) L.polyline(orig.map(ll), { ...off, color: C.ghost, weight: 2, dashArray: '5 5' }).addTo(g);
    if (partB) L.polyline(partB.map(ll), { ...off, color: C.partB, weight: 3, dashArray: '2 5' }).addTo(g);
    // Glitch runs (signal loss, teleports) are dotted so the straight chords don't read as ridden route.
    const solid = [], dotted = [];
    let start = 0;
    for (const r of gaps) {
      if (r.a > start) solid.push(pts.slice(start, r.a + 1).map(ll));
      dotted.push(pts.slice(r.a, r.b + 1).map(ll));
      start = r.b;
    }
    solid.push(pts.slice(start).map(ll));
    L.polyline(solid, { ...off, color: C.track, weight: 4 }).addTo(g);
    // With outliers highlighted (setOutliers) the glitch geometry is drawn there instead.
    if (dotGaps && dotted.length) L.polyline(dotted, { ...off, color: C.dark, weight: 3, dashArray: '1 7', lineCap: 'round' }).addTo(g);
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

  /**
   * Detected outliers in orange: a halo plus a dashed line over each stretch and a dot on every point
   * inside it. Hover shows the reason; click picks the stretch (only when `interactive`, so the
   * redraw and points tools can click through to the map).
   */
  setOutliers(pts, runs, labels, onPick, interactive) {
    const L = this.L, g = this.outL;
    g.clearLayers();
    if (!runs) return;
    const o = { renderer: this.outR, interactive, bubblingMouseEvents: false };
    let dots = 0;
    runs.forEach((r, k) => {
      const line = pts.slice(r.a, r.b + 1).map(ll);
      for (const style of [{ weight: 12, opacity: 0.28, lineCap: 'round' }, { weight: 3, dashArray: '6 5' }]) {
        const l = L.polyline(line, { ...o, color: C.out, ...style }).addTo(g);
        if (interactive) l.bindTooltip(labels[k], { sticky: true }).on('click', () => onPick(k));
      }
      for (let i = r.a + 1; i < r.b && dots < 3000; i++, dots++) {
        L.circleMarker(ll(pts[i]), { renderer: this.outR, interactive: false, radius: 3.5, color: C.paper, weight: 1.5, fillColor: C.out, fillOpacity: 1 }).addTo(g);
      }
    });
  }

  setSel(pts, sp) {
    const L = this.L, g = this.selL;
    g.clearLayers();
    if (!sp) return;
    const o = { interactive: false, renderer: this.top }, line = pts.slice(sp.a, sp.b + 1).map(ll);
    L.polyline(line, { ...o, color: C.sel, weight: 12, opacity: 0.22, lineCap: 'round' }).addTo(g);
    L.polyline(line, { ...o, color: C.sel, weight: 4, opacity: 0.95, lineJoin: 'round' }).addTo(g);
    [sp.a, sp.b].forEach(i => L.circleMarker(ll(pts[i]), { ...o, radius: 5, color: C.sel, weight: 2.5, fillColor: C.paper, fillOpacity: 1 }).addTo(g));
  }

  setDraft(pts, sp, draft, vertices) {
    const L = this.L, g = this.draftL;
    g.clearLayers();
    if (!sp || !draft.length) return;
    L.polyline([ll(pts[sp.a]), ...draft.map(ll), ll(pts[sp.b])], { interactive: false, renderer: this.top, color: C.dark, weight: 2.5, dashArray: '7 4' }).addTo(g);
    if (vertices) draft.forEach(p => L.marker(ll(p), { icon: this.sq(false), interactive: false }).addTo(g));
  }

  /**
   * Vertex editing. `idx` are point indices drawn as draggable squares (those in `bad` filled);
   * a "+" handle sits between every two adjacent points to insert a new one.
   * cb: preview(i, ll) → latlngs, move(i, ll), insert(k, ll), remove(i), activate(i), hover(i | null).
   */
  setEdit(opt) {
    const L = this.L, g = this.editL;
    g.clearLayers();
    this.vx = new Map();
    this.mids = [];
    if (!opt) return;
    const { pts, idx, bad, cb } = opt;
    const preview = L.polyline([], { interactive: false, renderer: this.top, color: C.dark, weight: 2.5, dashArray: '6 4' }).addTo(g);
    const icon = (cls, s) => L.divIcon({ className: cls, iconSize: [s, s], iconAnchor: [s / 2, s / 2] });

    for (let k = 0; k + 1 < idx.length; k++) {
      const a = idx[k], b = idx[k + 1];
      if (b !== a + 1) continue;
      const A = ll(pts[a]), B = ll(pts[b]), mid = { lat: (A[0] + B[0]) / 2, lng: (A[1] + B[1]) / 2 };
      const m = L.marker(mid, { icon: icon('tf-mid', 18), draggable: true, autoPan: true, keyboard: false, zIndexOffset: -500, title: 'Потяните или кликните — новая точка' })
        .on('drag', e => preview.setLatLngs([A, e.target.getLatLng(), B]))
        .on('dragend', e => { preview.setLatLngs([]); cb.insert(b, e.target.getLatLng()); })
        .on('click', () => cb.insert(b, mid))
        .addTo(g);
      this.mids.push([m, A, B]);
    }
    for (const i of idx) {
      const m = L.marker(ll(pts[i]), { icon: icon('tf-vx' + (bad.has(i) ? ' is-bad' : ''), 22), draggable: true, autoPan: true, keyboard: false, riseOnHover: true })
        .on('dragstart', () => cb.activate(i))
        .on('drag', e => preview.setLatLngs(cb.preview(i, e.target.getLatLng())))
        .on('dragend', e => { preview.setLatLngs([]); cb.move(i, e.target.getLatLng()); })
        .on('click', () => cb.activate(i))
        .on('dblclick contextmenu', e => { L.DomEvent.stop(e.originalEvent); cb.remove(i); })
        .on('mouseover', () => cb.hover(i))
        .on('mouseout', () => cb.hover(null))
        .addTo(g);
      this.vx.set(i, m);
    }
    this.updateMids();
  }

  /** Hide "+" handles whose segment is too short on screen to grab without hitting a vertex. */
  updateMids() {
    for (const [m, A, B] of this.mids) {
      const el = m.getElement();
      if (el) el.style.visibility = this.map.latLngToLayerPoint(A).distanceTo(this.map.latLngToLayerPoint(B)) < 24 ? 'hidden' : '';
    }
  }

  setActiveVertex(i) {
    for (const [j, m] of this.vx) {
      const el = m.getElement();
      if (el) el.classList.toggle('is-active', j === i);
      m.setZIndexOffset(j === i ? 1000 : 0);
    }
  }

  pxDistance(a, b) {
    return this.map.latLngToContainerPoint(ll(a)).distanceTo(this.map.latLngToContainerPoint(ll(b)));
  }

  /** The red point that runs along the track with the track-line cursor; moved, not recreated. */
  setHover(p) {
    if (!p) { this.hoverL.clearLayers(); this.hv = null; return; }
    if (!this.hv) {
      const o = { interactive: false, renderer: this.top };
      this.hv = [
        this.L.circleMarker(ll(p), { ...o, radius: 11, color: C.sel, weight: 1.5, fillColor: C.sel, fillOpacity: 0.15 }),
        this.L.circleMarker(ll(p), { ...o, radius: 5.5, color: C.paper, weight: 2, fillColor: C.sel, fillOpacity: 1 }),
      ];
      this.hv.forEach(m => m.addTo(this.hoverL));
    }
    this.hv.forEach(m => m.setLatLng(ll(p)));
  }

  showRange(pts, sp, maxZoom = 17) {
    const b = this.L.latLngBounds(pts.slice(sp.a, sp.b + 1).map(ll));
    if (b.isValid()) this.map.fitBounds(b.pad(0.6), { maxZoom });
  }

  setMode({ drawing, crosshair, editing }) {
    if (drawing) this.map.dragging.disable(); else this.map.dragging.enable();
    // While editing points, arrows nudge the active point and double click deletes it.
    for (const h of [this.map.keyboard, this.map.doubleClickZoom]) { if (editing) h.disable(); else h.enable(); }
    this.el.classList.toggle('is-drawing', !!crosshair);
  }
}
