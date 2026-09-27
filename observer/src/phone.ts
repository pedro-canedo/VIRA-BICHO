// Métricas do celular lidas de /proc e /sys. No Android várias dessas entradas podem dar
// EACCES (SELinux) ou nem existir: cada leitura falha sozinha e vira null.
import { readFile, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export interface PhoneMetrics {
  at: number;
  load: [number, number, number] | null;
  mem: { totalMB: number; availableMB: number } | null;
  uptimeS: number | null;
  /** Maior temperatura plausível entre as thermal zones (°C). */
  tempC: number | null;
  tempZone: string | null;
  battery: { capacity: number | null; status: string | null; tempC: number | null } | null;
  disk: { totalMB: number; freeMB: number } | null;
  /**
   * O próprio observador. privateMB (RssAnon) é o custo real: o resto do RSS são páginas do
   * binário do Node, compartilhadas com o processo do jogo.
   */
  self: {
    rssMB: number;
    privateMB: number | null;
    /** PSS (/proc/self/smaps_rollup): RSS com as páginas compartilhadas divididas entre os processos. */
    pssMB: number | null;
    heapUsedMB: number;
    cpuPct: number;
  };
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

function num(s: string | null): number | null {
  if (s === null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseLoadavg(s: string | null): [number, number, number] | null {
  if (!s) return null;
  const p = s.split(/\s+/).slice(0, 3).map(Number);
  return p.length === 3 && p.every(Number.isFinite) ? [p[0], p[1], p[2]] : null;
}

export function parseMeminfo(s: string | null): { totalMB: number; availableMB: number } | null {
  if (!s) return null;
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(s);
    return m ? Number(m[1]) : null;
  };
  const total = kb('MemTotal');
  const avail = kb('MemAvailable') ?? (kb('MemFree') ?? 0) + (kb('Cached') ?? 0);
  if (total === null) return null;
  return { totalMB: Math.round(total / 1024), availableMB: Math.round(avail / 1024) };
}

/** Converte leituras de temperatura: miligraus (45000), décimos (450) ou graus (45). */
export function normalizeTemp(raw: number | null): number | null {
  if (raw === null) return null;
  let c = raw;
  if (Math.abs(c) >= 1000) c = c / 1000;
  else if (Math.abs(c) >= 150) c = c / 10;
  return c > -30 && c < 150 ? Math.round(c * 10) / 10 : null;
}

interface Zone {
  dir: string;
  type: string;
}

/**
 * Temperatura: maior leitura entre as thermal zones. A varredura do diretório (até 64 zonas, e no
 * Android algumas são lentas) só acontece de hora em hora; no meio tempo lê apenas as zonas que
 * deram leitura válida na última varredura, em paralelo.
 */
class ThermalReader {
  private zones: Zone[] | null = null;
  private scannedAt = 0;

  constructor(
    private readonly sysRoot: string,
    private readonly rescanMs = 3600_000,
  ) {}

  private async scan(): Promise<Zone[]> {
    const base = join(this.sysRoot, 'class', 'thermal');
    let entries: string[];
    try {
      entries = (await readdir(base)).filter((e) => e.startsWith('thermal_zone')).slice(0, 64);
    } catch {
      return [];
    }
    const found = await Promise.all(
      entries.map(async (e) => {
        const dir = join(base, e);
        const t = normalizeTemp(num(await readText(join(dir, 'temp'))));
        if (t === null || t <= 0) return null; // zonas desligadas costumam reportar 0
        return { dir, type: ((await readText(join(dir, 'type'))) ?? e).slice(0, 40) };
      }),
    );
    return found.filter((z): z is Zone => z !== null);
  }

  async read(): Promise<{ tempC: number | null; zone: string | null }> {
    const now = Date.now();
    if (!this.zones || now - this.scannedAt >= this.rescanMs) {
      this.zones = await this.scan();
      this.scannedAt = now;
    }
    const temps = await Promise.all(this.zones.map(async (z) => normalizeTemp(num(await readText(join(z.dir, 'temp'))))));
    let best: number | null = null;
    let zone: string | null = null;
    temps.forEach((t, i) => {
      if (t === null || t <= 0) return;
      if (best === null || t > best) {
        best = t;
        zone = this.zones![i].type;
      }
    });
    return { tempC: best, zone };
  }
}

async function readBattery(sysRoot: string): Promise<PhoneMetrics['battery']> {
  const base = join(sysRoot, 'class', 'power_supply', 'battery');
  const [cap, status, temp] = await Promise.all([
    readText(join(base, 'capacity')),
    readText(join(base, 'status')),
    readText(join(base, 'temp')),
  ]);
  if (cap === null && status === null && temp === null) return null;
  const rawTemp = num(temp);
  return {
    capacity: num(cap),
    status: status ? status.slice(0, 32) : null,
    // power_supply/temp é em décimos de grau.
    tempC: rawTemp === null ? null : normalizeTemp(Math.abs(rawTemp) < 1000 ? rawTemp / 10 : rawTemp),
  };
}

async function readDisk(path: string): Promise<PhoneMetrics['disk']> {
  try {
    const s = await statfs(path);
    return {
      totalMB: Math.round((s.blocks * s.bsize) / 1048576),
      freeMB: Math.round((s.bavail * s.bsize) / 1048576),
    };
  } catch {
    return null;
  }
}

/** CPU do próprio processo (% de um núcleo) entre chamadas. */
export class SelfCpu {
  private last = process.cpuUsage();
  private lastT = performance.now();
  read(): number {
    const now = performance.now();
    const cur = process.cpuUsage();
    const usedUs = cur.user - this.last.user + (cur.system - this.last.system);
    const pct = now > this.lastT ? (usedUs / 1000 / (now - this.lastT)) * 100 : 0;
    this.last = cur;
    this.lastT = now;
    return Math.round(pct * 100) / 100;
  }
}

export interface PhoneReaderOptions {
  procRoot: string;
  sysRoot: string;
  /** Caminho usado no statfs (a pasta de dados). */
  diskPath: string;
}

export class PhoneReader {
  private cpu = new SelfCpu();
  private readonly thermal: ThermalReader;
  constructor(private readonly opts: PhoneReaderOptions) {
    this.thermal = new ThermalReader(opts.sysRoot);
  }

  async read(): Promise<PhoneMetrics> {
    const { procRoot, sysRoot, diskPath } = this.opts;
    const [loadS, memS, upS, thermal, battery, disk, selfStatus, rollup] = await Promise.all([
      readText(join(procRoot, 'loadavg')),
      readText(join(procRoot, 'meminfo')),
      readText(join(procRoot, 'uptime')),
      this.thermal.read(),
      readBattery(sysRoot),
      readDisk(diskPath),
      readText('/proc/self/status'),
      readText('/proc/self/smaps_rollup'),
    ]);
    const anon = selfStatus ? /^RssAnon:\s+(\d+)/m.exec(selfStatus) : null;
    const pss = rollup ? /^Pss:\s+(\d+)/m.exec(rollup) : null;
    const mem = process.memoryUsage();
    const up = upS ? num(upS.split(/\s+/)[0]) : null;
    return {
      at: Date.now(),
      load: parseLoadavg(loadS),
      mem: parseMeminfo(memS),
      uptimeS: up === null ? null : Math.round(up),
      tempC: thermal.tempC,
      tempZone: thermal.zone,
      battery,
      disk,
      self: {
        rssMB: Math.round((mem.rss / 1048576) * 10) / 10,
        privateMB: anon ? Math.round((Number(anon[1]) / 1024) * 10) / 10 : null,
        pssMB: pss ? Math.round((Number(pss[1]) / 1024) * 10) / 10 : null,
        heapUsedMB: Math.round((mem.heapUsed / 1048576) * 10) / 10,
        cpuPct: this.cpu.read(),
      },
    };
  }
}
