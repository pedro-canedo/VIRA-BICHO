import Phaser from 'phaser';
import { decodeTiles, speciesName, type ClientMsg, type ServerMsg } from '@vb/shared';
import { lostMessage } from './closeReasons';
import { Net } from './net';
import { GameScene } from './scenes/GameScene';
import { BattleUi } from './ui/battle';
import { BattleInset, applyInsetToDocument } from './ui/battleInset';
import { recordLook } from './ui/bestiary';
import { clearUi } from './ui/dom';
import { showDeath, showEliminated, showEnd } from './ui/end';
import { Hud } from './ui/hud';
import { savedMode, showLobby, showMenu, type PlayRequest } from './ui/screens';
import './style.css';

type Screen = 'menu' | 'lobby' | 'game' | 'end';

// Aberto por http:// no domínio público: o WebSocket seria recusado, então vai para https.
if (location.protocol === 'http:' && location.hostname.endsWith('.caixazen.online')) {
  location.replace(`https://${location.host}${location.pathname}${location.search}${location.hash}`);
}

const scene = new GameScene();
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  pixelArt: true,
  backgroundColor: '#0b0716',
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  // Só o canvas: um toque num botão do HUD que some antes do dedo subir deixava o
  // ponteiro "preso" e o jogo ignorava todos os toques seguintes (iPhone).
  input: { windowEvents: false, activePointers: 2 },
  scene: [scene],
});

/** Solta ponteiros que possam ter ficado presos e reajusta o canvas ao viewport atual. */
function resetInput(): void {
  for (const p of game.input?.pointers ?? []) if (p.id > 0) p.reset();
  game.scale.refresh();
}

const gameEl = document.getElementById('game')!;
/** Altura do painel de batalha: sobe o foco da câmera e desce os toasts para logo acima dele. */
const battleInset = new BattleInset((px) => {
  scene.setBattleInset(px);
  applyInsetToDocument(px);
});
let screen: Screen = 'menu';
let hud: Hud | null = null;
let battle: BattleUi | null = null;
let deadEl: HTMLElement | null = null;
/** Aviso de morte (renascendo) e o que espera o painel de batalha fechar para aparecer. */
let deathEl: HTMLElement | null = null;
let pendingDeath: (() => void) | null = null;
let lastReq: PlayRequest | null = null;

const net = new Net(onMsg, (code) => {
  if (screen === 'lobby' || screen === 'game') toMenu(lostMessage(code));
});

/** Tudo o que a interface manda passa por aqui (o ?uidemo troca por um servidor de mentira). */
let send = (m: ClientMsg): void => net.send(m);

scene.onTap = (tile, id) => {
  if (id !== null) send({ t: 'target', id });
  else if (tile) send({ t: 'move', x: tile.x, y: tile.y });
};

function setScreen(s: Screen): void {
  screen = s;
  gameEl.style.visibility = s === 'game' ? 'visible' : 'hidden';
}

function cleanupGame(): void {
  battle?.destroy();
  battle = null;
  hud?.destroy();
  hud = null;
  deadEl = null;
  deathEl?.remove();
  deathEl = null;
  pendingDeath = null;
  battleInset.track(null);
  scene.clearWorld();
}

function toMenu(error = ''): void {
  send({ t: 'leave' });
  cleanupGame();
  setScreen('menu');
  showMenu(play, error);
}

async function play(req: PlayRequest): Promise<void> {
  lastReq = req;
  try {
    await net.connect();
    send({ t: 'hello', name: req.name, mode: req.mode, code: req.code, gm: req.gm });
  } catch (err) {
    showMenu(play, (err as Error).message);
  }
}

