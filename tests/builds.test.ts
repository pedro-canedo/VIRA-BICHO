import { describe, expect, it } from 'vitest';
import {
  BALANCE,
  MODES,
  SKILLS,
  maxHp,
  modsOf,
  isWalkable,
  nearestWalkable,
  Rng,
  type Action,
  type ClientMsg,
  type FxEvent,
  type GameMode,
  type ServerMsg,
  type SkillId,
  type Snap,
  type Stage,
} from '@vb/shared';
import { BOT_SPECIAL_CHANCE, botChoose, botWish, makeBrain } from '../server/src/bots';
import type { Conn, Player } from '../server/src/entities';
import { Lobby } from '../server/src/lobby';
import { Room, type Member } from '../server/src/room';

type Ev<K extends FxEvent['k']> = Extract<FxEvent, { k: K }>;
type Msg<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/** Sala com humanos e bots parados (sem cérebro). `hatched`: todos já saíram do ovo. */
function setup(o: { humans?: number; total?: number; gm?: GameMode; hatched?: boolean } = {}) {
  const { humans = 1, total = 8, gm = 'rapido', hatched = true } = o;
  const room = new Room('BLDS', true, 11, { gm });
  const members: { m: Member; msgs: ServerMsg[] }[] = [];
  let now = 1_000_000;
  for (let i = 0; i < humans; i++) {
    const msgs: ServerMsg[] = [];
    const m: Member = { conn: { send: (x) => msgs.push(x) }, name: `H${i}`, player: null };
    room.join(m, now);
    members.push({ m, msgs });
  }
  room.start(now, total);
  const me = members[0].m.player!;
  const bots = [...room.players.values()].filter((p) => !p.conn).sort((a, b) => a.id - b.id);
  for (const b of bots) b.bot = null;
  if (hatched) for (const p of room.players.values()) p.hatchUntil = 0;
  const c = nearestWalkable(room.map, room.zone.x, room.zone.y);
  const place = (p: Player, dx: number, dy = 0) => {
    p.x = c.x + dx;
    p.y = c.y + dy;
    p.path = [];
  };
  const set = (p: Player, stage: Stage) => {
    p.stage = stage;
    p.hp = room.maxHpOf(p);
  };
  const tick = (ms = BALANCE.tickMs) => room.tick((now += ms));
  const advanceTo = (el: number) => (room.startedAt = now - el);
  const msgs = (i = 0) => members[i].msgs;
  const ofType = <T extends ServerMsg['t']>(t: T, i = 0) => msgs(i).filter((m): m is Msg<T> => m.t === t);
  const snaps = (i = 0) => ofType('snap', i) as Snap[];
  const lastSnap = (i = 0) => snaps(i).at(-1)!;
  const ofKind = <K extends FxEvent['k']>(k: K, i = 0) => snaps(i).flatMap((s) => s.fx ?? []).filter((e): e is Ev<K> => e.k === k);
  const toasts = (i = 0) => ofType('toast', i).map((t) => t.text);
  const runBattle = (p: Player, max = 300) => {
    for (let i = 0; i < max && p.battle && room.state === 'play'; i++) tick();
  };
  const choose = (a: Player, ca: Action, b: Player, cb: Action) => {
    room.act(a, ca);
    room.act(b, cb);
  };
  /** Batalha PvP entre dois jogadores lado a lado na Caçada. */
  const pvp = (a: Player, b: Player) => {
    if (room.phase === 'coleta') {
      advanceTo(MODES[gm].phases.coletaEnd + 1000);
      tick();
    }
    place(a, 0);
    place(b, 1);
    room.startBattle(a, b);
    return a.battle!;
  };
  return { room, members, me, bots, c, place, set, tick, advanceTo, msgs, ofType, snaps, lastSnap, ofKind, toasts, runBattle, choose, pvp, now: () => now };
}

// ------------------------------------------------------------------ modos e filas

