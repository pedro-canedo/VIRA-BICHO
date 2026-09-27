// /metrics no formato de texto do Prometheus (exposition format 0.0.4).
import type { Observer } from './observer';

type Labels = Record<string, string>;

export function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

class Builder {
  private lines: string[] = [];
  private declared = new Set<string>();

  add(name: string, type: 'gauge' | 'counter', help: string, value: number | null | undefined, labels?: Labels): void {
    if (!this.declared.has(name)) {
      this.declared.add(name);
      this.lines.push(`# HELP ${name} ${help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
      this.lines.push(`# TYPE ${name} ${type}`);
    }
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    const l = labels && Object.keys(labels).length
      ? `{${Object.entries(labels)
          .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
          .join(',')}}`
      : '';
    this.lines.push(`${name}${l} ${value}`);
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }
}

export function renderMetrics(obs: Observer): string {
  const b = new Builder();
  const sum = obs.summary();
  const s = obs.collector.fresh();
  const g = sum.game;

  b.add('vb_game_up', 'gauge', 'Jogo respondendo ao observador (1) ou fora (0).', g.status === 'up' ? 1 : 0);
  b.add('vb_game_state_seconds', 'gauge', 'Tempo no estado atual (up/down).', Math.round(g.forMs / 1000));
  b.add('vb_game_uptime_seconds', 'gauge', 'Uptime do processo do jogo.', g.uptimeMs === null ? null : Math.round(g.uptimeMs / 1000));
  b.add('vb_game_restarts_total', 'counter', 'Reinícios do jogo detectados desde que o observador subiu.', g.restarts);
  b.add('vb_game_poll_ms', 'gauge', 'Latência da última consulta ao endpoint interno.', g.pollMs);

  if (s) {
    b.add('vb_players', 'gauge', 'Jogadores por situação.', s.players.online, { state: 'online' });
    b.add('vb_players', 'gauge', '', s.players.lobby, { state: 'lobby' });
    b.add('vb_players', 'gauge', '', s.players.playing, { state: 'playing' });
    b.add('vb_players', 'gauge', '', s.players.spectating, { state: 'spectating' });
    b.add('vb_rooms', 'gauge', 'Salas abertas por estado.', s.rooms.filter((r) => r.state === 'lobby').length, { state: 'lobby' });
    b.add('vb_rooms', 'gauge', '', s.rooms.filter((r) => r.state === 'play').length, { state: 'play' });
    b.add('vb_rooms', 'gauge', '', s.rooms.filter((r) => r.state === 'fim').length, { state: 'fim' });
    b.add('vb_rooms_active', 'gauge', 'Salas com pelo menos um humano.', s.rooms.filter((r) => r.humans > 0).length);
    b.add('vb_connections_open', 'gauge', 'Conexões WebSocket abertas.', s.connections.open);
    b.add('vb_connections_total', 'counter', 'Conexões desde o início do processo do jogo.', s.connections.total);
    b.add('vb_game_rss_megabytes', 'gauge', 'RSS do processo do jogo (MB).', s.process.rssMB);
    b.add('vb_game_heap_used_megabytes', 'gauge', 'Heap usado do jogo (MB).', s.process.heapUsedMB);
    b.add('vb_game_cpu_percent', 'gauge', 'CPU do processo do jogo (% de um núcleo).', s.process.cpuPct);
    for (const q of ['p50', 'p99', 'max'] as const) {
      const quantile = q === 'p50' ? '0.5' : q === 'p99' ? '0.99' : '1';
      b.add('vb_event_loop_lag_ms', 'gauge', 'Atraso do event loop do jogo (ms).', s.process.eventLoopLagMs[q], { quantile });
    }
    for (const q of ['p50', 'p99', 'max'] as const) {
      const quantile = q === 'p50' ? '0.5' : q === 'p99' ? '0.99' : '1';
      b.add('vb_tick_ms', 'gauge', 'Duração do tick das salas (ms).', s.process.tickMs[q], { quantile });
    }
    const c = s.counters;
    b.add('vb_joins_total', 'counter', 'Entradas em sala.', c.joins);
    b.add('vb_matches_started_total', 'counter', 'Partidas iniciadas.', c.matchesStarted);
    b.add('vb_matches_ended_total', 'counter', 'Partidas terminadas.', c.matchesEnded);
    b.add('vb_battles_total', 'counter', 'Batalhas por tipo.', c.battles.wild, { kind: 'wild' });
    b.add('vb_battles_total', 'counter', '', c.battles.pvp, { kind: 'pvp' });
    b.add('vb_battles_total', 'counter', '', c.battles.final, { kind: 'final' });
    b.add('vb_eliminations_total', 'counter', 'Eliminações.', c.eliminations);
    b.add('vb_rate_limited_total', 'counter', 'Mensagens barradas por limite de taxa.', c.rateLimited);
    b.add('vb_rejected_connections_total', 'counter', 'Conexões recusadas.', c.rejectedConnections);
    b.add('vb_origin_rejected_total', 'counter', 'Conexões recusadas pela origem.', c.originRejected);
    b.add('vb_errors_total', 'counter', 'Erros no servidor do jogo.', c.errors);
    for (const [country, n] of Object.entries(s.breakdown.countries)) {
      b.add('vb_players_by_country', 'gauge', 'Jogadores online por país.', n, { country });
    }
    for (const [device, n] of Object.entries(s.breakdown.devices)) {
      b.add('vb_players_by_device', 'gauge', 'Jogadores online por dispositivo.', n, { device });
    }
  }

  const t = sum.today;
  b.add('vb_today_matches_ended', 'gauge', 'Partidas terminadas hoje.', t.matchesEnded);
  b.add('vb_today_peak_online', 'gauge', 'Pico de jogadores online hoje.', t.peakOnline);
  b.add('vb_today_avg_match_seconds', 'gauge', 'Duração média das partidas de hoje.', t.avgDurationMs === null ? null : t.avgDurationMs / 1000);

  const pub = sum.public;
  b.add('vb_public_up', 'gauge', 'Endereço público (túnel) respondendo.', pub.ok === null ? null : pub.ok ? 1 : 0);
  b.add('vb_public_latency_ms', 'gauge', 'Latência da checagem pública.', pub.latencyMs);

  const p = sum.phone;
  if (p) {
    b.add('vb_phone_load', 'gauge', 'Load average do celular.', p.load?.[0], { period: '1m' });
    b.add('vb_phone_load', 'gauge', '', p.load?.[1], { period: '5m' });
    b.add('vb_phone_load', 'gauge', '', p.load?.[2], { period: '15m' });
    b.add('vb_phone_mem_available_megabytes', 'gauge', 'Memória disponível no celular (MB).', p.mem?.availableMB);
    b.add('vb_phone_mem_total_megabytes', 'gauge', 'Memória total do celular (MB).', p.mem?.totalMB);
    b.add('vb_phone_uptime_seconds', 'gauge', 'Uptime do celular.', p.uptimeS);
    b.add('vb_phone_temperature_celsius', 'gauge', 'Maior temperatura entre as thermal zones.', p.tempC);
    b.add('vb_phone_battery_percent', 'gauge', 'Carga da bateria.', p.battery?.capacity);
    b.add('vb_phone_battery_temperature_celsius', 'gauge', 'Temperatura da bateria.', p.battery?.tempC);
    b.add('vb_phone_disk_free_megabytes', 'gauge', 'Disco livre na pasta de dados (MB).', p.disk?.freeMB);
    b.add('vb_phone_disk_total_megabytes', 'gauge', 'Tamanho do disco da pasta de dados (MB).', p.disk?.totalMB);
  }
  for (const sv of sum.services ?? []) {
    b.add('vb_service_up', 'gauge', 'Serviço runit rodando (1) ou não (0).', sv.state === 'run' ? 1 : 0, { service: sv.name });
  }
  b.add('vb_obs_rss_megabytes', 'gauge', 'RSS do observador (MB).', sum.observer.rssMB);
  b.add('vb_obs_private_megabytes', 'gauge', 'Memória privada (RssAnon) do observador (MB).', sum.observer.privateMB);
  b.add('vb_obs_pss_megabytes', 'gauge', 'PSS do observador (MB): RSS com as páginas compartilhadas divididas.', sum.observer.pssMB);
  b.add('vb_obs_cpu_percent', 'gauge', 'CPU do observador (% de um núcleo).', sum.observer.cpuPct);
  b.add('vb_obs_sse_clients', 'gauge', 'Painéis conectados por SSE.', sum.observer.sseClients);
  return b.toString();
}
