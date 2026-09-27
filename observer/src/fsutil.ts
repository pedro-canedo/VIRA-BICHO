// Gravação atômica e durável: escreve num .tmp, faz fsync, renomeia e sincroniza o diretório.
// Sem o fsync, uma queda de energia do celular logo após o rename pode deixar o arquivo vazio.
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

async function syncDir(dir: string): Promise<void> {
  try {
    const h = await open(dir, 'r');
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch {
    // Alguns sistemas de arquivos (e o Android) não deixam abrir/sincronizar diretórios.
  }
}

export async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp`;
  try {
    const h = await open(tmp, 'w', 0o600);
    try {
      await h.writeFile(data);
      await h.sync();
    } finally {
      await h.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await syncDir(dirname(path));
}

/** Versão síncrona, para gravações raras e pequenas (sessões revogadas). */
export function writeAtomicSync(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // já não existe
    }
    throw err;
  }
  try {
    const fd = openSync(dirname(path), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // diretório não sincronizável
  }
}
