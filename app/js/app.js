// TrackFix UI controller: one state object, a rAF-batched render, memoised heavy parts.
import {
  THRESH, derive, trackStats, findPauses, kmSplits, medianSpacing, normalize, hav,
  cutRange, keepRange, dropHead, splitAt, mergeTracks, smoothRange, dropPauses, shiftTime,
  insertPoint, insertAt, dragShift, dragPoint, removePoint, dropOutliers, replaceGeometry, applyElevation,
} from './track.js';
import { parseTrackFile } from './parsers.js';
import { CFG, loadConfig, setConfig, resetConfig, findAnomalies, describe, shortLabel } from './detect.js';
import { routeByBike, fetchElevations } from './services.js';
import { toGPX, downloadFile } from './exporter.js';
import { buildDemoRaw } from './demo.js';
import { buildChart, xOf } from './chart.js';
import { MapView } from './mapview.js';

const $ = id => document.getElementById(id);

const S = {
  fileName: '', baseName: '', trackName: '', format: '',
  pts: null, orig: null, has: null, partB: null, partBHas: null,   // pts === null: empty editor, no track yet
  dragFile: false,    // a file is being dragged over the page
  ver: 0, sel: null, dragging: null, hover: null, draft: [], history: [],
  tool: 'cut', dm: 'road', pp: 'stretch', sw: 7,
  ch: { sp: true, hr: true, pw: false },
  toast: '', busy: false, anomIdx: 0,
  active: null,       // point index picked in the points tool
};
let D = null, map = null, needFit = false, freeDrawing = false, EM = null;
const MAX_VERTS = 300; // editable markers shown at once; beyond that every k-th point
const M = { stats: null, anoms: [], pauses: [], splits: [], origDist: 0 };
const last = {};

/* ───────────── formatting ───────────── */

const km = m => (m / 1000).toFixed(2);
const z2 = n => String(n).padStart(2, '0');
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  return h ? h + ':' + z2(m) : m + ' мин';
}
function pace(v) {
  if (!(v > 0.2) || !Number.isFinite(v)) return '—';
  const s = Math.round(3600 / v);
  return Math.floor(s / 60) + ':' + z2(s % 60);
}
const clock = t => { const d = new Date(t); return z2(d.getHours()) + ':' + z2(d.getMinutes()) + ':' + z2(d.getSeconds()); };
const toLocalInput = t => { const d = new Date(t); return `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}T${clock(t)}`; };
const span = () => (S.sel ? { a: Math.min(S.sel.a, S.sel.b), b: Math.max(S.sel.a, S.sel.b) } : null);

/* ───────────── state changes ───────────── */

function recompute() {
  D = derive(S.pts);
  M.stats = trackStats(S.pts, D);
  M.anoms = findAnomalies(S.pts, D, CFG);
  M.pauses = findPauses(S.pts, D);
  M.splits = kmSplits(S.pts, D);
  if (S.anomIdx >= M.anoms.length) S.anomIdx = 0;
  if (S.sel && Math.max(S.sel.a, S.sel.b) >= S.pts.length) S.sel = null;
}

function commit(pts, extra = {}) {
  if (pts.length < 2) { S.toast = 'После правки осталось бы меньше двух точек — действие отменено.'; render(); return; }
  S.history.push({ pts: S.pts, partB: S.partB, partBHas: S.partBHas, has: S.has });
  if (S.history.length > 60) S.history.shift();
  S.pts = pts; S.ver++; S.draft = [];
  Object.assign(S, extra);
  recompute();
  render();
}

function undo() {
  const h = S.history.pop();
  if (!h || S.busy) return;
  Object.assign(S, { pts: h.pts, partB: h.partB, partBHas: h.partBHas, has: h.has, sel: null, draft: [], active: null, toast: 'Последнее действие отменено' });
  S.ver++;
  recompute();
  render();
}

// Batch renders into one frame; the timer covers background tabs where rAF is paused.
let raf = 0, rafTimer = 0;
function render() {
  if (raf) return;
  const run = () => { if (!raf) return; cancelAnimationFrame(raf); clearTimeout(rafTimer); raf = 0; draw(); };
  raf = requestAnimationFrame(run);
  rafTimer = setTimeout(run, 80);
}
function toast(msg) { S.toast = msg; render(); }

/* ───────────── loading ───────────── */

function setUploadMsg(msg, isError) {
  const el = $('uploadMsg');
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
  el.classList.toggle('text-muted', !isError);
}

function confirmDiscard() {
  return !S.history.length || confirm('Несохранённые правки будут потеряны. Продолжить?');
}

async function openFile(file) {
  if (!file) return;
  const dz = $('dropzone');
  dz.classList.add('is-busy');
  if (S.pts) toast('Читаю ' + file.name + '…'); else setUploadMsg('Читаю ' + file.name + '…');
  try {
    const r = await parseTrackFile(file);
    loadTrack(r, file.name);
  } catch (e) {
    console.error(e);
    // A file that fails to parse leaves the open track as it is.
    const msg = file.name + ': ' + (e.message || 'не удалось прочитать файл');
    if (S.pts) toast(msg); else { setUploadMsg(msg, true); render(); }
  } finally {
    dz.classList.remove('is-busy');
  }
}

