import { token } from './github.ts';
import type { RepoHome } from './repository-types.ts';

/** Authenticated, read-only GitHub requests for the repository browser. */
export async function githubRead<T>(path: string, query?: { query: string; variables: Record<string, unknown> }): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: query ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    ...(query ? { body: JSON.stringify(query) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}. Check repository access and try again.`);
  return res.json() as Promise<T>;
}

export async function githubArchive(owner: string, repo: string, sha: string): Promise<Response> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`, {
    headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Could not prepare repository search (GitHub ${response.status})`);
  return response;
}

/** Only fetch metadata for the start page; clone a repository when a PR is opened. */
export async function loadRepoHome(repo: string): Promise<RepoHome> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected a repository in owner/repo format');
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`, {
    headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Could not load ${repo} from GitHub (${res.status}). Check gh auth status and try refreshing.`);
  const pulls = (await res.json()) as { number: number; title: string; user: { login: string } | null; draft: boolean }[];
  return { repo, pulls: pulls.map((p) => ({ number: p.number, title: p.title, author: p.user?.login ?? 'unknown', draft: p.draft })) };
}
