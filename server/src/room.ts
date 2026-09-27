import {
  BALANCE,
  ELEMS,
  MAX_STAGE,
  Rng,
  applyXp,
  biomeAt,
  chebyshev,
  encodeTiles,
  findPath,
  generateMap,
  isWalkable,
  lookOf,
  maxHp,
  nearestWalkable,
  randomSeed,
  resolveTurn,
  speciesName,
  type Action,
  type BattleSnap,
  type Combatant,
  type EntSnap,
  type FighterInfo,
  type GameMap,
  type LeaderRow,
  type Look,
  type Phase,
  type ServerMsg,
  type Stage,
  type Vec,
} from '@vb/shared';
import { botChoose, botThink, makeBrain, wildChoose } from './bots';
import type { Battle, Conn, Entity, Player, Side, Wild } from './entities';

const BOT_NAMES = [
  'Farofa', 'Paçoca', 'Cuscuz', 'Tapioca', 'Pitanga', 'Jambo', 'Caju', 'Pipoca', 'Mandioca', 'Jabuti',
  'Capivara', 'Sabiá', 'Brigadeiro', 'Quindim', 'Pamonha', 'Guaraná', 'Açaí', 'Cocada', 'Munguzá', 'Canjica',
];

export interface Member {
  conn: Conn;
  name: string;
  player: Player | null;
}

export type RoomState = 'lobby' | 'play' | 'fim';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);

export class Room {
  state: RoomState = 'lobby';
  readonly members = new Set<Member>();
  readonly players = new Map<number, Player>();
  readonly wilds = new Map<number, Wild>();
  readonly battles = new Map<number, Battle>();
  map!: GameMap;
  readonly rng: Rng;
  phase: Phase = 'coleta';
  zone = { x: 0, y: 0, r: 0, r0: 0, tr: 0 };
  fruitRespawnAt: number[] = [];
  crownId: number | null = null;
  startsAt: number | null = null;
  startedAt = 0;
  endedAt = 0;
  now = 0;
  totalPlayers = 0;
  /** Sala sem nenhum humano conectado durante a partida. */
  abandoned = false;

  private nextId = 1;
  private lastLobbyAt = 0;
  private nextWildAt = 0;
  private nextCrownPingAt = 0;
  private crownPingUntil = 0;
  private lastCrownFeedAt = -Infinity;

  constructor(
    readonly code: string,
    readonly isPrivate: boolean,
    readonly seed: number = randomSeed(),
  ) {
    this.rng = new Rng(seed ^ 0x5bd1e995);
  }

  get elapsed(): number {
    return this.now - this.startedAt;
  }

  get humans(): number {
    return this.members.size;
  }

  // ---------------------------------------------------------------- lobby

  join(member: Member, now: number): void {
    const taken = new Set([...this.members].map((m) => m.name));
    let name = member.name;
    for (let i = 2; taken.has(name); i++) name = `${member.name} ${i}`;
    member.name = name;
    this.members.add(member);
    if (this.startsAt === null) this.startsAt = now + BALANCE.lobby.waitMs;
    if (this.members.size >= BALANCE.lobby.maxPlayers) this.startsAt = now;
    this.lastLobbyAt = 0;
  }

  leave(member: Member): void {
    this.members.delete(member);
    const p = member.player;
    if (p && this.state === 'play') {
      p.conn = null;
      if (p.alive) p.bot = makeBrain(this.rng);
      if (this.members.size === 0) this.abandoned = true;
    }
    if (this.state === 'lobby' && this.members.size === 0) this.startsAt = null;
    this.lastLobbyAt = 0;
  }

  startNow(now: number): void {
    if (this.state === 'lobby') this.startsAt = now;
  }

  private broadcastLobby(now: number): void {
    const msg: ServerMsg = {
      t: 'lobby',
      code: this.code,
      private: this.isPrivate,
      players: [...this.members].map((m) => m.name),
      startsIn: this.startsAt === null ? null : Math.max(0, this.startsAt - now),
      min: BALANCE.lobby.minPlayers,
      max: BALANCE.lobby.maxPlayers,
    };
    for (const m of this.members) m.conn.send(msg);
  }