function loadTrack(r, fileName) {
  const base = fileName.replace(/\.(gpx|fit|tcx)$/i, '');
  // ver keeps growing across files: stats, splits, chart and map are memoised by it, and restarting
  // at 0 made a freshly opened file hit the previous track's cache and leave it on screen.
  Object.assign(S, {
    fileName, baseName: base, trackName: r.name || base, format: r.format,
    pts: r.pts, orig: r.pts, has: { ...r.has }, partB: null, partBHas: null,
    ver: S.ver + 1, sel: null, dragging: null, hover: null, draft: [], history: [], tool: 'cut', anomIdx: 0, busy: false, active: null, dragFile: false,
    ch: { sp: true, hr: r.has.hr, pw: false },
  });
  recompute();
  M.origDist = M.stats.dist;
  const sensors = ['скорость', r.has.ele && 'высота', r.has.hr && 'пульс', r.has.pw && 'мощность', r.has.cad && 'каденс'].filter(Boolean);
  S.toast = `Файл разобран (${r.format}): 1 трек, ${S.pts.length} точек, ${km(M.stats.dist)} км, датчики: ${sensors.join(', ')}`
    + (r.has.time ? '' : ' · в файле нет времени — оно рассчитано для 20 км/ч');
  setUploadMsg('');
  needFit = true;
  render();
}

function loadDemo() {
  const { pts, has } = normalize(buildDemoRaw());
  loadTrack({ pts, has, name: 'Демо: Крылатское', format: 'GPX' }, 'demo_krylatskoe.gpx');
}

async function openSecondFile(file) {
  if (!file) return;
  toast('Читаю ' + file.name + '…');
  try {
    const r = await parseTrackFile(file);
    S.partB = r.pts; S.partBHas = r.has;
    toast(`Второй файл загружен: ${r.pts.length} точек · нажмите «Присоединить часть B»`);
  } catch (e) {
    toast(file.name + ': ' + (e.message || 'не удалось прочитать файл'));
  }
}

/* ───────────── edits ───────────── */

async function applyRedraw() {
  const sp = span();
  if (!sp || S.busy) return;
  const ver0 = S.ver, pts = S.pts, D0 = D, A = pts[sp.a], B = pts[sp.b];
  const pick = p => ({ lat: p.lat, lng: p.lng });
  let path = [pick(A), ...S.draft, pick(B)];
  let note = S.dm === 'free' ? 'линия от руки' : 'линия по прямым';
  if (S.dm === 'road') {
    S.busy = true; toast('Строю маршрут по велодорогам…');
    try {
      path = [pick(A), ...(await routeByBike(path)), pick(B)];
      note = 'маршрут привязан к дорогам';
    } catch (e) {
      note = 'сервис дорог недоступен (' + e.message + '), построено по прямой';
    }
    S.busy = false;
    if (S.ver !== ver0) { render(); return; }
  }
  const spacing = Math.min(50, Math.max(3, medianSpacing(D0)));
  const r = replaceGeometry(pts, D0, sp.a, sp.b, path, S.pp, spacing);
  const dt = (B.t - A.t) / 1000, v = dt > 0 ? r.L / dt * 3.6 : 0;
  commit(r.pts, {
    sel: null,
    toast: `Геометрия заменена: ${r.added} точек, ${km(r.L)} км · ${note} · `
      + (S.pp === 'stretch' ? 'исходные параметры растянуты по новой длине' : 'параметры интерполированы по краям')
      + (v ? ` · средняя на участке ${v.toFixed(1)} км/ч` : ''),
  });
}

async function runDem() {
  if (S.busy) return;
  const sp = span(), n = S.pts.length, a = sp ? sp.a : 0, b = sp ? sp.b : n - 1;
  const ver0 = S.ver, pts = S.pts, D0 = D;
  const step = Math.max(1, Math.ceil((b - a + 1) / 1000)), idx = [];
  for (let i = a; i <= b; i += step) idx.push(i);
  if (idx[idx.length - 1] !== b) idx.push(b);
  S.busy = true; toast('Запрашиваю высоты рельефа…');
  try {
    const { elevations, source } = await fetchElevations(idx.map(i => pts[i]), (d, t) => toast(`Запрашиваю высоты рельефа… ${d}/${t}`));
    if (S.ver !== ver0) return;
    const samples = idx.map((i, k) => ({ i, ele: elevations[k] })).filter(s => Number.isFinite(s.ele));
    if (samples.length < 2) throw new Error('сервис не вернул высоты');
    const partial = S.has.ele && (a > 0 || b < n - 1);
    S.busy = false;
    commit(applyElevation(pts, D0, a, b, samples, partial), {
      has: { ...S.has, ele: true },
      toast: `Высота пересчитана по DEM на ${b - a + 1} точках · ${source}` + (partial ? ' · края сшиты с исходной высотой' : ''),
    });
  } catch (e) {
    toast('Не удалось получить высоты: ' + e.message);
  } finally {
    S.busy = false; render();
  }
}

function applyShift() {
  const t = new Date($('startTime').value).getTime();
  if (!Number.isFinite(t)) { toast('Укажите дату и время старта'); return; }
  const delta = t - S.pts[0].t;
  if (!delta) { toast('Старт уже такой'); return; }
  const mins = Math.round(Math.abs(delta) / 60000);
  commit(shiftTime(S.pts, delta), {
    toast: `Старт записи сдвинут на ${new Date(t).toLocaleString('ru-RU')} · ${delta > 0 ? '+' : '−'}${mins >= 60 ? fmtDur(mins * 60) : mins + ' мин'}`,
  });
}

function exportGPX(pts, has, suffix) {
  const name = S.baseName + suffix + '.gpx';
  downloadFile(toGPX(pts, { name: S.trackName, has }), name);
  const dist = pts === S.pts ? M.stats.dist : derive(pts).d[pts.length - 1];
  toast(`${name} готов · ${pts.length} точек · ${km(dist)} км`);
}

