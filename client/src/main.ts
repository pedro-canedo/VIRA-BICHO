import Phaser from 'phaser';
import { decodeTiles, speciesName, type ServerMsg } from '@vb/shared';
import { lostMessage } from './closeReasons';
import { Net } from './net';
import { GameScene } from './scenes/GameScene';
import { BattleUi } from './ui/battle';
import { recordLook } from './ui/bestiary';
import { clearUi } from './ui/dom';
import { showEliminated, showEnd } from './ui/end';
import { Hud } from './ui/hud';
import { showLobby, showMenu, type PlayRequest } from './ui/screens';
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
let screen: Screen = 'menu';
let hud: Hud | null = null;
let battle: BattleUi | null = null;
let deadEl: HTMLElement | null = null;
let lastReq: PlayRequest | null = null;

const net = new Net(onMsg, (code) => {
  if (screen === 'lobby' || screen === 'game') toMenu(lostMessage(code));
});

scene.onTap = (tile, id) => {
  if (id !== null) net.send({ t: 'target', id });
  else if (tile) net.send({ t: 'move', x: tile.x, y: tile.y });
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
  scene.setBattleInset(0);
  scene.clearWorld();
}

function toMenu(error = ''): void {
  net.send({ t: 'leave' });
  cleanupGame();
  setScreen('menu');
  showMenu(play, error);
}

async function play(req: PlayRequest): Promise<void> {
  lastReq = req;
  try {
    await net.connect();
    net.send({ t: 'hello', name: req.name, mode: req.mode, code: req.code });
  } catch (err) {
    showMenu(play, (err as Error).message);
  }
}

function onMsg(msg: ServerMsg): void {
  switch (msg.t) {
    case 'lobby':
      if (screen !== 'lobby') cleanupGame();
      setScreen('lobby');
      showLobby(msg, { onStartNow: () => net.send({ t: 'startnow' }), onLeave: () => toMenu() });
      return;
    case 'start': {
      clearUi();
      cleanupGame();
      setScreen('game');
      const tiles = decodeTiles(msg.tiles);
      hud = new Hud();
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
      if (msg.spectate) {
        deadEl?.remove();
        deadEl = null;
      }
      battle = new BattleUi(msg, (a) => net.send({ t: 'act', a }));
      // O mundo centraliza a luta na área visível acima do painel.
      requestAnimationFrame(() => scene.setBattleInset(document.querySelector('.battle')?.getBoundingClientRect().height ?? 0));
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
          scene.setBattleInset(0);
        }
      });
      return;
    }
    case 'feed':
      hud?.feed(msg.text, msg.kind);
      return;
    case 'toast':
      hud?.toast(msg.text);
      return;
    case 'elim':
      battle?.destroy();
      battle = null;
      scene.setBattleInset(0);
      deadEl?.remove();
      deadEl = showEliminated(msg.by, msg.place, msg.reason, () => toMenu());
      return;
    case 'end':
      cleanupGame();
      clearUi();
      setScreen('end');
      showEnd(
        msg,
        () => play({ mode: 'quick', name: lastReq?.name ?? 'Bichinho' }),
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

// ?fxdemo: demonstração dos efeitos, sem servidor (só desenvolvimento).
const demo = new URLSearchParams(location.search).get('fxdemo');
if (demo !== null) void import('./fxdemo').then((m) => m.runFxDemo({ onMsg, scene, name: demo }));
else {
  setScreen('menu');
  showMenu(play);
}
