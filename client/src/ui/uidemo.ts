import {
  canBuy,
  encodeTiles,
  generateMap,
  isGameMode,
  isSkillId,
  isWalkable,
  maxHp,
  modsOf,
  powerOf,
  SKILLS,
  specialOf,
  titleOf,
  withSkill,
  type Action,
  type ClientMsg,
  type Elem,
  type EntSnap,
  type FighterInfo,
  type Form,
  type GameMode,
  type LeaderRow,
  type Look,
  type Move,
  type RankRow,
  type ServerMsg,
  type SkillId,
  type Snap,
  type Stage,
} from '@vb/shared';
import { recordLook } from './bestiary';
import { showHelp } from './help';

/**
 * Demonstração da interface (só desenvolvimento): ?uidemo=<tela>. Não abre conexão: monta as telas
 * com mensagens sintéticas do protocolo e um "servidor" de mentira para a loja.
 * Telas: menu, lobby, hud, shop, battle, spectate, death, end, bestiary, help.
 * Parâmetros: gm (modo), ess (Essência), sk (habilidades separadas por vírgula), auto=0 (sem roteiro automático).
 * window.__uidemo controla a batalha e os eventos para as capturas.
 */

interface Ctx {
  onMsg: (m: ServerMsg) => void;
  name: string;
  setSend: (fn: (m: ClientMsg) => void) => void;
  menu: () => void;
}

const ME = 1;
const BATTLE = 900;

const look = (form: Form, stage: Stage, order: Elem[]): Look => ({ form, stage, order });

/** Rivais do placar: nome, forma, nível e build. */
const RIVALS: [string, Form, Stage, Elem[], SkillId[]][] = [
  ['Tubarão', 'mare', 3, ['mare'], ['m_foco', 'm_escudo', 'm_arcana', 'c_esquiva']],
  ['Lu', 'vapor', 3, ['brasa', 'mare'], ['c_passos', 'c_faro', 'c_armadilha', 'c_esquiva']],
  ['Zeca', 'broto', 2, ['broto'], ['g_couro', 'g_contra']],
  ['Bia', 'cinza', 2, ['brasa', 'broto'], ['m_canal']],
  ['Dudu', 'quimera', 2, ['brasa', 'mare', 'broto'], ['g_pesado', 'g_brutal', 'm_foco']],
  ['Nina', 'mangue', 1, ['mare', 'broto'], []],
  ['Rafa', 'neutro', 1, [], ['c_faro']],
  ['Gui', 'brasa', 0, ['brasa'], []],
  ['🤖 Bot Tatu', 'broto', 1, ['broto'], ['g_couro']],
];