function toolCfg() {
  const sp = span(), has = !!sp, busy = S.busy;
  switch (S.tool) {
    case 'cut': return { title: 'Вырезать участок', hint: 'Удаляет выделенные точки. Соседние точки соединяются, их параметры остаются как в файле.',
      primary: 'Вырезать выделение', off: !has,
      run: () => commit(cutRange(S.pts, sp.a, sp.b), { sel: null, toast: `Вырезано ${sp.b - sp.a + 1} точек · параметры соседних точек не изменены` }) };
    case 'redraw': return { title: 'Перерисовать участок по карте',
      hint: !has ? 'Сначала выделите промежуток на трек-лайне или нажмите «Выделить участок» в диагностике.'
        : S.dm === 'road' ? 'Кликайте по карте промежуточные точки (можно ни одной) — маршрут между краями выделения построится по велодорогам OSM.'
        : S.dm === 'free' ? 'Зажмите кнопку мыши и ведите по карте — линия соединит края выделения.'
        : 'Кликайте по карте, чтобы задать правильный маршрут между краями выделения.',
      primary: 'Заменить геометрию', off: busy || !(has && (S.draft.length || S.dm === 'road')), run: applyRedraw,
      draw: true, policy: true, sec: 'Сбросить линию', secOff: !S.draft.length, secRun: () => { S.draft = []; toast(''); } };
    case 'points': {
      const m = getEM();
      return { title: 'Точки: правка выбросов на карте',
        hint: (has ? '' : 'Выделите на трек-лайне участок с выбросом — его точки появятся на карте. ')
          + 'Тяните точки мышью — линия перестраивается на лету, время и датчики остаются. Новая точка — потяните или кликните «+» между точками (появляются при приближении карты), либо кликните рядом с линией.'
          + (m.step > 1 ? ` Показана каждая ${m.step}-я точка: скрытые соседи сдвигаются плавно вместе с ней. Выделите участок короче, чтобы править каждую.` : '')
          + (m.bad.size ? ` Точек-выбросов: ${m.bad.size}, они закрашены.` : ''),
        primary: 'Готово', off: false, run: () => { S.tool = 'cut'; S.active = null; toast('Правка точек завершена'); },
        sec: m.outliers ? `Удалить выбросы (${m.outliers})` : null, secOff: false,
        secRun: () => { const r = dropOutliers(S.pts, m.runs); commit(r.pts, { sel: null, active: null, toast: `Удалено ${r.removed} точек-выбросов · края участков соединены` }); } };
    }
    case 'smooth': return { title: 'Сгладить GPS-шум', hint: 'Скользящее среднее по координатам внутри выделения. Высота, скорость и датчики не меняются.',
      primary: 'Сгладить', off: !has, smooth: true,
      run: () => commit(smoothRange(S.pts, sp.a, sp.b, S.sw), { toast: `GPS-шум сглажен · окно ${S.sw} точек` }) };
    case 'dem': return { title: 'Исправить высоту по DEM',
      hint: 'Заменяет барометрические выбросы профилем рельефа (Copernicus DEM, 90 м). Работает по выделению или по всему треку; края выделения сшиваются плавно.',
      primary: busy ? 'Запрос…' : 'Пересчитать высоту', off: busy, run: runDem };
    case 'trim': return { title: 'Обрезать начало и конец', hint: 'Выделите нужную часть записи — остальное отбрасывается.',
      primary: 'Оставить выделение', off: !has,
      run: () => commit(keepRange(S.pts, sp.a, sp.b), { sel: null, toast: 'Оставлен только выделенный промежуток' }),
      sec: 'Отрезать начало', secOff: !has,
      secRun: () => commit(dropHead(S.pts, sp.a), { sel: null, toast: `Начало трека обрезано · удалено ${sp.a} точек` }) };
    case 'split': return { title: 'Разделить трек', hint: 'Точка разделения — начало выделения. Часть B откладывается и показывается пунктиром; её можно скачать отдельно.',
      primary: 'Разделить здесь', off: !has || sp.a < 1,
      run: () => { const r = splitAt(S.pts, sp.a); commit(r.head, { partB: r.tail, partBHas: S.has, sel: null, toast: 'Трек разделён · часть B отложена (пунктир на карте)' }); },
      sec: S.partB ? 'Скачать часть B' : null, secOff: false, secRun: () => exportGPX(S.partB, S.partBHas || S.has, '_part_b') };
    case 'merge': return { title: 'Склеить два трека',
      hint: S.partB ? 'Часть B будет присоединена к концу текущего трека, время продолжится непрерывно.' : 'Нет отложенной части. Разделите трек или загрузите второй файл.',
      primary: 'Присоединить часть B', off: !S.partB,
      run: () => {
        const r = mergeTracks(S.pts, S.partB), hB = S.partBHas || S.has;
        const has = Object.fromEntries(Object.keys(S.has).map(k => [k, S.has[k] || hB[k]]));
        commit(r.pts, { partB: null, partBHas: null, has, toast: `Части склеены · ${r.pts.length} точек` + (r.shift ? ' · время части B сдвинуто вслед за концом трека' : '') });
      },
      sec: 'Загрузить второй файл', secOff: false, secRun: () => $('fileInput2').click() };
    case 'time': return { title: 'Сдвинуть время и паузы',
      hint: 'Старт записи задаётся вручную — сдвигаются все отметки времени. Удаление пауз убирает точки со скоростью ниже 3 км/ч и схлопывает время стоянок.'
        + (S.has.time ? '' : ' В исходном файле времени не было.'),
      primary: 'Удалить паузы', off: !M.pauses.length && !D.seg.some(v => v < THRESH.pauseKmh), time: true,
      run: () => { const r = dropPauses(S.pts, D); commit(r.pts, { sel: null, toast: `Удалено ${r.removed} точек паузы · время пересчитано (−${fmtDur(r.savedSec)})` }); },
      sec: 'Применить сдвиг', secOff: false, secRun: applyShift };
  }
}

