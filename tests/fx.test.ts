import { describe, expect, it } from 'vitest';
import {
  BALANCE,
  FX_CHARGED,
  FX_CLASH,
  FX_KO,
  FX_MAX_PER_TICK,
  maxHp,
  nearestWalkable,
  resolveTurn,
  type Action,
  type FxEvent,
  type ServerMsg,
  type Snap,
  type Stage,
} from '@vb/shared';
import type { Player } from '../server/src/entities';
import { Room, type Member } from '../server/src/room';

type Ev<K extends FxEvent['k']> = Extract<FxEvent, { k: K }>;

/** Acesso aos internos da fila só para os testes. */
type RoomFx = { fxq: FxEvent[]; fx(ev: FxEvent): void; sendSnapshots(): void; combatant(e: Player, charged: boolean): Parameters<typeof resolveTurn>[0] };
const internals = (room: Room) => room as unknown as RoomFx;

/** Sala com humanos e bots parados (sem cérebro), para os eventos saírem só do que o teste provoca. */
function setup(humans = 1, total = 8) {
  const room = new Room('FXFX', true, 7);
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
  const c = nearestWalkable(room.map, room.zone.x, room.zone.y);
  const place = (p: Player, dx: number, dy = 0) => {
    p.x = c.x + dx;
    p.y = c.y + dy;
    p.path = [];
  };
  const set = (p: Player, stage: Stage) => {
    p.stage = stage;
    p.hp = maxHp(stage);
  };
  const tick = (ms = BALANCE.tickMs) => room.tick((now += ms));
  const advanceTo = (el: number) => (room.startedAt = now - el);
  const snaps = (i = 0) => members[i].msgs.filter((m): m is Snap => m.t === 'snap');
  const lastSnap = (i = 0) => snaps(i).at(-1)!;
  /** Todos os eventos recebidos por um membro, na ordem. */
  const allFx = (i = 0) => snaps(i).flatMap((s) => s.fx ?? []);
  const ofKind = <K extends FxEvent['k']>(k: K, i = 0) => allFx(i).filter((e): e is Ev<K> => e.k === k);
  /** Roda os ticks até a batalha acabar (ou o limite). */
  const runBattle = (p: Player, max = 200) => {
    for (let i = 0; i < max && p.battle && room.state === 'play'; i++) tick();
  };
  /** Força as duas escolhas do turno atual. */
  const choose = (a: Player, ca: Action, b: Player, cb: Action) => {
    room.act(a, ca);
    room.act(b, cb);
  };
  return { room, members, me, bots, c, place, set, tick, advanceTo, snaps, lastSnap, allFx, ofKind, runBattle, choose, now: () => now };
}