export function runUiDemo(ctx: Ctx): void {
  const q = new URLSearchParams(location.search);
  const gmQ = q.get('gm');
  const gm: GameMode = isGameMode(gmQ) ? gmQ : 'classico';
  let skills: SkillId[] = (q.get('sk') ?? 'g_couro,g_pesado,g_brutal').split(',').filter(isSkillId);
  let essence = Number(q.get('ess') ?? 9);
  const auto = q.get('auto') !== '0';
  const name = ctx.name || 'hud';

  if (name === 'menu') return ctx.menu();
  if (name === 'help') return showHelp();
  if (name === 'bestiary') {
    const seen: [Form, Stage, Elem[]][] = [
      ['neutro', 0, []],
      ['neutro', 1, []],
      ['brasa', 0, ['brasa']],
      ['brasa', 1, ['brasa']],
      ['brasa', 2, ['brasa']],
      ['brasa', 3, ['brasa']],
      ['mare', 0, ['mare']],
      ['mare', 1, ['mare']],
      ['broto', 0, ['broto']],
      ['vapor', 2, ['brasa', 'mare']],
      ['quimera', 0, ['brasa', 'mare', 'broto']],
    ];
    for (const [f, s, o] of seen) recordLook(look(f, s, o));
    ctx.menu();
    window.setTimeout(() => (document.querySelectorAll<HTMLButtonElement>('.btn').forEach((b) => b.textContent === 'Bestiário' && b.click())), 50);
    return;
  }
  if (name === 'lobby') {
    let left = 25_000;
    const players = ['Pedro', 'Tubarão', 'Lu'];
    const tick = () => {
      ctx.onMsg({ t: 'lobby', code: 'KWXZ', private: true, players: [...players], startsIn: left, min: 8, max: 16, gm });
      left = Math.max(0, left - 1000);
      if (players.length < 6 && left % 4000 === 0) players.push(['Zeca', 'Bia', 'Dudu'][players.length - 3]);
    };
    tick();
    window.setInterval(tick, 1000);
    return;
  }
  if (name === 'end') return ctx.onMsg(endMsg(skills));

  // ---------- partida ----------
  const map = generateMap(20260927, 8);
  let mx = Math.floor(map.w / 2);
  let my = Math.floor(map.h / 2);
  search: for (let r = 0; r < 12; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        let ok = true;
        for (let yy = -2; yy <= 2 && ok; yy++) for (let xx = -3; xx <= 3 && ok; xx++) ok = isWalkable(map, mx + dx + xx, my + dy + yy);
        if (ok) {
          mx += dx;
          my += dy;
          break search;
        }
      }

  const myLook = look('brasa', 2, ['brasa', 'mare']);
  let alive = true;
  let battle: number | null = null;
  let deaths = 1;
  let hatch = 0;
  let el = gm === 'rapido' ? 150_000 : 260_000;
  const fx: NonNullable<Snap['fx']> = [];
  const others: EntSnap[] = RIVALS.slice(0, 5).map(([n, f, s, o, sk], i) => {
    const t = titleOf(sk);
    return { id: 10 + i, k: 'p', n, x: mx + [3, -3, 4, -4, 0][i], y: my + [1, -1, -2, 2, 3][i], f, s, o, hp: maxHp(s), mhp: maxHp(s), ...(t ? { ln: t.line, tl: t.level } : {}) };
  });
  const wilds: EntSnap[] = [
    { id: 200, k: 'w', x: mx + 2, y: my - 2, f: 'broto', s: 1, o: ['broto'], hp: 12, mhp: 12 },
    { id: 201, k: 'w', x: mx - 2, y: my + 2, f: 'mare', s: 1, o: ['mare'], hp: 10, mhp: 12 },
  ];

  const mhp = () => Math.round(maxHp(myLook.stage) * modsOf(skills).hpMult);
  let hp = Math.round(mhp() * 0.8);
  const power = () => powerOf({ stage: myLook.stage, trophies: 1, skills, essence, hpPct: hp / mhp() });

  const lb = (): LeaderRow[] => {
    const t = titleOf(skills);
    const rows: LeaderRow[] = [{ id: ME, n: 'Pedro', s: myLook.stage, f: myLook.form, pw: power(), ...(t ? { ln: t.line, tl: t.level } : {}) }];
    RIVALS.forEach(([n, f, s, o, sk], i) => {
      const tt = titleOf(sk);
      rows.push({ id: 10 + i, n, s, f, pw: powerOf({ stage: s, trophies: s === 3 ? 2 : 0, skills: sk, essence: 3 + i, hpPct: 1 }), ...(i === 0 ? { cr: 1 as const } : {}), ...(tt ? { ln: tt.line, tl: tt.level } : {}) });
      void o;
    });
    return rows.sort((a, b) => b.pw - a.pw);
  };

  const snapshot = (): Snap => ({
    t: 'snap',
    el,
    ph: el < 120_000 ? 'coleta' : el < 240_000 ? 'cacada' : 'final',
    z: { x: mx, y: my, r: 22, tr: 14 },
    al: 9,
    ents: [{ id: ME, k: 'p', n: 'Pedro', x: mx, y: my, f: myLook.form, s: myLook.stage, o: myLook.order, hp, mhp: mhp(), ...(battle ? { b: battle } : {}), ...(hatch > 0 ? { hx: 1 as const } : {}) }, ...others, ...wilds],
    bs: battle ? [{ id: battle, x: mx + 1.5, y: my + 0.5 }] : [],
    fr: map.fruits.map((_, i) => i),
    me: {
      id: ME,
      x: mx,
      y: my,
      look: myLook,
      xp: 2,
      xpNeed: 4,
      hp,
      mhp: mhp(),
      points: { brasa: 6, mare: 3, broto: 0 },
      trophies: 1,
      shieldMs: 0,
      hungerMs: 0,
      alive,
      crown: false,
      battle,
      target: null,
      essence,
      skills: [...skills],
      power: power(),
      deaths,
      hatchMs: hatch,
    },
    view: ME,
    crown: { x: others[0].x, y: others[0].y },
    lb: lb(),
    duel: null,
    ...(fx.length ? { fx: fx.splice(0) } : {}),
  });

  // "Servidor" da loja: valida com canBuy e aplica withSkill, como o de verdade
  ctx.setSend((m) => {
    if (m.t !== 'buy') return;
    window.setTimeout(() => {
      if (battle !== null || !alive || canBuy(skills, essence, m.s, gm) !== null) return;
      const frac = hp / mhp();
      skills = withSkill(skills, m.s);
      essence -= SKILLS[m.s].cost;
      hp = Math.round(frac * mhp());
      fx.push({ k: 'k', x: mx, y: my, id: ME, s: m.s });
    }, 180);
  });

  ctx.onMsg({ t: 'start', you: ME, w: map.w, h: map.h, tiles: encodeTiles(map.tiles), fruits: map.fruits, players: 10, gm });
  ctx.onMsg(snapshot());
  window.setInterval(() => {
    el += 100;
    if (hatch > 0) hatch = Math.max(0, hatch - 100);
    ctx.onMsg(snapshot());
  }, 100);

  const feed = () => {
    ctx.onMsg({ t: 'feed', text: 'Tubarão comprou Explosão Arcana', kind: 'info' });
    ctx.onMsg({ t: 'feed', text: 'Lu roubou um nível de Nina!', kind: 'steal' });
    ctx.onMsg({ t: 'feed', text: 'Gui morreu e renasce do ovo', kind: 'elim' });
  };

  // ---------- batalha ----------
  const me = (): FighterInfo => ({ name: 'Pedro', look: myLook, hp, mhp: mhp(), charged: false, trophies: 1, wild: false, skills: [...skills], special: specialOf(skills), specialLeft: specialOf(skills) ? modsOf(skills).specialUses : 0 });
  const oppSkills: SkillId[] = ['m_foco', 'm_escudo', 'm_arcana', 'c_esquiva'];
  const opp = (): FighterInfo => ({ name: 'Tubarão', look: look('mare', 3, ['mare']), hp: 110, mhp: 110, charged: false, trophies: 2, wild: false, skills: oppSkills, special: 'arcana', specialLeft: 1 });
  let hpYou = 0;
  let hpOpp = 110;
  let spYou = 0;
  let spOpp = 1;
  const bStart = (spectate = false) => {
    battle = BATTLE;
    hpYou = hp;
    hpOpp = 110;
    spYou = me().specialLeft;
    spOpp = 1;
    ctx.onMsg(snapshot());
    ctx.onMsg({ t: 'b_start', id: BATTLE, kind: spectate ? 'final' : 'pvp', you: spectate ? { ...opp(), name: 'Lu', look: look('vapor', 3, ['brasa', 'mare']), skills: ['c_passos', 'c_faro', 'c_armadilha', 'c_esquiva'], special: 'armadilha' } : me(), opp: opp(), turn: 1, ms: 5000, ...(spectate ? { spectate: true } : {}) });
  };
  type R = { you: Action; opp: Action; mY: Move; mO: Move; dY: number; dO: number; w: 'you' | 'opp' | 'tie'; text: string; heal?: number; dodgeO?: boolean; shieldO?: boolean };
  const script: R[] = [
    { you: 'especial', opp: 'ataque', mY: 'brutal', mO: 'ataque', dY: 0, dO: 17, w: 'you', text: 'Golpe Brutal venceu Ataque! O escudo arcano absorveu metade.', shieldO: true },
    { you: 'defesa', opp: 'especial', mY: 'defesa', mO: 'arcana', dY: 25, dO: 0, w: 'opp', text: 'Explosão Arcana venceu Defesa!' },
    { you: 'carga', opp: 'defesa', mY: 'carga', mO: 'defesa', dY: 0, dO: 0, w: 'you', text: 'Carga venceu Defesa! Esquivou!', dodgeO: true },
    { you: 'ataque', opp: 'carga', mY: 'ataque', mO: 'carga', dY: 0, dO: 44, w: 'you', text: 'Ataque venceu Carga!', heal: skills.includes('g_sede') ? Math.round(mhp() * 0.1) : 0 },
  ];
  let turn = 1;
  const reveal = (i: number) => {
    const r = script[i % script.length];
    if (r.mY !== r.you) spYou = Math.max(0, spYou - 1);
    if (r.mO !== r.opp) spOpp = Math.max(0, spOpp - 1);
    hpYou = Math.max(0, Math.min(mhp(), hpYou - r.dY + (r.heal ?? 0)));
    hpOpp = Math.max(0, hpOpp - r.dO);
    ctx.onMsg({
      t: 'b_reveal',
      id: BATTLE,
      turn,
      you: r.you,
      opp: r.opp,
      dmgYou: r.dY,
      dmgOpp: r.dO,
      hpYou,
      hpOpp,
      chYou: r.mY === 'carga' && r.w === 'you',
      chOpp: false,
      winner: r.w,
      text: r.text,
      moveYou: r.mY,
      moveOpp: r.mO,
      healYou: r.heal ?? 0,
      healOpp: 0,
      dodgeYou: false,
      dodgeOpp: !!r.dodgeO,
      shieldYou: false,
      shieldOpp: !!r.shieldO,
      spLeftYou: spYou,
      spLeftOpp: spOpp,
    });
  };
  const nextTurn = () => ctx.onMsg({ t: 'b_turn', id: BATTLE, turn: ++turn, ms: 5000 });
  const bEnd = (result: 'win' | 'lose' = 'win') => {
    ctx.onMsg({ t: 'b_end', id: BATTLE, result, text: result === 'win' ? 'Você venceu Tubarão! +3 ✨' : 'Tubarão venceu.' });
    window.setTimeout(() => (battle = null), 1800);
  };
  const death = () => {
    alive = false;
    deaths++;
    essence = Math.floor(essence / 2);
    ctx.onMsg({ t: 'death', by: 'Tubarão', reason: 'batalha', respawnMs: 5000, lost: { essence: Math.ceil(essence), points: 4 } });
    window.setTimeout(() => {
      alive = true;
      hatch = 2500;
      myLook.stage = 0;
      fx.push({ k: 'r', x: mx, y: my, id: ME });
    }, 5000);
  };

  (window as unknown as { __uidemo: unknown }).__uidemo = {
    snapshot,
    feed,
    bStart,
    reveal,
    nextTurn,
    bEnd,
    death,
    essence: (n: number) => (essence = n),
    skills: (s: SkillId[]) => (skills = s),
    toast: (text: string) => ctx.onMsg({ t: 'toast', text }),
  };

  if (!auto) return;
  if (name === 'hud' || name === 'shop') {
    window.setTimeout(feed, 400);
    window.setTimeout(() => (essence += 3), 1500);
    if (name === 'shop') window.setTimeout(() => document.querySelector<HTMLButtonElement>('.shopbtn')?.click(), 300);
  } else if (name === 'battle') {
    // Roteiro em loop: Especial, Especial do oponente, esquiva, cura
    let i = 0;
    const loop = () => {
      turn = 1;
      bStart();
      i = 0;
      const step = () => {
        if (i >= script.length) {
          bEnd('win');
          window.setTimeout(loop, 3000);
          return;
        }
        reveal(i++);
        window.setTimeout(() => {
          if (i < script.length) nextTurn();
          window.setTimeout(step, i < script.length ? 1500 : 1400);
        }, 1400);
      };
      window.setTimeout(step, 1500);
    };
    loop();
  } else if (name === 'spectate') {
    bStart(true);
  } else if (name === 'death') {
    window.setTimeout(death, 300);
  }
}

