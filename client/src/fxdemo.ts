import {
  BALANCE,
  FX_CHARGED,
  FX_CLASH,
  FX_KO,
  encodeTiles,
  generateMap,
  isWalkable,
  maxHp,
  type Action,
  type Elem,
  type EntSnap,
  type Form,
  type FxEvent,
  type Phase,
  type ServerMsg,
  type Snap,
  type Stage,
} from '@vb/shared';
import type { GameScene } from './scenes/GameScene';

/**
 * Modo de demonstração dos efeitos (só desenvolvimento): ?fxdemo na URL.
 * Não abre conexão: gera um mapa, monta snapshots a 10 Hz e injeta FxEvents
 * sintéticos em sequência. ?fxdemo=<cena> repete só uma cena.
 */

interface Ctx {
  onMsg: (m: ServerMsg) => void;
  scene: GameScene;
  name: string;
}

type Step = [number, () => void];
interface Scene {
  ms: number;
  steps: () => Step[];
}

const ME = 1;

export function runFxDemo({ onMsg, scene, name }: Ctx): void {
  const map = generateMap(20260927, 8);
  const cx = Math.floor(map.w / 2);
  const cy = Math.floor(map.h / 2);
  // Um tile caminhável perto do centro, com vizinhos livres.
  let mx = cx;
  let my = cy;
  search: for (let r = 0; r < 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        let ok = true;
        for (let yy = -3; yy <= 3 && ok; yy++) for (let xx = -4; xx <= 4 && ok; xx++) ok = isWalkable(map, cx + dx + xx, cy + dy + yy);
        if (ok) {
          mx = cx + dx;
          my = cy + dy;
          break search;
        }
      }
    }
  }

  const ents = new Map<number, EntSnap>();
  const battles = new Map<number, { id: number; x: number; y: number }>();
  let queue: FxEvent[] = [];
  let nextId = 100;
  let ph: Phase = 'cacada';
  let el = 150_000;
  let z = { x: mx, y: my, r: 14, tr: 10 };
  let alive = true;
  let view = ME;
  let duel: { a: string; b: string } | null = null;

  const player = (id: number, n: string, x: number, y: number, f: Form, s: Stage, o: Elem[]): EntSnap => {
    const e: EntSnap = { id, k: 'p', n, x, y, f, s, o, hp: maxHp(s), mhp: maxHp(s) };
    ents.set(id, e);
    return e;
  };
  const wild = (x: number, y: number, el: Elem): EntSnap => {
    const e: EntSnap = { id: nextId++, k: 'w', x, y, f: el, s: 1, o: [el], hp: 12, mhp: 12 };
    ents.set(e.id, e);
    return e;
  };
  const setLook = (e: EntSnap, f: Form, s: Stage, o: Elem[]) => {
    e.f = f;
    e.s = s;
    e.o = o;
    e.mhp = e.k === 'p' ? maxHp(s) : e.mhp;
    e.hp = Math.min(e.hp, e.mhp);
  };
  const battle = (a: EntSnap, b: EntSnap): number => {
    const id = nextId++;
    battles.set(id, { id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    a.b = b.b = id;
    return id;
  };
  const endBattle = (id: number) => {
    battles.delete(id);
    for (const e of ents.values()) if (e.b === id) delete e.b;
  };
  const hit = (a: EntSnap, d: EntSnap, v: number, act: Action, m: -1 | 0 | 1, fl = 0) => {
    const bt = a.b ?? d.b ?? 0;
    const b = battles.get(bt);
    d.hp = Math.max(0, d.hp - v);
    if (d.hp <= 0) fl |= FX_KO;
    queue.push({ k: 'h', x: b?.x ?? d.x, y: b?.y ?? d.y, bt, a: a.id, d: d.id, v, act, m, fl, hp: d.hp });
  };

  let panel = 0;
  const reset = () => {
    // Fecha o painel de uma batalha que a troca de cena interrompeu.
    if (panel) onMsg({ t: 'b_end', id: panel, result: 'over', text: '' });
    panel = 0;
    ents.clear();
    battles.clear();
    queue = [];
    ph = 'cacada';
    el = 150_000;
    z = { x: mx, y: my, r: 14, tr: 10 };
    alive = true;
    view = ME;
    duel = null;
    player(ME, 'Você', mx, my, 'brasa', 2, ['brasa']);
  };

  // ---------------------------------------------------------------- cenas

  const SCENES: Record<string, Scene> = {
    feiticos: {
      ms: 9600,
      steps: () => {
        const a = player(nextId++, 'Rival', mx - 2, my + 2, 'brasa', 2, ['brasa']);
        const b = player(nextId++, 'Nina', mx - 1, my + 2, 'broto', 2, ['broto']);
        const c = player(nextId++, 'Zeca', mx + 2, my - 2, 'mare', 2, ['mare']);
        const w = wild(mx + 3, my - 2, 'brasa');
        battle(a, b);
        battle(c, w);
        const looks: [Form, Stage, Elem[]][] = [
          ['brasa', 2, ['brasa']],
          ['mare', 2, ['mare']],
          ['broto', 2, ['broto']],
          ['vapor', 2, ['brasa', 'mare']],
          ['cinza', 3, ['broto', 'brasa']],
          ['mangue', 2, ['mare', 'broto']],
          ['quimera', 3, ['brasa', 'mare', 'broto']],
          ['neutro', 0, []],
        ];
        const steps: Step[] = [];
        looks.forEach(([f, s, o], i) => {
          steps.push([i * 1100, () => setLook(a, f, s, o)]);
          steps.push([i * 1100 + 400, () => hit(a, b, 9 + i, 'ataque', i < 3 ? 1 : 0)]);
          if (i % 2 === 0) steps.push([i * 1100 + 700, () => hit(c, w, 3, 'ataque', 1)]);
          steps.push([i * 1100 + 1000, () => (b.hp = b.mhp)]);
        });
        return steps;
      },
    },
    impacto: {
      ms: 8400,
      steps: () => {
        const a = player(nextId++, 'Rival', mx - 2, my + 2, 'mare', 2, ['mare']);
        const b = player(nextId++, 'Nina', mx - 1, my + 2, 'broto', 2, ['broto']);
        const c = player(nextId++, 'Zeca', mx + 2, my + 1, 'brasa', 3, ['brasa']);
        const d = player(nextId++, 'Bia', mx + 3, my + 1, 'mare', 1, ['mare']);
        battle(a, b);
        battle(c, d);
        return [
          [300, () => hit(a, b, 6, 'ataque', -1)],
          [1400, () => hit(b, a, 8, 'defesa', 1)],
          [2500, () => hit(c, d, 12, 'carga', -1)],
          [3600, () => (c.ch = 1)],
          [3700, () => hit(c, d, 24, 'ataque', -1, FX_CHARGED)],
          [3800, () => delete c.ch],
          [4900, () => {
            hit(a, b, 7, 'ataque', 1, FX_CLASH);
            hit(b, a, 7, 'ataque', -1, FX_CLASH);
          }],
          [6200, () => hit(c, d, 40, 'ataque', -1)],
          [7800, () => {
            // o KO termina num roubo
            queue.push({ k: 's', x: c.x, y: c.y, w: c.id, l: d.id, n: 1, tr: 1 });
            endBattle(d.b ?? 0);
            setLook(d, 'mare', 0, ['mare']);
          }],
        ];
      },
    },
    batalha: {
      ms: 9000,
      steps: () => {
        const me = ents.get(ME)!;
        const o = player(nextId++, 'Rival', mx + 1, my, 'broto', 2, ['broto']);
        let bt = 0;
        const info = (e: EntSnap) => ({ name: e.n ?? 'Selvagem', look: { form: e.f, stage: e.s, order: e.o }, hp: e.hp, mhp: e.mhp, charged: !!e.ch, trophies: 0, wild: e.k === 'w' });
        const reveal = (turn: number, you: Action, opp: Action, dYou: number, dOpp: number, winner: 'you' | 'opp' | 'tie', text: string) =>
          onMsg({ t: 'b_reveal', id: bt, turn, you, opp, dmgYou: dYou, dmgOpp: dOpp, hpYou: me.hp, hpOpp: o.hp, chYou: false, chOpp: false, winner, text });
        return [
          [200, () => {
            bt = battle(me, o);
            queue.push({ k: 'bt', x: mx + 0.5, y: my, id: bt, a: ME, b: o.id, kd: 'p' });
            panel = bt;
            onMsg({ t: 'b_start', id: bt, kind: 'pvp', you: info(me), opp: info(o), turn: 1, ms: 5000 });
          }],
          [1600, () => {
            hit(me, o, 27, 'ataque', 1);
            reveal(1, 'ataque', 'carga', 0, 27, 'you', 'Seu Ataque venceu a Carga!');
          }],
          [3400, () => {
            onMsg({ t: 'b_turn', id: bt, turn: 2, ms: 5000 });
          }],
          [4200, () => {
            hit(o, me, 30, 'ataque', -1);
            reveal(2, 'carga', 'ataque', 30, 0, 'opp', 'O Ataque dele venceu sua Carga.');
          }],
          [6000, () => {
            hit(me, o, 40, 'ataque', 1);
            reveal(3, 'ataque', 'carga', 0, 40, 'you', 'Nocaute!');
          }],
          [7000, () => {
            queue.push({ k: 's', x: me.x, y: me.y, w: ME, l: o.id, n: 1 });
            endBattle(bt);
            setLook(me, 'cinza', 3, ['brasa', 'broto']);
            setLook(o, 'broto', 1, ['broto']);
            panel = 0;
            onMsg({ t: 'b_end', id: bt, result: 'win', text: 'Você roubou a evolução!' });
          }],
        ];
      },
    },
    evolucao: {
      ms: 7600,
      steps: () => {
        const me = ents.get(ME)!;
        setLook(me, 'brasa', 1, ['brasa']);
        const b = player(nextId++, 'Nina', mx + 3, my + 1, 'mare', 1, ['mare']);
        return [
          [400, () => {
            setLook(me, 'brasa', 2, ['brasa']);
            queue.push({ k: 'v', x: me.x, y: me.y, id: ME, s: 2 });
          }],
          [1800, () => {
            setLook(b, 'mare', 2, ['mare']);
            queue.push({ k: 'v', x: b.x, y: b.y, id: b.id, s: 2 });
          }],
          [3000, () => {
            setLook(me, 'vapor', 3, ['brasa', 'mare']);
            queue.push({ k: 'v', x: me.x, y: me.y, id: ME, s: 3 });
          }],
          [5400, () => {
            setLook(me, 'vapor', 2, ['brasa', 'mare']);
            me.hp = Math.round(me.mhp / 2);
            queue.push({ k: 'z', x: me.x, y: me.y, id: ME, s: 2 });
          }],
        ];
      },
    },
    roubo: {
      ms: 7000,
      steps: () => {
        const a = player(nextId++, 'Rival', mx - 3, my + 2, 'brasa', 3, ['brasa']);
        const b = player(nextId++, 'Nina', mx - 1, my + 2, 'broto', 2, ['broto', 'mare']);
        a.tr = 1;
        b.cr = 1;
        const me = ents.get(ME)!;
        const c = player(nextId++, 'Zeca', mx + 2, my - 1, 'mangue', 3, ['mare', 'broto']);
        return [
          [300, () => {
            queue.push({ k: 's', x: a.x, y: a.y, w: a.id, l: b.id, n: 1, tr: 1, cr: 1 });
            a.tr = 2;
            a.cr = 1;
            delete b.cr;
            setLook(b, 'broto', 1, ['broto', 'mare']);
          }],
          [3200, () => {
            queue.push({ k: 's', x: me.x, y: me.y, w: ME, l: c.id, n: 2 });
            setLook(me, 'brasa', 3, ['brasa']);
            setLook(c, 'mangue', 1, ['mare', 'broto']);
          }],
        ];
      },
    },
    eliminacao: {
      ms: 6600,
      steps: () => {
        const a = player(nextId++, 'Rival', mx - 2, my + 2, 'brasa', 2, ['brasa']);
        const b = player(nextId++, 'Ovinho', mx - 1, my + 2, 'mare', 0, ['mare']);
        const c = player(nextId++, 'Zeca', mx + 3, my - 1, 'mangue', 0, ['mare', 'broto']);
        const d = player(nextId++, 'Bia', mx + 2, my + 2, 'quimera', 3, ['brasa', 'mare', 'broto']);
        return [
          [400, () => {
            ents.delete(b.id);
            queue.push({ k: 'x', x: b.x, y: b.y, id: b.id, f: b.f, s: b.s, o: b.o, by: a.id, r: 'b' });
          }],
          [2400, () => {
            ents.delete(c.id);
            queue.push({ k: 'x', x: c.x, y: c.y, id: c.id, f: c.f, s: c.s, o: c.o, by: 0, r: 'z' });
          }],
          [4400, () => {
            ents.delete(d.id);
            queue.push({ k: 'x', x: d.x, y: d.y, id: d.id, f: d.f, s: d.s, o: d.o, by: 0, r: 'd' });
          }],
        ];
      },
    },
    zona: {
      ms: 9000,
      steps: () => {
        z = { x: mx - 7, y: my, r: 6.5, tr: 4 };
        const b = player(nextId++, 'Nina', mx - 2, my + 1, 'mare', 2, ['mare']);
        return [
          [100, () => {
            const me = ents.get(ME)!;
            me.hp -= 4;
            b.hp -= 4;
          }],
          [800, () => {
            const me = ents.get(ME)!;
            me.hp -= 6;
          }],
          [3000, () => {
            ph = 'final';
            el = 250_000;
          }],
          [6000, () => {
            ph = 'duelo';
            el = 300_000;
            z = { x: mx - 5, y: my, r: 6, tr: 6 };
            duel = { a: 'Você', b: 'Nina' };
          }],
        ];
      },
    },
    minhamorte: {
      ms: 4000,
      steps: () => {
        const me = ents.get(ME)!;
        setLook(me, 'brasa', 0, ['brasa']);
        const a = player(nextId++, 'Rival', mx + 2, my, 'broto', 3, ['broto']);
        return [
          [600, () => {
            ents.delete(ME);
            alive = false;
            view = a.id;
            queue.push({ k: 'x', x: me.x, y: me.y, id: ME, f: me.f, s: me.s, o: me.o, by: a.id, r: 'b' });
          }],
        ];
      },
    },
  };

  // ---------------------------------------------------------------- relógio

  const order = name && SCENES[name] ? [name] : Object.keys(SCENES);
  let idx = -1;
  let t0 = 0;
  let steps: Step[] = [];
  let cur = '';
  const start = (n: string) => {
    reset();
    cur = n;
    steps = SCENES[n].steps().sort((p, q) => p[0] - q[0]);
    t0 = performance.now();
  };
  const next = () => {
    idx = (idx + 1) % order.length;
    start(order[idx]);
  };

  const snapshot = (): Snap => {
    const me = ents.get(ME);
    const v = ents.get(view) ?? me;
    const R = BALANCE.viewRadius;
    const list: EntSnap[] = [];
    for (const e of ents.values()) if (!v || (Math.abs(e.x - v.x) <= R && Math.abs(e.y - v.y) <= R)) list.push({ ...e, o: [...e.o] });
    const fx = queue.length ? queue : undefined;
    queue = [];
    return {
      t: 'snap',
      el,
      ph,
      z: { ...z },
      al: [...ents.values()].filter((e) => e.k === 'p').length,
      ents: list,
      bs: [...battles.values()],
      fr: map.fruits.map((_, i) => i),
      me: {
        id: ME,
        x: me?.x ?? mx,
        y: me?.y ?? my,
        look: { form: me?.f ?? 'neutro', stage: me?.s ?? 0, order: me?.o ?? [] },
        xp: 0,
        xpNeed: 3,
        hp: me?.hp ?? 0,
        mhp: me?.mhp ?? 40,
        points: { brasa: 3, mare: 0, broto: 0 },
        trophies: 0,
        shieldMs: 0,
        hungerMs: 0,
        alive,
        crown: false,
        battle: me?.b ?? null,
        target: null,
      },
      view: v?.id ?? null,
      crown: null,
      lb: [],
      duel,
      ...(fx ? { fx } : {}),
    };
  };

  onMsg({ t: 'start', you: ME, w: map.w, h: map.h, tiles: encodeTiles(map.tiles), fruits: map.fruits, players: 8 });
  next();
  window.setInterval(() => {
    const t = performance.now() - t0;
    while (steps.length && steps[0][0] <= t) steps.shift()![1]();
    el += 100;
    onMsg(snapshot());
    if (t >= SCENES[cur].ms) next();
  }, 100);

  (window as unknown as { __fxdemo: unknown }).__fxdemo = {
    scenes: Object.keys(SCENES),
    play: (n: string) => {
      const i = order.indexOf(n);
      if (i >= 0) idx = i;
      start(n);
    },
    current: () => ({ scene: cur, t: performance.now() - t0 }),
    stats: () => scene.fxStats(),
    scene,
  };
}
