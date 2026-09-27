import { describe, expect, it } from 'vitest';
import { BALANCE, type ServerMsg } from '@vb/shared';
import type { Conn } from '../server/src/entities';
import { Lobby } from '../server/src/lobby';
import { SECURITY, type LobbyLimits } from '../server/src/security';

type FakeConn = Conn & { msgs: ServerMsg[]; last(): string };
const mkConn = (key: string): FakeConn => {
  const msgs: ServerMsg[] = [];
  return {
    key,
    msgs,
    send: (m) => msgs.push(m),
    last() {
      const m = msgs.at(-1);
      return m?.t === 'error' ? m.msg : '';
    },
  };
};

const hello = (mode: 'quick' | 'create' | 'join', code?: string) => ({ t: 'hello' as const, name: 'X', mode, code });

function mkLobby(over: Partial<LobbyLimits> = {}, exempt: string[] = []) {
  return new Lobby({ limits: { ...SECURITY.lobby, ...over }, isExempt: (k) => exempt.includes(k) });
}

describe('limites do lobby', () => {
  it('uma conexão criando sem parar nunca ocupa mais de uma sala', () => {
    const lobby = mkLobby();
    const c = mkConn('A');
    let now = 1_000_000;
    for (let i = 0; i < 10; i++) {
      lobby.handle(c, hello('create'), (now += 5000));
      expect(lobby.rooms.size).toBeLessThanOrEqual(1);
    }
  });

  it('sala em lobby some assim que o último humano sai', () => {
    const lobby = mkLobby();
    const c = mkConn('A');
    lobby.handle(c, hello('create'), 0);
    expect(lobby.rooms.size).toBe(1);
    lobby.disconnect(c, 0);
    expect(lobby.rooms.size).toBe(0);
  });

  it('um IP não cria em mais de 2 salas ao mesmo tempo, mas entra em sala existente', () => {
    const lobby = mkLobby();
    lobby.handle(mkConn('A'), hello('create'), 0);
    lobby.handle(mkConn('A'), hello('create'), 0);
    expect(lobby.rooms.size).toBe(2);
    const c3 = mkConn('A');
    lobby.handle(c3, hello('create'), 0);
    expect(c3.last()).toContain('salas demais ao mesmo tempo');
    lobby.handle(mkConn('Z'), hello('quick'), 0);
    const c4 = mkConn('A');
    lobby.handle(c4, hello('quick'), 0);
    expect(c4.last()).toBe('');
    expect(lobby.roomOf(c4)?.isPrivate).toBe(false);
    expect(lobby.rooms.size).toBe(3);
  });

  it('taxa de criação por IP: 4 partidas iniciadas seguidas, a 5ª espera', () => {
    const lobby = mkLobby();
    let now = 0;
    for (let i = 0; i < 4; i++) {
      const c = mkConn('A');
      lobby.handle(c, hello('create'), now);
      expect(c.last()).toBe('');
      // A ficha só fica gasta quando a partida começa de fato.
      lobby.handle(c, { t: 'startnow' }, now);
      lobby.tick(now);
      expect(lobby.roomOf(c)?.state).toBe('play');
      lobby.disconnect(c, now);
    }
    const c5 = mkConn('A');
    lobby.handle(c5, hello('create'), now);
    expect(c5.last()).toContain('criou salas demais');
    now += 150_000;
    const c6 = mkConn('A');
    lobby.handle(c6, hello('create'), now);
    expect(c6.last()).toBe('');
  });

  it('entrar e sair do lobby sem começar não gasta a taxa de criação (quick e create)', () => {
    const lobby = mkLobby();
    const c = mkConn('A');
    let now = 0;
    // Regressão: sozinho, "Jogar agora" / "Sair" a cada ~4 s travava na 5ª vez por 150 s.
    for (let i = 0; i < 12; i++) {
      lobby.handle(c, hello(i % 2 ? 'create' : 'quick'), (now += 4000));
      expect(c.last()).toBe('');
      expect(lobby.roomOf(c)).not.toBeNull();
      lobby.handle(c, { t: 'leave' }, (now += 500));
      expect(lobby.rooms.size).toBe(0);
    }
    // Hellos seguidos (sem leave) também devolvem a ficha da sala anterior.
    for (let i = 0; i < 6; i++) {
      lobby.handle(c, hello('create'), (now += 4000));
      expect(c.last()).toBe('');
    }
    expect(lobby.rooms.size).toBe(1);
  });

  it('sala que esvazia antes de começar devolve a ficha ao criador, mesmo com outros tendo entrado', () => {
    const lobby = mkLobby({ roomCreate: { capacity: 1, refillPerSec: 0 } });
    const host = mkConn('A');
    lobby.handle(host, hello('create'), 0);
    const guest = mkConn('B');
    lobby.handle(guest, hello('join', lobby.roomOf(host)!.code), 0);
    lobby.disconnect(host, 0);
    lobby.disconnect(guest, 0);
    expect(lobby.rooms.size).toBe(0);
    const again = mkConn('A');
    lobby.handle(again, hello('create'), 0);
    expect(again.last()).toBe('');
  });

  it('partida rápida tem teto próprio por IP (CGNAT), acima do das privadas', () => {
    const lobby = mkLobby();
    const cs = [mkConn('N'), mkConn('N')];
    for (const c of cs) {
      lobby.handle(c, hello('create'), 0);
      expect(c.last()).toBe('');
    }
    const priv = mkConn('N');
    lobby.handle(priv, hello('create'), 0);
    expect(priv.last()).toContain('tente de novo em instantes');
    const quick = mkConn('N');
    lobby.handle(quick, hello('quick'), 0);
    expect(quick.last()).toBe('');
    const quick2 = mkConn('N');
    lobby.handle(quick2, hello('quick'), 0);
    // Já existe uma sala pública em lobby com vaga: entra nela em vez de criar.
    expect(lobby.roomOf(quick2)).toBe(lobby.roomOf(quick));
  });

  it('IPv6: vários /64 do mesmo /48 somam no teto de salas', () => {
    const lobby = mkLobby();
    const keys = ['2001:db8:1:1::/64', '2001:db8:1:2::/64', '2001:db8:1:3::/64'];
    for (const k of keys.slice(0, 2)) {
      for (let i = 0; i < 2; i++) {
        const c = mkConn(k);
        lobby.handle(c, hello('create'), 0);
        expect(c.last()).toBe('');
      }
    }
    const c5 = mkConn(keys[2]);
    lobby.handle(c5, hello('create'), 0);
    expect(c5.last()).toContain('salas demais');
    const other = mkConn('2001:db8:2:1::/64');
    lobby.handle(other, hello('create'), 0);
    expect(other.last()).toBe('');
  });

  it('força bruta de código com muitas chaves: teto global de códigos errados', () => {
    const lobby = mkLobby({ failedJoinGlobal: { windowMs: 60_000, max: 30 } });
    const host = mkConn('H');
    lobby.handle(host, hello('create'), 0);
    const code = lobby.roomOf(host)!.code;
    // 30 chaves diferentes, 1 erro cada: nenhuma chega ao limite por chave.
    for (let i = 0; i < 30; i++) lobby.handle(mkConn(`k${i}`), hello('join', 'ZZZZ'), 1000);
    const late = mkConn('nova');
    lobby.handle(late, hello('join', code), 2000);
    expect(late.last()).toContain('Muitas tentativas');
    expect(lobby.roomOf(late)).toBeNull();
    const exempt = new Lobby({ limits: { ...SECURITY.lobby, failedJoinGlobal: { windowMs: 60_000, max: 0 } }, isExempt: (k) => k === 'local' });
    const h2 = mkConn('H');
    exempt.handle(h2, hello('create'), 0);
    const loc = mkConn('local');
    exempt.handle(loc, hello('join', exempt.roomOf(h2)!.code), 0);
    expect(loc.last()).toBe('');
    // A janela esvazia e o join volta a funcionar.
    const after = mkConn('nova');
    lobby.handle(after, hello('join', code), 62_000);
    expect(after.last()).toBe('');
  });

  it('a folga da mira vem das opções (não do SECURITY global)', () => {
    const lobby = new Lobby({ limits: SECURITY.lobby, game: { targetSlackTiles: 0 } });
    const c = mkConn('A');
    lobby.handle(c, hello('create'), 0);
    expect(lobby.roomOf(c)!.targetSlackTiles).toBe(0);
    expect(mkLobby().rooms.size).toBe(0);
    const d = mkConn('B');
    const def = mkLobby();
    def.handle(d, hello('create'), 0);
    expect(def.roomOf(d)!.targetSlackTiles).toBe(SECURITY.game.targetSlackTiles);
  });

  it('reserva vagas para a partida rápida', () => {
    const lobby = mkLobby({ maxRooms: 4, maxPrivateRooms: 2 });
    lobby.handle(mkConn('B'), hello('create'), 0);
    lobby.handle(mkConn('C'), hello('create'), 0);
    const d = mkConn('D');
    lobby.handle(d, hello('create'), 0);
    expect(d.last()).toContain('Muitas salas privadas');
    const e = mkConn('E');
    lobby.handle(e, hello('quick'), 0);
    expect(e.last()).toBe('');
    expect(lobby.roomOf(e)?.isPrivate).toBe(false);
  });

  it('tentativas de código errado por IP: 10 por minuto', () => {
    const lobby = mkLobby();
    const host = mkConn('H');
    lobby.handle(host, hello('create'), 0);
    const code = lobby.roomOf(host)!.code;
    for (let i = 0; i < 10; i++) {
      const c = mkConn('F');
      lobby.handle(c, hello('join', 'ZZZZ'), 0);
      expect(c.last()).toBe('Sala não encontrada.');
    }
    const c11 = mkConn('F');
    lobby.handle(c11, hello('join', code), 0);
    expect(c11.last()).toContain('Muitas tentativas');
    const c12 = mkConn('F');
    lobby.handle(c12, hello('join', code), 60_000);
    expect(c12.last()).toBe('');
    expect(lobby.roomOf(c12)?.code).toBe(code);
  });

  it('hello repetido na mesma conexão é freado', () => {
    const lobby = mkLobby();
    const c = mkConn('G');
    for (let i = 0; i < 3; i++) lobby.handle(c, hello('quick'), 0);
    expect(c.last()).toBe('');
    lobby.handle(c, hello('quick'), 0);
    expect(c.last()).toContain('Calma!');
  });

  it('amigos no mesmo Wi-Fi enchem uma sala normalmente', () => {
    const lobby = mkLobby();
    const host = mkConn('X');
    lobby.handle(host, hello('create'), 0);
    const priv = lobby.roomOf(host)!;
    for (let i = 0; i < 15; i++) {
      const c = mkConn('W');
      lobby.handle(c, hello('join', priv.code), 0);
      expect(c.last()).toBe('');
    }
    expect(priv.humans).toBe(16);

    const quick = Array.from({ length: 8 }, () => mkConn('W'));
    for (const c of quick) lobby.handle(c, hello('quick'), 0);
    const rooms = new Set(quick.map((c) => lobby.roomOf(c)));
    expect(rooms.size).toBe(1);
    expect([...rooms][0]!.humans).toBe(8);
  });

  it('16 conexões do mesmo IP entram numa sala privada de outro IP', () => {
    const lobby = mkLobby();
    const host = mkConn('Y');
    lobby.handle(host, hello('create'), 0);
    const room = lobby.roomOf(host)!;
    // Sala de 16: o anfitrião ocupa 1 vaga, então 15 amigos entram e o 16º recebe "Sala cheia".
    const friends = Array.from({ length: 16 }, () => mkConn('W'));
    for (const c of friends) lobby.handle(c, hello('join', room.code), 0);
    expect(room.humans).toBe(16);
    expect(friends.at(-1)!.last()).toBe('Sala cheia.');
  });

  it('chave isenta cria várias salas', () => {
    const lobby = mkLobby({}, ['local']);
    for (let i = 0; i < 5; i++) {
      const c = mkConn('local');
      lobby.handle(c, hello('create'), 0);
      expect(c.last()).toBe('');
    }
    expect(lobby.rooms.size).toBe(5);
  });

  it('maxRooms subiu para 10 e stats não expõe códigos', () => {
    expect(BALANCE.lobby.maxRooms).toBe(10);
    const lobby = mkLobby();
    const c = mkConn('A');
    lobby.handle(c, hello('create'), 0);
    const code = lobby.roomOf(c)!.code;
    const s = lobby.stats();
    expect(s).toEqual({ rooms: 1, privateRooms: 1, lobbyRooms: 1, playRooms: 0, players: 1 });
    expect(JSON.stringify(s)).not.toContain(code);
  });
});
