// Painel do observatório VIRA-BICHO. Sem dependências e sem innerHTML: todo texto vindo do
// jogo (apelidos, salas, países, detalhes) entra no DOM só como nó de texto (textContent).
// @ts-check

import { C, EVENT_LABELS, FORM_COLORS, FORM_NAMES, PHASES, SECURITY_LABELS, feedItem, flag, fmtClockDur, fmtDur, fmtNum, fmtTime, h, lookup, setText } from './view.js';

/** @typedef {import('./view.js').Ev} Ev */

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

// ---------- estado ----------

const state = {
  /** @type {any} */ summary: null,
  /** Diferença relógio do servidor − relógio local. */
  skew: 0,
  /** @type {Ev[]} mais recentes primeiro */ events: [],
  /** @type {Ev[]} */ security: [],
  range: '1h',
  /** @type {any} */ chartSeries: null,
  /** @type {any} */ sparkSeries: null,
  /** @type {Set<string>} */ hidden: new Set(),
};

try {
  const saved = JSON.parse(localStorage.getItem('obs.hidden') ?? '[]');
  if (Array.isArray(saved)) saved.forEach((t) => typeof t === 'string' && state.hidden.add(t));
  const r = localStorage.getItem('obs.range');
  if (r === '1h' || r === '6h' || r === '24h') state.range = r;
} catch {
  // armazenamento indisponível: segue com o padrão
}

const serverNow = () => Date.now() + state.skew;

// ---------- desenho em canvas ----------

/** @param {HTMLCanvasElement} canvas */
function prepCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const hgt = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
  }
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  return { ctx, w, h: hgt };
}

