import { getFiletypeFromFileName } from '@pierre/diffs';
import { githubRead } from './repository-github.ts';
import type { RepoBranches, RepoEntry, RepoFile, RepoSnapshot, RepoTree } from './repository-types.ts';

export class RepoError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function checkRepo(owner: string, repo: string) {
  if (![owner, repo].every((s) => /^[\w.-]+$/.test(s) && s !== '.' && s !== '..')) throw new RepoError('Invalid repository');
}

export function checkSha(sha: string) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new RepoError('Invalid commit or object ID');
}

export function checkPath(path: string) {
  if (path.startsWith('/') || path.includes('\0') || (path && path.split('/').some((p) => !p || p === '.' || p === '..'))) {
    throw new RepoError('Invalid repository path');
  }
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const body = await githubRead<{ data?: T; errors?: { message: string }[] }>('/graphql', { query, variables });
  if (body.errors?.length || !body.data) throw new RepoError(body.errors?.map((e) => e.message).join('; ') ?? 'GitHub request failed', 502);
  return body.data;
}

interface Commit {
  oid: string;
  tree: { oid: string };
  messageHeadline: string;
  committedDate: string;
  author: { name: string; avatarUrl: string };
}
const COMMIT = 'oid tree{oid} messageHeadline committedDate author{name avatarUrl}';

interface Recent<T> { expires: number; promise: Promise<T> }
const snapshots = new Map<string, Recent<RepoSnapshot>>();
const branchPages = new Map<string, Recent<RepoBranches>>();
function recent<T>(cache: Map<string, Recent<T>>, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) return existing.promise;
  const promise = load();
  cache.delete(key);
  cache.set(key, { expires: Date.now() + ttl, promise });
  promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
  return promise;
}

export async function repoSnapshot(owner: string, repo: string, branch = '', sha = ''): Promise<RepoSnapshot> {
  checkRepo(owner, repo);
  if (sha) checkSha(sha);
  // Branch heads must be resolved afresh, including on Refresh. A pinned
  // commit cannot move; briefly cache its metadata to make reloads local.
  if (sha) return recent(snapshots, JSON.stringify([owner, repo, branch, sha]), 60_000, () => loadSnapshot(owner, repo, branch, sha));
  const snapshot = await loadSnapshot(owner, repo, branch, sha);
  // The URL now contains this commit; its first reload can reuse this lookup.
  await recent(snapshots, JSON.stringify([owner, repo, snapshot.branch, snapshot.sha]), 60_000, () => Promise.resolve(snapshot));
  return snapshot;
}

async function loadSnapshot(owner: string, repo: string, branch: string, sha: string): Promise<RepoSnapshot> {
  const data = await graphql<{ repository: {
    isPrivate: boolean;
    owner: { avatarUrl: string };
    defaultBranchRef: { name: string; target: Commit } | null;
    object?: Commit | null;
  } | null }>(`query($o:String!,$r:String!,$rev:String!,$selected:Boolean!){repository(owner:$o,name:$r){isPrivate owner{avatarUrl} defaultBranchRef{name target{... on Commit{${COMMIT}}}} object(expression:$rev) @include(if:$selected){... on Commit{${COMMIT}}}}}`,
  { o: owner, r: repo, rev: sha || `refs/heads/${branch}`, selected: !!(sha || branch) });
  const r = data.repository;
  if (!r) throw new RepoError('Repository not found or access denied', 404);
  if (!r.defaultBranchRef) throw new RepoError('This repository has no commits yet', 404);
  const c = sha || branch ? r.object : r.defaultBranchRef.target;
  if (!c?.tree) throw new RepoError(`Branch or commit not found: ${branch || sha}`, 404);
  return { repo: `${owner}/${repo}`, branch: branch || r.defaultBranchRef.name, defaultBranch: r.defaultBranchRef.name,
    private: r.isPrivate, sha: c.oid, tree: c.tree.oid, message: c.messageHeadline, author: c.author.name, date: c.committedDate,
    ownerAvatar: r.owner.avatarUrl, authorAvatar: c.author.avatarUrl };
}

export function repoBranches(owner: string, repo: string, query = '', cursor: string | null = null): Promise<RepoBranches> {
  checkRepo(owner, repo);
  return recent(branchPages, JSON.stringify([owner, repo, query, cursor]), 30_000, () => loadBranches(owner, repo, query, cursor));
}

