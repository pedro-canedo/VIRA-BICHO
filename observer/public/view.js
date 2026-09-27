// Construção de nós do painel. Todo texto vindo do jogo (apelidos, salas, países, detalhes)
// entra no DOM só como nó de texto: nada aqui usa innerHTML ou similares.
// @ts-check

/** @typedef {{ id: number, t: number, type: string, seq?: number, data: Record<string, string|number|boolean|null> }} Ev */

/**
 * Cria um elemento. Filhos string viram nós de texto (nunca HTML).
 * @param {string} tag
 * @param {{ class?: string, title?: string } | null} [props]
 * @param {...(Node | string | number | null | undefined | false)} children
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props?.class) el.className = props.class;
  if (props?.title) el.title = props.title;
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

/** @param {HTMLElement} el @param {string | number} text */
export function setText(el, text) {
  const s = String(text);
  if (el.textContent !== s) el.textContent = s;
}

// ---------- formatação ----------

export const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** @param {number | null | undefined} ms */
export function fmtDur(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${pad(mm)}m`;
  if (mm) return `${mm}m ${pad(ss)}s`;
  return `${ss}s`;
}

/** @param {number | null | undefined} ms */
export function fmtClockDur(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** @param {number | null | undefined} t @param {boolean} [secs] */
export function fmtTime(t, secs = true) {
  if (!t) return '—';
  const d = new Date(t);
  return secs ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** @param {number | null | undefined} v @param {number} [digits] */
export function fmtNum(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Bandeira a partir do código ISO (só letras A-Z; o resto aparece como está). @param {string} code */
export function flag(code) {
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export const FORM_NAMES = /** @type {Record<string, string>} */ ({
  brasa: 'Brasa',
  mare: 'Maré',
  broto: 'Broto',
  vapor: 'Vapor',
  cinza: 'Cinza',
  mangue: 'Mangue',
  quimera: 'Quimera',
  neutro: 'Neutro',
});
export const FORM_COLORS = /** @type {Record<string, string>} */ ({
  brasa: '#ff7a3d',
  mare: '#4aa3ff',
  broto: '#52c95f',
  vapor: '#b48cff',
  cinza: '#9d93b5',
  mangue: '#2fc3a4',
  quimera: '#ffcf3f',
  neutro: '#aa9fcc',
});
export const PHASES = /** @type {Record<string, string>} */ ({
  lobby: 'Na sala',
  coleta: 'Coleta',
  cacada: 'Caçada',
  final: 'Final',
  duelo: 'Duelo',
  fim: 'Fim',
});
export const EVENT_LABELS = /** @type {Record<string, string>} */ ({
  join: 'entrada',
  leave: 'saída',
  match_start: 'início',
  match_end: 'fim',
  duel: 'duelo',
  security: 'segurança',
  error: 'erro',
  restart: 'reinício',
  down: 'queda',
  up: 'volta',
});
export const C = {
  accent: '#ffcf3f',
  good: '#58e07a',
  bad: '#ff4f6d',
  warn: '#ffb03f',
  mare: '#4aa3ff',
  brasa: '#ff7a3d',
  muted: '#aa9fcc',
  line: '#3f3470',
};

/** Descrição do evento como nós (nomes em destaque, sempre como texto). @param {Ev} e */
export function describe(e) {
  const d = e.data;
  const s = (/** @type {string} */ k) => (d[k] === null || d[k] === undefined ? '?' : String(d[k]));
  const b = (/** @type {string} */ k) => h('b', null, s(k));
  switch (e.type) {
    case 'join':
      return [b('name'), ` entrou (${s('mode')}) na sala `, b('room'), ` · ${flag(s('country'))} ${s('country')} · ${d.device === 'mobile' ? 'celular' : 'computador'}`];
    case 'leave':
      return [b('name'), ' saiu da sala ', b('room'), ` (${s('reason')})${d.inMatch ? ' no meio da partida' : ''}`];
    case 'match_start':
      return ['Partida começou na sala ', b('room'), `: ${s('humans')} humano(s) + ${s('bots')} bot(s)`];
    case 'match_end': {
      const form = typeof d.form === 'string' ? FORM_NAMES[d.form] ?? d.form : null;
      const who = d.winner ? [b('winner'), ` venceu${form ? ` como ${form}` : ''}`] : ['ninguém venceu'];
      return ['Fim na sala ', b('room'), ': ', ...who, ` · ${fmtClockDur(typeof d.durationMs === 'number' ? d.durationMs : null)} · ${s('humans')} humano(s)`];
    }
    case 'duel':
      return ['Duelo final na sala ', b('room'), ': ', b('a'), ' × ', b('b')];
    case 'security':
      return [b('kind'), ` · ${s('ipHash')} · ${s('detail')}`];
    case 'error':
      return [s('message')];
    case 'restart':
      return [`O jogo reiniciou${d.version ? ` (versão ${d.version})` : ''}`];
    case 'down':
      return [`O jogo ficou fora do ar: ${s('reason')}`];
    case 'up':
      return [`O jogo voltou depois de ${fmtDur(typeof d.downMs === 'number' ? d.downMs : null)}`];
    default:
      return [JSON.stringify(d)];
  }
}

/** @param {Ev} e @param {boolean} fresh */
export function feedItem(e, fresh) {
  return h(
    'li',
    { class: fresh ? 'new' : '' },
    h('span', { class: 'time', title: new Date(e.t).toLocaleString('pt-BR') }, fmtTime(e.t)),
    h('span', { class: `ev ev-${e.type}` }, EVENT_LABELS[e.type] ?? e.type),
    h('span', { class: 'text' }, ...describe(e)),
  );
}