function onMsg(msg: ServerMsg): void {
  switch (msg.t) {
    case 'lobby':
      if (screen !== 'lobby') cleanupGame();
      setScreen('lobby');
      showLobby(msg, { onStartNow: () => send({ t: 'startnow' }), onLeave: () => toMenu() });
      return;
    case 'start': {
      clearUi();
      cleanupGame();
      setScreen('game');
      const tiles = decodeTiles(msg.tiles);
      hud = new Hud(msg.gm ?? 'rapido', (s) => send({ t: 'buy', s }));
      hud.setMap(msg.w, msg.h, tiles, msg.fruits);
      scene.setWorld(msg.w, msg.h, tiles, msg.fruits);
      resetInput();
      history.replaceState(null, '', location.pathname);
      return;
    }
    case 'snap':
      if (screen !== 'game') return;
      scene.applySnap(msg);
      hud?.update(msg);
      if (msg.me?.alive && recordLook(msg.me.look)) hud?.toast(`📖 Nova forma no bestiário: ${speciesName(msg.me.look.form, msg.me.look.stage)}!`);
      return;
    case 'b_start':
      battle?.destroy();
      // A loja fecha sozinha quando começa uma batalha
      hud?.closeShop();
      pendingDeath = null;
      if (msg.spectate) {
        deadEl?.remove();
        deadEl = null;
      }
      battle = new BattleUi(msg, (a) => send({ t: 'act', a }));
      // O mundo centraliza a luta na área visível acima do painel (e acompanha a altura dele).
      battleInset.track(battle.element);
      return;
    case 'b_turn':
      if (battle?.id === msg.id) battle.startTurn(msg.turn, msg.ms);
      return;
    case 'b_reveal':
      if (battle?.id === msg.id) battle.reveal(msg);
      return;
    case 'b_end': {
      const b = battle;
      if (b?.id !== msg.id) return;
      b.end(msg, () => {
        if (battle === b) {
          battle = null;
          battleInset.track(null);
        }
        // Morreu nesta batalha: o aviso aparece quando o painel sai
        const show = pendingDeath;
        pendingDeath = null;
        show?.();
      });
      return;
    }
    case 'death': {
      // Morreu, mas a partida continua: renasce do ovo em respawnMs
      hud?.closeShop();
      const at = performance.now() + msg.respawnMs;
      const show = () => {
        deathEl?.remove();
        deathEl = at - performance.now() > 300 ? showDeath(msg, at) : null;
      };
      if (!battle) show();
      else {
        pendingDeath = show;
        // Se o painel não fechar (b_end perdido), o aviso aparece mesmo assim
        window.setTimeout(() => {
          if (pendingDeath !== show) return;
          pendingDeath = null;
          show();
        }, 2500);
      }
      return;
    }
    case 'feed':
      hud?.feed(msg.text, msg.kind);
      return;
    case 'toast':
      hud?.toast(msg.text);
      return;
    case 'elim':
      // Só o corte do Duelo Final tira alguém da partida
      hud?.closeShop();
      deathEl?.remove();
      deathEl = null;
      pendingDeath = null;
      battle?.destroy();
      battle = null;
      battleInset.track(null);
      deadEl?.remove();
      deadEl = showEliminated(msg.by, msg.place, msg.reason, () => toMenu());
      return;
    case 'end':
      cleanupGame();
      clearUi();
      setScreen('end');
      showEnd(
        msg,
        () => play({ mode: 'quick', name: lastReq?.name ?? 'Bichinho', gm: lastReq?.gm ?? savedMode() }),
        () => toMenu(),
      );
      return;
    case 'error':
      if (screen !== 'game') {
        setScreen('menu');
        showMenu(play, msg.msg);
      } else hud?.toast(msg.msg);
      return;
  }
}

// ?fxdemo: demonstração dos efeitos; ?uidemo: telas da interface com mensagens sintéticas (sem servidor, só desenvolvimento).
const params = new URLSearchParams(location.search);
const demo = params.get('fxdemo');
const uidemo = params.get('uidemo');
if (demo !== null) void import('./fxdemo').then((m) => m.runFxDemo({ onMsg, scene, name: demo }));
else if (uidemo !== null) void import('./ui/uidemo').then((m) => m.runUiDemo({ onMsg, name: uidemo, setSend: (fn) => (send = fn), menu: () => showMenu(play) }));
else {
  setScreen('menu');
  showMenu(play);
}
