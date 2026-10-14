// A cheap fingerprint of the source tree. The CLI restarts a running daemon
// whose fingerprint differs, so edits take effect on the next `prv`.
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

export function sourceVersion(): string {
  const h = createHash('sha1');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${p}:${st.mtimeMs}:${st.size}\n`);
    }
  };
  walk(join(ROOT, 'src'));
  for (const f of ['package.json', 'bun.lock']) {
    const st = statSync(join(ROOT, f));
    h.update(`${f}:${st.mtimeMs}:${st.size}\n`);
  }
  return h.digest('hex').slice(0, 12);
}