describe('modos: fila por modo e sala privada', () => {
  const mkConn = (): Conn & { msgs: ServerMsg[] } => {
    const msgs: ServerMsg[] = [];
    return { msgs, send: (m) => msgs.push(m), key: `k${Math.random()}` };
  };
  const hello = (mode: 'quick' | 'create' | 'join', gm?: GameMode, code?: string): ClientMsg => ({ t: 'hello', name: 'X', mode, ...(gm ? { gm } : {}), ...(code ? { code } : {}) });

  it('partida rápida: uma fila por modo (sem gm vale Rápido)', () => {
    const lobby = new Lobby({ isExempt: () => true });
    const a = mkConn();
    const b = mkConn();
    const c = mkConn();
    const d = mkConn();
    lobby.handle(a, hello('quick'), 0);
    lobby.handle(b, hello('quick', 'classico'), 0);
    lobby.handle(c, hello('quick', 'rapido'), 0);
    lobby.handle(d, hello('quick', 'classico'), 0);
    expect(lobby.roomOf(a)!.gm).toBe('rapido');
    expect(lobby.roomOf(c)).toBe(lobby.roomOf(a));
    expect(lobby.roomOf(b)!.gm).toBe('classico');
    expect(lobby.roomOf(d)).toBe(lobby.roomOf(b));
    expect(lobby.roomOf(a)).not.toBe(lobby.roomOf(b));
    lobby.tick(2000);
    const lob = a.msgs.find((m): m is Msg<'lobby'> => m.t === 'lobby');
    expect(lob?.gm).toBe('rapido');
    expect(b.msgs.find((m): m is Msg<'lobby'> => m.t === 'lobby')?.gm).toBe('classico');
  });

  it('a sala privada guarda o modo de quem cria; quem entra por código joga nele', () => {
    const lobby = new Lobby({ isExempt: () => true });
    const host = mkConn();
    lobby.handle(host, hello('create', 'avancado'), 0);
    const room = lobby.roomOf(host)!;
    expect(room.gm).toBe('avancado');
    const guest = mkConn();
    lobby.handle(guest, hello('join', 'rapido', room.code), 0);
    expect(lobby.roomOf(guest)).toBe(room);
    // A fila rápida do Avançado não enxerga a sala privada.
    const q = mkConn();
    lobby.handle(q, hello('quick', 'avancado'), 0);
    expect(lobby.roomOf(q)).not.toBe(room);
    lobby.handle(host, { t: 'startnow' }, 0);
    lobby.tick(100);
    const start = host.msgs.find((m): m is Msg<'start'> => m.t === 'start')!;
    expect(start.gm).toBe('avancado');
    // Arena do modo: 48 × 1,5 com 8 jogadores.
    expect(start.w).toBe(Math.round(48 * MODES.avancado.mapScale));
  });

  it('o tamanho do mapa segue a escala do modo', () => {
    for (const gm of ['rapido', 'classico', 'avancado'] as const) {
      const { room } = setup({ gm, total: 16 });
      expect(room.map.w).toBe(Math.round(64 * MODES[gm].mapScale));
    }
  });
});

// ------------------------------------------------------------------ eclosão

describe('nascimento: todos começam chocando', () => {
  it('não anda, não mira, não compra e não pode ser alvo até sair do ovo', () => {
    const { room, me, bots, tick, lastSnap, toasts, advanceTo } = setup({ hatched: false });
    const start = { x: me.x, y: me.y };
    tick();
    const s = lastSnap();
    expect(s.me!.hatchMs).toBeGreaterThan(0);
    expect(s.me!.hatchMs).toBeLessThanOrEqual(BALANCE.respawn.hatchMs);
    expect(s.ents.find((e) => e.id === me.id)?.hx).toBe(1);
    expect(s.me!.look.stage).toBe(0);
    expect(s.me!.mhp).toBe(maxHp(0));

    // Pedido de movimento fica guardado para depois da eclosão.
    room.commandMove(me, me.x + 3, me.y);
    tick();
    expect({ x: me.x, y: me.y }).toEqual(start);
    expect(me.pendingDest).not.toBeNull();
    const wild = [...room.wilds.values()][0];
    expect(room.setTarget(me, wild.id)).toBe(false);
    me.essence = 99;
    expect(room.buy(me, 'g_couro')).toBe('busy');
    expect(toasts().at(-1)).toMatch(/sair do ovo/);
    // Ninguém mira em quem está chocando (nem na Caçada).
    advanceTo(MODES.rapido.phases.coletaEnd + 100);
    bots[0].hatchUntil = 0;
    expect(room.setTarget(bots[0], me.id)).toBe(false);

    for (let i = 0; i < 30 && room.isHatching(me); i++) tick();
    expect(room.isHatching(me)).toBe(false);
    tick();
    tick();
    expect(me.x !== start.x || me.y !== start.y).toBe(true);
    expect(lastSnap().ents.find((e) => e.id === me.id)?.hx).toBeUndefined();
    expect(lastSnap().me!.hatchMs).toBe(0);
    expect(room.buy(me, 'g_couro')).toBeNull();
  });
});

