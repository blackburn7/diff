// Bundle the client: the app as one ES module and the Shiki highlighter as one
// classic worker script. Neither has imports or chunks, so an export can
// inline both. Grammars are not bundled; the server (or the export) supplies
// the ones a PR uses.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

export interface ClientBuild {
  js: string;
  css: string;
  worker: string;
  hash: string;
}

async function bundle(entry: string, format: 'esm' | 'iife'): Promise<string> {
  const res = await Bun.build({ entrypoints: [join(ROOT, entry)], target: 'browser', format, minify: true });
  if (!res.success) throw new AggregateError(res.logs, `build of ${entry} failed`);
  if (res.outputs.length !== 1) throw new Error(`${entry} produced ${res.outputs.length} outputs`);
  return res.outputs[0]!.text();
}

export async function buildClient(): Promise<ClientBuild> {
  const [js, worker] = await Promise.all([bundle('src/client/app.ts', 'esm'), bundle('src/client/hl-worker.ts', 'iife')]);
  const css = readFileSync(join(ROOT, 'src/client/style.css'), 'utf8');
  const hash = createHash('sha1').update(js).update(worker).update(css).digest('hex').slice(0, 10);
  return { js, css, worker, hash };
}
