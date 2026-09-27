// Estado dos serviços runit do Termux ("sv status" em $PREFIX/var/service/*).
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface ServiceStatus {
  name: string;
  /** run, down, finish, fail, warning... */
  state: string;
  pid: number | null;
  uptimeS: number | null;
  /** Estado do logger (svlogger), quando existir. */
  log: string | null;
}

/**
 * Interpreta a saída do sv status, uma linha por serviço, por exemplo:
 *   run: /data/.../service/vira-bicho: (pid 1234) 3600s; run: log: (pid 1235) 3600s
 *   down: /data/.../service/vira-bicho-obs: 5s, normally up
 *   fail: /data/.../service/x: unable to change to service directory: file does not exist
 */
export function parseSvStatus(out: string): ServiceStatus[] {
  const list: ServiceStatus[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\w+): ([^:]+): (.*)$/.exec(line.trim());
    if (!m) continue;
    const [, state, path, rest] = m;
    const [main, logPart] = rest.split(/;\s*/, 2);
    const pid = /\(pid (\d+)\)/.exec(main);
    const up = /(\d+)s\b/.exec(main);
    const log = logPart ? /^(\w+): log:/.exec(logPart.trim()) : null;
    list.push({
      name: basename(path.trim()),
      state,
      pid: pid ? Number(pid[1]) : null,
      uptimeS: up ? Number(up[1]) : null,
      log: log ? log[1] : null,
    });
  }
  return list;
}

/** null quando não há runit (sv ausente ou pasta de serviços inexistente): o painel só esconde a seção. */
export async function readServices(serviceDir: string | null, timeoutMs = 3_000): Promise<ServiceStatus[] | null> {
  if (!serviceDir) return null;
  let dirs: string[];
  try {
    const entries = await readdir(serviceDir, { withFileTypes: true });
    dirs = entries.filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')).map((e) => join(serviceDir, e.name));
  } catch {
    return null;
  }
  if (dirs.length === 0) return [];
  return new Promise((resolvePromise) => {
    execFile('sv', ['status', ...dirs.slice(0, 64)], { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        resolvePromise(null);
        return;
      }
      // sv sai com código != 0 quando algum serviço não está rodando; a saída continua válida.
      resolvePromise(parseSvStatus(String(stdout ?? '')));
    });
  });
}