  /** Inicia a partida, completando com bots até o mínimo. */
  start(now: number, botsOnly = 0): void {
    const humans = [...this.members];
    const total = clamp(Math.max(BALANCE.lobby.minPlayers, humans.length, botsOnly), 1, BALANCE.lobby.maxPlayers);
    this.map = generateMap(this.seed, total);
    this.totalPlayers = total;
    this.state = 'play';
    this.now = now;
    this.startedAt = now;
    this.fruitRespawnAt = this.map.fruits.map(() => 0);
    const c = nearestWalkable(this.map, (this.map.w - 1) / 2, (this.map.h - 1) / 2);
    const r0 = Math.hypot(this.map.w, this.map.h) / 2 + 1;
    this.zone = { x: c.x, y: c.y, r: r0, r0, tr: r0 };
    this.nextCrownPingAt = now + BALANCE.phases.coletaEnd;

    const spawns = this.rng.shuffle([...this.map.spawns]);
    const botNames = this.rng.shuffle([...BOT_NAMES]);
    for (let i = 0; i < total; i++) {
      const human = humans[i];
      const p = this.createPlayer(human ? human.name : botNames[i % botNames.length], spawns[i], human?.conn ?? null);
      if (human) human.player = p;
      else p.bot = makeBrain(this.rng);
    }
    const tiles = encodeTiles(this.map.tiles);
    for (const m of humans) {
      m.conn.send({
        t: 'start',
        you: m.player!.id,
        w: this.map.w,
        h: this.map.h,
        tiles,
        fruits: this.map.fruits,
        players: total,
      });
    }
    this.feed('A Coleta começou! Coma bichos selvagens para evoluir.', 'phase');
    this.maintainWilds(now, true);
  }

  private createPlayer(name: string, at: Vec, conn: Conn | null): Player {
    const p: Player = {
      kind: 'player',
      id: this.nextId++,
      name,
      conn,
      bot: null,
      x: at.x,
      y: at.y,
      path: [],
      nextStepAt: 0,
      hp: maxHp(0),
      battle: null,
      stage: 0,
      xp: 0,
      points: { brasa: 0, mare: 0, broto: 0 },
      trophies: 0,
      alive: true,
      shieldUntil: 0,
      hungerUntil: 0,
      target: null,
      targetSeenAt: null,
      repathAt: 0,
      lastToastAt: 0,
      eliminatedBy: null,
      killerId: null,
      place: 0,
      history: [],
      stats: { wins: 0, steals: 0, wilds: 0 },
    };
    this.players.set(p.id, p);
    this.pushHistory(p, 'Nasceu');
    return p;
  }

  // ---------------------------------------------------------------- helpers

  look(e: Entity): Look {
    if (e.kind === 'wild') return { form: e.elem, stage: 1, order: [e.elem] };
    return lookOf(e.points, e.stage);
  }

  maxHpOf(e: Entity): number {
    return e.kind === 'wild' ? e.maxHp : maxHp(e.stage);
  }

  entity(id: number): Entity | undefined {
    return this.players.get(id) ?? this.wilds.get(id);
  }

  alivePlayers(): Player[] {
    return [...this.players.values()].filter((p) => p.alive);
  }

  inZone(v: Vec, margin = 0): boolean {
    // Estrito: com raio zero ninguém está dentro, nem no tile central.
    return Math.hypot(v.x - this.zone.x, v.y - this.zone.y) < this.zone.r - margin;
  }

  send(p: Player, msg: ServerMsg): void {
    p.conn?.send(msg);
  }

  toast(p: Player, text: string, force = false): void {
    if (!p.conn) return;
    if (!force && this.now - p.lastToastAt < 1500) return;
    p.lastToastAt = this.now;
    p.conn.send({ t: 'toast', text });
  }

  feed(text: string, kind: 'steal' | 'elim' | 'evo' | 'info' | 'phase'): void {
    for (const m of this.members) m.conn.send({ t: 'feed', text, kind });
  }

  private pushHistory(p: Player, ev: string): void {
    p.history.push({ el: Math.max(0, this.elapsed), look: this.look(p), ev });
    if (p.history.length > 40) p.history.splice(1, 1);
  }

  /** Muda o estágio preservando a fração de HP. */
  private setStage(p: Player, stage: Stage, hpPct?: number): void {
    const pct = hpPct ?? p.hp / maxHp(p.stage);
    p.stage = stage;
    p.hp = Math.max(1, Math.round(pct * maxHp(stage)));
  }

  private gainXp(p: Player, amount: number): void {
    const before = p.stage;
    const pct = p.hp / maxHp(p.stage);
    const gained = applyXp(p, amount);
    if (gained > 0) {
      p.hp = Math.max(1, Math.round(pct * maxHp(p.stage)));
      const name = speciesName(this.look(p).form, p.stage);
      this.toast(p, `Você evoluiu para ${name}!`, true);
      this.pushHistory(p, 'Evoluiu');
      if (p.stage === MAX_STAGE && before < MAX_STAGE) this.feed(`${p.name} alcançou a forma final: ${name}!`, 'evo');
    }
  }

  // ---------------------------------------------------------------- comandos

  moveTo(p: Player, x: number, y: number): void {
    if (!p.alive || p.battle || this.state !== 'play') return;
    p.target = null;
    const dest = nearestWalkable(this.map, x, y);
    p.path = findPath(this.map, p, dest) ?? [];
  }