/** Teto "bonito" para o eixo Y. @param {number} v */
function niceMax(v) {
  if (v <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/**
 * Traça uma série com quebras onde falta dado (null) ou há buraco no tempo.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} ts @param {(number|null)[]} vs
 * @param {(t:number)=>number} X @param {(v:number)=>number} Y
 * @param {number} gapMs
 * @param {string} color @param {number} baseY @param {boolean} fill
 */
function traceLine(ctx, ts, vs, X, Y, gapMs, color, baseY, fill) {
  /** @type {[number, number][][]} */
  const runs = [];
  /** @type {[number, number][]} */
  let run = [];
  for (let i = 0; i < ts.length; i++) {
    const v = vs[i];
    if (v === null || v === undefined || (i > 0 && ts[i] - ts[i - 1] > gapMs)) {
      if (run.length) runs.push(run);
      run = [];
    }
    if (v !== null && v !== undefined) run.push([X(ts[i]), Y(v)]);
  }
  if (run.length) runs.push(run);
  for (const r of runs) {
    if (fill && r.length > 1) {
      const grad = ctx.createLinearGradient(0, Math.min(...r.map((p) => p[1])), 0, baseY);
      grad.addColorStop(0, color + '55');
      grad.addColorStop(1, color + '00');
      ctx.beginPath();
      ctx.moveTo(r[0][0], baseY);
      for (const [x, y] of r) ctx.lineTo(x, y);
      ctx.lineTo(r[r.length - 1][0], baseY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
    }
    ctx.beginPath();
    r.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (r.length === 1) ctx.arc(r[0][0], r[0][1], 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

/** Intervalo entre marcas do eixo X. @param {number} span @param {number} maxTicks */
function timeStep(span, maxTicks) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720].map((m) => m * 60_000);
  return steps.find((st) => span / st <= maxTicks) ?? steps[steps.length - 1];
}

/**
 * Sombreia os trechos sem dado: vermelho onde o observador coletou mas o jogo estava fora do ar
 * (online = null) e cinza onde nem o observador coletou (buraco no tempo).
 * @param {CanvasRenderingContext2D} ctx @param {any} s
 * @param {(t:number)=>number} X @param {number} top @param {number} bottom @param {number} right
 */
function shadeGaps(ctx, s, X, top, bottom, right) {
  const half = s.stepMs / 2;
  const gapMs = Math.max(s.stepMs * 3, 20_000);
  const clampX = (/** @type {number} */ t) => Math.min(right, Math.max(X(s.from), X(t)));
  for (let i = 0; i < s.t.length; i++) {
    if (i > 0 && s.t[i] - s.t[i - 1] > gapMs) {
      ctx.fillStyle = C.gapFill;
      const x0 = clampX(s.t[i - 1] + half);
      ctx.fillRect(x0, top, clampX(s.t[i] - half) - x0, bottom - top);
    }
    if (s.fields.online[i] === null) {
      ctx.fillStyle = C.downFill;
      const x0 = clampX(s.t[i] - half);
      ctx.fillRect(x0, top, clampX(s.t[i] + half) - x0, bottom - top);
    }
  }
}

/** @type {{ from: number, to: number, left: number, right: number, series: any } | null} */
let chartGeom = null;
/** @type {number | null} */
let hoverX = null;

function drawMainChart() {
  const canvas = /** @type {HTMLCanvasElement} */ ($('chart-online'));
  const { ctx, w, h: hgt } = prepCanvas(canvas);
  const s = state.chartSeries;
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  const to = s ? s.to : serverNow();
  const from = s ? s.from : to - 3600_000;
  const vals = s ? [...s.fields.online, ...s.fields.playing].filter((v) => v !== null) : [];
  const yMax = niceMax(vals.length ? Math.max(...vals) : 0);
  const X = (/** @type {number} */ t) => pad.l + ((t - from) / (to - from)) * (w - pad.l - pad.r);
  const Y = (/** @type {number} */ v) => pad.t + (1 - v / yMax) * (hgt - pad.t - pad.b);
  chartGeom = { from, to, left: pad.l, right: w - pad.r, series: s };

  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = C.muted;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(fmtNum(v, v % 1 ? 1 : 0), pad.l - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Marcas do eixo X em horários redondos (múltiplos de 5/10/15/30 min, 1/2/3/4/6 h, no fuso local).
  const step = timeStep(to - from, w < 420 ? 3 : 6);
  const off = new Date(from).getTimezoneOffset() * 60_000;
  for (let t = Math.ceil((from - off) / step) * step + off; t <= to; t += step) {
    const x = X(t);
    if (x < pad.l + 14 || x > w - pad.r - 14) continue;
    ctx.fillText(fmtTime(t, false), x, hgt - pad.b + 6);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, hgt - pad.b);
    ctx.lineTo(Math.round(x) + 0.5, hgt - pad.b + 3);
    ctx.stroke();
  }
  const hasData = !!s && s.fields.online.some((/** @type {number | null} */ v) => v !== null);
  if (s) shadeGaps(ctx, s, X, pad.t, hgt - pad.b, w - pad.r);
  if (!s || !hasData) {
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const msg = s && s.t.length ? 'jogo fora do ar neste intervalo' : 'sem dados neste intervalo';
    ctx.fillText(msg, (pad.l + w - pad.r) / 2, (pad.t + hgt - pad.b) / 2);
    return;
  }
  const gap = Math.max(s.stepMs * 3, 20_000);
  traceLine(ctx, s.t, s.fields.playing, X, Y, gap, C.good, Y(0), false);
  traceLine(ctx, s.t, s.fields.online, X, Y, gap, C.accent, Y(0), true);

  const tip = $('chart-tip');
  if (hoverX !== null && hoverX >= pad.l && hoverX <= w - pad.r) {
    let best = 0;
    for (let i = 1; i < s.t.length; i++) if (Math.abs(X(s.t[i]) - hoverX) < Math.abs(X(s.t[best]) - hoverX)) best = i;
    const x = Math.round(X(s.t[best])) + 0.5;
    ctx.strokeStyle = C.muted;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, hgt - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    tip.replaceChildren(
      h('div', null, fmtTime(s.t[best], false)),
      h('div', { class: 't-online' }, `online ${fmtNum(s.fields.online[best], 1)}`),
      h('div', { class: 't-playing' }, `jogando ${fmtNum(s.fields.playing[best], 1)}`),
    );
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(x + 10, 0), w - tw)}px`;
  } else {
    tip.hidden = true;
  }
}

/**
 * Minigráfico sem eixos.
 * @param {HTMLCanvasElement} canvas @param {string} field @param {string} color @param {number} [minMax]
 */
function drawSpark(canvas, field, color, minMax = 1) {
  const { ctx, w, h: hgt } = prepCanvas(canvas);
  const s = state.sparkSeries;
  if (!s || !s.fields[field]) return;
  const vs = /** @type {(number|null)[]} */ (s.fields[field]);
  const nums = /** @type {number[]} */ (vs.filter((v) => v !== null));
  if (!nums.length) return;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums, lo + minMax);
  const span = hi - lo || 1;
  const X = (/** @type {number} */ t) => ((t - s.from) / (s.to - s.from)) * w;
  const Y = (/** @type {number} */ v) => 2 + (1 - (v - lo) / span) * (hgt - 4);
  traceLine(ctx, s.t, vs, X, Y, Math.max(s.stepMs * 3, 20_000), color, hgt, true);
}

// ---------- blocos de métricas ----------

/** @typedef {{ el: HTMLElement, value: HTMLElement, detail: HTMLElement, canvas: HTMLCanvasElement | null, meter: HTMLElement | null, field: string | null, color: string, minMax: number }} Tile */
/** @type {Map<string, Tile>} */
const tiles = new Map();

/**
 * @param {HTMLElement} parent @param {string} key @param {string} label
 * @param {{ field?: string, color?: string, meter?: boolean, minMax?: number }} [opt]
 */
function tile(parent, key, label, opt = {}) {
  let t = tiles.get(key);
  if (t) return t;
  const value = h('p', { class: 'mid' }, '—');
  const detail = h('p', { class: 'detail' });
  const canvas = opt.field ? /** @type {HTMLCanvasElement} */ (h('canvas', null)) : null;
  const meter = opt.meter ? h('div', { class: 'meter' }, h('span', null)) : null;
  const el = h('div', { class: 'metric' }, h('p', { class: 'label' }, label), value, detail, meter, canvas);
  parent.append(el);
  t = { el, value, detail, canvas, meter, field: opt.field ?? null, color: opt.color ?? C.accent, minMax: opt.minMax ?? 1 };
  tiles.set(key, t);
  return t;
}

/**
 * @param {Tile} t @param {string} value @param {string} unit @param {string} detail
 * @param {'good'|'warn'|'bad'|''} [level] @param {number | null} [meterPct]
 */
function setTile(t, value, unit, detail, level = '', meterPct = null) {
  const v = h('span', null, value);
  t.value.replaceChildren(v, unit ? h('span', { class: 'unit' }, unit) : '');
  setText(t.detail, detail);
  t.el.className = `metric ${level}`;
  if (t.meter) {
    t.meter.className = `meter ${level === 'good' ? '' : level}`;
    const bar = /** @type {HTMLElement} */ (t.meter.firstChild);
    bar.style.width = `${Math.max(0, Math.min(100, meterPct ?? 0))}%`;
  }
}

function drawSparks() {
  for (const t of tiles.values()) if (t.canvas && t.field) drawSpark(t.canvas, t.field, t.color, t.minMax);
}

// ---------- renderização ----------

/** @param {HTMLElement} el @param {'good'|'bad'|''} cls */
function setStatusClass(el, cls) {
  el.className = `status ${cls}`;
}

function renderStatus() {
  const s = state.summary;
  if (!s) return;
  const g = s.game;
  const box = $('st-game');
  const now = serverNow();
  if (g.status === 'up') {
    setStatusClass(box, 'good');
    setText($('st-game-v'), 'NO AR');
    const parts = [`há ${fmtDur(g.uptimeMs === null ? null : g.uptimeMs + (now - s.now))}`];
    if (g.version) parts.push(`v${g.version}`);
    if (g.pollMs !== null) parts.push(`consulta ${g.pollMs} ms`);
    if (g.restarts) parts.push(`${g.restarts} reinício(s)`);
    setText($('st-game-h'), parts.join(' · '));
  } else if (g.status === 'down') {
    setStatusClass(box, 'bad');
    setText($('st-game-v'), 'FORA DO AR');
    setText($('st-game-h'), `há ${fmtDur(now - g.since)}${g.lastError ? ` · ${g.lastError}` : ''}`);
  } else {
    setStatusClass(box, '');
    setText($('st-game-v'), 'verificando…');
    setText($('st-game-h'), '');
  }

  const p = s.public;
  const pb = $('st-public');
  if (p.ok === null) {
    setStatusClass(pb, '');
    setText($('st-public-v'), 'aguardando');
    setText($('st-public-h'), p.url);
  } else if (p.ok && g.status === 'down' && p.checkedAt < g.since) {
    // O /health público passa pelo jogo: um OK de antes da queda já não diz nada.
    setStatusClass(pb, '');
    setText($('st-public-v'), 'rechecando…');
    setText($('st-public-h'), `último OK há ${fmtDur(now - p.checkedAt)}, antes da queda`);
  } else if (p.ok) {
    setStatusClass(pb, 'good');
    setText($('st-public-v'), `OK · ${p.latencyMs} ms`);
    setText($('st-public-h'), `checado há ${fmtDur(now - p.checkedAt)}`);
  } else {
    setStatusClass(pb, 'bad');
    setText($('st-public-v'), 'FALHA');
    const since = p.lastOkAt ? `último ok há ${fmtDur(now - p.lastOkAt)}` : 'nunca respondeu';
    setText($('st-public-h'), `${p.error ?? 'erro'} · ${since}`);
  }

  const chips = $('st-services');
  if (!s.services) {
    chips.replaceChildren(h('span', { class: 'chip none' }, 'sem runit neste host'));
  } else if (!s.services.length) {
    chips.replaceChildren(h('span', { class: 'chip none' }, 'nenhum serviço'));
  } else {
    chips.replaceChildren(
      ...s.services.map((/** @type {any} */ sv) =>
        h(
          'span',
          { class: `chip ${sv.state}`, title: sv.pid ? `pid ${sv.pid}` : sv.state },
          sv.name,
          sv.state === 'run' && sv.uptimeS !== null ? ` · ${fmtDur(sv.uptimeS * 1000)}` : ` · ${sv.state}`,
        ),
      ),
    );
  }
}

function renderCards() {
  const st = state.summary?.stats;
  const set = (/** @type {string} */ id, /** @type {number | null | undefined} */ v) => {
    const el = $(id);
    setText(el, st ? fmtNum(v) : '—');
    /** @type {HTMLElement} */ (el.parentElement).classList.toggle('stale', !st);
  };
  set('c-online', st?.players.online);
  set('c-playing', st?.players.playing);
  set('c-lobby', st?.players.lobby);
  set('c-spectating', st?.players.spectating);
  set('c-rooms', st?.activeRooms);
  const online = st?.players.online;
  document.title = state.summary?.game.status === 'down' ? 'FORA DO AR · VIRA-BICHO' : st ? `(${online}) VIRA-BICHO · Observatório` : 'VIRA-BICHO · Observatório';
}

function renderRooms() {
  const rooms = /** @type {any[]} */ (state.summary?.stats?.rooms ?? []);
  const sorted = [...rooms].sort((a, b) => b.humans - a.humans || b.elapsedMs - a.elapsedMs);
  $('rooms-body').replaceChildren(
    ...sorted.map((r) => {
      const phase = r.state === 'lobby' ? 'lobby' : r.phase || r.state;
      return h(
        'tr',
        null,
        h('td', { class: 'code' }, r.code),
        h(
          'td',
          null,
          h('span', { class: r.private ? 'tag priv' : 'tag' }, h('span', { class: 'lg' }, r.private ? 'privada' : 'pública'), h('span', { class: 'sm' }, r.private ? 'priv' : 'púb')),
        ),
        h('td', { class: `phase-${phase}` }, lookup(PHASES, phase) ?? phase),
        h('td', { class: 'r' }, fmtClockDur(r.elapsedMs)),
        h('td', { class: 'r' }, r.humans),
        h('td', { class: 'r' }, r.bots),
        h('td', { class: 'r' }, r.state === 'lobby' ? '—' : r.alive),
      );
    }),
  );
  $('rooms-empty').hidden = sorted.length > 0;
  const active = rooms.filter((r) => r.humans > 0).length;
  setText($('rooms-count'), rooms.length ? `${rooms.length} aberta(s) · ${active} com humanos` : '');
}

/**
 * Barras horizontais.
 * @param {HTMLElement} parent @param {[string, number][]} entries
 * @param {(k: string) => string} name @param {(k: string) => string} color
 */
function renderBars(parent, entries, name, color) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  const total = entries.reduce((a, e) => a + e[1], 0) || 1;
  parent.replaceChildren(
    ...entries.map(([k, n]) => {
      const fill = h('div', { class: 'fill' });
      fill.style.width = `${(n / max) * 100}%`;
      fill.style.background = color(k);
      return h(
        'div',
        { class: 'bar', title: `${Math.round((n / total) * 100)}%` },
        h('span', { class: 'name' }, name(k)),
        h('div', { class: 'track' }, fill),
        h('span', { class: 'n' }, n),
      );
    }),
  );
}

function renderToday() {
  const t = state.summary?.today;
  if (!t) return;
  setText($('today-day'), t.day.split('-').reverse().join('/'));
  setText($('t-matches'), fmtNum(t.matchesEnded));
  setText($('t-avg'), t.avgDurationMs === null ? '—' : fmtClockDur(t.avgDurationMs));
  $('t-peak').replaceChildren(h('span', null, fmtNum(t.peakOnline)), t.peakAt ? h('span', { class: 'unit' }, ` às ${fmtTime(t.peakAt, false)}`) : '');
  setText($('t-joins'), fmtNum(t.joins));
  const winners = t.winnersByForm && typeof t.winnersByForm === 'object' ? t.winnersByForm : {};
  const entries = /** @type {[string, number][]} */ (Object.entries(winners))
    .filter((e) => typeof e[1] === 'number')
    .sort((a, b) => b[1] - a[1]);
  const box = $('t-forms');
  if (!entries.length) box.replaceChildren(h('p', { class: 'empty' }, 'Nenhuma partida terminada hoje.'));
  else renderBars(box, entries, (k) => lookup(FORM_NAMES, k) ?? k, (k) => lookup(FORM_COLORS, k) ?? '#5d5480');
}

function renderBreakdown() {
  const st = state.summary?.stats;
  const devBox = $('devices');
  const ctryBox = $('countries');
  if (!st) {
    devBox.replaceChildren(h('p', { class: 'empty' }, 'Sem dados do jogo.'));
    ctryBox.replaceChildren();
    return;
  }
  const m = st.breakdown.devices.mobile ?? 0;
  const d = st.breakdown.devices.desktop ?? 0;
  const tot = m + d;
  const segM = h('div', { class: 'seg-mobile' });
  const segD = h('div', { class: 'seg-desktop' });
  segM.style.width = tot ? `${(m / tot) * 100}%` : '0';
  segD.style.width = tot ? `${(d / tot) * 100}%` : '0';
  const pct = (/** @type {number} */ n) => (tot ? ` ${Math.round((n / tot) * 100)}%` : '');
  devBox.replaceChildren(
    h('p', { class: 'label sub-h' }, 'Dispositivos'),
    h('div', { class: 'track' }, segM, segD),
    h('div', { class: 'legend' }, h('span', { class: 'key k-mobile' }, `celular ${m}${pct(m)}`), h('span', { class: 'key k-desktop' }, `computador ${d}${pct(d)}`)),
  );
  const entries = /** @type {[string, number][]} */ (Object.entries(st.breakdown.countries))
    .filter((e) => e[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  if (!entries.length) {
    ctryBox.replaceChildren(h('p', { class: 'label sub-h' }, 'Países'), h('p', { class: 'empty' }, 'Ninguém online.'));
    return;
  }
  const wrap = h('div', { class: 'bars' });
  renderBars(wrap, entries, (k) => `${flag(k)} ${k}`.trim(), () => C.mare);
  ctryBox.replaceChildren(h('p', { class: 'label sub-h' }, 'Países'), wrap);
}

const FEED_MAX = 150;

function renderFeedFilters() {
  $('feed-filters').replaceChildren(
    ...Object.keys(EVENT_LABELS).map((type) => {
      const chip = h('button', { class: `chip ev-${type}${state.hidden.has(type) ? ' off' : ''}` }, EVENT_LABELS[type]);
      chip.setAttribute('type', 'button');
      chip.setAttribute('aria-pressed', String(!state.hidden.has(type)));
      chip.addEventListener('click', () => {
        if (state.hidden.has(type)) state.hidden.delete(type);
        else state.hidden.add(type);
        try {
          localStorage.setItem('obs.hidden', JSON.stringify([...state.hidden]));
        } catch {
          // sem armazenamento
        }
        renderFeedFilters();
        renderFeed();
      });
      return chip;
    }),
  );
}

function renderFeed() {
  const list = state.events.filter((e) => !state.hidden.has(e.type)).slice(0, FEED_MAX);
  const feed = $('feed');
  if (!list.length) feed.replaceChildren(h('li', { class: 'empty' }, 'Nenhum evento.'));
  else feed.replaceChildren(...list.map((e) => feedItem(e, false)));
}

/** Mais recente primeiro, pelo horário do evento (o id desempata). @param {Ev} a @param {Ev} b */
const byTimeDesc = (a, b) => b.t - a.t || b.id - a.id;

/** @param {Ev[]} evs */
function addEvents(evs) {
  if (!evs.length) return;
  const known = new Set(state.events.slice(0, 300).map((e) => e.id));
  const fresh = evs.filter((e) => !known.has(e.id)).sort(byTimeDesc);
  if (!fresh.length) return;
  // Eventos podem chegar com horário anterior ao do topo do feed (ex.: o jogo voltou antes de o
  // observador perceber). Nesse caso reordena tudo em vez de só empilhar em cima.
  const top = state.events[0];
  const inOrder = !top || fresh[fresh.length - 1].t >= top.t;
  state.events = [...fresh, ...state.events];
  if (!inOrder) state.events.sort(byTimeDesc);
  state.events = state.events.slice(0, 500);
  const sec = fresh.filter((e) => e.type === 'security');
  if (sec.length) {
    state.security = [...sec, ...state.security].sort(byTimeDesc).slice(0, 20);
    renderSecurityTable();
  }
  if (!inOrder) {
    renderFeed();
    return;
  }
  const feed = $('feed');
  const visible = fresh.filter((e) => !state.hidden.has(e.type));
  if (!visible.length) return;
  if (feed.firstElementChild?.classList.contains('empty')) feed.replaceChildren();
  feed.prepend(...visible.map((e) => feedItem(e, true)));
  while (feed.childElementCount > FEED_MAX) feed.lastElementChild?.remove();
}

function renderGame() {
  const st = state.summary?.stats;
  const box = $('game-metrics');
  const rss = tile(box, 'g-rss', 'Memória (RSS)', { field: 'gameRssMB', color: C.mare, minMax: 5 });
  const cpu = tile(box, 'g-cpu', 'CPU', { field: 'gameCpuPct', color: C.brasa, minMax: 5 });
  const lag = tile(box, 'g-lag', 'Lag do event loop p99', { field: 'lagP99', color: C.accent, minMax: 5 });
  const tick = tile(box, 'g-tick', 'Tick p99', { field: 'tickP99', color: C.good, minMax: 5 });
  const conns = tile(box, 'g-conns', 'Conexões abertas', { field: 'conns', color: C.muted, minMax: 2 });
  setText($('g-version'), state.summary?.game.version ? `v${state.summary.game.version}` : '');
  if (!st) {
    for (const t of [rss, cpu, lag, tick, conns]) setTile(t, '—', '', 'jogo sem dados');
    return;
  }
  const p = st.process;
  setTile(rss, fmtNum(p.rssMB), 'MB', `heap ${fmtNum(p.heapUsedMB)} MB`, p.rssMB > 400 ? 'bad' : p.rssMB > 250 ? 'warn' : '');
  setTile(cpu, fmtNum(p.cpuPct, 1), '%', 'de um núcleo', p.cpuPct > 80 ? 'bad' : p.cpuPct > 50 ? 'warn' : '');
  const L = p.eventLoopLagMs;
  setTile(lag, fmtNum(L.p99, 1), 'ms', `p50 ${fmtNum(L.p50, 1)} · máx ${fmtNum(L.max, 1)}`, L.p99 > 100 ? 'bad' : L.p99 > 40 ? 'warn' : '');
  const T = st.process.tickMs;
  setTile(tick, fmtNum(T.p99, 1), 'ms', `p50 ${fmtNum(T.p50, 1)} · máx ${fmtNum(T.max, 1)}`, T.p99 > 50 ? 'bad' : T.p99 > 25 ? 'warn' : '');
  setTile(conns, fmtNum(st.connections.open), '', `${fmtNum(st.connections.total)} desde o início`);
}

function renderPhone() {
  const s = state.summary;
  const p = s?.phone;
  const box = $('phone-metrics');
  const bat = tile(box, 'p-bat', 'Bateria', { field: 'battery', color: C.good, meter: true, minMax: 5 });
  const temp = tile(box, 'p-temp', 'Temperatura', { field: 'tempC', color: C.brasa, minMax: 3 });
  const mem = tile(box, 'p-mem', 'RAM disponível', { field: 'memFreeMB', color: C.mare, meter: true, minMax: 50 });
  const load = tile(box, 'p-load', 'Carga (1 min)', { field: 'load1', color: C.accent, minMax: 1 });
  const disk = tile(box, 'p-disk', 'Disco livre', { meter: true });
  const self = tile(box, 'p-self', 'Observador');
  if (!p) return;
  setText($('p-uptime'), p.uptimeS !== null ? `ligado há ${fmtDur(p.uptimeS * 1000)}` : '');

  const b = p.battery;
  if (b && b.capacity !== null) {
    const status = { Charging: 'carregando', Discharging: 'descarregando', Full: 'cheia', 'Not charging': 'sem carregar' }[/** @type {string} */ (b.status)] ?? b.status ?? '';
    setTile(bat, fmtNum(b.capacity), '%', [status, b.tempC !== null ? `${fmtNum(b.tempC, 1)} °C` : ''].filter(Boolean).join(' · '), b.capacity < 20 ? 'bad' : b.capacity < 40 ? 'warn' : 'good', b.capacity);
  } else setTile(bat, '—', '', 'ilegível neste aparelho');

  const tc = p.tempC ?? b?.tempC ?? null;
  if (tc !== null) setTile(temp, fmtNum(tc, 1), '°C', p.tempZone ? `zona ${p.tempZone}` : 'bateria', tc >= 55 ? 'bad' : tc >= 45 ? 'warn' : '');
  else setTile(temp, '—', '', 'ilegível neste aparelho');

  if (p.mem) {
    const freePct = (p.mem.availableMB / p.mem.totalMB) * 100;
    setTile(mem, fmtNum(p.mem.availableMB), 'MB', `de ${fmtNum(p.mem.totalMB)} MB`, freePct < 10 ? 'bad' : freePct < 20 ? 'warn' : 'good', 100 - freePct);
  } else setTile(mem, '—', '', 'ilegível');

  if (p.load) setTile(load, fmtNum(p.load[0], 2), '', `5 min ${fmtNum(p.load[1], 2)} · 15 min ${fmtNum(p.load[2], 2)} · 8 núcleos`, p.load[0] > 8 ? 'bad' : p.load[0] > 5 ? 'warn' : '');
  else setTile(load, '—', '', 'ilegível (restrição do Android)');

  if (p.disk) {
    const usedPct = 100 - (p.disk.freeMB / p.disk.totalMB) * 100;
    setTile(disk, fmtNum(p.disk.freeMB / 1024, 1), 'GB', `de ${fmtNum(p.disk.totalMB / 1024, 1)} GB`, usedPct > 95 ? 'bad' : usedPct > 85 ? 'warn' : 'good', usedPct);
  } else setTile(disk, '—', '', 'ilegível');

  const o = s.observer;
  // PSS: RSS com as páginas do binário do Node divididas com o jogo (o custo real no celular).
  const own = o.pssMB ?? o.privateMB ?? o.rssMB;
  const kind = o.pssMB !== null ? 'PSS' : o.privateMB !== null ? 'privada' : 'RSS';
  setTile(
    self,
    fmtNum(own, 1),
    'MB',
    `${kind}${kind !== 'RSS' ? ` (RSS ${fmtNum(o.rssMB)} MB)` : ''} · CPU ${fmtNum(o.cpuPct, 2)}% · ${o.sseClients} painel(is) · no ar há ${fmtDur(o.uptimeMs)}`,
    own > 30 ? 'warn' : '',
  );
}

function renderSecurityCounters() {
  const c = state.summary?.stats?.counters;
  const items = [
    ['Limite de taxa', c?.rateLimited],
    ['Conexões recusadas', c?.rejectedConnections],
    ['Origem recusada', c?.originRejected],
    ['Erros', c?.errors],
  ];
  $('sec-counters').replaceChildren(
    ...items.map(([label, v]) => h('div', null, h('p', { class: 'label' }, String(label)), h('p', { class: `mid${Number(v) > 0 ? ' warnv' : ''}` }, c ? fmtNum(/** @type {number} */ (v)) : '—'))),
  );
}

function renderSecurityTable() {
  $('sec-body').replaceChildren(
    ...state.security.map((e) =>
      h(
        'tr',
        null,
        h('td', { title: new Date(e.t).toLocaleString('pt-BR') }, fmtTime(e.t)),
        h('td', { title: String(e.data.kind ?? '') }, lookup(SECURITY_LABELS, e.data.kind) ?? String(e.data.kind ?? '?')),
        h('td', null, String(e.data.ipHash ?? '?')),
        h('td', { class: 'detail' }, String(e.data.detail ?? '')),
      ),
    ),
  );
  $('sec-empty').hidden = state.security.length > 0;
}

function renderFoot() {
  const s = state.summary;
  if (!s) return;
  setText($('foot'), `atualizado ${fmtTime(s.now)} · ${s.observer.seriesPoints} amostras · consulta ao jogo a cada 2 s`);
}

function renderAll() {
  renderStatus();
  renderCards();
  renderRooms();
  renderToday();
  renderBreakdown();
  renderGame();
  renderPhone();
  renderSecurityCounters();
  renderFoot();
}

// ---------- dados ----------

/** @param {string} url */
async function getJSON(url) {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('sessão expirada');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadSeries() {
  try {
    const spark = await getJSON('/api/series?range=1h');
    state.sparkSeries = spark;
    state.chartSeries = state.range === '1h' ? spark : await getJSON(`/api/series?range=${state.range}&fields=online,playing`);
    drawMainChart();
    drawSparks();
  } catch (err) {
    console.warn('séries:', err);
  }
}

async function loadSecurity() {
  try {
    const { events } = await getJSON('/api/events?type=security&limit=20');
    state.security = events;
    renderSecurityTable();
  } catch (err) {
    console.warn('segurança:', err);
  }
}

/** @param {any} summary */
function applySummary(summary) {
  state.summary = summary;
  state.skew = summary.now - Date.now();
  renderAll();
}

/** @type {EventSource | null} */
let stream = null;
let retryTimer = 0;
let backoffMs = 3_000;

function connect() {
  const live = $('live');
  clearTimeout(retryTimer);
  stream?.close();
  const es = new EventSource('/api/stream');
  stream = es;
  es.addEventListener('bye', () => {
    // Sessão encerrada no servidor (sair, "sair de todos" ou expirou).
    es.close();
    location.href = '/login';
  });
  es.addEventListener('hello', (msg) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (msg).data);
    state.events = [];
    applySummary(data.summary);
    addEvents(data.events);
    renderFeed();
  });
  es.addEventListener('tick', (msg) => {
    const data = JSON.parse(/** @type {MessageEvent} */ (msg).data);
    applySummary(data.summary);
    addEvents(data.events);
  });
  es.onopen = () => {
    backoffMs = 3_000;
    live.className = 'live on';
    setText(live, 'ao vivo');
  };
  es.onerror = () => {
    if (stream !== es) return;
    live.className = 'live off';
    setText(live, 'reconectando…');
    // Se a sessão expirou, o EventSource não mostra o 401: confere pela API.
    getJSON('/api/summary').catch(() => {});
    // Com resposta HTTP de erro (502/530 da Cloudflare durante um deploy, 503 de painéis demais)
    // o EventSource desiste para sempre (CLOSED). Reabre por conta própria, com espera crescente.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      stream = null;
      retryTimer = window.setTimeout(connect, backoffMs + Math.random() * 1_000);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  };
}

function setupRangeTabs() {
  const tabs = $('range-tabs');
  const buttons = /** @type {HTMLButtonElement[]} */ ([...tabs.querySelectorAll('button')]);
  const mark = () => buttons.forEach((b) => b.classList.toggle('on', b.dataset.range === state.range));
  mark();
  for (const b of buttons) {
    b.addEventListener('click', () => {
      state.range = b.dataset.range ?? '1h';
      try {
        localStorage.setItem('obs.range', state.range);
      } catch {
        // sem armazenamento
      }
      mark();
      void loadSeries();
    });
  }
}

function setupChartHover() {
  const canvas = $('chart-online');
  canvas.addEventListener('pointermove', (e) => {
    hoverX = e.offsetX;
    drawMainChart();
  });
  canvas.addEventListener('pointerleave', () => {
    hoverX = null;
    drawMainChart();
  });
}

function init() {
  setupRangeTabs();
  setupChartHover();
  renderFeedFilters();
  connect();
  void loadSeries();
  void loadSecurity();
  setInterval(loadSeries, 30_000);
  setInterval(loadSecurity, 60_000);
  // Durações ("há 3m 10s") andam sozinhas entre as atualizações.
  setInterval(renderStatus, 1_000);
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      drawMainChart();
      drawSparks();
    }, 150);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
