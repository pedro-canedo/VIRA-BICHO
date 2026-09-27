import { WS_PATH, type ClientMsg, type ServerMsg } from '@vb/shared';

/** Conexão WebSocket com o servidor (wss atrás do túnel, ws em desenvolvimento). */
export class Net {
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;

  constructor(
    private onMsg: (msg: ServerMsg) => void,
    private onLost: (code: number) => void,
  ) {}

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}${WS_PATH}`;
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url());
      ws.onopen = () => {
        this.ws = ws;
        this.opening = null;
        resolve();
      };
      ws.onerror = () => {
        this.opening = null;
        // O navegador não expõe o status do handshake (403/429/503).
        reject(new Error('Não foi possível conectar ao servidor. Tente de novo em instantes.'));
      };
      ws.onclose = (ev) => {
        if (this.ws === ws) {
          this.ws = null;
          this.onLost(ev.code);
        }
      };
      ws.onmessage = (ev) => {
        try {
          this.onMsg(JSON.parse(ev.data));
        } catch (err) {
          console.error('mensagem inválida', err);
        }
      };
    });
    return this.opening;
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