/** Select detected stretch k (from the diagnostics button or a click on the map) and open redraw. */
function selectRun(k) {
  const r = M.anoms[k];
  if (!r) return;
  Object.assign(S, { anomIdx: k, sel: { a: r.a, b: r.b }, hover: r.a, tool: 'redraw', draft: [], active: null,
    toast: describe(r) + ' Участок выделен — вырежьте его или перерисуйте по карте.' });
  if (map) map.showRange(S.pts, r);
  render();
}

function selectAnomaly() {
  const an = M.anoms;
  if (!an.length) return;
  const cur = an[S.anomIdx], sp = span();
  selectRun(sp && sp.a === cur.a && sp.b === cur.b && an.length > 1 ? (S.anomIdx + 1) % an.length : S.anomIdx);
}

/* ───────────── drawing ───────────── */

function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
const corners = el => ['tl', 'tr', 'bl', 'br'].forEach(c => el.append(node('i', 'corner ' + c)));

function draw() {
  const loaded = !!S.pts;
  $('fileName').textContent = loaded ? S.fileName : 'файл не выбран';
  $('fileName').title = loaded ? S.fileName : '';
  $('btnOther').textContent = loaded ? 'Другой файл' : 'Открыть файл';
  $('btnExport').disabled = !loaded || S.busy;
  $('mapEmpty').hidden = loaded && !S.dragFile;
  $('dropzone').classList.toggle('is-drag', S.dragFile);
  $('dzTitle').textContent = loaded ? 'Отпустите файл — откроется новый трек' : 'Перетащите файл трека сюда';
  $('toast').textContent = S.toast;
  if (!map && window.L) map = new MapView($('map'), mapHandlers);
  if (!loaded) { drawEmpty(); return; }

  drawStats();
  drawDiag();
  drawSelection();
  drawSplits();
  drawChart();
  drawChartOverlay();
  drawTools();
  drawMap();
  drawHover();
}

function statCell(k, v, n) {
  const c = node('div', 'blueprint stat');
  corners(c);
  c.append(node('span', 'stat-k', k), node('span', 'stat-v', String(v)), node('span', 'text-muted stat-n', n));
  return c;
}

/** The editor before any file: every block in place, values blank, tools off. */
function drawEmpty() {
  if (last.stats === 'empty') return;
  last.stats = last.splits = last.chart = 'empty';
  const cells = [['Дистанция', 'км'], ['В движении', 'общее —'], ['Набор', 'спуск —'], ['Средняя', 'км/ч'], ['Максимум', 'км/ч'],
    ['Мощность', 'Вт средних'], ['Пульс', 'уд/мин средних'], ['Каденс', 'об/мин'], ['Калории', 'ккал']];
  $('stats').replaceChildren(...cells.map(([k, n]) => statCell(k, '—', n)));
  const tr = node('tr'), td = node('td', 'empty', 'нет данных');
  td.colSpan = 4; tr.append(td);
  $('splits').replaceChildren(tr);
  ['pElevArea', 'pElevLine', 'pSpeed', 'pHr', 'pPw', 'hoverRule'].forEach(id => $(id).setAttribute('d', ''));
  setBands($('gAnom'), []);
  setBands($('gPause'), []);
  $('gSel').setAttribute('hidden', '');
  for (const [id, opt] of [['chSp', 'optSp'], ['chHr', 'optHr'], ['chPw', 'optPw']]) { $(id).disabled = true; $(opt).classList.add('is-off'); }
  for (const b of $('tools').children) { b.disabled = true; b.className = 'btn ' + (b.dataset.tool === 'cut' ? 'btn-primary' : 'btn-secondary'); }
  $('toolTitle').textContent = 'Инструменты правки';
  $('toolHint').textContent = 'Откройте трек, выделите промежуток на трек-лайне и выберите инструмент.';
  ['fDraw', 'fSmooth', 'fPolicy', 'fTime'].forEach(id => { $(id).hidden = true; });
  $('btnPrimary').textContent = 'Вырезать выделение';
  $('btnPrimary').disabled = true;
  $('btnSecondary').hidden = true;
  $('btnUndo').disabled = true;
}

function drawStats() {
  if (last.stats === S.ver) return;
  last.stats = S.ver;
  const s = M.stats, h = S.has, delta = (s.dist - M.origDist) / 1000;
  const cells = [
    ['Дистанция', km(s.dist), S.pts !== S.orig ? (delta >= 0 ? '+' : '') + delta.toFixed(2) + ' км к исходному' : 'км · как в файле'],
    ['В движении', fmtDur(s.move), 'общее ' + fmtDur(s.total)],
    h.ele ? ['Набор', Math.round(s.gain) + ' м', 'спуск ' + Math.round(s.loss) + ' м'] : ['Набор', '—', 'нет данных высоты'],
    ['Средняя', s.avg.toFixed(1), 'км/ч · темп ' + pace(s.avg) + '/км'],
    ['Максимум', Number.isFinite(s.max) ? s.max.toFixed(0) : '∞', s.max > THRESH.anomalyKmh ? 'км/ч · подозрительно' : 'км/ч · в норме'],
    ['Мощность', s.pw != null ? Math.round(s.pw) : '—', s.pw != null ? 'Вт средних' : 'нет датчика'],
    ['Пульс', s.hr != null ? Math.round(s.hr) : '—', s.hr != null ? 'уд/мин средних' : 'нет датчика'],
    ['Каденс', s.cad != null ? Math.round(s.cad) : '—', s.cad != null ? 'об/мин' : 'нет датчика'],
    ['Калории', s.kcal != null ? Math.round(s.kcal) : '—', s.kcal != null ? 'ккал · по мощности' : 'нужна мощность'],
  ];
  $('stats').replaceChildren(...cells.map(([k, v, n]) => statCell(k, v, n)));
}