async function loadBranches(owner: string, repo: string, query: string, cursor: string | null): Promise<RepoBranches> {
  const data = await graphql<{ repository: { refs: { nodes: { name: string }[]; totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null }>(
    'query($o:String!,$r:String!,$q:String!,$after:String){repository(owner:$o,name:$r){refs(refPrefix:"refs/heads/",query:$q,first:50,after:$after,orderBy:{field:ALPHABETICAL,direction:ASC}){nodes{name}totalCount pageInfo{hasNextPage endCursor}}}}',
    { o: owner, r: repo, q: query, after: cursor });
  if (!data.repository) throw new RepoError('Repository not found or access denied', 404);
  const r = data.repository.refs;
  return { names: r.nodes.map((n) => n.name), total: r.totalCount, cursor: r.pageInfo.endCursor, more: r.pageInfo.hasNextPage };
}

// Git objects are immutable. Cache a bounded number of requests by object ID,
// and share in-flight requests from the sidebar and directory viewer.
const trees = new Map<string, Promise<RepoTree>>();
function cached<T>(cache: Map<string, Promise<T>>, key: string, limit: number, load: () => Promise<T>): Promise<T> {
  let value = cache.get(key);
  if (value) return value;
  value = load();
  cache.set(key, value);
  value.catch(() => cache.delete(key));
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
  return value;
}

export function repoTree(owner: string, repo: string, sha: string, recursive = false): Promise<RepoTree> {
  checkRepo(owner, repo); checkSha(sha);
  const path = `/repos/${owner}/${repo}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`;
  return cached(trees, path, 128, async () => {
    const data = await githubRead<{ tree: RepoEntry[]; truncated: boolean }>(path);
    return { entries: data.tree.map(({ path, type, mode, sha, size }) => ({ path, type, mode, sha, size })), truncated: data.truncated };
  });
}

/** Resolve paths through the pinned tree, never through a moving branch name. */
export async function repoEntry(owner: string, repo: string, tree: string, path: string): Promise<RepoEntry> {
  checkPath(path); checkSha(tree); checkRepo(owner, repo);
  return resolveEntry(tree, path, (sha) => repoTree(owner, repo, sha));
}

export async function resolveEntry(tree: string, path: string, readTree: (sha: string) => Promise<RepoTree>): Promise<RepoEntry> {
  checkPath(path); checkSha(tree);
  if (!path) return { path: '', type: 'tree', mode: '040000', sha: tree };
  let entry: RepoEntry = { path: '', type: 'tree', mode: '040000', sha: tree };
  for (const part of path.split('/')) {
    if (entry.type !== 'tree') throw new RepoError('Path is not a directory', 404);
    const next = (await readTree(entry.sha)).entries.find((e) => e.path === part);
    if (!next) throw new RepoError(`Path not found on this branch: ${path}`, 404);
    entry = next;
  }
  return { ...entry, path };
}

const MAX_PREVIEW = 2 * 1024 * 1024;
const blobs = new Map<string, Promise<Buffer>>();
export async function repoBlob(owner: string, repo: string, entry: RepoEntry): Promise<Buffer> {
  checkRepo(owner, repo); checkSha(entry.sha);
  if (entry.type !== 'blob') throw new RepoError('This entry is not a file');
  if ((entry.size ?? 0) > MAX_PREVIEW) throw new RepoError('This file is larger than the 2 MB local preview limit. Open it on GitHub.', 413);
  return cached(blobs, `${owner}/${repo}/${entry.sha}`, 32, async () => {
    const blob = await githubRead<{ encoding: string; content: string; size: number }>(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
    if (blob.size > MAX_PREVIEW) throw new RepoError('File is too large to preview', 413);
    if (blob.encoding !== 'base64') throw new RepoError('Unsupported file encoding', 415);
    return Buffer.from(blob.content, 'base64');
  });
}

export function decodeFile(bytes: Uint8Array): { text: string | null; binary: boolean } {
  if (bytes.includes(0)) return { text: null, binary: true };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), binary: false }; }
  catch { return { text: null, binary: true }; }
}

export async function repoFile(owner: string, repo: string, entry: RepoEntry): Promise<RepoFile> {
  if (entry.type !== 'blob') throw new RepoError('This entry is not a file');
  const lang = getFiletypeFromFileName(entry.path);
  if ((entry.size ?? 0) > MAX_PREVIEW) return { size: entry.size!, binary: false, text: null, tooLarge: true, lang };
  const data = await repoBlob(owner, repo, entry);
  return { size: data.length, ...decodeFile(data), tooLarge: false, lang };
}
