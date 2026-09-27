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

const scene = new GameScene();
new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  pixelArt: true,
  backgroundColor: '#0b0716',
  scale: { mode: Phaser.Scale.RESIZE, width: window.innerWidth, height: window.innerHeight },
  scene: [scene],
});

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
        if (battle === b) battle = null;
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

setScreen('menu');
showMenu(play);
