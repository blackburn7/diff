// Loaded only after all original PR endpoints have been ruled out.
import type { ClientBuild } from './build.ts';
import { homeBuild, repositoryBuild, markdownBuild } from './repository-build.ts';
import { homePage, repoPage } from './repository-html.ts';
export { resetBuilds } from './repository-build.ts';

const DEFAULT_REPO = process.env.PRV_REPO;
const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
const text = (body: string, type: string, extra: Record<string, string> = {}) =>
  new Response(body, { headers: { 'content-type': type, ...extra } });
const pageHeaders = { 'cache-control': 'no-store', 'content-security-policy': "frame-ancestors 'none'" };

export async function routeRepository(req: Request, url: URL, client: ClientBuild): Promise<Response | null> {
  const path = url.pathname;
  let m: RegExpExecArray | null;
  if (path === '/' && DEFAULT_REPO) {
    const { loadRepoHome } = await import('./repository-github.ts');
    const [assets, home] = await Promise.all([homeBuild(), loadRepoHome(DEFAULT_REPO).catch((e) => ({
      repo: DEFAULT_REPO, pulls: [], error: e instanceof Error ? e.message : String(e),
    }))]);
    return text(homePage({ css: client.css, hash: client.hash, homeHash: assets.hash, home }), 'text/html; charset=utf-8', pageHeaders);
  }
  if ((m = /^\/([\w.-]+)\/([\w.-]+)\/(?:tree|blob)\/?$/.exec(path))) {
    const assets = await repositoryBuild();
    return text(repoPage({ owner: m[1]!, repo: m[2]!, css: client.css, hash: assets.hash, workerHash: client.hash }), 'text/html; charset=utf-8', pageHeaders);
  }
  if (path === '/api/markdown-assets') {
    const assets = await markdownBuild();
    return json({ hash: assets.hash }, { headers: { 'cache-control': 'no-store' } });
  }
  if ((m = /^\/(home|repo|markdown)\.(js|css)$/.exec(path))) {
    const build = m[1] === 'home' ? homeBuild : m[1] === 'repo' ? repositoryBuild : markdownBuild;
    const assets = await build();
    const js = m[2] === 'js';
    // A stale page must not cache new bytes under an old content hash.
    const cache = url.searchParams.get('v') === assets.hash ? 'public, max-age=31536000, immutable' : 'no-store';
    return text(js ? assets.js : assets.css, js ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', { 'cache-control': cache });
  }
  if ((m = /^\/api\/repo\/([\w.-]+)\/([\w.-]+)\/(snapshot|branches|tree|entry|paths|raw|grep)$/.exec(path))) {
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, { status: 405 });
    return repositoryApi(url, m);
  }
  return null;
}

async function repositoryApi(url: URL, m: RegExpExecArray): Promise<Response> {
  const { repoSnapshot, repoBranches, repoTree, repoEntry, repoFile, repoBlob, RepoError } = await import('./repository.ts');
  try {
    const [owner, repo, action] = [m[1]!, m[2]!, m[3]!];
    const q = url.searchParams;
    if (action === 'grep') {
      const { grepRepository } = await import('./repository-search.ts');
      return json(await grepRepository(owner, repo, q.get('commit') ?? '', q.get('q') ?? '', q.get('regex') === '1'));
    }
    if (action === 'snapshot') {
      const snapshot = await repoSnapshot(owner, repo, q.get('ref') ?? '', q.get('commit') ?? '');
      const root = q.get('include') === 'root' ? await repoTree(owner, repo, snapshot.tree) : undefined;
      return json({ ...snapshot, ...(root ? { root } : {}) }, { headers: { 'cache-control': 'no-store' } });
    }
    if (action === 'branches') return json(await repoBranches(owner, repo, q.get('q') ?? '', q.get('cursor')));
    if (action === 'tree') return json(await repoTree(owner, repo, q.get('sha') ?? ''));
    if (action === 'paths') {
      const tree = await repoTree(owner, repo, q.get('sha') ?? '', true);
      return json({ paths: tree.entries.filter((entry) => entry.type !== 'tree').map((entry) => entry.path), truncated: tree.truncated });
    }
    const entry = await repoEntry(owner, repo, q.get('tree') ?? '', q.get('path') ?? '');
    if (action === 'raw') {
      const bytes = await repoBlob(owner, repo, entry);
      const ext = entry.path.split('.').pop()?.toLowerCase() ?? '';
      const images: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml' };
      const name = entry.path.split('/').pop()!.replace(/[\r\n"\\]/g, '_');
      return new Response(new Uint8Array(bytes), { headers: {
        'content-type': q.has('image') ? images[ext] ?? 'application/octet-stream' : 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox",
        ...(q.has('download') ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } : {}),
      } });
    }
    return json({ entry, ...(entry.type === 'tree' ? await repoTree(owner, repo, entry.sha) : entry.type === 'blob' ? { file: await repoFile(owner, repo, entry) } : {}) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof RepoError ? e.status : 500 });
  }
}