// ------------------------------------------------------------------ loja

describe('loja', () => {
  it('compra: tira a Essência, guarda a habilidade, sobe o HP máximo mantendo a fração, emite k e avisa', () => {
    const { room, me, set, tick, lastSnap, ofKind, toasts } = setup();
    set(me, 2);
    me.hp = room.maxHpOf(me) / 2;
    me.essence = 20;
    expect(room.buy(me, 'g_couro')).toBeNull();
    expect(me.essence).toBe(20 - SKILLS.g_couro.cost);
    expect(me.skills).toEqual(['g_couro']);
    expect(room.maxHpOf(me)).toBe(Math.round(BALANCE.hp[2] * modsOf(['g_couro']).hpMult));
    expect(me.hp / room.maxHpOf(me)).toBeCloseTo(0.5);
    expect(me.stats.buys).toBe(1);
    expect(toasts().at(-1)).toContain('Couro Grosso');
    expect(me.history.at(-1)?.ev).toContain('Couro Grosso');
    tick();
    expect(ofKind('k')).toEqual([{ k: 'k', x: me.x, y: me.y, id: me.id, s: 'g_couro' }]);
    const s = lastSnap().me!;
    expect(s.skills).toEqual(['g_couro']);
    expect(s.essence).toBe(me.essence);
    expect(s.mhp).toBe(room.maxHpOf(me));
    expect(s.power).toBe(room.powerOf(me));
  });

  it('título novo vem no aviso e no snapshot (ln/tl)', () => {
    const { room, me, tick, lastSnap, toasts } = setup();
    me.essence = 99;
    room.buy(me, 'm_foco');
    room.buy(me, 'm_canal');
    expect(toasts().at(-1)).toContain('Aprendiz de Mago');
    tick();
    expect(lastSnap().ents.find((e) => e.id === me.id)).toMatchObject({ ln: 'mago', tl: 1 });
    expect(lastSnap().lb.find((r) => r.id === me.id)).toMatchObject({ ln: 'mago', tl: 1 });
  });

  it('recusa com um motivo amigável: já tem, sem Essência, sem vaga, maestria, em batalha e fora da partida', () => {
    const { room, me, bots, toasts, pvp } = setup();
    me.essence = 5;
    expect(room.buy(me, 'g_couro')).toBe('essence');
    expect(toasts().at(-1)).toMatch(/Falta Essência.*9 ✨.*5/);
    me.essence = 999;
    room.buy(me, 'g_couro');
    expect(room.buy(me, 'g_couro')).toBe('owned');
    expect(toasts().at(-1)).toMatch(/já tem/);
    expect(room.buy(me, 'g_sede')).toBe('mastery');
    expect(toasts().at(-1)).toMatch(/maestria.*Clássico e Avançado/);
    room.buy(me, 'g_pesado');
    room.buy(me, 'm_foco');
    room.buy(me, 'm_canal');
    expect(me.skills).toHaveLength(MODES.rapido.slots);
    expect(room.buy(me, 'c_passos')).toBe('slots');
    expect(toasts().at(-1)).toMatch(/até 4 habilidades/);
    expect(room.buy(me, 'nada' as SkillId)).toBe('unknown');
    const essence = me.essence;
    pvp(me, bots[0]);
    expect(room.buy(me, 'g_brutal')).toBe('busy');
    expect(toasts().at(-1)).toMatch(/batalha/);
    me.alive = false;
    me.battle = null;
    expect(room.buy(me, 'g_brutal')).toBe('busy');
    expect(me.essence).toBe(essence);
  });

  it('um Especial novo troca o antigo sem ocupar vaga', () => {
    const { room, me, toasts } = setup();
    me.essence = 999;
    for (const id of ['g_couro', 'g_pesado', 'g_brutal', 'm_foco'] as SkillId[]) room.buy(me, id);
    expect(room.buy(me, 'c_armadilha')).toBeNull();
    expect(me.skills).toEqual(['g_couro', 'g_pesado', 'm_foco', 'c_armadilha']);
    expect(toasts().at(-1)).toMatch(/trocou Golpe Brutal por .*Armadilha/);
  });

  it('a mensagem buy do cliente passa pelo Lobby', () => {
    const lobby = new Lobby({ isExempt: () => true });
    const msgs: ServerMsg[] = [];
    const conn: Conn = { send: (m) => msgs.push(m), key: 'k' };
    lobby.handle(conn, { t: 'hello', name: 'Loja', mode: 'create' }, 0);
    lobby.handle(conn, { t: 'startnow' }, 0);
    lobby.tick(100);
    const p = lobby.playerOf(conn)!;
    p.hatchUntil = 0;
    p.essence = 50;
    lobby.handle(conn, { t: 'buy', s: 'c_passos' }, 200);
    expect(p.skills).toEqual(['c_passos']);
  });
});