  setTarget(p: Player, id: number): void {
    if (!p.alive || p.battle || this.state !== 'play' || id === p.id) return;
    const t = this.entity(id);
    if (!t) return;
    if (t.kind === 'wild' && t.battle) {
      this.toast(p, 'Esse bicho já está batalhando com outro jogador.', true);
      return;
    }
    if (t.kind === 'player') {
      if (!t.alive) return;
      if (this.phase === 'coleta') {
        this.toast(p, 'Batalhas entre jogadores só começam na Caçada (2:00).', true);
        return;
      }
    }
    p.target = id;
    p.targetSeenAt = null;
    p.repathAt = 0;
  }

  act(p: Player, a: Action): void {
    const bt = p.battle;
    if (!bt || bt.phase !== 'choose') return;
    const side: Side = bt.a === p ? 'a' : 'b';
    if (bt.choice[side] === null) bt.choice[side] = a;
  }

  // ---------------------------------------------------------------- loop

  tick(now: number): void {
    const dt = this.now ? Math.min(1000, now - this.now) : BALANCE.tickMs;
    this.now = now;
    if (this.state === 'lobby') {
      if (this.startsAt !== null && now >= this.startsAt && this.members.size > 0) this.start(now);
      else if (now - this.lastLobbyAt >= 1000) {
        this.lastLobbyAt = now;
        this.broadcastLobby(now);
      }
      return;
    }
    if (this.state !== 'play') return;

    this.updatePhase();
    for (const p of this.players.values()) {
      if (p.alive && p.bot && !p.battle && now >= p.bot.nextThinkAt) botThink(this, p, now);
    }
    this.updateTargets(now);
    this.moveEntities(now);
    this.updateBattles(now);
    this.applyZone(dt);
    this.maintainWilds(now, false);
    this.updateCrown(now);
    this.checkEnd();
    if (this.state === 'play') this.sendSnapshots();
  }

  private updatePhase(): void {
    const el = this.elapsed;
    const P = BALANCE.phases;
    const Z = BALANCE.zone;
    const r0 = this.zone.r0;
    let phase: Phase;
    if (el < P.coletaEnd) {
      phase = 'coleta';
      this.zone.r = r0;
      this.zone.tr = r0 * Z.cacadaFrac;
    } else if (el < P.cacadaEnd) {
      phase = 'cacada';
      this.zone.r = lerp(r0, r0 * Z.cacadaFrac, (el - P.coletaEnd) / (P.cacadaEnd - P.coletaEnd));
      this.zone.tr = r0 * Z.cacadaFrac;
    } else if (el < P.finalEnd) {
      phase = 'final';
      this.zone.r = lerp(r0 * Z.cacadaFrac, Z.finalRadius, (el - P.cacadaEnd) / (P.finalEnd - P.cacadaEnd));
      this.zone.tr = Z.finalRadius;
    } else {
      phase = 'subita';
      this.zone.r = lerp(Z.finalRadius, 0, (el - P.finalEnd) / (P.suddenEnd - P.finalEnd));
      this.zone.tr = 0;
    }
    if (phase !== this.phase) {
      this.phase = phase;
      if (phase === 'cacada') this.feed('A Caçada começou! Agora dá para desafiar outros jogadores. A zona está fechando.', 'phase');
      if (phase === 'final') this.feed('Fase final! Os selvagens sumiram e cada derrota custa 2 estágios.', 'phase');
      if (phase === 'subita') this.feed('MORTE SÚBITA! A zona vai sumir: sobrevive quem aguentar mais.', 'phase');
    }
  }

  private updateTargets(now: number): void {
    for (const p of this.players.values()) {
      if (!p.alive || p.battle || p.target === null) continue;
      const t = this.entity(p.target);
      if (!t || (t.kind === 'player' && (!t.alive || this.phase === 'coleta'))) {
        p.target = null;
        continue;
      }
      if (chebyshev(p, t) <= BALANCE.engageRange) {
        p.path = [];
        this.tryEngage(p, t);
        continue;
      }
      const moved = !p.targetSeenAt || p.targetSeenAt.x !== t.x || p.targetSeenAt.y !== t.y;
      if (moved && now >= p.repathAt) {
        p.path = findPath(this.map, p, t) ?? [];
        p.targetSeenAt = { x: t.x, y: t.y };
        p.repathAt = now + 400;
        if (p.path.length === 0) p.target = null;
      }
    }
  }

