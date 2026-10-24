'use strict';
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
const AXES = [
  { key: 'G2', field: 'contribution_G2', label: 'Устойчивые спутники', color: '#69d3d6' },
  { key: 'G3', field: 'contribution_G3', label: 'Повторяющиеся цепочки', color: '#b7a0ed' },
  { key: 'G4', field: 'contribution_G4', label: 'Всплеск и возвраты', color: '#f6c17c' },
];
const state = {
  rows: [],
  points: null,
  ids: new Map(),
  selected: -1,
  threshold: 0,
  mode: 'contributions',
  mix: 0,
  targetMix: 0,
  page: 0,
  tab: 'observatory',
  flights: new Map(),
  flightsLoaded: false,
  loadingFlights: false,
  source: 'Синтетический набор',
  top: [],
  rankQuery: '',
  renderFPS: 0,
};
let renderer = null,
  toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}
function status(msg) {
  $('status-message').textContent = msg;
}
function parseCSV(text) {
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return [];
  const lines = cleaned.split(/\r?\n/),
    headers = parseLine(lines[0]);
  const data = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    let arr = parseLine(lines[i]),
      row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = arr[j] ?? '';
    data[i - 1] = row;
  }
  return data.filter(Boolean);
}
function parseLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let v = '',
    q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        v += '"';
        i++;
      } else q = !q;
    } else if (c === ',' && !q) {
      out.push(v);
      v = '';
    } else v += c;
  }
  out.push(v);
  return out;
}
function numberValue(value) {
  if (value === null || value === undefined || String(value).trim() === '') return NaN;
  return Number(value);
}
function mechanismValue(value) {
  if (typeof value === 'boolean') return Number(value);
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === 'true') return 1;
  if (text === 'false') return 0;
  return numberValue(value);
}
function normalizeRows(rows) {
  if (!rows.length) throw Error('CSV пуст');
  const header = rows[0],
    idField = 'person_id' in header ? 'person_id' : 'passenger_id',
    scoreField = 'target' in header ? 'target' : 'anomaly_score';
  if (!(idField in header) || !(scoreField in header))
    throw Error('Нужны person_id и target либо passenger_id и anomaly_score');
  const hasBehavior = ['behavior_x', 'behavior_y', 'behavior_z'].every((field) => field in header),
    hasContributions = AXES.every((axis) => axis.field in header),
    hasValues = AXES.every((axis) => axis.key in header);
  if (!hasBehavior && !hasContributions && !hasValues)
    throw Error('Нужны behavior_x/y/z, contribution_G2/G3/G4 либо G2/G3/G4.');
  const valid = [],
    ids = new Set();
  for (const r of rows) {
    const id = String(r[idField] ?? '').trim(),
      values = AXES.map((axis, i) =>
        mechanismValue(
          r[
            hasBehavior
              ? ['behavior_x', 'behavior_y', 'behavior_z'][i]
              : hasContributions
                ? axis.field
                : axis.key
          ]
        )
      ),
      s = numberValue(r[scoreField]);
    if (!id || ids.has(id) || ![...values, s].every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
      continue;
    const flags = AXES.map((axis, i) => {
      const value = mechanismValue(r[axis.key]);
      return value === 0 || value === 1 ? value : Number(values[i] > 0);
    });
    ids.add(id);
    valid.push({
      ...r,
      passenger_id: id,
      x: values[0],
      y: values[1],
      z: values[2],
      axisFlags: flags,
      axisSource: hasBehavior ? 'behavior' : hasContributions ? 'contributions' : 'values',
      anomaly_score: s,
      cluster_id: r.cluster_id ?? '',
      flight_count: Math.max(0, numberValue(r.reliable_segments ?? r.flight_count) || 0),
      unique_destinations: Number.isFinite(numberValue(r.unique_destinations))
        ? Math.max(0, numberValue(r.unique_destinations))
        : null,
      confidence: Number.isFinite(numberValue(r.confidence)) ? numberValue(r.confidence) : null,
      signal_count: Number.isFinite(numberValue(r.core_mechanisms ?? r.signal_count))
        ? numberValue(r.core_mechanisms ?? r.signal_count)
        : null,
      first_seen: r.first_seen ?? r.first_day ?? '',
      last_seen: r.last_seen ?? r.last_day ?? '',
      top_reason: r.top_reason || r.matched_hypotheses || 'Не указано',
    });
  }
  if (!valid.length)
    throw Error(
      'Не найдено корректных уникальных профилей: проверьте ID, target и значения G2–G4 в диапазоне 0–1'
    );
  return valid;
}
function createPoints(rows) {
  const n = rows.length,
    positions = new Float32Array(n * 3),
    featurePositions = new Float32Array(n * 3),
    scores = new Float32Array(n),
    radii = new Float32Array(n),
    ids = new Map();
  for (let i = 0; i < n; i++) {
    const r = rows[i],
      values = [r.x, r.y, r.z];
    ids.set(r.passenger_id, i);
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = (values[k] - 0.5) * 12;
      featurePositions[i * 3 + k] = (r.axisFlags[k] - 0.5) * 12;
    }
    scores[i] = r.anomaly_score;
    radii[i] = r.anomaly_score > 0.8 ? 1.75 : 1;
  }
  return { positions, featurePositions, scores, radii, ids };
}
function updateAxisReadout() {
  const row = state.rows[state.selected];
  const behavior = state.mode !== 'flags' && state.rows[0]?.axisSource === 'behavior';
  if (row) {
    const values = state.mode === 'flags' ? row.axisFlags : [row.x, row.y, row.z];
    $('profile-coords').textContent = values
      .map(
        (v, i) =>
          `${'XYZ'[i]} · ${behavior ? ['Попутчики', 'Связность', 'Всплеск'][i] : AXES[i].key} = ${v.toFixed(3)}`
      )
      .join(' / ');
  }
  $('axis-mode-label').textContent = behavior
    ? 'Поведение · шкала 0–1'
    : state.mode === 'flags'
      ? 'Флаги G2–G4 · 0 / 1'
      : 'Вклады G2–G4 · 0–1';
  ['x', 'y', 'z'].forEach((key, i) => {
    const el = $('legend-' + key);
    if (el)
      el.textContent = behavior
        ? ['X · Попутчики', 'Y · Связность', 'Z · Всплеск'][i]
        : `${'XYZ'[i]} · ${AXES[i].key}`;
  });
  updatePositionCounts();
}
function positionKey(row) {
  return (state.mode === 'flags' ? row.axisFlags : [row.x, row.y, row.z]).join('|');
}
function updatePositionCounts() {
  const counts = new Map();
  let visible = 0;
  for (const row of state.rows) {
    if (row.anomaly_score < state.threshold) continue;
    visible++;
    const key = positionKey(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  state.positionCounts = counts;
  $('stat-clusters').textContent = fmt(counts.size);
  $('visible-count').textContent = fmt(visible);
  const el = $('position-count');
  if (el)
    el.textContent = `Позиций: ${fmt(counts.size)} · Совпадающих сверх первой: ${fmt(visible - counts.size)}`;
}
function setData(raw, source) {
  const rows = normalizeRows(raw);
  state.rows = rows;
  state.points = createPoints(rows);
  state.ids = state.points.ids;
  state.selected = -1;
  state.source = source;
  state.threshold = 0;
  $('threshold').value = '0';
  $('threshold-num').textContent = '0.00';
  updateCombinationLegend();
  updateAxisReadout();
  const flagged = rows.filter((r) => r.anomaly_score >= 0.8).length;
  const clusters = new Set(rows.map(positionKey));
  $('stat-profiles').textContent = fmt(raw.length);
  $('stat-flagged').textContent = fmt(flagged);
  $('stat-clusters').textContent = fmt(clusters.size);
  $('dataset-name').textContent = source.toUpperCase();
  $('visible-count').textContent = fmt(rows.length);
  state.top = rows.map((r, i) => i).sort((a, b) => rows[b].anomaly_score - rows[a].anomaly_score);
  state.page = 0;
  renderRanking();
  showUnselected();
  if (renderer) renderer.updateData(state.points);
  $('file-summary').textContent =
    `Источник: ${source}. Профилей: ${fmt(rows.length)}. ${rows[0].axisSource === 'behavior' ? 'X = Попутчики, Y = Связность, Z = Всплеск' : 'X = G2, Y = G3, Z = G4'}; цвет = target. Координаты: ${rows[0].axisSource === 'behavior' ? 'behavior_x/y/z' : rows[0].axisSource === 'contributions' ? 'contribution_G2/G3/G4' : 'G2/G3/G4'}. Без пригодных координат / некорректных строк: ${fmt(raw.length - rows.length)}.`;
  status(`LOADED ${fmt(rows.length)} PROFILES`);
}
function combinationLevel(score) {
  if (score < 0.2) return ['Низкая выраженность', 'Условно: 1–2 совпадающих сигнала'];
  if (score < 0.45) return ['Небольшое сочетание', 'Несколько условных совпадений'];
  if (score < 0.65) return ['Умеренное сочетание', 'Нужна проверка контекста'];
  if (score < 0.8) return ['Повышенное сочетание', 'Несколько сильных сигналов'];
  return ['Высокая выраженность', 'Нужна экспертная проверка'];
}
function updateCombinationLegend() {
  const [name, subtitle] = combinationLevel(state.threshold);
  $('combination-level').textContent = name;
  $('combination-subtitle').textContent = subtitle;
}
function severity(score) {
  return score >= 0.8 ? 'ВЫСОКАЯ' : score >= 0.45 ? 'СРЕДНЯЯ' : 'НИЗКАЯ';
}
function selectProfile(index, focus = true) {
  if (index < 0 || index >= state.rows.length) return;
  state.selected = index;
  const r = state.rows[index],
    s = r.anomaly_score;
  $('inspector-empty').hidden = true;
  $('inspector-profile').hidden = false;
  $('inspector-title').textContent = r.passenger_id;
  $('severity-label').textContent = severity(s);
  $('severity-label').style.color = s >= 0.8 ? '#ff8c8e' : s >= 0.45 ? '#f6c17c' : '#69d3d6';
  $('score-val').textContent = s.toFixed(3);
  $('score-fill').style.width = s * 100 + '%';
  $('profile-cluster').textContent = r.cluster_id === '' ? '—' : r.cluster_id;
  $('profile-flights').textContent = fmt(r.flight_count);
  $('profile-dests').textContent =
    r.unique_destinations === null ? '—' : fmt(r.unique_destinations);
  $('profile-confidence').textContent = Number.isFinite(r.confidence)
    ? r.confidence.toFixed(2)
    : '—';
  $('profile-dates').textContent = `${r.first_seen || '—'}  →  ${r.last_seen || '—'}`;
  $('profile-reason').textContent = r.top_reason || 'Не указано';
  $('profile-combination').textContent =
    combinationLevel(s)[0] +
    (Number.isInteger(r.signal_count) && r.signal_count >= 0
      ? ' · сигналов в CSV: ' + r.signal_count
      : ' · количество сигналов не предоставлено');
  updateAxisReadout();
  if (renderer) {
    renderer.selected = index;
    if (focus) renderer.focus(index);
  }
  showCoincident(r);
  status(`SELECTED ${r.passenger_id}`);
}
function showUnselected() {
  if (renderer) renderer.releaseFocus();
  state.selected = -1;
  $('inspector-empty').hidden = false;
  $('inspector-profile').hidden = true;
  $('inspector-title').textContent = 'Профиль не выбран';
  if (renderer) renderer.selected = -1;
}
function setTab(tab) {
  state.tab = tab;
  document
    .querySelectorAll('.nav')
    .forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  document
    .querySelectorAll('.view')
    .forEach((el) => el.classList.toggle('visible', el.id === tab + '-view'));
  if (tab === 'observatory' && renderer) setTimeout(() => renderer.resize(), 0);
  if (tab === 'ranking') renderRanking();
  if (tab === 'chronicle') renderHistory();
}
function rankIndices() {
  if (!state.rankQuery.trim()) return state.top;
  return state.top.filter((i) =>
    state.rows[i].passenger_id.toLowerCase().includes(state.rankQuery.toLowerCase())
  );
}
function renderRanking() {
  const indices = rankIndices(),
    pages = Math.max(1, Math.ceil(indices.length / 20));
  state.page = Math.min(state.page, pages - 1);
  const subset = indices.slice(state.page * 20, (state.page + 1) * 20);
  $('ranking-total').textContent = `${fmt(indices.length)} PROFILES`;
  $('ranking-body').innerHTML = subset
    .map((i, j) => {
      const r = state.rows[i],
        s = r.anomaly_score;
      return `<tr data-index="${i}"><td>${state.page * 20 + j + 1}</td><td><b>${escapeHTML(r.passenger_id)}</b></td><td>${escapeHTML(String(r.cluster_id))}</td><td>${fmt(r.flight_count)}</td><td><div class="score-inline"><span style="color:${s >= 0.8 ? '#fa8791' : '#a0dce0'}">${s.toFixed(3)}</span><div class="mini-track"><span style="width:${s * 100}%"></span></div></div></td><td><button aria-label="Открыть профиль">→</button></td></tr>`;
    })
    .join('');
  $('page-indicator').textContent = `${state.page + 1} / ${pages}`;
  $('prev-page').disabled = state.page === 0;
  $('next-page').disabled = state.page >= pages - 1;
}
function escapeHTML(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
async function ensureFlights() {
  if (state.flightsLoaded) return;
  if (state.loadingFlights) return;
  state.loadingFlights = true;
  status('READING FLIGHT EVENTS');
  try {
    let res = await fetch('data/flights.csv');
    if (!res.ok)
      throw Error('Файл flights.csv отсутствует. Загрузите события через терминал данных.');
    const text = await res.text();
    loadFlightText(text);
    toast('История перелётов загружена');
  } catch (err) {
    toast(err.message);
    status('FLIGHT DATA UNAVAILABLE');
  } finally {
    state.loadingFlights = false;
  }
}
function loadFlightText(text) {
  const rows = parseCSV(text);
  if (rows.length && (!('passenger_id' in rows[0]) || !('flight_date' in rows[0])))
    throw Error('В CSV перелётов нужны passenger_id и flight_date');
  const map = new Map();
  for (const r of rows) {
    if (!r.passenger_id) continue;
    let list = map.get(r.passenger_id);
    if (!list) {
      list = [];
      map.set(r.passenger_id, list);
    }
    list.push(r);
  }
  for (const list of map.values()) list.sort((a, b) => a.flight_date.localeCompare(b.flight_date));
  state.flights = map;
  state.flightsLoaded = true;
  status(`LOADED ${fmt(rows.length)} EVENTS`);
}
async function openHistory() {
  if (state.selected < 0) {
    toast('Сначала выберите пассажира');
    return;
  }
  setTab('chronicle');
  $('chronicle-content').innerHTML =
    '<div class="empty-state"><p>Загрузка истории событий…</p></div>';
  await ensureFlights();
  renderHistory();
}
function renderHistory() {
  if (state.selected < 0) {
    $('chronicle-content').innerHTML =
      '<div class="empty-state"><div class="empty-icon">▤</div><h3>Пассажир не выбран</h3><p>Откройте профиль в обсерватории или рейтинге.</p><button class="action" onclick="window.switchToObservatory()">Открыть обсерваторию →</button></div>';
    return;
  }
  const r = state.rows[state.selected],
    events = state.flights.get(r.passenger_id) || [];
  if (!state.flightsLoaded) {
    $('chronicle-content').innerHTML =
      `<div class="empty-state"><h3>${escapeHTML(r.passenger_id)}</h3><p>Данные событий ещё не загружены.</p><button class="action" id="lazy-load-flights">Загрузить историю перелётов →</button></div>`;
    $('lazy-load-flights').onclick = openHistory;
    return;
  }
  const destinations = new Set(events.map((x) => x.destination));
  $('chronicle-content').innerHTML =
    `<h2 style="margin-top:30px">${escapeHTML(r.passenger_id)} <span style="color:#7097aa;font-size:12px;font-weight:400">/ FLIGHT RECORD</span></h2><div class="history-summary"><div><span>СОБЫТИЙ В ИСТОЧНИКЕ</span><strong>${fmt(events.length)}</strong></div><div><span>НАПРАВЛЕНИЙ</span><strong>${fmt(destinations.size)}</strong></div><div><span>ANOMALY SCORE</span><strong>${r.anomaly_score.toFixed(3)}</strong></div></div>${!events.length ? '<p class="subtitle">Для этого пассажира не найдено событий в текущем файле.</p>' : ''}<div class="timeline">${events.map((e) => `<div class="timeline-item"><small>${escapeHTML(e.flight_date)} · ${escapeHTML(e.departure_hour || '—')}:00</small><strong>${escapeHTML(e.origin || '???')} → ${escapeHTML(e.destination || '???')}</strong><span>EVENT ${escapeHTML(e.event_id || '—')} · ${escapeHTML(e.source || 'unknown')}</span></div>`).join('')}</div>`;
}
window.switchToObservatory = () => setTab('observatory');
const vertex = `#version 300 es
precision highp float;
in vec3 aPosition;in vec3 aFeatures;in float aScore;in float aRadius;
uniform mat4 uProj;uniform mat4 uView;uniform float uMix;uniform float uThreshold;uniform float uPixelRatio;uniform int uSelected;
out float vScore;out float vVisible;out float vSelected;
void main(){vec3 p=mix(aPosition,aFeatures,uMix);vec4 view=uView*vec4(p,1.0);gl_Position=uProj*view;vScore=aScore;vVisible=step(uThreshold-.0001,aScore);vSelected=float(gl_VertexID==uSelected);float depth=max(1.0,-view.z);gl_PointSize=min(42.0,(4.2+aRadius*2.0+vSelected*15.0)*uPixelRatio*30.0/depth);if(vVisible<0.5)gl_PointSize=0.0;
}`;
const fragment = `#version 300 es
precision highp float;
in float vScore;in float vVisible;in float vSelected;out vec4 outColor;
void main(){vec2 p=gl_PointCoord*2.0-1.0;float r=length(p);if(r>1.0||vVisible<0.5)discard;vec3 low=vec3(.22,.81,.91),middle=vec3(.96,.70,.37),high=vec3(1.0,.32,.45);vec3 col=mix(low,middle,smoothstep(.18,.58,vScore));col=mix(col,high,smoothstep(.58,.92,vScore));if(vSelected>.5)col=vec3(.88,1.0,1.0);float core=exp(-r*r*11.0);float halo=exp(-r*r*2.3)*.40;float alpha=(core*.90+halo*.35)*(vSelected>.5?1.0:.83);outColor=vec4(col*(.7+core*1.25),alpha);
}`;
class CloudRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw Error('Canvas 2D недоступен');
    this.selected = -1;
    this.yaw = 0.5;
    this.pitch = 0.18;
    this.radius = 25;
    this.targetRadius = 25;
    this.center = [0, 0, 0];
    this.targetCenter = [0, 0, 0];
    this.pointer = null;
    this.dragged = false;
    this.last = performance.now();
    this.frames = 0;
    this.lastFPS = this.last;
    this.n = 0;
    this.buffer = document.createElement('canvas');
    this.bctx = this.buffer.getContext('2d', { alpha: false });
    this.canvas.style.cursor = 'grab';
    this.installEvents();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    requestAnimationFrame((t) => this.frame(t));
  }
  updateData(d) {
    this.n = d.scores.length;
    this.reset();
  }
  reset() {
    this.yaw = 0.5;
    this.pitch = 0.18;
    this.targetRadius = 25;
    this.targetCenter = [0, 0, 0];
  }
  releaseFocus() {
    this.targetCenter = [0, 0, 0];
    this.targetRadius = 25;
  }
  focus(i) {
    const d = state.points,
      m = state.targetMix,
      p = m > 0.5 ? d.featurePositions : d.positions;
    this.targetCenter = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    this.targetRadius = 8;
  }
  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(2, Math.floor(r.width));
    this.canvas.height = Math.max(2, Math.floor(r.height));
    const scale = Math.min(1, 950 / Math.max(r.width, 1));
    this.buffer.width = Math.max(2, Math.floor(r.width * scale));
    this.buffer.height = Math.max(2, Math.floor(r.height * scale));
    this.pixelPriority = new Float32Array(this.buffer.width * this.buffer.height);
  }
  installEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointer = { x: e.clientX, y: e.clientY };
      this.dragged = false;
      this.canvas.style.cursor = 'grabbing';
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.pointer) return;
      const dx = e.clientX - this.pointer.x,
        dy = e.clientY - this.pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) this.dragged = true;
      this.yaw -= dx * 0.006;
      this.pitch = Math.max(-1.42, Math.min(1.42, this.pitch + dy * 0.006));
      this.pointer = { x: e.clientX, y: e.clientY };
    });
    c.addEventListener('pointerup', (e) => {
      if (this.pointer && !this.dragged) this.pick(e);
      this.pointer = null;
      this.canvas.style.cursor = 'grab';
    });
    c.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.canvas.style.cursor = 'grab';
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.targetRadius = Math.max(
          4,
          Math.min(75, this.targetRadius * Math.exp(e.deltaY * 0.001))
        );
      },
      { passive: false }
    );
  }
  getEye() {
    return [
      this.center[0] + this.radius * Math.sin(this.yaw) * Math.cos(this.pitch),
      this.center[1] + this.radius * Math.sin(this.pitch),
      this.center[2] + this.radius * Math.cos(this.yaw) * Math.cos(this.pitch),
    ];
  }
  matrices() {
    const eye = this.getEye();
    return {
      view: lookAt(eye, this.center, [0, 1, 0]),
      proj: perspective(Math.PI / 3, this.canvas.width / this.canvas.height, 0.1, 200),
    };
  }
  frame(t) {
    const delta = Math.min((t - this.last) / 1000, 0.1);
    this.last = t;
    const f = 1 - Math.exp(-delta * 5);
    this.radius += (this.targetRadius - this.radius) * f;
    for (let k = 0; k < 3; k++) this.center[k] += (this.targetCenter[k] - this.center[k]) * f;
    state.mix += (state.targetMix - state.mix) * f;
    if (!this.lastPaint || t - this.lastPaint >= 32) {
      this.lastPaint = t;
      this.draw();
      this.frames++;
    }
    if (t - this.lastFPS >= 1000) {
      $('fps').textContent =
        Math.round((this.frames * 1000) / (t - this.lastFPS)) + ' FPS · Canvas';
      this.frames = 0;
      this.lastFPS = t;
    }
    requestAnimationFrame((tm) => this.frame(tm));
  }
  draw() {
    const W = this.buffer.width,
      H = this.buffer.height,
      bctx = this.bctx,
      ctx = this.ctx;
    const image = bctx.createImageData(W, H),
      pixels = image.data;
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 7;
      pixels[i + 1] = 12;
      pixels[i + 2] = 22;
      pixels[i + 3] = 255;
    }
    const priorities = this.pixelPriority;
    priorities.fill(-1);
    if (this.n && state.points) {
      const d = state.points,
        view = this.matrices().view,
        positions = d.positions,
        features = d.featurePositions,
        scores = d.scores;
      const m = state.mix,
        inv = 1 - m,
        threshold = state.threshold,
        factor = H / (2 * Math.tan(Math.PI / 6));
      const a = view[0],
        b = view[4],
        c = view[8],
        tx = view[12],
        aa = view[1],
        bb = view[5],
        cc = view[9],
        ty = view[13],
        az = view[2],
        bz = view[6],
        cz = view[10],
        tz = view[14];
      for (let i = 0; i < this.n; i++) {
        const score = scores[i];
        if (score < threshold) continue;
        const j = i * 3;
        const x = positions[j] * inv + features[j] * m,
          y = positions[j + 1] * inv + features[j + 1] * m,
          z = positions[j + 2] * inv + features[j + 2] * m;
        const dz = -(az * x + bz * y + cz * z + tz);
        if (dz < 0.2 || dz > 180) continue;
        const px = Math.round(W / 2 + ((a * x + b * y + c * z + tx) * factor) / dz),
          py = Math.round(H / 2 - ((aa * x + bb * y + cc * z + ty) * factor) / dz);
        if (px < 2 || py < 2 || px >= W - 2 || py >= H - 2) continue;
        const base = (py * W + px) * 4;
        const r = score > 0.8 ? 255 : score > 0.45 ? 241 : 68,
          g = score > 0.8 ? 91 : score > 0.45 ? 183 : 213,
          bl = score > 0.8 ? 126 : score > 0.45 ? 110 : 229;
        const intense = i === this.selected ? 2.4 : 1;
        for (let yy = -1; yy <= 1; yy++) {
          for (let xx = -1; xx <= 1; xx++) {
            const p = base + (yy * W + xx) * 4,
              strength = (xx === 0 && yy === 0 ? 1 : 0.31) * intense;
            const priority = score + strength;
            if (priority <= priorities[p / 4]) continue;
            priorities[p / 4] = priority;
            pixels[p] = Math.min(255, 7 + r * strength);
            pixels[p + 1] = Math.min(255, 12 + g * strength);
            pixels[p + 2] = Math.min(255, 22 + bl * strength);
          }
        }
      }
    }
    bctx.putImageData(image, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.55;
    ctx.filter = 'blur(7px)';
    ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.28;
    ctx.filter = 'blur(2px)';
    ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    this.drawAxes();
    if (this.selected >= 0 && state.points) {
      const d = state.points,
        j = this.selected * 3,
        m = state.mix,
        inv = 1 - m,
        x = d.positions[j] * inv + d.featurePositions[j] * m,
        y = d.positions[j + 1] * inv + d.featurePositions[j + 1] * m,
        z = d.positions[j + 2] * inv + d.featurePositions[j + 2] * m;
      const { view, proj } = this.matrices(),
        v = transform(view, [x, y, z, 1]),
        p = transform(proj, v);
      if (p[3] > 0) {
        const sx = ((p[0] / p[3]) * 0.5 + 0.5) * this.canvas.width,
          sy = (0.5 - (p[1] / p[3]) * 0.5) * this.canvas.height;
        ctx.beginPath();
        ctx.arc(sx, sy, 15, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(244,251,255,.95)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(sx, sy, 20, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(105,211,214,.45)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }
  }
  drawAxes() {
    const ctx = this.ctx,
      { view, proj } = this.matrices(),
      W = this.canvas.width,
      H = this.canvas.height;
    const project = (p) => {
      const v = transform(proj, transform(view, [...p, 1]));
      return v[3] > 0.1 ? [((v[0] / v[3]) * 0.5 + 0.5) * W, (0.5 - (v[1] / v[3]) * 0.5) * H] : null;
    };
    const origin = project([-6, -6, -6]);
    if (!origin) return;
    ctx.save();
    ctx.font = '10px system-ui';
    ctx.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      const end = [-6, -6, -6];
      end[k] = 6;
      const p = project(end);
      if (!p) continue;
      ctx.strokeStyle = AXES[k].color;
      ctx.fillStyle = AXES[k].color;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(...origin);
      ctx.lineTo(...p);
      ctx.stroke();
      ctx.globalAlpha = 0.95;
      if (p[0] > 0 && p[0] < W - 100 && p[1] > 12 && p[1] < H - 12)
        ctx.fillText(
          `${'XYZ'[k]} · ${state.mode !== 'flags' && state.rows[0]?.axisSource === 'behavior' ? ['Попутчики', 'Связность', 'Всплеск'][k] : AXES[k].key} · 1`,
          p[0] + 5,
          p[1] - 5
        );
      if (state.mode !== 'flags') {
        const mid = [-6, -6, -6];
        mid[k] = 0;
        const tick = project(mid);
        if (tick && tick[0] > 0 && tick[0] < W - 30 && tick[1] > 12 && tick[1] < H - 12) {
          ctx.globalAlpha = 0.6;
          ctx.fillText('0.5', tick[0] + 4, tick[1] - 4);
        }
      }
    }
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = '#91aabc';
    if (origin[0] > 0 && origin[0] < W && origin[1] > 0 && origin[1] < H)
      ctx.fillText('0', origin[0] - 10, origin[1] + 12);
    ctx.restore();
  }
  pick(e) {
    if (!state.points) return;
    const rect = this.canvas.getBoundingClientRect(),
      px = ((e.clientX - rect.left) / rect.width) * 2 - 1,
      py = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const { view, proj } = this.matrices(),
      d = state.points;
    const pickRadius = Math.max(18, Math.min(28, Math.min(rect.width, rect.height) * 0.02));
    let best = -1,
      bestMetric = pickRadius * pickRadius;
    for (let i = 0; i < this.n; i++) {
      if (d.scores[i] < state.threshold) continue;
      const j = i * 3,
        m = state.mix,
        x = d.positions[j] * (1 - m) + d.featurePositions[j] * m,
        y = d.positions[j + 1] * (1 - m) + d.featurePositions[j + 1] * m,
        z = d.positions[j + 2] * (1 - m) + d.featurePositions[j + 2] * m;
      const v = transform(view, [x, y, z, 1]);
      if (v[2] >= -0.1) continue;
      const clip = transform(proj, v);
      if (clip[3] <= 0) continue;
      const dx = (clip[0] / clip[3] - px) * rect.width * 0.5,
        dy = (clip[1] / clip[3] - py) * rect.height * 0.5,
        dist = dx * dx + dy * dy,
        depth = -v[2],
        metric = dist + depth * 0.35;
      if (metric < bestMetric) {
        best = i;
        bestMetric = metric;
      }
    }
    if (best >= 0) selectProfile(best, true);
  }
}
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2),
    nf = 1 / (near - far);
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    0,
    (far + near) * nf,
    -1,
    0,
    0,
    2 * far * near * nf,
    0,
  ]);
}
function lookAt(eye, center, up) {
  let z = unit(sub(eye, center)),
    x = unit(cross(up, z)),
    y = cross(z, x);
  return new Float32Array([
    x[0],
    y[0],
    z[0],
    0,
    x[1],
    y[1],
    z[1],
    0,
    x[2],
    y[2],
    z[2],
    0,
    -dot(x, eye),
    -dot(y, eye),
    -dot(z, eye),
    1,
  ]);
}
const sub = (a, b) => a.map((v, i) => v - b[i]),
  dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0),
  cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  unit = (a) => {
    const l = Math.hypot(...a) || 1;
    return a.map((v) => v / l);
  };