function drawDiag() {
  const an = M.anoms;
  $('diagAnomaly').hidden = !an.length;
  $('cleanText').hidden = !!an.length;
  if (!an.length) {
    $('cleanText').textContent = `Выбросов не найдено. Пауз: ${M.pauses.length} · геометрия непрерывна.`;
    return;
  }
  const cur = an[S.anomIdx];
  $('anomalyText').textContent = (an.length > 1 ? `Найдено участков: ${an.length}. ` : '') + describe(cur);
  $('anomalyRange').textContent = `с ${km(D.d[cur.a])} км по ${km(D.d[cur.b])} км`;
  $('btnSelectAnomaly').textContent = an.length > 1 ? `Выделить участок ${S.anomIdx + 1}/${an.length}` : 'Выделить участок';
}

function drawSelection() {
  const sp = span();
  let v = ['—', '—', '—', '—', '—', '—'];
  if (sp) {
    const pts = S.pts, A = pts[sp.a], B = pts[sp.b];
    let s0 = Infinity, s1 = 0, e0 = Infinity, e1 = -Infinity, hr = 0, hn = 0;
    for (let i = sp.a; i <= sp.b; i++) {
      const s = D.sp[i];
      if (Number.isFinite(s)) { s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
      e0 = Math.min(e0, pts[i].ele); e1 = Math.max(e1, pts[i].ele);
      if (pts[i].hr != null) { hr += pts[i].hr; hn++; }
    }
    v = [`${sp.b - sp.a + 1} из ${pts.length}`, km(D.d[sp.b] - D.d[sp.a]) + ' км', fmtDur((B.t - A.t) / 1000),
      s0 <= s1 ? `${s0.toFixed(0)}–${s1.toFixed(0)} км/ч` : '—',
      S.has.ele ? `${e0.toFixed(0)}–${e1.toFixed(0)} м` : '—', hn ? Math.round(hr / hn) + ' уд/мин' : '—'];
  }
  ['selPoints', 'selLen', 'selTime', 'selSpeed', 'selElev', 'selHr'].forEach((id, k) => { $(id).textContent = v[k]; });
}

function drawSplits() {
  if (last.splits === S.ver) return;
  last.splits = S.ver;
  const rows = M.splits.map(r => {
    const tr = node('tr');
    tr.append(node('td', null, r.km), node('td', null, pace(r.v)), node('td', null, r.v.toFixed(1)), node('td', null, S.has.ele ? '+' + Math.round(r.gain) : '—'));
    return tr;
  });
  if (!rows.length) { const tr = node('tr'); const td = node('td', 'empty', 'трек короче километра'); td.colSpan = 4; tr.append(td); rows.push(tr); }
  $('splits').replaceChildren(...rows);
}

function setBands(g, bands) {
  g.replaceChildren(...bands.map(b => {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', b.x.toFixed(1)); r.setAttribute('y', '0');
    r.setAttribute('width', b.w.toFixed(1)); r.setAttribute('height', '176');
    return r;
  }));
}

function drawChart() {
  const key = S.ver + '|' + S.ch.sp + S.ch.hr + S.ch.pw;
  if (last.chart === key) return;
  last.chart = key;
  const c = buildChart(S.pts, D, { ch: S.ch, has: S.has, anoms: M.anoms, pauses: M.pauses });
  $('pElevArea').setAttribute('d', c.area);
  $('pElevLine').setAttribute('d', c.elev);
  $('pSpeed').setAttribute('d', c.speed);
  $('pHr').setAttribute('d', c.hr);
  $('pPw').setAttribute('d', c.pw);
  setBands($('gAnom'), c.anomBands);
  setBands($('gPause'), c.pauseBands);
  const n = S.pts.length;
  $('axisElev').textContent = S.has.ele ? `высота ${Math.round(c.e0)} м – ${Math.round(c.e1)} м` : 'высота: нет данных';
  $('axisMid').textContent = (D.d[Math.floor((n - 1) / 2)] / 1000).toFixed(1) + ' км';
  $('axisEnd').textContent = km(D.d[n - 1]) + ' км';

  for (const [k, id, opt] of [['sp', 'chSp', 'optSp'], ['hr', 'chHr', 'optHr'], ['pw', 'chPw', 'optPw']]) {
    const avail = k === 'sp' || S.has[k];
    $(id).checked = S.ch[k] && avail;
    $(id).disabled = !avail;
    $(opt).classList.toggle('is-off', !avail);
    $(opt).title = avail ? '' : 'В файле нет этого датчика';
  }
}

function drawChartOverlay() {
  const sp = span(), n = S.pts.length, g = $('gSel');
  if (sp) {
    const x0 = xOf(sp.a, n), x1 = xOf(sp.b, n);
    g.removeAttribute('hidden');
    $('selRect').setAttribute('x', x0.toFixed(1));
    $('selRect').setAttribute('width', Math.max(2, x1 - x0).toFixed(1));
    $('selEdges').setAttribute('d', `M${x0.toFixed(1)} 0V176M${x1.toFixed(1)} 0V176`);
  } else g.setAttribute('hidden', '');
  $('hoverRule').setAttribute('d', S.hover != null ? `M${xOf(S.hover, n).toFixed(1)} 0V176` : '');
  const p = S.hover != null ? S.pts[S.hover] : null;
  $('hoverLabel').textContent = p ? [
    km(D.d[S.hover]) + ' км', S.has.ele && Math.round(p.ele) + ' м', D.sp[S.hover].toFixed(1) + ' км/ч',
    p.hr != null && Math.round(p.hr) + ' уд', p.pw != null && Math.round(p.pw) + ' Вт', S.has.time && clock(p.t),
  ].filter(Boolean).join(' · ') : 'наведите на трек-лайн';
}

let cfg = null;
function drawTools() {
  cfg = toolCfg();
  for (const b of $('tools').children) { b.disabled = false; b.className = 'btn ' + (b.dataset.tool === S.tool ? 'btn-primary' : 'btn-secondary'); }
  $('toolTitle').textContent = cfg.title;
  $('toolHint').textContent = cfg.hint;
  $('fDraw').hidden = !cfg.draw;
  $('fSmooth').hidden = !cfg.smooth;
  $('fPolicy').hidden = !cfg.policy;
  $('fTime').hidden = !cfg.time;
  document.querySelectorAll('input[name=dm]').forEach(i => { i.checked = i.value === S.dm; });
  document.querySelectorAll('input[name=sw]').forEach(i => { i.checked = +i.value === S.sw; });
  document.querySelectorAll('input[name=pp]').forEach(i => { i.checked = i.value === S.pp; });
  if (cfg.time && document.activeElement !== $('startTime') && last.time !== S.ver) {
    last.time = S.ver;
    $('startTime').value = toLocalInput(S.pts[0].t);
  }
  $('btnPrimary').textContent = cfg.primary;
  $('btnPrimary').disabled = !!cfg.off || S.busy;
  $('btnSecondary').hidden = !cfg.sec;
  $('btnSecondary').textContent = cfg.sec || '';
  $('btnSecondary').disabled = !!cfg.secOff || S.busy;
  $('btnUndo').disabled = !S.history.length || S.busy;
}

function drawMap() {
  if (!map) return;
  const sp = span(), sk = sp ? sp.a + ':' + sp.b : '-';
  const show = CFG.showOnMap, pickable = S.tool !== 'redraw' && S.tool !== 'points';
  const baseKey = S.ver + '|' + (S.partB ? S.partB.length : 0) + '|' + show;
  if (last.base !== baseKey) { last.base = baseKey; map.setBase({ pts: S.pts, orig: S.orig, partB: S.partB, ghost: S.pts !== S.orig, gaps: M.anoms, dotGaps: !show }); }
  const outKey = S.ver + '|' + show + '|' + pickable;
  if (last.out !== outKey) { last.out = outKey; map.setOutliers(S.pts, show ? M.anoms : null, M.anoms.map(shortLabel), selectRun, pickable); }
  const selKey = S.ver + '|' + sk;
  if (last.sel !== selKey) { last.sel = selKey; map.setSel(S.pts, sp); }
  const draftKey = selKey + '|' + S.draft.length + '|' + S.dm;
  if (last.draft !== draftKey) { last.draft = draftKey; map.setDraft(S.pts, sp, S.draft, S.dm !== 'free'); }
  if (S.tool !== 'points') {
    if (last.edit !== 'off') { last.edit = 'off'; map.setEdit(null); }
  } else if (S.dragging == null) { // rebuild markers once the chart selection settles
    const em = getEM();
    if (last.edit !== em.key) {
      last.edit = em.key;
      map.setEdit({ pts: S.pts, idx: em.idx, bad: em.bad, cb: editCb });
      map.setActiveVertex(S.active);
    }
  }
  const drawing = S.tool === 'redraw' && S.dm === 'free' && !!sp;
  map.setMode({ drawing, crosshair: (S.tool === 'redraw' && !!sp) || S.tool === 'points', editing: S.tool === 'points' });
  $('mapHint').textContent = S.tool === 'redraw'
    ? (sp ? (S.dm === 'free' ? 'Тяните по карте, чтобы нарисовать линию' : 'Кликайте по карте — точки новой линии') : 'Выделите промежуток на трек-лайне')
    : S.tool === 'points' ? 'Тяните точки · «+» или клик у линии — добавить · двойной клик — удалить · стрелки — сдвиг'
    : (S.pts !== S.orig ? 'Пунктир — исходная геометрия, сплошная — текущая' : 'Сплошная — трек из файла · квадрат — старт, круг — финиш')
      + (!M.anoms.length ? '' : show ? ` · оранжевым — выбросы (${M.anoms.length}), клик выделяет участок` : ` · точки — разрывы сигнала (${M.anoms.length})`);
  if (needFit) { needFit = false; requestAnimationFrame(() => map.fit(S.pts)); }
}

function drawHover() {
  if (!map) return;
  const key = S.ver + '|' + S.hover;
  if (last.hover === key) return;
  last.hover = key;
  map.setHover(S.hover != null ? S.pts[S.hover] : null);
}

/* ───────────── points tool ───────────── */

/** Which points of the range get markers: every step-th, plus all glitch points and the active one. */
function editModel() {
  const sp = span(), n = S.pts.length, a = sp ? sp.a : 0, b = sp ? sp.b : n - 1;
  const step = Math.max(1, Math.ceil((b - a + 1) / MAX_VERTS));
  const bad = new Set(), runs = [];
  let outliers = 0;
  for (const r of M.anoms) {
    if (r.b <= a || r.a >= b) continue;
    if (r.b - r.a >= 2) { runs.push(r); outliers += r.b - r.a - 1; }
    for (let i = Math.max(r.a + 1, a); i <= Math.min(r.b - 1, b); i++) bad.add(i);
  }
  const shown = new Set(bad);
  for (let i = a; i <= b; i += step) shown.add(i);
  shown.add(b);
  if (S.active != null && S.active >= a && S.active <= b) shown.add(S.active);
  return { a, b, step, bad, runs, outliers, idx: [...shown].sort((x, y) => x - y) };
}

function getEM() {
  const sp = span(), key = S.ver + '|' + (sp ? sp.a + ':' + sp.b : '-');
  if (!EM || EM.key !== key) EM = { key, ...editModel() };
  return EM;
}

/** Neighbouring markers of point i — the span a drag of i bends. */
function vertexBounds(i) {
  const idx = getEM().idx, k = idx.indexOf(i), n = S.pts.length;
  return [k > 0 ? idx[k - 1] : Math.max(0, i - 1), k >= 0 && k < idx.length - 1 ? idx[k + 1] : Math.min(n - 1, i + 1)];
}

/** Selection after inserting (delta +1) or removing (delta −1) point k. */
function shiftSel(k, delta) {
  const sp = span();
  if (!sp) return null;
  const a = delta > 0 ? (k <= sp.a ? sp.a + 1 : sp.a) : (k < sp.a ? sp.a - 1 : sp.a);
  const b = delta > 0 ? (k <= sp.b ? sp.b + 1 : sp.b) : (k <= sp.b ? sp.b - 1 : sp.b);
  return b - a >= 1 ? { a, b } : null;
}

const fmtDist = m => (m < 1000 ? Math.round(m) + ' м' : km(m) + ' км');

const editCb = {
  preview: (i, ll) => { const [lo, hi] = vertexBounds(i); return dragShift(S.pts, i, ll, lo, hi).map(p => [p.lat, p.lng]); },
  move(i, ll) {
    const [lo, hi] = vertexBounds(i), follow = hi - lo - 2, d = hav(S.pts[i], ll);
    commit(dragPoint(S.pts, i, ll, lo, hi), {
      active: i, hover: i,
      toast: `Точка ${i + 1} сдвинута на ${fmtDist(d)}` + (follow > 0 ? ` · ${follow} соседних точек сдвинуты плавно` : '') + ' · время и датчики сохранены',
    });
  },
  insert(k, ll) {
    commit(insertAt(S.pts, k, ll), { sel: shiftSel(k, 1), active: k, hover: k, toast: `Добавлена точка ${k + 1} · время и датчики интерполированы` });
  },
  remove(i) {
    if (S.pts.length <= 2) return;
    commit(removePoint(S.pts, i), { sel: shiftSel(i, -1), active: null, hover: null, toast: `Точка ${i + 1} удалена` });
  },
  activate(i) { S.active = i; S.hover = i; if (map) map.setActiveVertex(i); render(); },
  hover(i) { S.hover = i; render(); },
};

function nudge(north, east, meters) {
  const p = S.pts[S.active];
  editCb.move(S.active, {
    lat: p.lat + north * meters / 111320,
    lng: p.lng + east * meters / (111320 * Math.cos(p.lat * Math.PI / 180)),
  });
}

/* ───────────── outlier detection settings ───────────── */

/** Re-run detection and pause-dependent stats after the config changed. */
function applyDetect() {
  if (S.pts) { S.ver++; recompute(); }
  render();
  updateCfgSummary();
}

const getPath = (o, path) => path.split('.').reduce((x, k) => x[k], o);
function setPath(o, path, v) { const ks = path.split('.'), key = ks.pop(); ks.reduce((x, k) => x[k], o)[key] = v; }

function markOffRules() {
  for (const fs of $('cfgForm').querySelectorAll('[data-rule]')) fs.classList.toggle('is-off', !CFG[fs.dataset.rule].enabled);
}

function fillCfgForm() {
  for (const el of $('cfgForm').elements) {
    if (!el.name) continue;
    const v = getPath(CFG, el.name);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  markOffRules();
  updateCfgSummary();
}

/** Current config with the form applied; empty or negative numbers keep their previous value. */
function readCfgForm() {
  const next = JSON.parse(JSON.stringify(CFG));
  for (const el of $('cfgForm').elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') setPath(next, el.name, el.checked);
    else { const v = parseFloat(el.value); if (Number.isFinite(v) && v >= 0) setPath(next, el.name, v); }
  }
  return next;
}

function updateCfgSummary() {
  $('cfgSummary').textContent = S.pts
    ? `На текущем треке: выбросов — ${M.anoms.length}, пауз — ${M.pauses.length}`
    : 'Откройте трек, чтобы сразу видеть результат.';
}

function bindConfig() {
  const dlg = $('cfgDialog'), form = $('cfgForm');
  const close = () => { dlg.hidden = true; };
  $('btnCfg').addEventListener('click', () => { fillCfgForm(); dlg.hidden = false; form.querySelector('input').focus(); });
  let timer = 0;
  // Live apply; the form is not refilled while typing so a half-typed "0." is not rewritten.
  form.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { setConfig(readCfgForm()); markOffRules(); applyDetect(); }, 150);
  });
  form.addEventListener('submit', e => { e.preventDefault(); close(); });
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  $('cfgReset').addEventListener('click', () => { resetConfig(); fillCfgForm(); applyDetect(); });
  $('cfgExport').addEventListener('click', () => downloadFile(JSON.stringify(CFG, null, 2) + '\n', 'detect.json', 'application/json'));
}