/** Fim de partida com o ranking completo (você em 3º). */
function endMsg(skills: SkillId[]): Extract<ServerMsg, { t: 'end' }> {
  const rows: RankRow[] = [];
  const mine = look('brasa', 3, ['brasa', 'mare']);
  const all: [string, Look, SkillId[], number][] = [
    ['Tubarão', look('mare', 3, ['mare']), ['m_foco', 'm_escudo', 'm_arcana', 'm_canal'], 0],
    ['Lu', look('vapor', 3, ['brasa', 'mare']), ['c_passos', 'c_faro', 'c_armadilha', 'c_esquiva'], 1],
    ['Pedro', mine, skills, 2],
    ...RIVALS.slice(2).map(([n, f, s, o, sk], i): [string, Look, SkillId[], number] => [n, look(f, s, o), sk, (i * 7) % 4]),
    ['🤖 Bot Capivara', look('neutro', 1, []), [], 5],
    ['🤖 Bot Jacaré', look('mare', 0, ['mare']), [], 6],
  ];
  all.forEach(([n, l, sk, d], i) => {
    const t = titleOf(sk);
    rows.push({
      place: i + 1,
      name: n,
      look: l,
      power: powerOf({ stage: l.stage, trophies: l.stage === 3 ? 3 - Math.min(2, i) : 0, skills: sk, essence: 12 - i, hpPct: 1 }),
      title: t?.name ?? null,
      skills: sk,
      deaths: d,
      ...(i === 0 ? { duel: 1 as const } : i === 1 ? { duel: 2 as const } : {}),
      ...(n === 'Pedro' ? { you: true as const } : {}),
    });
  });
  const t = titleOf(skills);
  return {
    t: 'end',
    winner: { name: 'Tubarão', look: all[0][1] },
    place: 3,
    total: rows.length,
    you: { name: 'Pedro', look: mine, wins: 6, steals: 3, wilds: 14, deaths: 2, power: rows[2].power, skills, title: t?.name ?? null },
    history: [
      { el: 0, look: look('neutro', 0, []), ev: 'Nasceu' },
      { el: 30_000, look: look('brasa', 1, ['brasa']), ev: 'Evoluiu' },
      { el: 95_000, look: look('brasa', 2, ['brasa']), ev: 'Evoluiu' },
      { el: 150_000, look: look('neutro', 0, []), ev: 'Morreu e renasceu' },
      { el: 190_000, look: look('vapor', 2, ['brasa', 'mare']), ev: 'Roubou um nível' },
      { el: 260_000, look: mine, ev: 'Forma final' },
    ],
    ranking: rows,
  };
}