// ------------------------------------------------------------------ build no mundo

describe('build no mundo', () => {
  it('Passos Leves e Rastreador encurtam o passo no mapa', () => {
    const walk = (skills: SkillId[]) => {
      const { room, me, place, tick } = setup();
      me.skills = skills;
      me.mods = modsOf(skills);
      place(me, 0);
      const from = { x: me.x, y: me.y };
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: from.x + dx, y: from.y + dy })).find((v) => isWalkable(room.map, v.x, v.y))!;
      // Vai e volta entre dois tiles vizinhos: conta os passos dados em 2 s.
      me.path = Array.from({ length: 40 }, (_, i) => (i % 2 ? from : nb));
      const n = me.path.length;
      for (let i = 0; i < 20; i++) tick();
      return n - me.path.length;
    };
    const plain = walk([]);
    const fast = walk(['c_passos', 'c_faro']);
    expect(fast).toBeGreaterThan(plain);
  });

  it('comer selvagem dá Essência (Faro: +1 e cura maior) e XP (Rastro: +1)', () => {
    const eat = (skills: SkillId[]) => {
      const { room, me, place, set, tick, runBattle } = setup({ gm: 'classico' });
      tick();
      me.skills = skills;
      me.mods = modsOf(skills);
      set(me, 1);
      me.hp = room.maxHpOf(me) * 0.5;
      me.essence = 0;
      place(me, 0);
      const wild = [...room.wilds.values()][0];
      wild.x = me.x + 1;
      wild.y = me.y;
      wild.path = [];
      wild.wanderAt = Number.MAX_SAFE_INTEGER;
      room.startBattle(me, wild);
      wild.hp = 1;
      const bt = me.battle!;
      bt.autoAt.b = null;
      bt.choice.b = 'carga';
      room.act(me, 'ataque');
      const xp = me.xp;
      runBattle(me);
      return { essence: me.essence, xp: me.xp - xp, hpPct: me.hp / room.maxHpOf(me) };
    };
    const plain = eat([]);
    expect(plain.essence).toBe(BALANCE.essence.wild);
    expect(plain.xp).toBe(1);
    expect(plain.hpPct).toBeCloseTo(0.5 + BALANCE.healOnWildPct);
    const hunter = eat(['c_faro', 'c_rastro']);
    expect(hunter.essence).toBe(BALANCE.essence.wild + 1);
    expect(hunter.xp).toBe(2);
    expect(hunter.hpPct).toBeCloseTo(0.5 + BALANCE.healOnWildPct * 1.5);
  });

  it('no Avançado a Essência rende menos, mas a fração acumula entre os ganhos', () => {
    const { room, me, place, set, tick, runBattle } = setup({ gm: 'avancado' });
    tick();
    set(me, 1);
    me.essence = 0;
    const got: number[] = [];
    for (let i = 0; i < 3; i++) {
      place(me, 0);
      me.hp = room.maxHpOf(me);
      const wild = [...room.wilds.values()][0];
      wild.x = me.x + 1;
      wild.y = me.y;
      wild.path = [];
      wild.wanderAt = Number.MAX_SAFE_INTEGER;
      room.startBattle(me, wild);
      wild.hp = 1;
      const bt = me.battle!;
      bt.autoAt.b = null;
      bt.choice.b = 'carga';
      room.act(me, 'ataque');
      runBattle(me);
      got.push(me.essence);
    }
    // 2 por selvagem × 0,45 = 0,9 → 0 · 1,8 → 1 · 2,7 → 2
    const mult = MODES.avancado.essenceMult;
    expect(got).toEqual([1, 2, 3].map((n) => Math.floor(n * BALANCE.essence.wild * mult + 1e-9)));
    expect(me.stats.earned).toBe(got[2]);
  });
});

