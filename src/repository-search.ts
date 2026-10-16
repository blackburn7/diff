import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_ROOT } from './github.ts';
import { githubArchive } from './repository-github.ts';
import { checkRepo, checkSha, RepoError } from './repository.ts';

export interface SearchMatch { path: string; line: number; text: string }
export interface SearchResult { indexing?: boolean; matches: SearchMatch[]; truncated: boolean }
const indexes = new Map<string, Promise<void>>();
const indexErrors = new Map<string, string>();

// Only regular files and symlink *text* are copied. Archive paths never escape
// the temporary directory, and no archive permissions or executables are run.
const EXTRACT = `import sys, tarfile, pathlib, shutil
root=pathlib.Path(sys.argv[2])
with tarfile.open(sys.argv[1], 'r:gz') as archive:
 for member in archive:
  parts=pathlib.PurePosixPath(member.name).parts
  if len(parts)<2: continue
  parts=parts[1:]
  if any(p in ('','..','.') for p in parts) or member.name.startswith('/'): raise ValueError('Invalid archive path')
  destination=root.joinpath(*parts)
  if member.isdir(): destination.mkdir(parents=True,exist_ok=True)
  elif member.isfile() or member.issym():
   destination.parent.mkdir(parents=True,exist_ok=True)
   if member.issym(): destination.write_text(member.linkname)
   else:
    with archive.extractfile(member) as source, destination.open('wb') as target: shutil.copyfileobj(source,target)
`;

async function prepare(owner: string, repo: string, sha: string, root: string) {
  mkdirSync(root, { recursive: true });
  const temp = mkdtempSync(join(root, '.prepare-'));
  try {
    const archive = join(temp, 'snapshot.tar.gz');
    await Bun.write(archive, await githubArchive(owner, repo, sha));
    const files = join(temp, 'files');
    mkdirSync(files);
    const process = Bun.spawn(['python3', '-c', EXTRACT, archive, files], { stdout: 'ignore', stderr: 'pipe' });
    const error = await new Response(process.stderr).text();
    if (await process.exited) throw new Error(`Could not unpack repository snapshot: ${error.slice(-500)}`);
    const destination = join(root, sha);
    if (!existsSync(destination)) renameSync(files, destination);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export async function grepRepository(owner: string, repo: string, sha: string, query: string, regex = false): Promise<SearchResult> {
  checkRepo(owner, repo); checkSha(sha);
  if (!query.trim()) return { matches: [], truncated: false };
  if (query.length > 2000 || query.includes('\n') || query.includes('\0')) throw new RepoError('Use a single search expression under 2,000 characters');
  const root = join(CACHE_ROOT, 'search', owner, repo);
  const directory = join(root, sha);
  if (!existsSync(directory)) {
    const error = indexErrors.get(directory);
    if (error) { indexErrors.delete(directory); indexes.delete(directory); throw new RepoError(error, 502); }
    let task = indexes.get(directory);
    if (!task) {
      task = prepare(owner, repo, sha, root);
      indexes.set(directory, task);
      // Retain errors for the next poll, without an unhandled rejection.
      void task.catch((e) => indexErrors.set(directory, e instanceof Error ? e.message : String(e)));
      return { indexing: true, matches: [], truncated: false };
    }
    return { indexing: true, matches: [], truncated: false };
  }
  const process = Bun.spawn(['rg', '--json', '--line-number', '--hidden', '--no-ignore', '--no-messages', '--color', 'never', '--ignore-case',
    ...(regex ? [] : ['--fixed-strings']), '-e', query, '.'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const stderr = new Response(process.stderr).text();
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  const matches: SearchMatch[] = [];
  let pending = '', truncated = false;
  try {
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type !== 'match') continue;
        if (matches.length === 200) { truncated = true; process.kill(); break outer; }
        const data = event.data;
        const path = data.path.text ?? Buffer.from(data.path.bytes, 'base64').toString('utf8');
        const text = data.lines.text ?? Buffer.from(data.lines.bytes, 'base64').toString('utf8');
        matches.push({ path: path.replace(/^\.\//, ''), line: data.line_number, text: text.replace(/\r?\n$/, '').slice(0, 500) });
      }
    }
  } finally { reader.releaseLock(); }
  const code = await process.exited;
  const error = await stderr;
  if (!truncated && code !== 0 && code !== 1) throw new RepoError(error.trim() || 'Search failed');
  return { matches, truncated };
}