function transform(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}
function bindUI() {
  document.querySelectorAll('.nav').forEach((n) => (n.onclick = () => setTab(n.dataset.tab)));
  document.querySelectorAll('.mode').forEach(
    (n) =>
      (n.onclick = () => {
        state.mode = n.dataset.mode;
        state.targetMix = state.mode === 'flags' ? 1 : 0;
        document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('active', b === n));
        updateAxisReadout();
        if (state.selected >= 0) renderer?.focus(state.selected);
        status(
          state.mode === 'flags'
            ? 'FLAGS / X = G2 · Y = G3 · Z = G4'
            : 'Показатели поведения / вклады'
        );
      })
  );
  $('threshold').oninput = (e) => {
    state.threshold = +e.target.value;
    $('threshold-num').textContent = state.threshold.toFixed(2);
    updateCombinationLegend();
    updatePositionCounts();
  };
  $('isolate-btn').onclick = () => {
    state.threshold = 0.8;
    $('threshold').value = '.8';
    $('threshold').dispatchEvent(new Event('input'));
    toast('Отображаются профили с anomaly_score ≥ 0.80');
  };
  $('reset-btn').onclick = () => {
    renderer?.reset();
    state.threshold = 0;
    $('threshold').value = '0';
    $('threshold').dispatchEvent(new Event('input'));
    showUnselected();
  };
  $('close-selection').onclick = showUnselected;
  $('open-history').onclick = openHistory;
  $('chronicle-go').onclick = () => setTab('observatory');
  $('copy-profile').onclick = () => {
    const id = state.rows[state.selected]?.passenger_id;
    if (!id) return;
    navigator.clipboard
      ?.writeText(id)
      .then(() => toast(`Скопировано: ${id}`))
      .catch(() => toast(id));
  };
  $('rank-search').oninput = (e) => {
    state.rankQuery = e.target.value;
    state.page = 0;
    renderRanking();
  };
  $('ranking-body').onclick = (e) => {
    let tr = e.target.closest('tr[data-index]');
    if (tr) {
      selectProfile(+tr.dataset.index);
      setTab('observatory');
    }
  };
  $('prev-page').onclick = () => {
    state.page--;
    renderRanking();
  };
  $('next-page').onclick = () => {
    state.page++;
    renderRanking();
  };
  $('fullscreen-btn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else
      document.documentElement
        .requestFullscreen()
        .catch(() => toast('Не удалось включить полный экран'));
  };
  $('import-btn').onclick = () => $('passenger-file').click();
  $('data-passenger-btn').onclick = () => $('passenger-file').click();
  $('data-flights-btn').onclick = () => $('flights-file').click();
  $('passenger-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      $('loading').hidden = false;
      $('loading-text').textContent = 'Разбор пользовательского CSV…';
      await new Promise((r) => setTimeout(r, 30));
      const text = await file.text();
      setData(parseCSV(text), file.name);
      toast('Новый набор профилей загружен');
      setTab('observatory');
    } catch (err) {
      toast('Ошибка импорта: ' + err.message);
    } finally {
      $('loading').hidden = true;
      e.target.value = '';
    }
  };
  $('flights-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      loadFlightText(await file.text());
      toast('CSV событий загружен');
      renderHistory();
    } catch (err) {
      toast('Ошибка импорта: ' + err.message);
    }
    e.target.value = '';
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      showUnselected();
      if (document.fullscreenElement) document.exitFullscreen();
    }
    if (e.key.toLowerCase() === 'f' && e.target.tagName !== 'INPUT') {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  });
}
async function boot() {
  bindUI();
  try {
    renderer = new CloudRenderer($('space'));
  } catch (err) {
    $('loading-text').textContent = err.message;
    status('RENDER ERROR');
    return;
  }
  try {
    $('loading-bar').style.width = '35%';
    let res = await fetch('data/passengers.csv');
    if (!res.ok) throw Error('Не найден data/passengers.csv');
    $('loading-text').textContent = 'Загрузка профилей G2–G4…';
    let text = await res.text();
    $('loading-bar').style.width = '75%';
    await new Promise((r) => setTimeout(r, 50));
    const records = parseCSV(text);
    setData(
      records,
      String(records[0]?.is_synthetic).toLowerCase() === 'true'
        ? 'Синтетический набор'
        : 'passengers.csv'
    );
    $('loading-bar').style.width = '100%';
    setTimeout(() => ($('loading').hidden = true), 400);
  } catch (err) {
    $('loading').hidden = true;
    status('DATASET NOT LOADED');
    toast(`${err.message}. Используйте «ИМПОРТ CSV».`);
    $('file-summary').textContent =
      `Ошибка автоматической загрузки: ${err.message}. Импортируйте CSV вручную.`;
  }
}

function showCoincident(row) {
  const box = $('coincident');
  if (!box) return;
  const key = positionKey(row);
  const peers = state.rows.filter(
    (r) => r.anomaly_score >= state.threshold && positionKey(r) === key
  );
  box.innerHTML =
    '<b>В этой позиции: ' +
    fmt(peers.length) +
    '</b><div style="max-height:160px;overflow:auto">' +
    peers
      .slice(0, 100)
      .map(
        (r) =>
          '<button class="toolbar-btn" data-person="' +
          escapeHTML(r.passenger_id) +
          '">' +
          escapeHTML(r.passenger_id) +
          ' · ' +
          r.anomaly_score.toFixed(3) +
          '</button>'
      )
      .join('') +
    '</div>' +
    (peers.length > 100 ? '<small>Первые 100. Все профили доступны в рейтинге по ID.</small>' : '');
  box.onclick = (e) => {
    const b = e.target.closest('[data-person]');
    if (b) selectProfile(state.ids.get(b.dataset.person), false);
  };
}
boot();