  private tryEngage(p: Player, t: Entity): void {
    if (t.kind === 'wild' && t.battle) {
      this.toast(p, 'Esse bicho já está batalhando com outro jogador.', true);
      p.target = null;
      return;
    }
    if (t.battle) {
      this.toast(p, 'Esperando a batalha acabar... o vencedor vai sair enfraquecido.');
      return;
    }
    if (t.kind === 'player') {
      if (t.shieldUntil > this.now) {
        this.toast(p, `${t.name} está protegido por mais ${Math.ceil((t.shieldUntil - this.now) / 1000)}s.`);
        return;
      }
      p.shieldUntil = 0;
    }
    this.startBattle(p, t);
  }

  private moveEntities(now: number): void {
    const step = (e: Entity, ms: number) => {
      if (e.battle || e.path.length === 0) return;
      if (e.nextStepAt < now - ms) e.nextStepAt = now;
      if (now < e.nextStepAt) return;
      const next = e.path.shift()!;
      if (!isWalkable(this.map, next.x, next.y)) {
        e.path = [];
        return;
      }
      e.x = next.x;
      e.y = next.y;
      e.nextStepAt += ms;
      if (e.kind === 'player') this.checkFruit(e);
    };
    for (const p of this.players.values()) if (p.alive) step(p, BALANCE.stepMs);
    for (const w of this.wilds.values()) {
      if (!w.battle && w.path.length === 0 && now >= w.wanderAt) this.wander(w, now);
      step(w, BALANCE.wildStepMs);
    }
  }

  private checkFruit(p: Player): void {
    this.map.fruits.forEach((f, i) => {
      if (f.x !== p.x || f.y !== p.y || this.fruitRespawnAt[i] > this.now) return;
      this.fruitRespawnAt[i] = this.now + BALANCE.fruitRespawnMs;
      p.points[f.elem] += BALANCE.fruitPoints;
      this.toast(p, `Fruta rara! +${BALANCE.fruitPoints} de ${f.elem === 'brasa' ? 'Brasa' : f.elem === 'mare' ? 'Maré' : 'Broto'}.`, true);
      this.gainXp(p, BALANCE.fruitXp);
    });
  }

  private wander(w: Wild, now: number): void {
    w.wanderAt = now + BALANCE.wildStepMs * (1 + this.rng.next() * 3);
    if (!this.rng.chance(0.6)) return;
    const [dx, dy] = this.rng.pick([
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]);
    const nx = w.x + dx;
    const ny = w.y + dy;
    if (isWalkable(this.map, nx, ny) && biomeAt(this.map, nx, ny) === w.elem && this.inZone({ x: nx, y: ny }, 1)) {
      w.path = [{ x: nx, y: ny }];
    }
  }

  // ---------------------------------------------------------------- batalhas

  private combatant(e: Entity, charged: boolean): Combatant {
    return {
      look: this.look(e),
      baseDmg: e.kind === 'wild' ? BALANCE.wild.dmg : BALANCE.dmg[e.stage],
      trophies: e.kind === 'wild' ? 0 : e.trophies,
      charged,
    };
  }

  private fighterInfo(e: Entity, charged: boolean): FighterInfo {
    return {
      name: e.kind === 'wild' ? `${speciesName(e.elem, 1)} selvagem` : e.name,
      look: this.look(e),
      hp: Math.max(0, Math.round(e.hp)),
      mhp: this.maxHpOf(e),
      charged,
      trophies: e.kind === 'wild' ? 0 : e.trophies,
      wild: e.kind === 'wild',
    };
  }

  private choiceMs(bt: Battle): number {
    return bt.kind === 'wild' ? BALANCE.battle.choiceMsWild : BALANCE.battle.choiceMsPlayer;
  }

  private scheduleAuto(bt: Battle): void {
    const ms = this.choiceMs(bt);
    bt.autoAt.a = bt.a.bot ? this.now + 500 + this.rng.next() * Math.min(2200, ms - 700) : null;
    const b = bt.b;
    if (b.kind === 'wild') bt.autoAt.b = this.now + 300;
    else bt.autoAt.b = b.bot ? this.now + 500 + this.rng.next() * Math.min(2200, ms - 700) : null;
  }

