import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhoneReader, normalizeTemp, parseLoadavg, parseMeminfo } from '../observer/src/phone';
import { parseSvStatus, readServices } from '../observer/src/services';

describe('métricas do celular (/proc e /sys)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'obs-phone-'));
  });
  afterEach(() => {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  function fakeTree() {
    const proc = join(root, 'proc');
    const sys = join(root, 'sys');
    mkdirSync(proc, { recursive: true });
    writeFileSync(join(proc, 'loadavg'), '1.25 0.80 0.50 2/345 6789\n');
    writeFileSync(join(proc, 'meminfo'), 'MemTotal:        3794000 kB\nMemFree:          200000 kB\nMemAvailable:    1536000 kB\n');
    writeFileSync(join(proc, 'uptime'), '12345.67 54321.00\n');
    for (const [zone, type, temp] of [
      ['thermal_zone0', 'cpu0', '41000'],
      ['thermal_zone1', 'battery', '33500'],
      ['thermal_zone2', 'off', '0'],
    ]) {
      mkdirSync(join(sys, 'class', 'thermal', zone), { recursive: true });
      writeFileSync(join(sys, 'class', 'thermal', zone, 'type'), type);
      writeFileSync(join(sys, 'class', 'thermal', zone, 'temp'), temp);
    }
    const bat = join(sys, 'class', 'power_supply', 'battery');
    mkdirSync(bat, { recursive: true });
    writeFileSync(join(bat, 'capacity'), '87\n');
    writeFileSync(join(bat, 'status'), 'Charging\n');
    writeFileSync(join(bat, 'temp'), '312\n');
    return { proc, sys };
  }

  it('lê carga, memória, uptime, temperatura, bateria e disco', async () => {
    const { proc, sys } = fakeTree();
    const m = await new PhoneReader({ procRoot: proc, sysRoot: sys, diskPath: root }).read();
    expect(m.load).toEqual([1.25, 0.8, 0.5]);
    expect(m.mem).toEqual({ totalMB: 3705, availableMB: 1500 });
    expect(m.uptimeS).toBe(12346);
    expect(m.tempC).toBe(41);
    expect(m.tempZone).toBe('cpu0');
    expect(m.battery).toEqual({ capacity: 87, status: 'Charging', tempC: 31.2 });
    expect(m.disk && m.disk.totalMB).toBeGreaterThan(0);
    expect(m.self.rssMB).toBeGreaterThan(0);
  });

  it('tolera /proc e /sys ausentes ou ilegíveis (EACCES/EISDIR) devolvendo null', async () => {
    const { proc, sys } = fakeTree();
    // "temp" vira diretório (EISDIR) e a bateria some; a pasta /proc fica sem permissão.
    rmSync(join(sys, 'class', 'thermal', 'thermal_zone0', 'temp'));
    mkdirSync(join(sys, 'class', 'thermal', 'thermal_zone0', 'temp'));
    rmSync(join(sys, 'class', 'power_supply'), { recursive: true });
    chmodSync(proc, 0o000);
    const m = await new PhoneReader({ procRoot: proc, sysRoot: sys, diskPath: join(root, 'nao-existe') }).read();
    if (process.getuid?.() !== 0) {
      expect(m.load).toBeNull();
      expect(m.mem).toBeNull();
      expect(m.uptimeS).toBeNull();
    }
    expect(m.tempC).toBe(33.5); // sobra a zona da bateria
    expect(m.battery).toBeNull();
    expect(m.disk).toBeNull();
    chmodSync(proc, 0o700);

    const empty = await new PhoneReader({ procRoot: join(root, 'x'), sysRoot: join(root, 'y'), diskPath: join(root, 'z') }).read();
    expect(empty).toMatchObject({ load: null, mem: null, uptimeS: null, tempC: null, tempZone: null, battery: null, disk: null });
  });

  it('interpreta formatos de leitura', () => {
    expect(parseLoadavg('garbage')).toBeNull();
    expect(parseMeminfo('MemFree: 100 kB')).toBeNull();
    expect(normalizeTemp(45000)).toBe(45);
    expect(normalizeTemp(450)).toBe(45);
    expect(normalizeTemp(45)).toBe(45);
    expect(normalizeTemp(-273000)).toBeNull();
  });
});

describe('serviços runit', () => {
  it('interpreta a saída do sv status', () => {
    const out = [
      'run: /data/data/com.termux/files/usr/var/service/vira-bicho: (pid 1234) 3600s; run: log: (pid 1235) 3601s',
      'down: /data/data/com.termux/files/usr/var/service/vira-bicho-obs: 5s, normally up; run: log: (pid 99) 10s',
      'fail: /data/data/com.termux/files/usr/var/service/x: unable to change to service directory: file does not exist',
      'lixo',
    ].join('\n');
    expect(parseSvStatus(out)).toEqual([
      { name: 'vira-bicho', state: 'run', pid: 1234, uptimeS: 3600, log: 'run' },
      { name: 'vira-bicho-obs', state: 'down', pid: null, uptimeS: 5, log: 'run' },
      { name: 'x', state: 'fail', pid: null, uptimeS: null, log: null },
    ]);
  });

  it('sem pasta de serviços ou sem o comando sv: ignora (null)', async () => {
    expect(await readServices(null)).toBeNull();
    expect(await readServices(join(tmpdir(), 'nao-existe-obs-sv'))).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'obs-sv-'));
    mkdirSync(join(dir, 'vira-bicho'));
    const path = process.env.PATH;
    process.env.PATH = join(dir, 'sem-bin');
    try {
      expect(await readServices(dir)).toBeNull();
    } finally {
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