/* ───────────── input ───────────── */

const mapHandlers = {
  click(ll) {
    if (S.busy || !S.pts) return;
    const p = { lat: ll.lat, lng: ll.lng }, sp = span();
    if (S.tool === 'redraw' && S.dm !== 'free' && sp) {
      S.draft = S.draft.concat([p]);
      toast('Точек в новой линии: ' + S.draft.length);
    } else if (S.tool === 'points') {
      const em = getEM(), r = insertPoint(S.pts, p, em.a, em.b);
      if (map.pxDistance(p, r.onLine) > 30) {
        editCb.activate(null);
        toast('Чтобы добавить точку, кликните рядом с линией трека или потяните «+» между точками');
        return;
      }
      commit(r.pts, { sel: shiftSel(r.index, 1), active: r.index, hover: r.index, toast: `Добавлена точка ${r.index + 1} · время и датчики интерполированы` });
    }
  },
  down(ll) {
    if (S.busy || S.tool !== 'redraw' || S.dm !== 'free' || !span()) return;
    freeDrawing = true;
    S.draft = [{ lat: ll.lat, lng: ll.lng }];
    render();
  },
  move(ll) {
    if (!freeDrawing) return;
    const p = { lat: ll.lat, lng: ll.lng };
    if (hav(S.draft[S.draft.length - 1], p) > 12) { S.draft = S.draft.concat([p]); render(); }
  },
  up() {
    if (!freeDrawing) return;
    freeDrawing = false;
    toast(`Нарисовано ${S.draft.length} точек · нажмите «Заменить геометрию»`);
  },
};