describe('eventos visuais (Snap.fx)', () => {
  it('snapshot sem eventos não tem a chave fx, e o povoamento inicial não gera eventos', () => {
    const { room, tick, lastSnap, snaps } = setup();
    expect(internals(room).fxq).toHaveLength(0);
    for (let i = 0; i < 5; i++) tick();
    const s = lastSnap();
    expect('fx' in s).toBe(false);
    expect(JSON.stringify(s)).not.toContain('"fx"');
    expect(snaps().every((x) => !('fx' in x))).toBe(true);
  });

  it('turno PvP gera um h coerente com o b_reveal, que não reaparece no tick seguinte', () => {
    const { room, members, me, bots, place, set, tick, advanceTo, lastSnap, choose } = setup();
    advanceTo(BALANCE.phases.coletaEnd + 1000);
    tick();
    const foe = bots[0];
    set(me, 1);
    set(foe, 1);
    place(me, 0);
    place(foe, 1);
    // A batalha começa dentro do tick (desafio a 1 tile) e vira um 'bt' com kd 'p'.
    room.setTarget(me, foe.id);
    tick();
    const bt = me.battle!;
    expect(bt.b).toBe(foe);
    const start = (lastSnap().fx ?? []).find((e): e is Ev<'bt'> => e.k === 'bt');
    expect(start).toMatchObject({ id: bt.id, a: me.id, b: foe.id, kd: 'p', x: bt.cx, y: bt.cy });

    choose(me, 'ataque', foe, 'carga');
    const before = members[0].msgs.length;
    tick();
    const reveal = members[0].msgs.slice(before).find((m) => m.t === 'b_reveal');
    expect(reveal?.t).toBe('b_reveal');
    if (reveal?.t !== 'b_reveal') return;
    const hits = (lastSnap().fx ?? []).filter((e): e is Ev<'h'> => e.k === 'h');
    expect(hits).toHaveLength(1);
    const h = hits[0];
    expect(h).toMatchObject({ bt: bt.id, a: me.id, d: foe.id, act: 'ataque', v: reveal.dmgOpp, hp: reveal.hpOpp, x: bt.cx, y: bt.cy, m: 0 });
    expect(h.fl & FX_CLASH).toBe(0);
    tick();
    expect((lastSnap().fx ?? []).some((e) => e.k === 'h')).toBe(false);
  });

  it('Ataque×Ataque gera dois h com FX_CLASH; carregado gera FX_CHARGED; alvo zerado gera FX_KO; tipo vira m', () => {
    const { room, me, bots, place, set, tick, advanceTo, lastSnap, choose } = setup();
    advanceTo(BALANCE.phases.coletaEnd + 1000);
    tick();
    const foe = bots[0];
    set(me, 2);
    set(foe, 2);
    me.points = { brasa: 9, mare: 0, broto: 0 }; // Brasa > Broto
    foe.points = { brasa: 0, mare: 0, broto: 9 };
    place(me, 0);
    place(foe, 1);
    room.startBattle(me, foe);
    const bt = me.battle!;
    bt.charged.a = true;
    foe.hp = 1;
    choose(me, 'ataque', foe, 'ataque');
    tick();
    const hits = (lastSnap().fx ?? []).filter((e): e is Ev<'h'> => e.k === 'h');
    expect(hits).toHaveLength(2);
    const [mine, theirs] = hits;
    expect(mine).toMatchObject({ a: me.id, d: foe.id, hp: 0, m: 1 });
    expect(mine.fl).toBe(FX_CHARGED | FX_CLASH | FX_KO);
    expect(theirs).toMatchObject({ a: foe.id, d: me.id, m: -1 });
    expect(theirs.fl).toBe(FX_CLASH);
    expect(theirs.hp).toBe(Math.round(me.hp));
  });

  it('quem vê a mais de R+1 tiles do centro da batalha não recebe o h', () => {
    const { room, members, me, bots, place, set, tick, advanceTo, allFx, choose } = setup(2);
    advanceTo(BALANCE.phases.coletaEnd + 1000);
    tick();
    const far = members[1].m.player!;
    const foe = bots[0];
    set(me, 1);
    set(foe, 1);
    place(me, -10);
    place(foe, -9);
    const R = BALANCE.viewRadius;
    place(far, -9 + R + 2);
    room.startBattle(me, foe);
    choose(me, 'ataque', foe, 'carga');
    tick();
    tick();
    expect(allFx(0).some((e) => e.k === 'h')).toBe(true);
    expect(allFx(1).some((e) => e.k === 'h' || e.k === 'bt')).toBe(false);
  });

  it('roubo: n 1 na Caçada, n 2 na fase final e tr 1 com o vencedor na forma final', () => {
    const cases: { el: number; win: Stage; lose: Stage; n: 1 | 2; tr: boolean }[] = [
      { el: BALANCE.phases.coletaEnd + 1000, win: 1, lose: 2, n: 1, tr: false },
      { el: BALANCE.phases.cacadaEnd + 1000, win: 1, lose: 3, n: 2, tr: false },
      { el: BALANCE.phases.coletaEnd + 1000, win: 3, lose: 1, n: 1, tr: true },
    ];
    for (const k of cases) {
      const { room, me, bots, place, set, tick, advanceTo, ofKind, runBattle, choose } = setup();
      advanceTo(k.el);
      tick();
      const foe = bots[0];
      set(me, k.win);
      set(foe, k.lose);
      place(me, 0);
      place(foe, 1);
      room.startBattle(me, foe);
      foe.hp = 1;
      choose(me, 'ataque', foe, 'carga');
      runBattle(me);
      const st = ofKind('s');
      expect(st).toHaveLength(1);
      expect(st[0]).toMatchObject({ w: me.id, l: foe.id, n: k.n, x: me.x, y: me.y });
      expect(st[0].tr === 1).toBe(k.tr);
      expect(foe.stage).toBe(k.lose - k.n);
      expect(ofKind('x')).toHaveLength(0);
    }
  });

  it('vencer um ovo gera x com r b e o visual do eliminado, que recebe o próprio x mesmo com a câmera longe', () => {
    const { room, me, bots, place, set, tick, advanceTo, ofKind, runBattle, choose, lastSnap } = setup();
    advanceTo(BALANCE.phases.coletaEnd + 1000);
    tick();
    const foe = bots[0];
    set(me, 0);
    set(foe, 2);
    me.points = { brasa: 1, mare: 0, broto: 0 };
    const R = BALANCE.viewRadius;
    place(me, -R + 2);
    place(foe, R - 2); // a câmera vai para o vencedor, a mais de R+1 tiles do eliminado
    const look = room.look(me);
    room.startBattle(foe, me);
    me.hp = 1;
    choose(foe, 'ataque', me, 'carga');
    runBattle(me);
    expect(me.alive).toBe(false);
    expect(lastSnap().view).toBe(foe.id);
    const xs = ofKind('x');
    expect(xs).toHaveLength(1);
    expect(xs[0]).toEqual({ k: 'x', x: me.x, y: me.y, id: me.id, f: look.form, s: look.stage, o: look.order, by: foe.id, r: 'b' });
    expect(Math.abs(xs[0].x - foe.x)).toBeGreaterThan(R + 1);
    expect(ofKind('s')).toHaveLength(0);
  });

  it('comer um selvagem gera c antes do v quando o XP evolui (com x2 na Fome)', () => {
    const { room, me, place, set, tick, ofKind, allFx, runBattle } = setup();
    tick();
    set(me, 0);
    place(me, 0);
    me.xp = BALANCE.xpToEvolve[0] - 2;
    me.hungerUntil = Number.MAX_SAFE_INTEGER;
    const wild = [...room.wilds.values()][0];
    wild.x = me.x + 1;
    wild.y = me.y;
    wild.path = [];
    wild.wanderAt = Number.MAX_SAFE_INTEGER;
    room.setTarget(me, wild.id);
    tick();
    const bt = me.battle!;
    expect(ofKind('bt').at(-1)).toMatchObject({ kd: 'w', a: me.id, b: wild.id, id: bt.id });
    wild.hp = 1;
    bt.autoAt.b = null;
    bt.choice.b = 'carga';
    room.act(me, 'ataque');
    tick();
    const h = ofKind('h').at(-1)!;
    expect(h).toMatchObject({ a: me.id, d: wild.id, hp: 0 });
    expect(h.fl & FX_KO).toBe(FX_KO);
    runBattle(me);
    const evs = allFx();
    const ci = evs.findIndex((e) => e.k === 'c');
    const vi = evs.findIndex((e) => e.k === 'v');
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(vi).toBeGreaterThan(ci);
    expect(evs[ci]).toEqual({ k: 'c', x: wild.x, y: wild.y, p: me.id, w: wild.id, e: wild.elem, x2: 1 });
    expect(evs[vi]).toMatchObject({ id: me.id, s: 1 });
    expect(me.stage).toBe(1);
  });

  it('a zona queimando um estágio gera z; sem estágio, x com r z', () => {
    const { me, set, tick, advanceTo, ofKind } = setup();
    advanceTo(BALANCE.phases.cacadaEnd + 1000);
    tick();
    set(me, 1);
    me.x = 0;
    me.y = 0; // canto do mapa, fora da zona
    me.hp = 0.01;
    tick();
    expect(ofKind('z')).toEqual([{ k: 'z', x: 0, y: 0, id: me.id, s: 0 }]);
    me.hp = 0.01;
    me.shieldUntil = 0;
    tick();
    expect(ofKind('x')).toMatchObject([{ id: me.id, r: 'z', by: 0, s: 0 }]);
  });

  it('selvagem que surge durante a partida gera w', () => {
    const { room, me, place, tick, ofKind } = setup();
    place(me, 0);
    tick();
    room.wilds.clear();
    for (let i = 0; i < 40; i++) tick();
    const ws = ofKind('w');
    expect(ws.length).toBeGreaterThan(0);
    for (const w of ws) {
      const real = room.wilds.get(w.id);
      if (real) expect(w.e).toBe(real.elem);
    }
  });

  it('Duelo Final: bt com kd f depois dos x com r d, o cortado recebe o próprio x, e a fúria gera fu', () => {
    const { room, me, bots, set, tick, advanceTo, lastSnap, ofKind } = setup();
    set(me, 0);
    bots.forEach((b, i) => set(b, (i < 2 ? 3 : i < 4 ? 2 : 1) as Stage));
    advanceTo(BALANCE.phases.finalEnd);
    tick();
    expect(room.phase).toBe('duelo');
    const fx = lastSnap().fx ?? [];
    const mine = fx.find((e): e is Ev<'x'> => e.k === 'x' && e.id === me.id);
    expect(mine).toMatchObject({ r: 'd', by: 0, s: 0 });
    const bt = fx.find((e): e is Ev<'bt'> => e.k === 'bt');
    expect(bt).toMatchObject({ kd: 'f', a: room.duel!.a.id, b: room.duel!.b.id });
    expect(fx.findIndex((e) => e.k === 'bt')).toBeGreaterThan(fx.findIndex((e) => e.k === 'x'));
    expect(fx.filter((e) => e.k === 'x').every((e) => e.k === 'x' && e.r === 'd')).toBe(true);

    // Ninguém escolhe: Defesa × Defesa, sem 'h', até a fúria da arena.
    const { a, b } = room.duel!;
    for (let i = 0; i < 5000 && room.state === 'play' && ofKind('fu').length === 0; i++) tick();
    const fu = ofKind('fu')[0];
    expect(fu).toMatchObject({ a: a.id, b: b.id, va: Math.round(BALANCE.duel.furyPct * maxHp(a.stage)), vb: Math.round(BALANCE.duel.furyPct * maxHp(b.stage)) });
  });

  it('HP fracionário entre 0 e 0,5 aparece como 1: hp 0 no h e no b_reveal só com FX_KO', () => {
    const { room, members, me, bots, place, set, tick, advanceTo, lastSnap, choose } = setup();
    advanceTo(BALANCE.phases.coletaEnd + 1000);
    tick();
    const foe = bots[0];
    set(me, 1);
    set(foe, 1);
    place(me, 0);
    place(foe, 1);
    room.startBattle(me, foe);
    const q = internals(room);
    const dmg = resolveTurn(q.combatant(me, false), q.combatant(foe, false), 'ataque', 'carga').dmgToB;
    foe.hp = dmg + 0.3; // sobra 0,3 de HP (regeneração/zona deixam o HP fracionário)
    choose(me, 'ataque', foe, 'carga');
    const before = members[0].msgs.length;
    tick();
    expect(foe.hp).toBeCloseTo(0.3);
    const h = (lastSnap().fx ?? []).find((e): e is Ev<'h'> => e.k === 'h')!;
    expect(h).toMatchObject({ d: foe.id, v: dmg, hp: 1 });
    expect(h.fl & FX_KO).toBe(0);
    const reveal = members[0].msgs.slice(before).find((m) => m.t === 'b_reveal');
    expect(reveal).toMatchObject({ hpOpp: 1 });
    expect(lastSnap().ents.find((e) => e.id === foe.id)?.hp).toBe(1);
  });

  it('KO só pela fúria (Defesa×Defesa): fu sem h, e o EntSnap do mesmo snapshot traz hp 0', () => {
    const { room, bots, set, tick, advanceTo, lastSnap, ofKind, choose } = setup();
    bots.forEach((b, i) => set(b, (i < 2 ? 3 : 1) as Stage));
    advanceTo(BALANCE.phases.finalEnd);
    tick();
    const { a, b } = room.duel!;
    const bt = a.battle!;
    const va = Math.round(BALANCE.duel.furyPct * maxHp(a.stage));
    const furyTurn = () => {
      for (let i = 0; i < 5000 && !(bt.turn >= BALANCE.duel.furyFromTurn && bt.phase === 'choose'); i++) tick();
      choose(a, 'defesa', b, 'defesa');
      const n = ofKind('fu').length;
      tick();
      expect(ofKind('fu')).toHaveLength(n + 1);
      const s = lastSnap();
      expect((s.fx ?? []).some((e) => e.k === 'h')).toBe(false);
      return s.ents.find((e) => e.id === a.id)!;
    };
    // Primeiro turno de fúria: sobra 0,3 de HP, o duelista segue vivo e aparece com 1.
    a.hp = va + 0.3;
    b.hp = maxHp(b.stage);
    expect(furyTurn().hp).toBe(1);
    expect(a.battle).toBe(bt);
    // Próximo turno: a fúria nocauteia; o único sinal no snapshot é o hp 0 do EntSnap junto do fu.
    a.hp = va;
    expect(furyTurn().hp).toBe(0);
    expect(a.hp).toBeLessThanOrEqual(0);
  });

  it('a fila respeita FX_MAX_PER_TICK e nenhum snapshot de uma partida inteira passa do teto', () => {
    const { room, me, bots, tick, lastSnap, snaps } = setup(1, 16);
    tick();
    const q = internals(room);
    for (let i = 0; i < FX_MAX_PER_TICK + 20; i++) q.fx({ k: 'w', x: me.x, y: me.y, id: 90_000 + i, e: 'brasa' });
    q.sendSnapshots();
    expect(lastSnap().fx).toHaveLength(FX_MAX_PER_TICK);
    expect(q.fxq).toHaveLength(0);

    // Partida inteira com os bots jogando.
    for (const b of bots) b.bot = { pref: 'brasa', nextThinkAt: 0, aggro: 0.8 };
    me.bot = { pref: 'mare', nextThinkAt: 0, aggro: 0.8 };
    for (let i = 0; i < 5000 && room.state === 'play'; i++) tick();
    expect(room.state).toBe('fim');
    const withFx = snaps().filter((s) => s.fx);
    expect(withFx.length).toBeGreaterThan(0);
    for (const s of withFx) {
      expect(s.fx!.length).toBeGreaterThan(0);
      expect(s.fx!.length).toBeLessThanOrEqual(FX_MAX_PER_TICK);
    }
  });
});