// ------------------------------------------------------------------ build na batalha

describe('build na batalha', () => {
  it('b_start leva a build; o Especial vence, é revelado, gasta o uso e vira Defesa depois', () => {
    const { me, bots, ofType, tick, lastSnap, choose, ofKind, pvp } = setup();
    const foe = bots[0];
    me.skills = ['g_brutal'];
    me.mods = modsOf(me.skills);
    foe.skills = ['c_esquiva'];
    foe.mods = modsOf(foe.skills);
    const bt = pvp(me, foe);
    const start = ofType('b_start').at(-1)!;
    expect(start.you).toMatchObject({ skills: ['g_brutal'], special: 'brutal', specialLeft: 1 });
    expect(start.opp).toMatchObject({ skills: ['c_esquiva'], special: null, specialLeft: 0 });

    // Turno 1: Golpe Brutal contra Ataque. A Esquiva do oponente zera o primeiro turno perdido.
    choose(me, 'especial', foe, 'ataque');
    tick();
    let rv = ofType('b_reveal').at(-1)!;
    expect(rv).toMatchObject({ you: 'especial', moveYou: 'brutal', moveOpp: 'ataque', winner: 'you', dmgOpp: 0, dodgeOpp: true, spLeftYou: 0, spLeftOpp: 0 });
    expect(bt.specialLeft.a).toBe(0);
    expect(bt.dodgeUsed.b).toBe(true);
    expect(ofKind('h')).toHaveLength(0);

    // Turno 2: sem uso, 'especial' vira Defesa (e vence o Ataque); agora sem Esquiva o golpe entra.
    for (let i = 0; i < 30 && bt.phase !== 'choose'; i++) tick();
    choose(me, 'especial', foe, 'ataque');
    tick();
    rv = ofType('b_reveal').at(-1)!;
    expect(rv).toMatchObject({ you: 'defesa', moveYou: 'defesa', winner: 'you', dodgeOpp: false });
    expect(rv.dmgOpp).toBeGreaterThan(0);
    const h = (lastSnap().fx ?? []).find((e): e is Ev<'h'> => e.k === 'h')!;
    expect(h).toMatchObject({ a: me.id, d: foe.id, act: 'defesa' });
    expect(h.sp).toBeUndefined();
  });

  it('FxEvent h leva sp quando o golpe é Especial (dano ×1,6 do Golpe Brutal)', () => {
    const { room, me, bots, tick, lastSnap, choose, pvp, set } = setup();
    const foe = bots[0];
    set(me, 1);
    set(foe, 1);
    me.skills = ['g_brutal'];
    me.mods = modsOf(me.skills);
    pvp(me, foe);
    choose(me, 'especial', foe, 'carga');
    tick();
    const h = (lastSnap().fx ?? []).find((e): e is Ev<'h'> => e.k === 'h')!;
    expect(h).toMatchObject({ a: me.id, d: foe.id, act: 'especial', sp: 'brutal', v: Math.round(BALANCE.dmg[1] * 1.6) });
  });

  it('Arquimago começa Carregado; Escudo Arcano corta o 1º golpe; Sede de Batalha cura até o máximo', () => {
    const { room, me, bots, tick, ofType, choose, pvp, set } = setup({ gm: 'classico' });
    const foe = bots[0];
    set(me, 2);
    set(foe, 2);
    me.skills = ['m_foco', 'm_canal', 'm_escudo', 'm_arcana'];
    me.mods = modsOf(me.skills);
    foe.skills = ['g_sede'];
    foe.mods = modsOf(foe.skills);
    const bt = pvp(me, foe);
    expect(bt.charged.a).toBe(true);
    expect(ofType('b_start').at(-1)!.you.charged).toBe(true);
    foe.hp = room.maxHpOf(foe) - 3;
    // O oponente vence com Ataque contra Carga: o escudo absorve metade e a Sede cura só até o máximo.
    choose(me, 'carga', foe, 'ataque');
    tick();
    const rv = ofType('b_reveal').at(-1)!;
    expect(rv).toMatchObject({ winner: 'opp', shieldYou: true, healOpp: 3 });
    expect(foe.hp).toBe(room.maxHpOf(foe));
    expect(bt.shieldUsed.a).toBe(true);
  });

  it('o Duelo Final transmite a revelação completa para quem assiste', () => {
    const { room, members, bots, tick, advanceTo, set, ofType } = setup({ humans: 2 });
    set(bots[0], 3);
    set(bots[1], 3);
    bots[0].skills = ['m_arcana'];
    bots[0].mods = modsOf(bots[0].skills);
    advanceTo(MODES.rapido.phases.finalEnd);
    tick();
    expect(room.duel?.a).toBe(bots[0]);
    room.act(bots[0], 'especial');
    room.act(bots[1], 'defesa');
    tick();
    for (const i of [0, 1]) {
      const rv = ofType('b_reveal', i).at(-1)!;
      expect(rv).toMatchObject({ moveYou: 'arcana', moveOpp: 'defesa', spLeftYou: 0, winner: 'you' });
    }
    void members;
  });
});

