import {
  BALANCE,
  ELEMS,
  FX_CHARGED,
  FX_CLASH,
  FX_KO,
  FX_MAX_PER_TICK,
  LINES,
  MAX_STAGE,
  MODES,
  Rng,
  SKILLS,
  applyXp,
  biomeAt,
  canBuy,
  chebyshev,
  encodeTiles,
  findPath,
  generateMap,
  isSpecial,
  isWalkable,
  lookOf,
  mapSizeFor,
  modsOf,
  nearestWalkable,
  powerOf,
  randomSeed,
  resolveTurn,
  specialOf,
  speciesName,
  titleOf,
  typeMult,
  withSkill,
  type Action,
  type BattleSnap,
  type BuyError,
  type Combatant,
  type Elem,
  type EntSnap,
  type FighterInfo,
  type FxEvent,
  type GameMap,
  type GameMode,
  type LeaderRow,
  type Look,
  type ModeConfig,
  type Move,
  type Phase,
  type RankRow,
  type ServerMsg,
  type SkillId,
  type Snap,
  type Stage,
  type Vec,
} from '@vb/shared';
import { botChoose, botThink, dominantLine, makeBrain, wildChoose } from './bots';
import type { Battle, Conn, Entity, Player, Side, Wild } from './entities';
import type { RoomHooks } from './hooks';
import { SECURITY } from './security';

const BOT_NAMES = [
  'Farofa', 'Paçoca', 'Cuscuz', 'Tapioca', 'Pitanga', 'Jambo', 'Caju', 'Pipoca', 'Mandioca', 'Jabuti',
  'Capivara', 'Sabiá', 'Brigadeiro', 'Quindim', 'Pamonha', 'Guaraná', 'Açaí', 'Cocada', 'Munguzá', 'Canjica',
];

const ELEM_NAME: Record<Elem, string> = { brasa: 'Brasa', mare: 'Maré', broto: 'Broto' };

export interface Member {
  conn: Conn;
  name: string;
  player: Player | null;
}

export type RoomState = 'lobby' | 'play' | 'fim';

/** Resultado de uma compra: null = comprou; senão o motivo da recusa. */
export type BuyResult = BuyError | 'busy' | null;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);
/** HP exibido: 0 só com HP <= 0 (nocaute); vivo com HP fracionário abaixo de 0,5 aparece como 1. */
const shownHp = (hp: number) => (hp <= 0 ? 0 : Math.max(1, Math.round(hp)));
/** Relógio m:ss de um tempo de partida. */
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');
/** Folga de Força para a Coroa trocar de dono (evita piscar entre dois líderes quase empatados). */
const CROWN_HYSTERESIS = 10;

/** Nomes dos modos com maestria, para a mensagem de recusa. */
const MASTERY_MODES = Object.values(MODES)
  .filter((m) => m.mastery)
  .map((m) => m.name)
  .join(' e ');

export class Room {
  state: RoomState = 'lobby';
  readonly members = new Set<Member>();
  readonly players = new Map<number, Player>();
  readonly wilds = new Map<number, Wild>();
  readonly battles = new Map<number, Battle>();
  map!: GameMap;
  readonly rng: Rng;
  /** Modo de jogo: fases, tamanho do mapa, vagas de habilidade, maestria e teto de troféus. */
  readonly gm: GameMode;
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
  /** Finalistas do Duelo Final (quando começou). */
  duel: { a: Player; b: Player } | null = null;
  /** Quantas buscas A* de jogadores já rodaram (métrica e testes). */
  pathfinds = 0;
  /** Observabilidade (injetada pelo Lobby); null = sem ganchos. */
  hooks: RoomHooks | null = null;

  private nextId = 1;
  private lastLobbyAt = 0;
  private nextWildAt = 0;
  private nextCrownPingAt = 0;
  private crownPingUntil = 0;
  private lastCrownFeedAt = -Infinity;
  /** Eventos visuais desde o último snapshot, filtrados por visão em sendSnapshots. */
  private readonly fxq: FxEvent[] = [];

  /** Folga (tiles) além do raio de visão aceita na mira pedida por humano. */
  readonly targetSlackTiles: number;

  constructor(
    readonly code: string,
    readonly isPrivate: boolean,
    readonly seed: number = randomSeed(),
    opts: { targetSlackTiles?: number; gm?: GameMode } = {},
  ) {
    this.rng = new Rng(seed ^ 0x5bd1e995);
    this.targetSlackTiles = opts.targetSlackTiles ?? SECURITY.game.targetSlackTiles;
    this.gm = opts.gm ?? 'rapido';
  }