function idxAt(e) {
  const r = $('chart').getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  return Math.round(f * (S.pts.length - 1));
}

function bind() {
  const input = $('fileInput'), dz = $('dropzone');
  const pick = () => { if (!S.pts || confirmDiscard()) input.click(); };
  dz.addEventListener('click', pick);
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; openFile(f); });
  $('fileInput2').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; openSecondFile(f); });
  $('btnDemo').addEventListener('click', loadDemo);
  $('btnOther').addEventListener('click', pick);
  $('btnExport').addEventListener('click', () => exportGPX(S.pts, S.has, '_fixed'));

  // Drop a file anywhere on the page; while it is dragged, the map shows the drop target.
  let depth = 0;
  const isFile = e => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const setDrag = on => { if (S.dragFile !== on) { S.dragFile = on; render(); } };
  window.addEventListener('dragenter', e => { if (!isFile(e)) return; e.preventDefault(); depth++; setDrag(true); });
  window.addEventListener('dragleave', e => { if (!isFile(e)) return; if (--depth <= 0) { depth = 0; setDrag(false); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; setDrag(false);
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f && (!S.pts || confirmDiscard())) openFile(f);
  });

  // Chart: drag to select, hover to inspect.
  const chart = $('chart');
  chart.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !S.pts) return;
    try { chart.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const i = idxAt(e);
    Object.assign(S, { dragging: i, sel: { a: i, b: i }, hover: i, draft: [], active: null });
    render();
  });
  chart.addEventListener('pointermove', e => {
    if (!S.pts) return;
    const i = idxAt(e);
    S.hover = i;
    if (S.dragging != null) S.sel = { a: S.dragging, b: i };
    render();
  });
  const release = () => {
    if (S.dragging == null) return;
    S.dragging = null;
    if (S.sel && Math.abs(S.sel.a - S.sel.b) < 2) S.sel = null;
    if (S.tool === 'points' && S.sel && map) map.showRange(S.pts, span(), 18);
    render();
  };
  chart.addEventListener('pointerup', release);
  chart.addEventListener('pointercancel', release);
  chart.addEventListener('pointerleave', () => { if (S.dragging == null) { S.hover = null; render(); } });

  for (const [k, id] of [['sp', 'chSp'], ['hr', 'chHr'], ['pw', 'chPw']]) {
    $(id).addEventListener('change', e => { S.ch = { ...S.ch, [k]: e.target.checked }; render(); });
  }

  const tools = [['cut', 'Вырезать'], ['redraw', 'Перерисовать'], ['points', 'Точки'], ['smooth', 'Сгладить'], ['dem', 'Высота DEM'], ['trim', 'Обрезать'], ['split', 'Разделить'], ['merge', 'Склеить'], ['time', 'Время и паузы']];
  $('tools').replaceChildren(...tools.map(([id, label]) => {
    const b = node('button', 'btn btn-secondary', label);
    b.type = 'button';
    b.dataset.tool = id;
    b.addEventListener('click', () => {
      Object.assign(S, { tool: id, draft: [], toast: '', active: null });
      if (id === 'points' && S.sel && map) map.showRange(S.pts, span(), 18);
      render();
    });
    return b;
  }));
  document.querySelectorAll('input[name=dm]').forEach(i => i.addEventListener('change', () => { S.dm = i.value; S.draft = []; render(); }));
  document.querySelectorAll('input[name=sw]').forEach(i => i.addEventListener('change', () => { S.sw = +i.value; render(); }));
  document.querySelectorAll('input[name=pp]').forEach(i => i.addEventListener('change', () => { S.pp = i.value; render(); }));
  // Read the tool config at click time, not from the last render.
  $('btnPrimary').addEventListener('click', () => { const c = toolCfg(); if (!c.off && !S.busy) c.run(); });
  $('btnSecondary').addEventListener('click', () => { const c = toolCfg(); if (c.sec && !c.secOff && !S.busy) c.secRun(); });
  $('btnUndo').addEventListener('click', undo);
  $('btnSelectAnomaly').addEventListener('click', selectAnomaly);
  bindConfig();

  document.addEventListener('keydown', e => {
    if (!S.pts || !$('cfgDialog').hidden || (e.target instanceof Element && e.target.closest('input, textarea'))) return;
    if (S.tool === 'points' && S.active != null && !S.busy) {
      const dir = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      if (dir) { e.preventDefault(); nudge(dir[0], dir[1], e.shiftKey ? 10 : 1); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editCb.remove(S.active); return; }
      if (e.key === 'Escape') { editCb.activate(null); return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (e.key === 'Escape') { S.sel = null; S.draft = []; render(); }
  });
  window.addEventListener('beforeunload', e => { if (S.history.length) { e.preventDefault(); e.returnValue = ''; } });
}

bind();
render();                 // empty editor right away
await loadConfig();       // detection rules from config/detect.json + this browser's tweaks
if (new URLSearchParams(location.search).has('demo')) loadDemo();
render();