// ------------------------------------------------------------------ morte e renascimento

describe('morte e renascimento', () => {
  it('perder sendo bebê: morre, perde parte do que juntou, mantém build e troféus e renasce chocando', () => {
    const { room, me, bots, tick, ofType, choose, pvp, set, runBattle, toasts } = setup();
    const foe = bots[0];
    set(foe, 2);
    set(me, 0);
    me.essence = 11;
    me.points = { brasa: 5, mare: 3, broto: 0 };
    me.xp = 2;
    me.trophies = 1;
    me.skills = ['c_passos'];
    me.mods = modsOf(me.skills);
    foe.essence = 0;
    pvp(foe, me);
    me.hp = 1;
    choose(foe, 'ataque', me, 'carga');
    runBattle(me);
    expect(me.alive).toBe(true);
    expect(ofType('elim')).toHaveLength(0);
    const death = ofType('death').at(-1)!;
    expect(death).toEqual({ t: 'death', by: foe.name, reason: 'batalha', respawnMs: BALANCE.respawn.hatchMs, lost: { essence: 5, points: 3 } });
    expect(me.essence).toBe(6);
    expect(me.points).toEqual({ brasa: 3, mare: 2, broto: 0 });
    expect(me.xp).toBe(0);
    expect(me.stage).toBe(0);
    expect(me.hp).toBe(room.maxHpOf(me));
    expect(me.skills).toEqual(['c_passos']);
    expect(me.trophies).toBe(1);
    expect(me.stats.deaths).toBe(1);
    expect(room.isHatching(me)).toBe(true);
    expect(room.inZone(me)).toBe(true);
    // O vencedor ganha a vitória e o bônus por mandar alguém de volta ao ovo.
    expect(foe.essence).toBe(BALANCE.essence.pvpWin + BALANCE.essence.kill);
    tick();
    const s = ofType('snap').at(-1)!;
    expect(s.me).toMatchObject({ alive: true, deaths: 1 });
    expect(s.me!.hatchMs).toBeGreaterThan(0);
    expect(s.al).toBe(8);
    void toasts;
  });

  it('a zona mata o bebê sem tirar ninguém da partida; o Predador rouba Essência do perdedor', () => {
    const { room, me, bots, tick, advanceTo, ofType, choose, pvp, set, runBattle } = setup();
    advanceTo(MODES.rapido.phases.cacadaEnd + 1000);
    tick();
    set(me, 0);
    me.x = 0;
    me.y = 0;
    me.hp = 0.01;
    tick();
    expect(ofType('death').at(-1)).toMatchObject({ by: null, reason: 'zona' });
    expect(me.alive).toBe(true);
    expect(room.alivePlayers()).toHaveLength(8);

    // Predador (4 do Caçador) rouba Essência de quem perde.
    const hunter = bots[1];
    const prey = bots[2];
    hunter.skills = ['c_passos', 'c_faro', 'c_esquiva', 'c_armadilha'];
    hunter.mods = modsOf(hunter.skills);
    set(hunter, 3);
    set(prey, 2);
    prey.essence = 10;
    hunter.essence = 0;
    pvp(hunter, prey);
    prey.hp = 1;
    choose(hunter, 'ataque', prey, 'carga');
    runBattle(prey);
    expect(prey.essence).toBe(10 - hunter.mods.stealEssence);
    expect(hunter.essence).toBe(BALANCE.essence.pvpWin + hunter.mods.stealEssence);
  });

  it('teto de troféus vem do modo', () => {
    for (const gm of ['rapido', 'classico'] as const) {
      const { me, bots, choose, pvp, set, runBattle } = setup({ gm });
      set(me, 3);
      me.trophies = MODES[gm].trophyMax;
      const foe = bots[0];
      set(foe, 1);
      pvp(me, foe);
      foe.hp = 1;
      choose(me, 'ataque', foe, 'carga');
      runBattle(me);
      expect(me.trophies).toBe(MODES[gm].trophyMax);
    }
  });
});