  startBattle(a: Player, b: Entity): void {
    const bt: Battle = {
      id: this.nextId++,
      kind: b.kind === 'wild' ? 'wild' : 'pvp',
      a,
      b,
      turn: 1,
      phase: 'choose',
      deadline: 0,
      choice: { a: null, b: null },
      autoAt: { a: null, b: null },
      charged: { a: false, b: false },
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
    bt.deadline = this.now + this.choiceMs(bt);
    this.scheduleAuto(bt);
    for (const e of [a, b]) {
      e.battle = bt;
      e.path = [];
      if (e.kind === 'player') e.target = null;
    }
    this.battles.set(bt.id, bt);
    const ms = this.choiceMs(bt);
    this.send(a, { t: 'b_start', id: bt.id, kind: bt.kind, you: this.fighterInfo(a, false), opp: this.fighterInfo(b, false), turn: 1, ms });
    if (b.kind === 'player') {
      this.send(b, { t: 'b_start', id: bt.id, kind: bt.kind, you: this.fighterInfo(b, false), opp: this.fighterInfo(a, false), turn: 1, ms });
    }
  }

  private autoChoice(bt: Battle, side: Side): Action {
    const self = side === 'a' ? bt.a : bt.b;
    if (self.kind === 'wild') return wildChoose(this.rng);
    return botChoose(this.rng, bt.charged[side], bt.charged[side === 'a' ? 'b' : 'a'], self.hp / maxHp(self.stage));
  }

  private updateBattles(now: number): void {
    for (const bt of [...this.battles.values()]) {
      if (bt.phase === 'choose') {
        for (const side of ['a', 'b'] as const) {
          const at = bt.autoAt[side];
          if (bt.choice[side] === null && at !== null && now >= at) bt.choice[side] = this.autoChoice(bt, side);
        }
        if ((bt.choice.a && bt.choice.b) || now >= bt.deadline) this.resolve(bt);
      } else if (now >= bt.deadline) {
        const over = bt.a.hp <= 0 || bt.b.hp <= 0 || bt.turn >= BALANCE.battle.maxTurns;
        if (over) this.finishBattle(bt);
        else {
          bt.turn++;
          bt.phase = 'choose';
          bt.choice = { a: null, b: null };
          bt.deadline = now + this.choiceMs(bt);
          this.scheduleAuto(bt);
          const ms = this.choiceMs(bt);
          this.send(bt.a, { t: 'b_turn', id: bt.id, turn: bt.turn, ms });
          if (bt.b.kind === 'player') this.send(bt.b, { t: 'b_turn', id: bt.id, turn: bt.turn, ms });
        }
      }
    }
  }

  private resolve(bt: Battle): void {
    const ca = bt.choice.a ?? 'defesa';
    const cb = bt.choice.b ?? 'defesa';
    const r = resolveTurn(this.combatant(bt.a, bt.charged.a), this.combatant(bt.b, bt.charged.b), ca, cb);
    bt.a.hp -= r.dmgToA;
    bt.b.hp -= r.dmgToB;
    bt.charged = { a: r.chargedA, b: r.chargedB };
    bt.phase = 'reveal';
    bt.deadline = this.now + BALANCE.battle.revealMs;
    const hes = (c: Action | null, who: string) => (c === null ? ` ${who} hesitou e se defendeu.` : '');
    const view = (side: Side) => {
      const you = side === 'a' ? bt.a : bt.b;
      const opp = side === 'a' ? bt.b : bt.a;
      const w = r.winner === 'tie' ? 'tie' : r.winner === side ? 'you' : 'opp';
      return {
        t: 'b_reveal' as const,
        id: bt.id,
        turn: bt.turn,
        you: side === 'a' ? ca : cb,
        opp: side === 'a' ? cb : ca,
        dmgYou: side === 'a' ? r.dmgToA : r.dmgToB,
        dmgOpp: side === 'a' ? r.dmgToB : r.dmgToA,
        hpYou: Math.max(0, Math.round(you.hp)),
        hpOpp: Math.max(0, Math.round(opp.hp)),
        chYou: side === 'a' ? r.chargedA : r.chargedB,
        chOpp: side === 'a' ? r.chargedB : r.chargedA,
        winner: w as 'you' | 'opp' | 'tie',
        text: r.text + hes(side === 'a' ? bt.choice.a : bt.choice.b, 'Você') + hes(side === 'a' ? bt.choice.b : bt.choice.a, 'O oponente'),
      };
    };
    this.send(bt.a, view('a'));
    if (bt.b.kind === 'player') this.send(bt.b, view('b'));
  }

  private endFor(p: Player, bt: Battle, result: 'win' | 'lose' | 'draw' | 'flee', text: string): void {
    this.send(p, { t: 'b_end', id: bt.id, result, text });
  }

  private finishBattle(bt: Battle): void {
    this.battles.delete(bt.id);
    bt.a.battle = null;
    bt.b.battle = null;
    const a = bt.a;
    const b = bt.b;
    const now = this.now;

    if (b.kind === 'wild') {
      const wildDown = b.hp <= 0;
      const playerDown = a.hp <= 0;
      if (wildDown) {
        this.wilds.delete(b.id);
        const mhp = maxHp(a.stage);
        a.hp = playerDown ? Math.round(mhp * BALANCE.wildLossHpPct) : Math.min(mhp, a.hp + mhp * BALANCE.healOnWildPct);
        a.points[b.elem] += 1;
        a.stats.wilds++;
        const hungry = a.hungerUntil > now;
        this.endFor(a, bt, 'win', `Você comeu o bicho! +1 de ${b.elem === 'brasa' ? 'Brasa' : b.elem === 'mare' ? 'Maré' : 'Broto'}${hungry ? ' (Fome: XP em dobro)' : ''}.`);
        this.gainXp(a, hungry ? BALANCE.hungerXpMult : 1);
      } else if (playerDown) {
        a.hp = Math.round(maxHp(a.stage) * BALANCE.wildLossHpPct);
        b.hp = b.maxHp;
        this.endFor(a, bt, 'lose', 'O bicho selvagem te nocauteou. Você se recompôs com pouca vida.');
      } else {
        this.wilds.delete(b.id);
        this.endFor(a, bt, 'flee', 'O bicho fugiu!');
      }
      return;
    }

    const pa = a.hp / maxHp(a.stage);
    const pb = b.hp / maxHp(b.stage);
    let winner: Player | null = null;
    if ((a.hp <= 0) !== (b.hp <= 0)) winner = a.hp > 0 ? a : b;
    else if (pa !== pb) winner = pa > pb ? a : b;
    if (!winner) {
      a.hp = Math.max(1, a.hp);
      b.hp = Math.max(1, b.hp);
      a.shieldUntil = b.shieldUntil = now + BALANCE.drawShieldMs;
      this.endFor(a, bt, 'draw', 'Empate! Ninguém trocou de estágio.');
      this.endFor(b, bt, 'draw', 'Empate! Ninguém trocou de estágio.');
      return;
    }
    const loser = winner === a ? b : a;
    winner.hp = Math.max(1, winner.hp);
    this.applyPvpOutcome(winner, loser, bt);
  }

  /** O twist: quem perde entrega um estágio ao vencedor (ou é eliminado se for ovo). */
  private applyPvpOutcome(winner: Player, loser: Player, bt: Battle): void {
    const now = this.now;
    const wasCrown = this.crownId === loser.id;
    for (const e of ELEMS) winner.points[e] += Math.round(loser.points[e] * BALANCE.absorbFrac);
    winner.stats.wins++;

    if (loser.stage === 0) {
      this.endFor(winner, bt, 'win', `Você eliminou ${loser.name}!`);
      this.endFor(loser, bt, 'lose', `${winner.name} te eliminou.`);
      this.eliminate(loser, winner.name, winner.id);
      this.pushHistory(winner, `Eliminou ${loser.name}`);
      this.gainXp(winner, 2);
    } else {
      const stolen = loser.stage;
      const lost = this.phase === 'final' || this.phase === 'subita' ? BALANCE.finalLossStages : 1;
      this.setStage(loser, Math.max(0, loser.stage - lost) as Stage, BALANCE.loserHpPct);
      loser.xp = 0;
      loser.shieldUntil = now + BALANCE.hungerShieldMs;
      loser.hungerUntil = now + BALANCE.hungerXpMs;
      if (winner.stage < MAX_STAGE) this.setStage(winner, (winner.stage + 1) as Stage);
      else winner.trophies = Math.min(BALANCE.trophyMax, winner.trophies + 1);
      winner.stats.steals++;
      const wName = speciesName(this.look(winner).form, winner.stage);
      this.endFor(winner, bt, 'win', winner.stage === MAX_STAGE && winner.trophies > 0 ? `Vitória! +1 Troféu (${winner.trophies}/${BALANCE.trophyMax}).` : `Vitória! Você roubou um estágio e virou ${wName}.`);
      this.endFor(
        loser,
        bt,
        'lose',
        lost > 1
          ? `Derrota dobrada! ${winner.name} roubou sua evolução e você caiu ${stolen - loser.stage} estágio(s).`
          : `${winner.name} roubou sua evolução. Fome ativa: 5s de proteção e XP em dobro por 30s.`,
      );
      this.pushHistory(winner, `Roubou de ${loser.name}`);
      this.pushHistory(loser, `Perdeu para ${winner.name}`);
      const what = stolen === MAX_STAGE ? 'a forma final' : 'um estágio';
      this.feed(`${winner.name} roubou ${what} de ${loser.name}!`, 'steal');
    }
    if (wasCrown) {
      this.feed(`${winner.name} derrubou a Coroa!`, 'steal');
      this.gainXp(winner, BALANCE.crownXpBonus);
    }
  }

  private eliminate(p: Player, by: string | null, killerId: number | null): void {
    const place = this.alivePlayers().length;
    p.alive = false;
    p.place = place;
    p.path = [];
    p.target = null;
    p.eliminatedBy = by;
    p.killerId = killerId;
    this.pushHistory(p, by ? `Eliminado por ${by}` : 'Eliminado pela zona');
    this.send(p, { t: 'elim', by, place });
    this.feed(by ? `${p.name} foi eliminado por ${by}.` : `${p.name} foi consumido pela zona.`, 'elim');
    for (const q of this.players.values()) if (q.target === p.id) q.target = null;
  }

  // ---------------------------------------------------------------- zona, selvagens, coroa

  private applyZone(dt: number): void {
    const sec = dt / 1000;
    // Na fase final e na morte súbita, a zona queima até quem está batalhando.
    const endgame = this.phase === 'final' || this.phase === 'subita';
    for (const p of this.alivePlayers()) {
      if (p.battle && !endgame) continue;
      const mhp = maxHp(p.stage);
      if (!this.inZone(p)) {
        const dps = this.phase === 'subita' ? BALANCE.zone.suddenDpsPct : BALANCE.zone.dpsPct;
        p.hp -= dps * mhp * sec;
        this.toast(p, 'Você está fora da zona! Volte para o círculo.');
        // Em batalha, o HP zerado é resolvido pelo fim do turno.
        if (p.hp <= 0 && !p.battle) this.zoneLoss(p);
      } else if (p.hp < mhp && !p.battle) {
        p.hp = Math.min(mhp, p.hp + BALANCE.regenPctPerSec * mhp * sec);
      }
    }
  }

  private zoneLoss(p: Player): void {
    if (p.stage === 0) {
      this.eliminate(p, null, null);
      return;
    }
    this.setStage(p, (p.stage - 1) as Stage, BALANCE.loserHpPct);
    p.xp = 0;
    p.shieldUntil = this.now + BALANCE.zoneLossShieldMs;
    this.pushHistory(p, 'Queimado pela zona');
    this.toast(p, 'A zona te queimou: você perdeu um estágio!', true);
  }

  private wildTarget(): number {
    const W = BALANCE.wild;
    const n = clamp(this.alivePlayers().length * W.perPlayer, W.min, W.max);
    return Math.ceil(n * W.phaseMult[this.phase]);
  }

  private maintainWilds(now: number, burst: boolean): void {
    for (const w of this.wilds.values()) if (!w.battle && !this.inZone(w)) this.wilds.delete(w.id);
    const target = this.wildTarget();
    while (this.wilds.size < target && (burst || now >= this.nextWildAt)) {
      this.nextWildAt = now + 300;
      if (!this.spawnWild(now) || !burst) break;
    }
  }

  private spawnWild(now: number): boolean {
    const alive = this.alivePlayers();
    for (let tries = 0; tries < 40; tries++) {
      const x = this.rng.int(0, this.map.w - 1);
      const y = this.rng.int(0, this.map.h - 1);
      if (!isWalkable(this.map, x, y) || !this.inZone({ x, y }, 1.5)) continue;
      if (alive.some((p) => chebyshev(p, { x, y }) < 4)) continue;
      const elem = biomeAt(this.map, x, y)!;
      const hp = this.rng.int(BALANCE.wild.hpMin, BALANCE.wild.hpMax);
      const w: Wild = { kind: 'wild', id: this.nextId++, x, y, path: [], nextStepAt: 0, hp, maxHp: hp, battle: null, elem, wanderAt: now };
      this.wilds.set(w.id, w);
      return true;
    }
    return false;
  }

  private updateCrown(now: number): void {
    const key = (p: Player) => p.stage * 1000 + p.trophies * 100 + p.xp;
    let best: Player | null = null;
    for (const p of this.alivePlayers()) {
      if (p.stage < 1) continue;
      if (!best || key(p) > key(best)) best = p;
    }
    const current = this.crownId !== null ? this.players.get(this.crownId) : undefined;
    if (current && current.alive && best && key(current) === key(best)) best = current;
    if (best?.id !== this.crownId) {
      this.crownId = best?.id ?? null;
      if (best && this.phase !== 'coleta' && now - this.lastCrownFeedAt > 10_000) {
        this.lastCrownFeedAt = now;
        this.feed(`${best.name} está com a Coroa. Derrotá-lo vale XP extra!`, 'info');
      }
    }
    if (this.phase !== 'coleta' && now >= this.nextCrownPingAt) {
      this.crownPingUntil = now + BALANCE.crownPingShowMs;
      this.nextCrownPingAt = now + BALANCE.crownPingEveryMs;
    }
  }

  // ---------------------------------------------------------------- fim de partida

  private checkEnd(): void {
    const alive = this.alivePlayers();
    if (alive.length > 1 && this.elapsed < BALANCE.phases.hardCap) return;
    this.state = 'fim';
    this.endedAt = this.now;
    for (const bt of this.battles.values()) {
      bt.a.battle = null;
      bt.b.battle = null;
    }
    this.battles.clear();
    alive.sort((p, q) => q.stage - p.stage || q.trophies - p.trophies || q.hp / maxHp(q.stage) - p.hp / maxHp(p.stage));
    alive.forEach((p, i) => (p.place = i + 1));
    const winner = alive[0] ?? null;
    if (winner) {
      this.pushHistory(winner, 'Venceu a partida');
      this.feed(`${winner.name} venceu a partida como ${speciesName(this.look(winner).form, winner.stage)}!`, 'phase');
    }
    for (const m of this.members) {
      const p = m.player;
      if (!p) continue;
      m.conn.send({
        t: 'end',
        winner: winner ? { name: winner.name, look: this.look(winner) } : null,
        place: p.place,
        total: this.totalPlayers,
        you: { name: p.name, look: this.look(p), ...p.stats },
        history: p.history,
      });
    }
  }

  // ---------------------------------------------------------------- snapshots

  private entSnap(e: Entity): EntSnap {
    const look = this.look(e);
    const s: EntSnap = { id: e.id, k: e.kind === 'wild' ? 'w' : 'p', x: e.x, y: e.y, f: look.form, s: look.stage, o: look.order, hp: Math.max(0, Math.round(e.hp)), mhp: this.maxHpOf(e) };
    if (e.battle) s.b = e.battle.id;
    if (e.kind === 'player') {
      s.n = e.name;
      if (this.crownId === e.id) s.cr = 1;
      if (e.shieldUntil > this.now) s.sh = 1;
      if (e.trophies) s.tr = e.trophies;
      if (e.battle && e.battle.charged[e.battle.a === e ? 'a' : 'b']) s.ch = 1;
    }
    return s;
  }

  /** Quem a câmera de um jogador segue: ele mesmo, ou quem ele assiste depois de eliminado. */
  viewOf(p: Player): Player | null {
    if (p.alive) return p;
    const killer = p.killerId !== null ? this.players.get(p.killerId) : undefined;
    if (killer?.alive) return killer;
    const crown = this.crownId !== null ? this.players.get(this.crownId) : undefined;
    if (crown?.alive) return crown;
    return this.alivePlayers()[0] ?? null;
  }

  private sendSnapshots(): void {
    const R = BALANCE.viewRadius;
    const lb: LeaderRow[] = this.alivePlayers()
      .sort((p, q) => q.stage - p.stage || q.trophies - p.trophies || q.xp - p.xp)
      .map((p) => {
        const row: LeaderRow = { id: p.id, n: p.name, s: p.stage, f: this.look(p).form };
        if (p.id === this.crownId) row.cr = 1;
        return row;
      });
    const crownP = this.crownId !== null ? this.players.get(this.crownId) : undefined;
    const crown = crownP && this.now < this.crownPingUntil ? { x: crownP.x, y: crownP.y } : null;
    const fr: number[] = [];
    this.fruitRespawnAt.forEach((t, i) => t <= this.now && fr.push(i));
    const al = lb.length;
    const zone = { x: this.zone.x, y: this.zone.y, r: Math.round(this.zone.r * 100) / 100, tr: Math.round(this.zone.tr * 100) / 100 };

    for (const m of this.members) {
      const p = m.player;
      if (!p) continue;
      const v = this.viewOf(p) ?? p;
      const near = (e: Vec) => Math.abs(e.x - v.x) <= R && Math.abs(e.y - v.y) <= R;
      const ents: EntSnap[] = [];
      for (const q of this.players.values()) if (q.alive && near(q)) ents.push(this.entSnap(q));
      for (const w of this.wilds.values()) if (near(w)) ents.push(this.entSnap(w));
      const bs: BattleSnap[] = [];
      for (const bt of this.battles.values()) if (near({ x: bt.cx, y: bt.cy })) bs.push({ id: bt.id, x: bt.cx, y: bt.cy });
      const look = this.look(p);
      m.conn.send({
        t: 'snap',
        el: this.elapsed,
        ph: this.phase,
        z: zone,
        al,
        ents,
        bs,
        fr,
        view: v.id,
        crown,
        lb,
        me: {
          id: p.id,
          x: p.x,
          y: p.y,
          look,
          xp: p.xp,
          xpNeed: p.stage < MAX_STAGE ? BALANCE.xpToEvolve[p.stage] : 0,
          hp: Math.max(0, Math.round(p.hp)),
          mhp: maxHp(p.stage),
          points: p.points,
          trophies: p.trophies,
          shieldMs: Math.max(0, p.shieldUntil - this.now),
          hungerMs: Math.max(0, p.hungerUntil - this.now),
          alive: p.alive,
          crown: this.crownId === p.id,
          battle: p.battle?.id ?? null,
          target: p.target,
        },
      });
    }
  }
}

