import {
  BALANCE,
  FORMS,
  FORM_LABEL,
  FX_CHARGED,
  FX_CLASH,
  FX_KO,
  STAGE_LABEL,
  encodeTiles,
  generateMap,
  isWalkable,
  maxHp,
  speciesName,
  type Action,
  type Elem,
  type EntSnap,
  type Form,
  type FxEvent,
  type Line,
  type Phase,
  type ServerMsg,
  type SkillId,
  type Snap,
  type SpecialKind,
  type Stage,
} from '@vb/shared';
import { creatureImg, eggImg } from './render/creature';
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
type Tile = [number, number];

const ME = 1;
const HATCH = BALANCE.respawn.hatchMs;
/** Elementos de exemplo de cada forma (tabela de bebês). */
const ORDER_OF: Record<Form, Elem[]> = {
  neutro: [],
  brasa: ['brasa'],
  mare: ['mare'],
  broto: ['broto'],
  vapor: ['brasa', 'mare'],
  cinza: ['brasa', 'broto'],
  mangue: ['mare', 'broto'],
  quimera: ['brasa', 'mare', 'broto'],
};

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
  let hunger = 0;
  let target: number | null = null;
  let crown: { x: number; y: number } | null = null;
  let dest: Tile | null = null;
  const frOff = new Set<number>();
  // Chocando: id → instante da cena em que o hx cai.
  const hatching = new Map<number, number>();
  let mySkills: SkillId[] = [];
  let deaths = 0;
  let sceneT = 0;
  let overlay: HTMLElement | null = null;
  /** Tiles já ocupados pela cena atual (para espalhar os ovos sem sobrepor). */
  const taken = new Set<number>();
  // Andadores: cada um anda 1 tile a cada `every` ms pelo caminho (em loop).
  let walkers: { e: EntSnap; path: Tile[]; i: number; acc: number; every: number }[] = [];
  const walk = (e: EntSnap, path: Tile[], every: number = BALANCE.stepMs) => walkers.push({ e, path, i: 0, acc: 0, every });
  const loop = (x0: number, y0: number, w: number, h: number): Tile[] => {
    const p: Tile[] = [];
    for (let x = x0; x < x0 + w; x++) p.push([x, y0]);
    for (let y = y0; y < y0 + h; y++) p.push([x0 + w, y]);
    for (let x = x0 + w; x > x0; x--) p.push([x, y0 + h]);
    for (let y = y0 + h; y > y0; y--) p.push([x0, y]);
    return p;
  };
  const JX = 30;
  const JY = 19;

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
  const pendingSteps: Step[] = [];
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
    hunger = 0;
    target = null;
    crown = null;
    dest = null;
    frOff.clear();
    walkers = [];
    hatching.clear();
    taken.clear();
    mySkills = [];
    deaths = 0;
    overlay?.remove();
    overlay = null;
    player(ME, 'Você', mx, my, 'brasa', 2, ['brasa']);
  };
  /** Tile caminhável e livre mais perto de (x, y). */
  const near = (x: number, y: number): Tile => {
    for (let r = 0; r < 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const tx = x + dx;
          const ty = y + dy;
          const k = ty * map.w + tx;
          if (isWalkable(map, tx, ty) && !taken.has(k) && !(tx === mx && ty === my)) {
            taken.add(k);
            return [tx, ty];
          }
        }
      }
    }
    return [x, y];
  };
  /** Começa a chocar: o ovo surge no brilho ('r') e o hx cai depois de hatchMs. */
  const hatchEv = (e: EntSnap) => {
    e.hx = 1;
    e.hp = e.mhp;
    hatching.set(e.id, sceneT + HATCH);
    queue.push({ k: 'r', x: e.x, y: e.y, id: e.id });
  };
  /** Morte ('x') e, se renascer, volta como bebê chocando em (x, y) depois de delay ms (0 = no mesmo snapshot). */
  const dieEv = (e: EntSnap, by: number, r: 'b' | 'z', at: Tile | null, delay = 0) => {
    queue.push({ k: 'x', x: e.x, y: e.y, id: e.id, f: e.f, s: e.s, o: e.o, by, r });
    ents.delete(e.id);
    if (e.id === ME) {
      deaths++;
      onMsg({ t: 'death', by: by ? (ents.get(by)?.n ?? null) : null, reason: r === 'z' ? 'zona' : 'batalha', respawnMs: delay, lost: { essence: 2, points: 3 } });
    }
    if (!at) return;
    const reborn = () => {
      e.x = at[0];
      e.y = at[1];
      delete e.b;
      setLook(e, e.f, 0, e.o);
      ents.set(e.id, e);
      hatchEv(e);
    };
    if (delay <= 0) reborn();
    else pendingSteps.push([sceneT + delay, reborn]);
  };
  const buyEv = (e: EntSnap, id: SkillId, ln?: Line, tl?: 1 | 2) => {
    queue.push({ k: 'k', x: e.x, y: e.y, id: e.id, s: id });
    if (e.id === ME) mySkills = [...mySkills, id];
    if (ln && tl) {
      e.ln = ln;
      e.tl = tl;
    }
  };
  const special = (a: EntSnap, d: EntSnap, v: number, sp: SpecialKind) => {
    const bt = a.b ?? d.b ?? 0;
    const b = battles.get(bt);
    d.hp = Math.max(0, d.hp - v);
    queue.push({ k: 'h', x: b?.x ?? d.x, y: b?.y ?? d.y, bt, a: a.id, d: d.id, v, act: 'especial', m: 0, fl: d.hp <= 0 ? FX_KO : 0, hp: d.hp, sp });
  };
  const moveMe = (x: number, y: number) => {
    const me = ents.get(ME)!;
    me.x = x;
    me.y = y;
  };
  const eatEv = (p: EntSnap, w: EntSnap, x2 = false) => {
    ents.delete(w.id);
    if (w.b) endBattle(w.b);
    p.hp = Math.min(p.mhp, p.hp + Math.round(p.mhp * 0.15));
    queue.push({ k: 'c', x: w.x, y: w.y, p: p.id, w: w.id, e: w.o[0], ...(x2 ? { x2: 1 as const } : {}) });
  };
  const spawnEv = (x: number, y: number, e: Elem) => {
    const w = wild(x, y, e);
    queue.push({ k: 'w', x, y, id: w.id, e });
    return w;
  };
  const btEv = (a: EntSnap, b: EntSnap, kd: 'p' | 'w' | 'f' = b.k === 'w' ? 'w' : 'p') => {
    const id = battle(a, b);
    queue.push({ k: 'bt', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, id, a: a.id, b: b.id, kd });
    return id;
  };

  // ---------------------------------------------------------------- cenas

  const SCENES: Record<string, Scene> = {
    // Tabela (sobreposta ao mundo): ovo, bebê, filhote, adulto e forma final de cada forma.
    tabela: {
      ms: 6000,
      steps: () => {
        const small = window.innerWidth < 600;
        const sc = small ? 2 : 3;
        const el = document.createElement('div');
        el.style.cssText =
          'position:fixed;inset:0;z-index:60;overflow:auto;background:rgba(11,7,22,0.94);color:#fffaf0;font:700 11px Nunito,sans-serif;display:flex;align-items:flex-start;justify-content:center;padding:12px 4px;box-sizing:border-box';
        // No celular uma coluna de formas; no computador duas, lado a lado.
        const blocks = small ? 1 : 2;
        const grid = document.createElement('div');
        const cols = `${small ? 52 : 64}px repeat(5,${32 * sc}px)`;
        grid.style.cssText = `display:grid;grid-template-columns:${blocks === 2 ? `${cols} 24px ${cols}` : cols};gap:${small ? 2 : 4}px ${small ? 4 : 8}px;align-items:center;justify-items:center`;
        const cell = (txt: string) => {
          const d = document.createElement('div');
          d.textContent = txt;
          d.style.cssText = 'text-align:center;line-height:1.1';
          return d;
        };
        const head = () => [cell(''), cell('Ovo'), ...STAGE_LABEL.map((l, i) => cell(`${l} (N${i + 1})`))];
        const row = (f: Form) => {
          const order = ORDER_OF[f];
          const out: HTMLElement[] = [cell(`${FORM_LABEL[f]}\n${speciesName(f, 0)}`), eggImg({ form: f, stage: 0, order }, sc, { variant: FORMS.indexOf(f) })];
          out[0].style.whiteSpace = 'pre-line';
          for (let st = 0; st < 4; st++) out.push(creatureImg({ form: f, stage: st as Stage, order }, sc));
          return out;
        };
        grid.append(...head(), ...(blocks === 2 ? [cell(''), ...head()] : []));
        const per = FORMS.length / blocks;
        for (let i = 0; i < per; i++) {
          grid.append(...row(FORMS[i]));
          if (blocks === 2) grid.append(cell(''), ...row(FORMS[i + per]));
        }
        el.append(grid);
        document.body.append(el);
        overlay = el;
        return [];
      },
    },
    // Os bebês de todas as formas em volta de você (também bebê).
    bebes: {
      ms: 7000,
      steps: () => {
        const me = ents.get(ME)!;
        setLook(me, 'brasa', 0, ['brasa']);
        me.n = 'Você';
        const list = FORMS.map((f, i) => {
          const a = (i / FORMS.length) * Math.PI * 2;
          const [x, y] = near(mx + Math.round(Math.cos(a) * 3), my + Math.round(Math.sin(a) * 2.4));
          return player(nextId++, speciesName(f, 0), x, y, f, 0, ORDER_OF[f]);
        });
        return [
          [2500, () => walk(list[1], loop(list[1].x, list[1].y, 1, 1))],
          [2600, () => walk(list[5], loop(list[5].x, list[5].y, 1, 1))],
          // Um bebê evolui para filhote no meio da roda.
          [4200, () => {
            setLook(list[3], 'broto', 1, ['broto']);
            list[3].n = speciesName('broto', 1);
            queue.push({ k: 'v', x: list[3].x, y: list[3].y, id: list[3].id, s: 1 });
          }],
        ];
      },
    },
    // Começo da partida: todos chocam ao mesmo tempo e estouram juntos (orçamento de partículas).
    eclosao: {
      ms: 6000,
      steps: () => [
        [0, () => {
          onMsg(startMsg());
          ph = 'coleta';
          el = 0;
          const me = ents.get(ME)!;
          setLook(me, 'neutro', 0, []);
          hatchEv(me);
          for (let i = 0; i < 13; i++) {
            const a = (i / 13) * Math.PI * 2 + 0.3;
            const r = 2.5 + (i % 3) * 1.6;
            const [x, y] = near(mx + Math.round(Math.cos(a) * r), my + Math.round(Math.sin(a) * r * 0.8));
            // No começo todos são neutros; alguns renascidos já têm cor (manchas no ovo).
            const f = i < 9 ? 'neutro' : FORMS[i - 8];
            hatchEv(player(nextId++, `Bot${i + 1}`, x, y, f, 0, ORDER_OF[f]));
          }
        }],
      ],
    },
    // Morte e renascimento: no mesmo snapshot, com atraso, e o seu (a câmera acompanha).
    renascer: {
      ms: 10000,
      steps: () => {
        const me = ents.get(ME)!;
        setLook(me, 'mare', 1, ['mare']);
        const a = player(nextId++, 'Rival', mx - 2, my + 2, 'brasa', 3, ['brasa']);
        const b = player(nextId++, 'Nina', mx - 1, my + 2, 'broto', 0, ['broto', 'mare']);
        const c = player(nextId++, 'Zeca', mx + 3, my - 1, 'vapor', 1, ['brasa', 'mare']);
        a.ln = 'guerreiro';
        a.tl = 2;
        taken.add(b.y * map.w + b.x);
        return [
          [200, () => btEv(a, b)],
          [700, () => hit(a, b, 60, 'ataque', 1)],
          // Renasce no mesmo snapshot do 'x', com o mesmo id, longe dali.
          [1500, () => {
            endBattle(a.b ?? 0);
            dieEv(b, a.id, 'b', near(mx + 4, my + 3));
          }],
          // A zona leva o Zeca; ele volta 1,2 s depois.
          [4200, () => dieEv(c, 0, 'z', near(mx - 4, my - 2), 1200)],
          // Você morre e renasce 6 tiles para lá (a câmera desliza até o ovo).
          [6200, () => dieEv(me, a.id, 'b', near(mx + 6, my - 1), 900)],
        ];
      },
    },
    // Os três Especiais entre outros bichos e depois em você (tremor forte).
    especiais: {
      ms: 11000,
      steps: () => {
        const me = ents.get(ME)!;
        me.ln = 'mago';
        me.tl = 1;
        const a = player(nextId++, 'Rival', mx - 4, my - 2, 'brasa', 3, ['brasa']);
        const b = player(nextId++, 'Nina', mx - 3, my - 2, 'broto', 2, ['broto']);
        const c = player(nextId++, 'Zeca', mx + 2, my - 2, 'mare', 2, ['mare']);
        const d = player(nextId++, 'Bia', mx + 3, my - 2, 'cinza', 2, ['brasa', 'broto']);
        const e = player(nextId++, 'Tico', mx - 2, my + 2, 'broto', 2, ['broto']);
        const f = player(nextId++, 'Lia', mx - 1, my + 2, 'mare', 1, ['mare']);
        const g = player(nextId++, 'Duda', mx + 1, my, 'cinza', 3, ['broto', 'brasa']);
        a.ln = 'guerreiro';
        a.tl = 2;
        c.ln = 'mago';
        c.tl = 2;
        e.ln = 'cacador';
        e.tl = 1;
        g.ln = 'guerreiro';
        g.tl = 1;
        return [
          [100, () => {
            battle(a, b);
            battle(c, d);
            battle(e, f);
          }],
          [400, () => special(a, b, 26, 'brutal')],
          [1900, () => special(c, d, 22, 'arcana')],
          [3400, () => special(e, f, 18, 'armadilha')],
          [5000, () => {
            b.hp = b.mhp;
            d.hp = d.mhp;
            f.hp = f.mhp;
            battle(g, me);
          }],
          // Em você: Brutal do oponente, sua Arcana e a Armadilha dele.
          [5400, () => special(g, me, 30, 'brutal')],
          [7200, () => special(me, g, 24, 'arcana')],
          [9000, () => special(g, me, 16, 'armadilha')],
        ];
      },
    },
    // Compra na loja: brilho na cor da linha e o distintivo aparecendo ao lado do nome.
    compra: {
      ms: 8000,
      steps: () => {
        const me = ents.get(ME)!;
        const a = player(nextId++, 'Rival', mx - 2, my + 1, 'brasa', 2, ['brasa']);
        const b = player(nextId++, 'Nina', mx + 2, my + 1, 'broto', 2, ['broto']);
        const c = player(nextId++, 'Zeca', mx + 1, my + 1, 'mare', 1, ['mare']);
        return [
          [300, () => buyEv(me, 'm_foco')],
          [900, () => buyEv(a, 'g_couro')],
          [1500, () => buyEv(b, 'c_passos')],
          [2100, () => buyEv(me, 'm_canal', 'mago', 1)],
          [2700, () => buyEv(a, 'g_pesado', 'guerreiro', 1)],
          [3300, () => buyEv(b, 'c_faro', 'cacador', 1)],
          [3900, () => buyEv(c, 'm_escudo')],
          [4500, () => buyEv(a, 'g_contra')],
          [5100, () => buyEv(a, 'g_brutal', 'guerreiro', 2)],
          [5700, () => buyEv(me, 'm_escudo')],
          [6300, () => buyEv(me, 'm_arcana', 'mago', 2)],
          // Nomes colados numa batalha: o distintivo entra na separação dos rótulos.
          [6900, () => battle(b, c)],
        ];
      },
    },
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
        const info = (e: EntSnap) => ({
          name: e.n ?? 'Selvagem',
          look: { form: e.f, stage: e.s, order: e.o },
          hp: e.hp,
          mhp: e.mhp,
          charged: !!e.ch,
          trophies: 0,
          wild: e.k === 'w',
          skills: [],
          special: null,
          specialLeft: 0,
        });
        const reveal = (turn: number, you: Exclude<Action, 'especial'>, opp: Exclude<Action, 'especial'>, dYou: number, dOpp: number, winner: 'you' | 'opp' | 'tie', text: string) =>
          onMsg({
            t: 'b_reveal',
            id: bt,
            turn,
            you,
            opp,
            dmgYou: dYou,
            dmgOpp: dOpp,
            hpYou: me.hp,
            hpOpp: o.hp,
            chYou: false,
            chOpp: false,
            winner,
            text,
            moveYou: you,
            moveOpp: opp,
            healYou: 0,
            healOpp: 0,
            dodgeYou: false,
            dodgeOpp: false,
            shieldYou: false,
            shieldOpp: false,
            spLeftYou: 0,
            spLeftOpp: 0,
          });
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
    arena: {
      ms: 7600,
      steps: () => {
        const a = player(nextId++, 'Rival', mx - 3, my + 2, 'brasa', 2, ['brasa']);
        const b = player(nextId++, 'Nina', mx - 2, my + 2, 'mare', 2, ['mare']);
        const c = player(nextId++, 'Zeca', mx + 2, my - 2, 'broto', 1, ['broto']);
        const w = wild(mx + 3, my - 2, 'mare');
        const d = wild(mx + 1, my + 1, 'brasa');
        let bt = 0;
        return [
          [300, () => (bt = btEv(a, b))],
          [1200, () => btEv(c, w)],
          [1900, () => hit(a, b, 9, 'ataque', 1)],
          [2600, () => hit(w, c, 4, 'ataque', 0)],
          [3300, () => hit(b, a, 8, 'defesa', -1)],
          // O selvagem foge: some de s.bs e do snapshot sem 'c' nem 'x'.
          [4200, () => {
            endBattle(w.b ?? 0);
            ents.delete(w.id);
          }],
          [4800, () => endBattle(bt)],
          // A sua batalha: a arena fica dourada e as outras brancas a 0,4.
          [5400, () => {
            btEv(ents.get(ME)!, d);
            bt = btEv(a, b);
          }],
          [6400, () => hit(ents.get(ME)!, d, 5, 'ataque', 1)],
        ];
      },
    },
    carga: {
      ms: 7000,
      steps: () => {
        const a = player(nextId++, 'Rival', mx - 3, my + 2, 'brasa', 2, ['brasa']);
        const b = player(nextId++, 'Nina', mx - 2, my + 2, 'mare', 2, ['mare']);
        const c = player(nextId++, 'Zeca', mx + 2, my + 2, 'broto', 3, ['broto']);
        const d = player(nextId++, 'Bia', mx + 3, my + 2, 'quimera', 3, ['brasa', 'mare', 'broto']);
        const e = player(nextId++, 'Bolinha', mx - 2, my - 2, 'neutro', 0, []);
        const w = wild(mx - 1, my - 2, 'brasa');
        return [
          [100, () => {
            battle(a, b);
            battle(c, d);
            battle(e, w);
          }],
          [300, () => (a.ch = b.ch = 1)],
          [700, () => (c.ch = d.ch = 1)],
          [1100, () => (e.ch = w.ch = 1)],
          [3600, () => {
            // A Carga do Rival vira raio; a da Nina some sem golpe.
            hit(a, b, 20, 'ataque', 1, FX_CHARGED);
            delete a.ch;
          }],
          [4400, () => delete b.ch],
          [5200, () => {
            hit(d, c, 24, 'ataque', 0, FX_CHARGED);
            delete d.ch;
          }],
        ];
      },
    },
    comer: {
      ms: 6000,
      steps: () => {
        const me = ents.get(ME)!;
        me.hp = Math.round(me.mhp * 0.6);
        const w1 = wild(mx + 1, my, 'mare');
        const a = player(nextId++, 'Rival', mx - 3, my + 1, 'broto', 2, ['broto']);
        const w2 = wild(mx - 2, my + 1, 'broto');
        const c = player(nextId++, 'Zeca', mx + 2, my - 2, 'mare', 1, ['mare']);
        const w3 = wild(mx + 3, my - 2, 'brasa');
        return [
          [200, () => {
            battle(me, w1);
            battle(a, w2);
            battle(c, w3);
          }],
          [700, () => eatEv(me, w1)],
          [2000, () => eatEv(a, w2, true)],
          [3400, () => {
            // Fugiu
            endBattle(w3.b ?? 0);
            ents.delete(w3.id);
          }],
          [4200, () => {
            const w4 = wild(mx - 1, my - 1, 'brasa');
            battle(me, w4);
          }],
          [4800, () => {
            const w4 = [...ents.values()].find((e) => e.k === 'w' && e.b === me.b);
            if (w4) eatEv(me, w4, true);
          }],
        ];
      },
    },
    passos: {
      ms: 9000,
      steps: () => {
        const looks: [Form, Stage, Elem[]][] = [
          ['brasa', 3, ['brasa']],
          ['mare', 2, ['mare']],
          ['broto', 1, ['broto']],
          ['vapor', 3, ['brasa', 'mare']],
          ['cinza', 2, ['brasa', 'broto']],
          ['mangue', 3, ['mare', 'broto']],
          ['quimera', 3, ['brasa', 'mare', 'broto']],
          ['neutro', 0, ['mare']],
        ];
        moveMe(JX, JY);
        const me = ents.get(ME)!;
        setLook(me, 'brasa', 3, ['brasa']);
        walk(me, loop(JX - 2, JY - 2, 4, 3));
        looks.forEach(([f, s, o], i) => {
          const e = player(nextId++, `B${i}`, JX - 6 + (i % 4) * 3, JY - 3 + Math.floor(i / 4) * 5, f, s, o);
          walk(e, loop(e.x, e.y, 2, 2));
        });
        const w = wild(JX + 5, JY + 3, 'broto');
        walk(w, loop(w.x, w.y, 2, 1), BALANCE.wildStepMs);
        return [];
      },
    },
    bioma: {
      ms: 7000,
      steps: () => {
        moveMe(JX, JY);
        ph = 'coleta';
        el = 40_000;
        z = { x: JX, y: JY, r: 30, tr: 30 };
        return [
          [3500, () => {
            // Durante a sua batalha o ambiente fica 2,5× mais lento.
            const w = wild(JX + 1, JY, 'brasa');
            battle(ents.get(ME)!, w);
          }],
        ];
      },
    },
    luz: {
      ms: 9000,
      steps: () => {
        const r = player(nextId++, 'Rival', mx + 1, my, 'mare', 3, ['mare']);
        ph = 'coleta';
        el = 60_000;
        z = { x: mx, y: my, r: 20, tr: 20 };
        return [
          [1500, () => {
            ph = 'cacada';
            el = 180_000;
          }],
          [3000, () => (el = 238_000)],
          [3300, () => {
            ph = 'final';
            el = 242_000;
          }],
          [4600, () => (el = 296_000)],
          [5200, () => {
            ph = 'duelo';
            el = 300_000;
            z = { x: mx, y: my, r: 6, tr: 6 };
            duel = { a: 'Você', b: 'Rival' };
            btEv(ents.get(ME)!, r, 'f');
          }],
          [6600, () => hit(r, ents.get(ME)!, 18, 'ataque', 1)],
          [7800, () => {
            const b = ents.get(ME)!.b ?? 0;
            const me = ents.get(ME)!;
            queue.push({ k: 'fu', x: me.x + 0.5, y: me.y, bt: b, a: ME, b: r.id, va: 8, vb: 9 });
          }],
        ];
      },
    },
    auras: {
      ms: 7000,
      steps: () => {
        const looks: [Form, Elem[]][] = [
          ['brasa', ['brasa']],
          ['mare', ['mare']],
          ['broto', ['broto']],
          ['vapor', ['brasa', 'mare']],
          ['cinza', ['brasa', 'broto']],
          ['mangue', ['mare', 'broto']],
          ['quimera', ['brasa', 'mare', 'broto']],
        ];
        const list = looks.map(([f, o], i) => player(nextId++, f, mx - 3 + (i % 4) * 2, my - 2 + Math.floor(i / 4) * 4, f, 3, o));
        list[0].tr = 1;
        list[1].tr = 2;
        list[2].tr = 3;
        list[3].cr = 1;
        const me = ents.get(ME)!;
        moveMe(mx + 3, my + 2);
        hunger = 20_000;
        return [
          [500, () => (list[4].sh = me.sh = 1)],
          [3500, () => delete list[4].sh],
          [5000, () => delete me.sh],
        ];
      },
    },
    frutas: {
      ms: 7000,
      steps: () => {
        const i = map.fruits.findIndex((f) => f.elem === 'broto');
        const f = map.fruits[i];
        moveMe(f.x - 3, f.y);
        const me = ents.get(ME)!;
        const j = map.fruits.findIndex((g, k) => k !== i && Math.abs(g.x - f.x) + Math.abs(g.y - f.y) < 30);
        return [
          [800, () => (me.x = f.x - 2)],
          [950, () => (me.x = f.x - 1)],
          [1100, () => {
            me.x = f.x;
            frOff.add(i);
          }],
          [1250, () => (me.x = f.x + 1)],
          [4000, () => frOff.delete(i)],
          [5000, () => j >= 0 && frOff.add(j)],
        ];
      },
    },
    toque: {
      ms: 7000,
      steps: () => {
        ph = 'coleta';
        el = 60_000;
        z = { x: mx, y: my, r: 20, tr: 20 };
        const w = wild(mx + 3, my - 1, 'mare');
        const a = player(nextId++, 'Rival', mx - 3, my + 1, 'broto', 2, ['broto']);
        const tap = (x: number, y: number) => (scene as unknown as { handleTap: (p: { worldX: number; worldY: number }) => void }).handleTap({ worldX: x, worldY: y });
        return [
          [400, () => tap((mx + 2.5) * 16, (my + 2.5) * 16)],
          [2600, () => tap((w.x + 0.5) * 16, (w.y + 0.5) * 16 - 2)],
          [4600, () => tap((a.x + 0.5) * 16, (a.y + 0.5) * 16 - 2)],
          [5600, () => tap((mx - 1.5) * 16, (my - 1.5) * 16)],
        ];
      },
    },
    portal: {
      ms: 5000,
      steps: () => [
        [300, () => spawnEv(mx + 2, my, 'brasa')],
        [1300, () => spawnEv(mx - 2, my + 1, 'mare')],
        [2300, () => spawnEv(mx + 1, my - 2, 'broto')],
      ],
    },
    coroa: {
      ms: 9500,
      steps: () => {
        const a = player(nextId++, 'Rival', mx + 3, my, 'brasa', 3, ['brasa']);
        const b = player(nextId++, 'Nina', mx - 3, my + 1, 'mare', 3, ['mare']);
        a.cr = 1;
        crown = { x: a.x, y: a.y };
        return [
          [2500, () => {
            delete a.cr;
            b.cr = 1;
            crown = { x: b.x, y: b.y };
          }],
          [4200, () => (crown = null)],
          [4800, () => {
            // O líder antigo sai da vista: a Coroa desce do céu no novo.
            b.x = mx - 30;
            delete b.cr;
            a.cr = 1;
          }],
          // O dono sai da vista e volta: sem voo, a Coroa não trocou de dono.
          [6500, () => (a.x = mx + 30)],
          [7500, () => (a.x = mx + 3)],
        ];
      },
    },
    tudo: {
      ms: 12000,
      steps: () => {
        moveMe(JX, JY);
        const me = ents.get(ME)!;
        setLook(me, 'quimera', 3, ['brasa', 'mare', 'broto']);
        me.tr = 2;
        hunger = 60_000;
        walk(me, loop(JX - 1, JY - 1, 3, 2));
        z = { x: JX - 12, y: JY, r: 15, tr: 11 };
        crown = { x: JX + 4, y: JY - 3 };
        const A = player(nextId++, 'A', JX + 4, JY - 3, 'brasa', 3, ['brasa']);
        const B = player(nextId++, 'B', JX + 5, JY - 3, 'mare', 2, ['mare']);
        const C = player(nextId++, 'C', JX - 5, JY + 3, 'quimera', 3, ['brasa', 'mare', 'broto']);
        const Wc = wild(JX - 4, JY + 3, 'broto');
        const D = player(nextId++, 'D', JX + 3, JY + 4, 'vapor', 3, ['brasa', 'mare']);
        const E = player(nextId++, 'E', JX + 4, JY + 4, 'cinza', 2, ['brasa', 'broto']);
        A.cr = 1;
        A.tr = 3;
        D.sh = 1;
        const looks: [Form, Stage, Elem[]][] = [
          ['broto', 1, ['broto']],
          ['mangue', 3, ['mare', 'broto']],
          ['neutro', 0, ['brasa']],
          ['mare', 3, ['mare']],
        ];
        const walkersE = looks.map(([f, s, o], i) => {
          const e = player(nextId++, `W${i}`, JX - 6 + i * 3, JY - 5, f, s, o);
          walk(e, loop(e.x, e.y, 2, 2));
          return e;
        });
        const steps: Step[] = [
          [100, () => {
            btEv(A, B);
            btEv(C, Wc);
            btEv(D, E);
          }],
          [300, () => (C.ch = Wc.ch = 1)],
        ];
        for (let t = 700; t < 11500; t += 700) {
          const k = t / 700;
          steps.push([t, () => hit(k & 1 ? A : B, k & 1 ? B : A, 6, 'ataque', k % 3 === 0 ? 1 : 0)]);
          steps.push([t + 350, () => hit(k & 1 ? D : E, k & 1 ? E : D, 5, k & 1 ? 'defesa' : 'ataque', 0, k % 4 === 0 ? FX_CLASH : 0)]);
          steps.push([t + 200, () => {
            A.hp = A.mhp;
            B.hp = B.mhp;
            D.hp = D.mhp;
            E.hp = E.mhp;
          }]);
        }
        for (let t = 1500; t < 11500; t += 2000) {
          steps.push([t, () => spawnEv(JX + 1 + ((t / 1000) % 3), JY + 2, (['brasa', 'mare', 'broto'] as const)[(t / 1000) % 3 | 0])]);
          steps.push([t + 900, () => {
            const w = [...ents.values()].find((e) => e.k === 'w' && e.b === undefined && e !== Wc);
            if (w) eatEv(me, w, true);
          }]);
        }
        for (let t = 2500; t < 11500; t += 3000) {
          steps.push([t, () => {
            const e = walkersE[((t / 3000) | 0) % walkersE.length];
            if (e && e.s < 3) {
              setLook(e, e.f, (e.s + 1) as Stage, e.o);
              queue.push({ k: 'v', x: e.x, y: e.y, id: e.id, s: e.s });
            }
          }]);
          steps.push([t + 1200, () => {
            hit(C, Wc, 10, 'ataque', 1, FX_CHARGED);
            Wc.hp = Wc.mhp;
          }]);
        }
        return steps;
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
    pendingSteps.length = 0;
    sceneT = 0;
    cur = n;
    steps = SCENES[n].steps().sort((p, q) => p[0] - q[0]);
    t0 = performance.now();
  };
  const next = () => {
    idx = (idx + 1) % order.length;
    start(order[idx]);
  };

  // Toque no demo: anda até o tile ou mira no bicho.
  scene.onTap = (tile, id) => {
    if (id !== null) target = id;
    else if (tile) dest = [tile.x, tile.y];
  };
  const stepWalkers = () => {
    for (const w of walkers) {
      if (!ents.has(w.e.id) || w.e.b !== undefined) continue;
      w.acc += 100;
      if (w.acc < w.every) continue;
      w.acc -= w.every;
      w.i = (w.i + 1) % w.path.length;
      [w.e.x, w.e.y] = w.path[w.i];
    }
    const me = ents.get(ME);
    if (me && dest && (me.x !== dest[0] || me.y !== dest[1])) {
      if (me.x !== dest[0]) me.x += Math.sign(dest[0] - me.x);
      else me.y += Math.sign(dest[1] - me.y);
    } else dest = null;
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
      fr: map.fruits.map((_, i) => i).filter((i) => !frOff.has(i)),
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
        hungerMs: hunger,
        alive,
        crown: !!me?.cr,
        battle: me?.b ?? null,
        target,
        essence: 6,
        skills: mySkills,
        power: (me?.s ?? 0) * 100,
        deaths,
        hatchMs: me?.hx ? Math.max(0, (hatching.get(ME) ?? sceneT) - sceneT) : 0,
      },
      view: v?.id ?? null,
      crown,
      // Placar com todos os jogadores (o servidor manda o lb inteiro, com a Coroa, mesmo fora da vista).
      lb: [...ents.values()]
        .filter((e) => e.k === 'p')
        .map((e) => ({ id: e.id, n: e.n ?? '', s: e.s, f: e.f, pw: e.s * 100, ...(e.cr ? { cr: 1 as const } : {}), ...(e.ln && e.tl ? { ln: e.ln, tl: e.tl } : {}) })),
      duel,
      ...(fx ? { fx } : {}),
    };
  };

  const startMsg = (): ServerMsg => ({ t: 'start', you: ME, w: map.w, h: map.h, tiles: encodeTiles(map.tiles), fruits: map.fruits, players: 8, gm: 'rapido' });
  onMsg(startMsg());
  next();
  window.setInterval(() => {
    const t = performance.now() - t0;
    sceneT = t;
    while (steps.length && steps[0][0] <= t) steps.shift()![1]();
    for (let i = pendingSteps.length - 1; i >= 0; i--) {
      if (pendingSteps[i][0] > t) continue;
      const fn = pendingSteps[i][1];
      pendingSteps.splice(i, 1);
      fn();
    }
    for (const [id, at] of hatching) {
      if (t < at) continue;
      const e = ents.get(id);
      if (e) delete e.hx;
      hatching.delete(id);
    }
    stepWalkers();
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
    resetPeaks: () => scene.resetFxPeaks(),
    scene,
  };
}