// ------------------------------------------------------------------ Força, placar e ranking

describe('Força e placar', () => {
  it('o placar vem ordenado pela Força, com pw, e a Coroa fica com a maior Força', () => {
    const { me, bots, tick, lastSnap, set } = setup();
    set(bots[0], 3);
    bots[1].skills = ['g_couro', 'g_pesado', 'g_contra', 'g_brutal'];
    bots[1].mods = modsOf(bots[1].skills);
    set(bots[1], 2);
    tick();
    const lb = lastSnap().lb;
    expect(lb.map((r) => r.pw)).toEqual([...lb.map((r) => r.pw)].sort((a, b) => b - a));
    expect(lb[0].id).toBe(bots[0].id);
    expect(lb[0].cr).toBe(1);
    expect(lb.find((r) => r.id === bots[1].id)).toMatchObject({ ln: 'guerreiro', tl: 2 });
    expect(lastSnap().me!.power).toBe(lb.find((r) => r.id === me.id)!.pw);
  });
});

// ------------------------------------------------------------------ bots

describe('bots', () => {
  it('querem a linha preferida em ordem, depois a segunda linha, sem trocar o próprio Especial', () => {
    const { room, bots } = setup({ gm: 'avancado' });
    const b = bots[0];
    const brain = { line: 'mago' as const, second: 'cacador' as const };
    const order: SkillId[] = [];
    for (let i = 0; i < MODES.avancado.slots; i++) {
      const w = botWish(b, brain, room)!;
      order.push(w);
      b.skills = [...b.skills, w];
    }
    expect(order).toEqual(['m_foco', 'm_canal', 'm_escudo', 'm_arcana', 'm_tempestade', 'c_passos', 'c_faro', 'c_esquiva']);
    expect(botWish(b, brain, room)).toBeNull();
  });

  it('compram assim que têm Essência e continuam jogando', () => {
    const { room, bots, tick } = setup();
    const b = bots[0];
    b.bot = makeBrain(room.rng, 'guerreiro');
    b.essence = SKILLS.g_couro.cost + 1;
    for (let i = 0; i < 15; i++) tick();
    expect(b.skills).toEqual(['g_couro']);
    expect(b.essence).toBe(1);
    expect(b.bot).not.toBeNull();
  });

  it('usam o Especial às vezes (≈35% dos turnos com uso)', () => {
    const rng = new Rng(3);
    let sp = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (botChoose(rng, false, false, 1, true) === 'especial') sp++;
    expect(sp / n).toBeGreaterThan(BOT_SPECIAL_CHANCE - 0.05);
    expect(sp / n).toBeLessThan(BOT_SPECIAL_CHANCE + 0.05);
    for (let i = 0; i < 500; i++) expect(botChoose(rng, false, false, 1, false)).not.toBe('especial');
  });

  it('numa partida inteira os bots compram e o ranking final vem completo', () => {
    const { room, members, bots, tick } = setup({ hatched: false });
    for (const b of bots) b.bot = makeBrain(room.rng);
    for (let i = 0; i < 6000 && room.state === 'play'; i++) tick();
    expect(room.state).toBe('fim');
    expect(bots.reduce((n, b) => n + b.stats.buys, 0)).toBeGreaterThan(bots.length);
    const end = members[0].msgs.find((m): m is Msg<'end'> => m.t === 'end')!;
    expect(end.ranking).toHaveLength(8);
    expect(end.ranking.map((r) => r.place)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(end.ranking[0].duel).toBe(1);
    expect(end.ranking[1].duel).toBe(2);
    // Do 3º em diante: Força no início do duelo, sem subir.
    const rest = end.ranking.slice(2).map((r) => r.power);
    expect(rest).toEqual([...rest].sort((a, b) => b - a));
    expect(end.you).toMatchObject({ name: 'H0' });
    expect(typeof end.you.power).toBe('number');
    expect(end.ranking.filter((r) => r.you)).toHaveLength(1);
  });
});