  get mode(): ModeConfig {
    return MODES[this.gm];
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
      // O bot que assume segue a build que o humano começou.
      if (p.alive) p.bot = makeBrain(this.rng, dominantLine(p.skills) ?? undefined);
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
      gm: this.gm,
    };
    for (const m of this.members) m.conn.send(msg);
  }

  /** Inicia a partida, completando com bots até o mínimo. Todos começam chocando. */
  start(now: number, botsOnly = 0): void {
    const humans = [...this.members];
    const total = clamp(Math.max(BALANCE.lobby.minPlayers, humans.length, botsOnly), 1, BALANCE.lobby.maxPlayers);
    this.map = generateMap(this.seed, total, Math.round(mapSizeFor(total) * this.mode.mapScale));
    this.totalPlayers = total;
    this.state = 'play';
    this.now = now;
    this.startedAt = now;
    this.fxq.length = 0;
    this.fruitRespawnAt = this.map.fruits.map(() => 0);
    const c = nearestWalkable(this.map, (this.map.w - 1) / 2, (this.map.h - 1) / 2);
    const r0 = Math.hypot(this.map.w, this.map.h) / 2 + 1;
    this.zone = { x: c.x, y: c.y, r: r0, r0, tr: r0 };
    this.nextCrownPingAt = now + this.mode.phases.coletaEnd;

    const spawns = this.rng.shuffle([...this.map.spawns]);
    const botNames = this.rng.shuffle([...BOT_NAMES]);
    // Bots distribuídos entre as 3 linhas (a partir de uma linha sorteada).
    const lineOffset = this.rng.int(0, LINES.length - 1);
    let bots = 0;
    for (let i = 0; i < total; i++) {
      const human = humans[i];
      const p = this.createPlayer(human ? human.name : botNames[i % botNames.length], spawns[i], human?.conn ?? null);
      if (human) human.player = p;
      else p.bot = makeBrain(this.rng, LINES[(lineOffset + bots++) % LINES.length]);
      this.fx({ k: 'r', x: p.x, y: p.y, id: p.id });
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
        gm: this.gm,
      });
    }
    this.feed('A Coleta começou! Coma bichos selvagens para evoluir e juntar Essência ✨ para a loja.', 'phase');
    this.maintainWilds(now, true);
    this.hooks?.matchStart(this);
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
      hp: 0,
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
      pendingDest: null,
      lastDest: null,
      lastToastAt: 0,
      eliminatedBy: null,
      killerId: null,
      place: 0,
      history: [],
      stats: { wins: 0, steals: 0, wilds: 0, deaths: 0, buys: 0, earned: 0 },
      essenceFrac: 0,
      essence: BALANCE.essence.start,
      skills: [],
      mods: modsOf([]),
      hatchUntil: this.now + BALANCE.respawn.hatchMs,
      duelPower: null,
    };
    p.hp = this.maxHpOf(p);
    this.players.set(p.id, p);
    this.pushHistory(p, 'Nasceu');
    return p;
  }

  // ---------------------------------------------------------------- helpers

  private fx(ev: FxEvent): void {
    if (this.fxq.length < FX_MAX_PER_TICK) this.fxq.push(ev);
  }

  look(e: Entity): Look {
    if (e.kind === 'wild') return { form: e.elem, stage: 1, order: [e.elem] };
    return lookOf(e.points, e.stage);
  }

  /** HP máximo: selvagens pelo sorteio; jogadores pelo estágio × Couro Grosso/Campeão. */
  maxHpOf(e: Entity): number {
    return e.kind === 'wild' ? e.maxHp : Math.round(BALANCE.hp[e.stage] * e.mods.hpMult);
  }

  /** Força do jogador agora (placar, Coroa e finalistas). */
  powerOf(p: Player): number {
    return powerOf({ stage: p.stage, trophies: p.trophies, skills: p.skills, essence: p.essence, hpPct: p.hp / this.maxHpOf(p) });
  }

  /** Chocando: não anda, não mira, não compra e não pode ser alvo. */
  isHatching(p: Player): boolean {
    return p.hatchUntil > this.now;
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

  /** Credita Essência com o multiplicador do modo; devolve quanto entrou de fato (inteiro). */
  private earn(p: Player, n: number): number {
    const total = n * this.mode.essenceMult + p.essenceFrac;
    const whole = Math.floor(total + 1e-9);
    p.essenceFrac = total - whole;
    p.essence += whole;
    p.stats.earned += whole;
    return whole;
  }

  /** Muda o estágio preservando a fração de HP. */
  private setStage(p: Player, stage: Stage, hpPct?: number): void {
    const pct = hpPct ?? p.hp / this.maxHpOf(p);
    p.stage = stage;
    p.hp = Math.max(1, Math.round(pct * this.maxHpOf(p)));
  }

  private gainXp(p: Player, amount: number): void {
    const before = p.stage;
    const pct = p.hp / this.maxHpOf(p);
    const gained = applyXp(p, amount);
    if (gained > 0) {
      p.hp = Math.max(1, Math.round(pct * this.maxHpOf(p)));
      this.fx({ k: 'v', x: p.x, y: p.y, id: p.id, s: p.stage });
      const name = speciesName(this.look(p).form, p.stage);
      this.toast(p, `Você evoluiu para ${name}!`, true);
      this.pushHistory(p, 'Evoluiu');
      if (p.stage === MAX_STAGE && before < MAX_STAGE) this.feed(`${p.name} alcançou a forma final: ${name}!`, 'evo');
    }
  }

  // ---------------------------------------------------------------- comandos

  moveTo(p: Player, x: number, y: number): void {
    if (!p.alive || p.battle || this.state !== 'play' || this.isHatching(p)) return;
    p.target = null;
    p.lastDest = { x, y };
    const dest = nearestWalkable(this.map, x, y);
    this.pathfinds++;
    p.path = findPath(this.map, p, dest) ?? [];
  }

  /** Movimento pedido por humano: só guarda o destino; o A* roda uma vez no próximo tick (depois da eclosão). */
  commandMove(p: Player, x: number, y: number): void {
    if (!p.alive || p.battle || this.state !== 'play') return;
    p.pendingDest = { x, y };
  }

  /** Mira pedida por humano: só em entidades dentro do raio de visão (com folga), contra radar por id. */
  commandTarget(p: Player, id: number): void {
    const t = this.entity(id);
    if (!t || chebyshev(p, t) > BALANCE.viewRadius + this.targetSlackTiles) return;
    // Alvo recusado não cancela o movimento pedido no mesmo tick.
    if (this.setTarget(p, id)) p.pendingDest = null;
  }

  /** Mira numa entidade; devolve false (sem mudar nada) se o alvo não vale. */
  setTarget(p: Player, id: number): boolean {
    if (!p.alive || p.battle || this.state !== 'play' || id === p.id || this.isHatching(p)) return false;
    const t = this.entity(id);
    if (!t) return false;
    if (t.kind === 'wild' && t.battle) {
      this.toast(p, 'Esse bicho já está batalhando com outro jogador.', true);
      return false;
    }
    if (t.kind === 'player') {
      if (!t.alive) return false;
      if (this.phase === 'coleta') {
        this.toast(p, `Batalhas entre jogadores só começam na Caçada (${clock(this.mode.phases.coletaEnd)}).`, true);
        return false;
      }
      if (this.isHatching(t)) {
        this.toast(p, `${t.name} ainda está saindo do ovo.`, true);
        return false;
      }
    }
    p.target = id;
    p.targetSeenAt = null;
    p.repathAt = 0;
    return true;
  }

  /** O lado ainda pode usar o Especial nesta batalha? */
  private canSpecial(bt: Battle, side: Side): boolean {
    const e = side === 'a' ? bt.a : bt.b;
    return e.kind === 'player' && specialOf(e.skills) !== null && bt.specialLeft[side] > 0;
  }

  act(p: Player, a: Action): void {
    const bt = p.battle;
    if (!bt || bt.phase !== 'choose') return;
    const side: Side = bt.a === p ? 'a' : 'b';
    if (bt.choice[side] !== null) return;
    // 'especial' sem Especial disponível vira Defesa.
    bt.choice[side] = a === 'especial' && !this.canSpecial(bt, side) ? 'defesa' : a;
  }

  /**
   * Compra na loja: só vivo, fora de batalha e fora da eclosão. Um Especial novo substitui o antigo
   * e o HP máximo novo preserva a fração de vida. Responde com um toast (sucesso ou motivo).
   */
  buy(p: Player, id: SkillId): BuyResult {
    if (this.state !== 'play' || !p.alive) {
      this.toast(p, 'A loja está fechada para quem já saiu da partida.', true);
      return 'busy';
    }
    if (p.battle) {
      this.toast(p, 'Não dá para comprar no meio de uma batalha.', true);
      return 'busy';
    }
    if (this.isHatching(p)) {
      this.toast(p, 'Espere sair do ovo para comprar.', true);
      return 'busy';
    }
    const def = SKILLS[id];
    const err = canBuy(p.skills, p.essence, id, this.gm);
    if (err) {
      this.toast(p, this.buyErrorText(p, id, err), true);
      return err;
    }
    const before = titleOf(p.skills);
    const oldSpecial = def.special ? p.skills.find((s) => SKILLS[s].special) : undefined;
    const pct = p.hp / this.maxHpOf(p);
    p.essence -= def.cost;
    p.skills = withSkill(p.skills, id);
    p.mods = modsOf(p.skills);
    p.hp = Math.min(this.maxHpOf(p), pct * this.maxHpOf(p));
    p.stats.buys++;
    this.fx({ k: 'k', x: p.x, y: p.y, id: p.id, s: id });
    const title = titleOf(p.skills);
    const newTitle = title && (title.line !== before?.line || title.level !== before?.level) ? title : null;
    let text = oldSpecial ? `Você trocou ${SKILLS[oldSpecial].name} por ${def.icon} ${def.name}!` : `Você aprendeu ${def.icon} ${def.name}!`;
    if (newTitle) text += ` Agora você é ${newTitle.name}!`;
    this.toast(p, text, true);
    this.pushHistory(p, `Aprendeu ${def.name}`);
    if (newTitle?.level === 2) this.feed(`${p.name} virou ${newTitle.name}!`, 'evo');
    return null;
  }

  private buyErrorText(p: Player, id: SkillId, err: BuyError): string {
    const def = SKILLS[id];
    switch (err) {
      case 'owned':
        return `Você já tem ${def.icon} ${def.name}.`;
      case 'essence':
        return `Falta Essência: ${def.name} custa ${def.cost} ✨ e você tem ${p.essence}.`;
      case 'slots':
        return `Sem vaga: no modo ${this.mode.name} cada bicho tem até ${this.mode.slots} habilidades.`;
      case 'mastery':
        return `${def.name} é uma maestria: só nos modos ${MASTERY_MODES}.`;
      default:
        return 'Essa habilidade não existe.';
    }
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

    // A fila de efeitos guarda o que aconteceu desde o último snapshot (inclui nascimentos e compras).
    this.updatePhase();
    for (const p of this.players.values()) {
      if (p.alive && p.bot && !p.battle && !this.isHatching(p) && now >= p.bot.nextThinkAt) botThink(this, p, now);
    }
    this.applyCommands();
    this.updateTargets(now);
    this.moveEntities(now);
    this.updateBattles(now);
    this.applyZone(dt);
    this.maintainWilds(now, false);
    this.updateCrown(now);
    this.checkEnd();
    if (this.state === 'play') this.sendSnapshots();
  }

  /** Aplica os destinos pedidos pelos humanos neste tick (o último pedido vence). Chocando, o pedido espera. */
  private applyCommands(): void {
    for (const p of this.players.values()) {
      const d = p.pendingDest;
      if (!d || this.isHatching(p)) continue;
      p.pendingDest = null;
      const same = p.lastDest && p.lastDest.x === d.x && p.lastDest.y === d.y;
      if (same && p.target === null && p.path.length > 0) continue;
      this.moveTo(p, d.x, d.y);
    }
  }

  private updatePhase(): void {
    if (this.phase === 'duelo') return; // zona congelada durante o duelo
    const el = this.elapsed;
    const P = this.mode.phases;
    const Z = BALANCE.zone;
    const r0 = this.zone.r0;
    if (el >= P.finalEnd) {
      this.startDuel();
      return;
    }
    let phase: Phase;
    if (el < P.coletaEnd) {
      phase = 'coleta';
      this.zone.r = r0;
      this.zone.tr = r0 * Z.cacadaFrac;
    } else if (el < P.cacadaEnd) {
      phase = 'cacada';
      this.zone.r = lerp(r0, r0 * Z.cacadaFrac, (el - P.coletaEnd) / (P.cacadaEnd - P.coletaEnd));
      this.zone.tr = r0 * Z.cacadaFrac;
    } else {
      phase = 'final';
      this.zone.r = lerp(r0 * Z.cacadaFrac, Z.finalRadius, (el - P.cacadaEnd) / (P.finalEnd - P.cacadaEnd));
      this.zone.tr = Z.finalRadius;
    }
    if (phase !== this.phase) {
      this.phase = phase;
      if (phase === 'cacada') this.feed('A Caçada começou! Agora dá para desafiar outros jogadores. A zona está fechando.', 'phase');
      if (phase === 'final') {
        this.feed(`Fase final! Os selvagens sumiram e cada derrota custa 2 estágios. Aos ${clock(P.finalEnd)}, os 2 mais fortes vão para o Duelo Final.`, 'phase');
      }
    }
  }

  private updateTargets(now: number): void {
    for (const p of this.players.values()) {
      if (!p.alive || p.battle || p.target === null) continue;
      const t = this.entity(p.target);
      if (!t || (t.kind === 'player' && (!t.alive || this.phase === 'coleta' || this.isHatching(t)))) {
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
        this.pathfinds++;
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
    // Passos Leves e Rastreador encurtam o passo.
    for (const p of this.players.values()) if (p.alive && !this.isHatching(p)) step(p, BALANCE.stepMs / p.mods.speedMult);
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
      const got = this.earn(p, BALANCE.essence.fruit);
      this.toast(p, `Fruta rara! +${BALANCE.fruitPoints} de ${ELEM_NAME[f.elem]}${got ? ` e +${got} ✨` : ''}.`, true);
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

  /** Lutador de um lado da batalha, com a build e o estado das passivas de uma vez. */
  private combatant(bt: Battle, side: Side): Combatant {
    const e = side === 'a' ? bt.a : bt.b;
    if (e.kind === 'wild') return { look: this.look(e), baseDmg: BALANCE.wild.dmg, trophies: 0, charged: bt.charged[side] };
    return {
      look: this.look(e),
      baseDmg: BALANCE.dmg[e.stage],
      trophies: e.trophies,
      charged: bt.charged[side],
      mods: e.mods,
      special: specialOf(e.skills),
      specialLeft: bt.specialLeft[side],
      shieldUsed: bt.shieldUsed[side],
      dodgeUsed: bt.dodgeUsed[side],
      maxHp: this.maxHpOf(e),
    };
  }

  private fighterInfo(bt: Battle, side: Side): FighterInfo {
    const e = side === 'a' ? bt.a : bt.b;
    return {
      name: e.kind === 'wild' ? `${speciesName(e.elem, 1)} selvagem` : e.name,
      look: this.look(e),
      hp: shownHp(e.hp),
      mhp: this.maxHpOf(e),
      charged: bt.charged[side],
      trophies: e.kind === 'wild' ? 0 : e.trophies,
      wild: e.kind === 'wild',
      skills: e.kind === 'wild' ? [] : [...e.skills],
      special: e.kind === 'wild' ? null : specialOf(e.skills),
      specialLeft: bt.specialLeft[side],
    };
  }

  private choiceMs(bt: Battle): number {
    if (bt.kind === 'final') return BALANCE.duel.choiceMs;
    return bt.kind === 'wild' ? BALANCE.battle.choiceMsWild : BALANCE.battle.choiceMsPlayer;
  }

  /** Quem assiste a uma batalha: só o Duelo Final é transmitido para todos. */
  private spectators(bt: Battle): Member[] {
    if (bt.kind !== 'final') return [];
    return [...this.members].filter((m) => m.player !== bt.a && m.player !== bt.b);
  }

  private scheduleAuto(bt: Battle): void {
    const ms = this.choiceMs(bt);
    bt.autoAt.a = bt.a.bot ? this.now + 500 + this.rng.next() * Math.min(2200, ms - 700) : null;
    const b = bt.b;
    if (b.kind === 'wild') bt.autoAt.b = this.now + 300;
    else bt.autoAt.b = b.bot ? this.now + 500 + this.rng.next() * Math.min(2200, ms - 700) : null;
  }

  startBattle(a: Player, b: Entity, kind: Battle['kind'] = b.kind === 'wild' ? 'wild' : 'pvp'): void {
    // Usos do Especial (Tempestade dá 2) e o Arquimago começando Carregado.
    const uses = (e: Entity) => (e.kind === 'player' && specialOf(e.skills) ? e.mods.specialUses : 0);
    const startCharged = (e: Entity) => e.kind === 'player' && e.mods.startCharged;
    const bt: Battle = {
      id: this.nextId++,
      kind,
      a,
      b,
      turn: 1,
      phase: 'choose',
      deadline: 0,
      choice: { a: null, b: null },
      autoAt: { a: null, b: null },
      charged: { a: startCharged(a), b: startCharged(b) },
      specialLeft: { a: uses(a), b: uses(b) },
      shieldUsed: { a: false, b: false },
      dodgeUsed: { a: false, b: false },
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
    this.hooks?.battle(this, kind);
    this.fx({ k: 'bt', x: bt.cx, y: bt.cy, id: bt.id, a: a.id, b: b.id, kd: kind === 'pvp' ? 'p' : kind === 'wild' ? 'w' : 'f' });
    const ms = this.choiceMs(bt);
    const fa = this.fighterInfo(bt, 'a');
    const fb = this.fighterInfo(bt, 'b');
    this.send(a, { t: 'b_start', id: bt.id, kind: bt.kind, you: fa, opp: fb, turn: 1, ms });
    if (b.kind === 'player') this.send(b, { t: 'b_start', id: bt.id, kind: bt.kind, you: fb, opp: fa, turn: 1, ms });
    for (const m of this.spectators(bt)) m.conn.send({ t: 'b_start', id: bt.id, kind: bt.kind, you: fa, opp: fb, turn: 1, ms, spectate: true });
  }

  private autoChoice(bt: Battle, side: Side): Action {
    const self = side === 'a' ? bt.a : bt.b;
    if (self.kind === 'wild') return wildChoose(this.rng);
    return botChoose(this.rng, bt.charged[side], bt.charged[other(side)], self.hp / this.maxHpOf(self), this.canSpecial(bt, side));
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
        const over = bt.a.hp <= 0 || bt.b.hp <= 0 || (bt.kind !== 'final' && bt.turn >= BALANCE.battle.maxTurns);
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
          for (const m of this.spectators(bt)) m.conn.send({ t: 'b_turn', id: bt.id, turn: bt.turn, ms });
        }
      }
    }
  }

  private resolve(bt: Battle): void {
    const chA = bt.charged.a;
    const chB = bt.charged.b;
    const ca = bt.choice.a ?? 'defesa';
    const cb = bt.choice.b ?? 'defesa';
    const r = resolveTurn(this.combatant(bt, 'a'), this.combatant(bt, 'b'), ca, cb);
    const baseA = r.dmgToA;
    const baseB = r.dmgToB;
    // Fúria da arena: no Duelo Final, depois de alguns turnos, os dois perdem HP a cada turno.
    const fury = bt.kind === 'final' && bt.turn >= BALANCE.duel.furyFromTurn;
    if (fury) {
      r.dmgToA += Math.round(BALANCE.duel.furyPct * this.maxHpOf(bt.a));
      r.dmgToB += Math.round(BALANCE.duel.furyPct * this.maxHpOf(bt.b));
      r.text += ' A fúria da arena queima os dois!';
    }
    bt.a.hp -= r.dmgToA;
    bt.b.hp -= r.dmgToB;
    // Sede de Batalha: a cura vem depois do dano, até o máximo, e não levanta quem caiu.
    const heal = (e: Entity, amount: number) => {
      if (amount <= 0 || e.hp <= 0) return 0;
      const got = Math.min(amount, this.maxHpOf(e) - e.hp);
      if (got <= 0) return 0;
      e.hp += got;
      return Math.round(got);
    };
    const healA = heal(bt.a, r.healA);
    const healB = heal(bt.b, r.healB);
    if (healA + healB > 0) r.text += ` A Sede de Batalha curou ${healA + healB} de HP.`;
    const hit = (att: Entity, def: Entity, v: number, act: Action, move: Move, charged: boolean) => {
      const tm = typeMult(this.look(att), this.look(def));
      const fl = (charged ? FX_CHARGED : 0) | (r.winner === 'tie' ? FX_CLASH : 0) | (def.hp <= 0 ? FX_KO : 0);
      this.fx({
        k: 'h',
        x: bt.cx,
        y: bt.cy,
        bt: bt.id,
        a: att.id,
        d: def.id,
        v,
        act,
        m: tm > 1 ? 1 : tm < 1 ? -1 : 0,
        fl,
        hp: shownHp(def.hp),
        ...(isSpecial(move) ? { sp: move } : {}),
      });
    };
    if (baseB > 0) hit(bt.a, bt.b, baseB, ca, r.moveA, chA);
    if (baseA > 0) hit(bt.b, bt.a, baseA, cb, r.moveB, chB);
    if (fury) this.fx({ k: 'fu', x: bt.cx, y: bt.cy, bt: bt.id, a: bt.a.id, b: bt.b.id, va: r.dmgToA - baseA, vb: r.dmgToB - baseB });
    bt.charged = { a: r.chargedA, b: r.chargedB };
    bt.specialLeft = { a: Math.max(0, r.specialLeftA), b: Math.max(0, r.specialLeftB) };
    bt.shieldUsed = { a: r.shieldUsedA, b: r.shieldUsedB };
    bt.dodgeUsed = { a: r.dodgeUsedA, b: r.dodgeUsedB };
    bt.phase = 'reveal';
    bt.deadline = this.now + BALANCE.battle.revealMs;
    const hes = (c: Action | null, who: string) => (c === null ? ` ${who} hesitou e se defendeu.` : '');
    const nameOf = (e: Entity) => (e.kind === 'player' ? e.name : 'O bicho');
    const view = (side: Side, spectator = false): ServerMsg => {
      const a = side === 'a';
      const you = a ? bt.a : bt.b;
      const opp = a ? bt.b : bt.a;
      const w = r.winner === 'tie' ? 'tie' : r.winner === side ? 'you' : 'opp';
      return {
        t: 'b_reveal',
        id: bt.id,
        turn: bt.turn,
        you: a ? ca : cb,
        opp: a ? cb : ca,
        dmgYou: a ? r.dmgToA : r.dmgToB,
        dmgOpp: a ? r.dmgToB : r.dmgToA,
        hpYou: shownHp(you.hp),
        hpOpp: shownHp(opp.hp),
        chYou: a ? r.chargedA : r.chargedB,
        chOpp: a ? r.chargedB : r.chargedA,
        winner: w,
        text: spectator
          ? r.text + hes(bt.choice.a, nameOf(bt.a)) + hes(bt.choice.b, nameOf(bt.b))
          : r.text + hes(a ? bt.choice.a : bt.choice.b, 'Você') + hes(a ? bt.choice.b : bt.choice.a, 'O oponente'),
        moveYou: a ? r.moveA : r.moveB,
        moveOpp: a ? r.moveB : r.moveA,
        healYou: a ? healA : healB,
        healOpp: a ? healB : healA,
        dodgeYou: a ? r.dodgedA : r.dodgedB,
        dodgeOpp: a ? r.dodgedB : r.dodgedA,
        shieldYou: a ? r.shieldedA : r.shieldedB,
        shieldOpp: a ? r.shieldedB : r.shieldedA,
        spLeftYou: bt.specialLeft[side],
        spLeftOpp: bt.specialLeft[other(side)],
      };
    };
    this.send(bt.a, view('a'));
    if (bt.b.kind === 'player') this.send(bt.b, view('b'));
    for (const m of this.spectators(bt)) m.conn.send(view('a', true));
  }

  private endFor(p: Player, bt: Battle, result: 'win' | 'lose' | 'draw' | 'flee' | 'over', text: string): void {
    this.send(p, { t: 'b_end', id: bt.id, result, text });
  }

  private finishBattle(bt: Battle): void {
    this.battles.delete(bt.id);
    bt.a.battle = null;
    bt.b.battle = null;
    const a = bt.a;
    const b = bt.b;
    const now = this.now;

    if (bt.kind === 'final' && b.kind === 'player') {
      this.finishDuel(bt, a, b);
      return;
    }

    if (b.kind === 'wild') {
      const wildDown = b.hp <= 0;
      const playerDown = a.hp <= 0;
      if (wildDown) {
        this.wilds.delete(b.id);
        const mhp = this.maxHpOf(a);
        // Faro: cura 50% a mais e dá Essência extra; Rastro: XP extra (tudo dobrado pela Fome, no XP).
        a.hp = playerDown ? Math.round(mhp * BALANCE.wildLossHpPct) : Math.min(mhp, a.hp + mhp * BALANCE.healOnWildPct * a.mods.wildHealMult);
        a.points[b.elem] += 1;
        a.stats.wilds++;
        const ess = this.earn(a, BALANCE.essence.wild + a.mods.wildEssence);
        const hungry = a.hungerUntil > now;
        this.fx({ k: 'c', x: b.x, y: b.y, p: a.id, w: b.id, e: b.elem, ...(hungry ? { x2: 1 as const } : {}) });
        this.endFor(a, bt, 'win', `Você comeu o bicho! +1 de ${ELEM_NAME[b.elem]}${ess ? ` e +${ess} ✨` : ''}${hungry ? ' (Fome: XP em dobro)' : ''}.`);
        this.gainXp(a, (1 + a.mods.wildXp) * (hungry ? BALANCE.hungerXpMult : 1));
      } else if (playerDown) {
        a.hp = Math.round(this.maxHpOf(a) * BALANCE.wildLossHpPct);
        b.hp = b.maxHp;
        this.endFor(a, bt, 'lose', 'O bicho selvagem te nocauteou. Você se recompôs com pouca vida.');
      } else {
        this.wilds.delete(b.id);
        this.endFor(a, bt, 'flee', 'O bicho fugiu!');
      }
      return;
    }

    const pa = a.hp / this.maxHpOf(a);
    const pb = b.hp / this.maxHpOf(b);
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

  /** O twist: quem perde entrega um estágio ao vencedor (ou morre e renasce, se ainda for bebê). */
  private applyPvpOutcome(winner: Player, loser: Player, bt: Battle): void {
    const now = this.now;
    const E = BALANCE.essence;
    const wasCrown = this.crownId === loser.id;
    for (const e of ELEMS) winner.points[e] += Math.round(loser.points[e] * BALANCE.absorbFrac);
    winner.stats.wins++;
    // Essência: vitória, Coroa e o roubo do Predador (tirado do perdedor).
    const stolen = Math.min(loser.essence, winner.mods.stealEssence);
    loser.essence -= stolen;
    // O roubo do Predador é transferência exata; só o ganho passa pelo multiplicador do modo.
    let ess = E.pvpWin + (wasCrown ? E.crown : 0);
    const robbed = stolen > 0 ? ` O Predador roubou ${stolen} ✨.` : '';

    if (loser.stage === 0) {
      ess += E.kill;
      const got = this.earn(winner, ess) + stolen;
      winner.essence += stolen;
      this.endFor(winner, bt, 'win', `Você derrotou ${loser.name}, que volta ao ovo! +${got} ✨`);
      this.endFor(loser, bt, 'lose', `${winner.name} te derrotou. Você vai renascer do ovo.${robbed}`);
      this.pushHistory(winner, `Derrotou ${loser.name}`);
      this.die(loser, winner, 'batalha');
      this.gainXp(winner, 2);
    } else {
      ess = this.earn(winner, ess) + stolen;
      winner.essence += stolen;
      const stolenStage = loser.stage;
      const lost = this.phase === 'final' ? BALANCE.finalLossStages : 1;
      this.setStage(loser, Math.max(0, loser.stage - lost) as Stage, BALANCE.loserHpPct);
      loser.xp = 0;
      loser.shieldUntil = now + BALANCE.hungerShieldMs;
      loser.hungerUntil = now + BALANCE.hungerXpMs;
      const trophy = winner.stage === MAX_STAGE;
      if (!trophy) this.setStage(winner, (winner.stage + 1) as Stage);
      else winner.trophies = Math.min(this.mode.trophyMax, winner.trophies + 1);
      this.fx({ k: 's', x: winner.x, y: winner.y, w: winner.id, l: loser.id, n: (stolenStage - loser.stage) as 1 | 2, ...(trophy ? { tr: 1 as const } : {}), ...(wasCrown ? { cr: 1 as const } : {}) });
      winner.stats.steals++;
      const wName = speciesName(this.look(winner).form, winner.stage);
      this.endFor(
        winner,
        bt,
        'win',
        winner.stage === MAX_STAGE && winner.trophies > 0 && trophy
          ? `Vitória! +1 Troféu (${winner.trophies}/${this.mode.trophyMax}) e +${ess} ✨.`
          : `Vitória! Você roubou um estágio e virou ${wName}. +${ess} ✨`,
      );
      this.endFor(
        loser,
        bt,
        'lose',
        (lost > 1
          ? `Derrota dobrada! ${winner.name} roubou sua evolução e você caiu ${stolenStage - loser.stage} estágio(s).`
          : `${winner.name} roubou sua evolução. Fome ativa: 5s de proteção e XP em dobro por 30s.`) + robbed,
      );
      this.pushHistory(winner, `Roubou de ${loser.name}`);
      this.pushHistory(loser, `Perdeu para ${winner.name}`);
      const what = stolenStage === MAX_STAGE ? 'a forma final' : 'um estágio';
      this.feed(`${winner.name} roubou ${what} de ${loser.name}!`, 'steal');
    }
    if (wasCrown) {
      this.feed(`${winner.name} derrubou a Coroa!`, 'steal');
      this.gainXp(winner, BALANCE.crownXpBonus);
    }
  }

  /**
   * Morte: ninguém sai da partida antes do duelo. Perde parte da Essência e dos pontos de tipo,
   * zera o XP, mantém habilidades e troféus e renasce bebê chocando num tile seguro da zona.
   */
  private die(p: Player, killer: Player | null, reason: 'batalha' | 'zona'): void {
    const look = this.look(p);
    this.fx({ k: 'x', x: p.x, y: p.y, id: p.id, f: look.form, s: look.stage, o: look.order, by: killer?.id ?? 0, r: reason === 'batalha' ? 'b' : 'z' });
    const R = BALANCE.respawn;
    const lostEssence = Math.floor(p.essence * (1 - R.essenceKeep));
    p.essence -= lostEssence;
    let lostPoints = 0;
    for (const e of ELEMS) {
      const l = Math.floor(p.points[e] * (1 - R.pointsKeep));
      p.points[e] -= l;
      lostPoints += l;
    }
    p.stats.deaths++;
    p.xp = 0;
    p.stage = 0;
    p.hp = this.maxHpOf(p);
    p.path = [];
    p.target = null;
    p.targetSeenAt = null;
    p.pendingDest = null;
    p.lastDest = null;
    for (const q of this.players.values()) if (q.target === p.id) q.target = null;
    const by = killer?.name ?? null;
    this.pushHistory(p, by ? `Derrotado por ${by}` : 'Consumido pela zona');
    this.send(p, { t: 'death', by, reason, respawnMs: R.hatchMs, lost: { essence: lostEssence, points: lostPoints } });
    this.feed(by ? `${p.name} foi derrotado por ${by} e vai renascer do ovo.` : `${p.name} foi consumido pela zona e vai renascer do ovo.`, 'elim');
    this.hooks?.eliminated(this, p);

    // Renasce chocando; depois da eclosão vale a Fome (proteção curta e XP em dobro).
    const at = this.respawnSpot(p);
    p.x = at.x;
    p.y = at.y;
    p.nextStepAt = 0;
    p.hatchUntil = this.now + R.hatchMs;
    p.shieldUntil = p.hatchUntil + BALANCE.hungerShieldMs;
    p.hungerUntil = p.hatchUntil + BALANCE.hungerXpMs;
    this.fx({ k: 'r', x: p.x, y: p.y, id: p.id });
    this.pushHistory(p, 'Renasceu');
  }

  /** Tile caminhável dentro da zona, a pelo menos respawn.minDist dos outros (ou o mais longe possível). */
  private respawnSpot(p: Player): Vec {
    const others = this.alivePlayers().filter((q) => q !== p);
    const r = Math.max(1, this.zone.r - 1.5);
    let best: Vec | null = null;
    let bestD = -1;
    for (let tries = 0; tries < 80; tries++) {
      const x = Math.round(this.zone.x + (this.rng.next() * 2 - 1) * r);
      const y = Math.round(this.zone.y + (this.rng.next() * 2 - 1) * r);
      if (!isWalkable(this.map, x, y) || !this.inZone({ x, y }, 1.5)) continue;
      const d = others.reduce((m, q) => Math.min(m, chebyshev(q, { x, y })), Infinity);
      if (d >= BALANCE.respawn.minDist) return { x, y };
      if (d > bestD) {
        best = { x, y };
        bestD = d;
      }
    }
    return best ?? nearestWalkable(this.map, this.zone.x, this.zone.y);
  }

  /** Tira alguém da partida: só no corte do Duelo Final (e o perdedor do duelo). */
  private eliminate(p: Player, place: number, by: Player | null, reason: 'batalha' | 'duelo'): void {
    const look = this.look(p);
    this.fx({ k: 'x', x: p.x, y: p.y, id: p.id, f: look.form, s: look.stage, o: look.order, by: by?.id ?? 0, r: reason === 'batalha' ? 'b' : 'd' });
    p.alive = false;
    p.place = place;
    p.path = [];
    p.target = null;
    p.hatchUntil = 0;
    p.eliminatedBy = by?.name ?? null;
    p.killerId = by?.id ?? null;
    this.pushHistory(p, reason === 'duelo' ? 'Ficou fora do Duelo Final' : `Perdeu o duelo para ${by?.name ?? '?'}`);
    this.send(p, { t: 'elim', by: p.eliminatedBy, place, reason });
    for (const q of this.players.values()) if (q.target === p.id) q.target = null;
    this.hooks?.eliminated(this, p);
  }

  // ---------------------------------------------------------------- duelo final

  /** Ordem pela Força (desempate: menos mortes, mais vitórias, quem entrou antes). */
  private rankByPower(list: Player[]): Player[] {
    const pw = new Map(list.map((p) => [p, this.powerOf(p)]));
    return [...list].sort((p, q) => pw.get(q)! - pw.get(p)! || p.stats.deaths - q.stats.deaths || q.stats.wins - p.stats.wins || p.id - q.id);
  }

  /**
   * Duelo Final: só as 2 maiores Forças continuam. Batalhas em andamento são canceladas
   * sem troca de estágio, os demais saem com a colocação do ranking e os finalistas
   * lutam no centro com HP cheio, sem limite de turnos.
   */
  private startDuel(): void {
    if (this.phase === 'duelo' || this.state !== 'play') return;
    this.phase = 'duelo';
    for (const bt of [...this.battles.values()]) {
      this.battles.delete(bt.id);
      bt.a.battle = null;
      bt.b.battle = null;
      for (const e of [bt.a, bt.b]) {
        if (e.kind !== 'player') continue;
        e.hp = Math.max(1, e.hp);
        this.endFor(e, bt, 'over', 'A arena convocou o Duelo Final! Esta batalha foi cancelada.');
      }
    }
    this.wilds.clear();
    const ranked = this.rankByPower(this.alivePlayers());
    for (const p of ranked) p.duelPower = this.powerOf(p);
    const out = ranked.length - 2;
    for (let i = ranked.length - 1; i >= 2; i--) this.eliminate(ranked[i], i + 1, null, 'duelo');
    const [a, b] = ranked;
    if (!a || !b) return;
    const pa = nearestWalkable(this.map, this.zone.x - 1, this.zone.y);
    const pb = nearestWalkable(this.map, this.zone.x + 1, this.zone.y);
    for (const [p, at] of [
      [a, pa],
      [b, pb],
    ] as const) {
      p.x = at.x;
      p.y = at.y;
      p.path = [];
      p.target = null;
      p.pendingDest = null;
      p.hatchUntil = 0;
      p.hp = this.maxHpOf(p);
      p.shieldUntil = 0;
      p.hungerUntil = 0;
      this.pushHistory(p, 'Chegou ao Duelo Final');
    }
    this.zone.r = this.zone.tr = BALANCE.zone.finalRadius;
    this.duel = { a, b };
    this.hooks?.duel(this, a, b);
    if (out > 0) this.feed(`${out} jogador(es) ficaram de fora: só as 2 maiores Forças seguem.`, 'elim');
    this.feed(`DUELO FINAL: ${a.name} contra ${b.name}! Quem vencer leva a partida.`, 'phase');
    this.startBattle(a, b, 'final');
  }

  private finishDuel(bt: Battle, a: Player, b: Player): void {
    const pa = a.hp / this.maxHpOf(a);
    const pb = b.hp / this.maxHpOf(b);
    let winner: Player;
    if ((a.hp <= 0) !== (b.hp <= 0)) winner = a.hp > 0 ? a : b;
    else if (pa !== pb) winner = pa > pb ? a : b;
    else winner = this.rng.chance(0.5) ? a : b;
    const loser = winner === a ? b : a;
    winner.hp = Math.max(1, winner.hp);
    winner.stats.wins++;
    this.endFor(winner, bt, 'win', 'Você venceu o Duelo Final e a partida!');
    this.endFor(loser, bt, 'lose', `${winner.name} venceu o Duelo Final.`);
    for (const m of this.spectators(bt)) m.conn.send({ t: 'b_end', id: bt.id, result: 'over', text: `${winner.name} venceu o Duelo Final!` });
    this.pushHistory(winner, `Venceu o duelo contra ${loser.name}`);
    this.eliminate(loser, 2, winner, 'batalha');
  }

  // ---------------------------------------------------------------- zona, selvagens, coroa

  private applyZone(dt: number): void {
    const sec = dt / 1000;
    if (this.phase === 'duelo') return;
    // Na fase final, a zona queima até quem está batalhando.
    const endgame = this.phase === 'final';
    for (const p of this.alivePlayers()) {
      if ((p.battle && !endgame) || this.isHatching(p)) continue;
      const mhp = this.maxHpOf(p);
      if (!this.inZone(p)) {
        p.hp -= BALANCE.zone.dpsPct * mhp * sec;
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
      this.die(p, null, 'zona');
      return;
    }
    this.setStage(p, (p.stage - 1) as Stage, BALANCE.loserHpPct);
    this.fx({ k: 'z', x: p.x, y: p.y, id: p.id, s: p.stage });
    p.xp = 0;
    p.shieldUntil = this.now + BALANCE.zoneLossShieldMs;
    this.pushHistory(p, 'Queimado pela zona');
    this.toast(p, 'A zona te queimou: você perdeu um estágio!', true);
  }

  private wildTarget(): number {
    const W = BALANCE.wild;
    // A população não cresce com a arena: nos modos longos os selvagens ficam mais espalhados (economia mais lenta).
    const n = clamp(this.alivePlayers().length * W.perPlayer, W.min, W.max);
    return Math.ceil(n * W.phaseMult[this.phase]);
  }

  private maintainWilds(now: number, burst: boolean): void {
    for (const w of this.wilds.values()) if (!w.battle && !this.inZone(w)) this.wilds.delete(w.id);
    const target = this.wildTarget();
    while (this.wilds.size < target && (burst || now >= this.nextWildAt)) {
      this.nextWildAt = now + 300;
      // O povoamento inicial (burst) não gera eventos.
      if (!this.spawnWild(now, !burst) || !burst) break;
    }
  }

  private spawnWild(now: number, announce = false): boolean {
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
      if (announce) this.fx({ k: 'w', x, y, id: w.id, e: elem });
      return true;
    }
    return false;
  }

  /** A Coroa fica com a maior Força (a partir do Nível 2), com folga para não trocar de dono a cada tick. */
  private updateCrown(now: number): void {
    let best: Player | null = null;
    let bestPw = -1;
    for (const p of this.alivePlayers()) {
      if (p.stage < 1) continue;
      const pw = this.powerOf(p);
      if (pw > bestPw) {
        best = p;
        bestPw = pw;
      }
    }
    const current = this.crownId !== null ? this.players.get(this.crownId) : undefined;
    if (current && current.alive && current.stage >= 1 && best && this.powerOf(current) + CROWN_HYSTERESIS >= bestPw) best = current;
    if (best?.id !== this.crownId) {
      this.crownId = best?.id ?? null;
      if (best && this.phase !== 'coleta' && now - this.lastCrownFeedAt > 10_000) {
        this.lastCrownFeedAt = now;
        this.feed(`${best.name} está com a Coroa. Derrotá-lo vale XP e Essência extra!`, 'info');
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
    if (alive.length > 1 && this.elapsed < this.mode.phases.hardCap) return;
    this.state = 'fim';
    this.endedAt = this.now;
    for (const bt of this.battles.values()) {
      bt.a.battle = null;
      bt.b.battle = null;
    }
    this.battles.clear();
    const ranked = this.rankByPower(alive);
    ranked.forEach((p, i) => {
      p.place = i + 1;
      p.duelPower ??= this.powerOf(p);
    });
    const winner = ranked[0] ?? null;
    if (winner) {
      this.pushHistory(winner, 'Venceu a partida');
      this.feed(`${winner.name} venceu a partida como ${speciesName(this.look(winner).form, winner.stage)}!`, 'phase');
    }
    this.hooks?.matchEnd(this, winner);
    const ranking = this.ranking();
    for (const m of this.members) {
      const p = m.player;
      if (!p) continue;
      m.conn.send({
        t: 'end',
        winner: winner ? { name: winner.name, look: this.look(winner) } : null,
        place: p.place,
        total: this.totalPlayers,
        you: {
          name: p.name,
          look: this.look(p),
          wins: p.stats.wins,
          steals: p.stats.steals,
          wilds: p.stats.wilds,
          deaths: p.stats.deaths,
          power: p.duelPower ?? this.powerOf(p),
          skills: [...p.skills],
          title: titleOf(p.skills)?.name ?? null,
        },
        history: p.history,
        ranking: ranking.map((r) => (r.id === p.id ? { ...r.row, you: true as const } : r.row)),
      });
    }
  }

  /** Ranking completo: 1º e 2º pelo Duelo Final, os demais pela Força no início do duelo. */
  ranking(): { id: number; row: RankRow }[] {
    const finalists = this.duel ? [this.duel.a, this.duel.b] : [];
    return [...this.players.values()]
      .sort((p, q) => (p.place || Infinity) - (q.place || Infinity) || p.id - q.id)
      .map((p) => {
        const row: RankRow = {
          place: p.place,
          name: p.name,
          look: this.look(p),
          power: p.duelPower ?? this.powerOf(p),
          title: titleOf(p.skills)?.name ?? null,
          skills: [...p.skills],
          deaths: p.stats.deaths,
        };
        if (finalists.includes(p)) row.duel = p.place === 1 ? 1 : 2;
        return { id: p.id, row };
      });
  }

  // ---------------------------------------------------------------- snapshots

  private entSnap(e: Entity): EntSnap {
    const look = this.look(e);
    const s: EntSnap = { id: e.id, k: e.kind === 'wild' ? 'w' : 'p', x: e.x, y: e.y, f: look.form, s: look.stage, o: look.order, hp: shownHp(e.hp), mhp: this.maxHpOf(e) };
    if (e.battle) s.b = e.battle.id;
    // Selvagens carregados também mostram a Carga (só visual).
    if (e.battle && e.battle.charged[e.battle.a === e ? 'a' : 'b']) s.ch = 1;
    if (e.kind === 'player') {
      s.n = e.name;
      if (this.crownId === e.id) s.cr = 1;
      if (e.shieldUntil > this.now) s.sh = 1;
      if (e.trophies) s.tr = e.trophies;
      if (this.isHatching(e)) s.hx = 1;
      const t = titleOf(e.skills);
      if (t) {
        s.ln = t.line;
        s.tl = t.level;
      }
    }
    return s;
  }

  /** Quem a câmera de um jogador segue: ele mesmo, ou quem ele assiste depois de sair da partida. */
  viewOf(p: Player): Player | null {
    if (p.alive) return p;
    const killer = p.killerId !== null ? this.players.get(p.killerId) : undefined;
    if (killer?.alive) return killer;
    const crown = this.crownId !== null ? this.players.get(this.crownId) : undefined;
    if (crown?.alive) return crown;
    return this.alivePlayers()[0] ?? null;
  }

  private sendSnapshots(): void {
    // Sem humanos na sala (simulação ou só bots), não há para quem montar snapshots.
    if (this.members.size === 0) {
      this.fxq.length = 0;
      return;
    }
    const R = BALANCE.viewRadius;
    const power = new Map<Player, number>();
    const lb: LeaderRow[] = this.rankByPower(this.alivePlayers()).map((p) => {
      const pw = this.powerOf(p);
      power.set(p, pw);
      const row: LeaderRow = { id: p.id, n: p.name, s: p.stage, f: this.look(p).form, pw };
      if (p.id === this.crownId) row.cr = 1;
      const t = titleOf(p.skills);
      if (t) {
        row.ln = t.line;
        row.tl = t.level;
      }
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
      // Eventos no raio de visão (+1 para o que está saindo da tela); o 'x' e o 'r' do próprio jogador vão sempre.
      let fx: FxEvent[] | undefined;
      if (this.fxq.length > 0) {
        const RF = R + 1;
        for (const ev of this.fxq) {
          if ((Math.abs(ev.x - v.x) <= RF && Math.abs(ev.y - v.y) <= RF) || ((ev.k === 'x' || ev.k === 'r') && ev.id === p.id)) (fx ??= []).push(ev);
        }
      }
      const look = this.look(p);
      const snap: Snap = {
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
        duel: this.duel ? { a: this.duel.a.name, b: this.duel.b.name } : null,
        me: {
          id: p.id,
          x: p.x,
          y: p.y,
          look,
          xp: p.xp,
          xpNeed: p.stage < MAX_STAGE ? BALANCE.xpToEvolve[p.stage] : 0,
          hp: shownHp(p.hp),
          mhp: this.maxHpOf(p),
          points: p.points,
          trophies: p.trophies,
          shieldMs: Math.max(0, p.shieldUntil - this.now),
          hungerMs: Math.max(0, p.hungerUntil - this.now),
          alive: p.alive,
          crown: this.crownId === p.id,
          battle: p.battle?.id ?? null,
          target: p.target,
          essence: p.essence,
          skills: p.skills,
          power: power.get(p) ?? p.duelPower ?? this.powerOf(p),
          deaths: p.stats.deaths,
          hatchMs: Math.max(0, p.hatchUntil - this.now),
        },
      };
      if (fx) snap.fx = fx; // sem evento, sem chave
      m.conn.send(snap);
    }
    this.fxq.length = 0;
  }
}
