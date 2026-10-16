import { shell } from './html.ts';
import type { RepoHome } from './repository-types.ts';

const scriptData = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export function homePage(p: { css: string; hash: string; homeHash: string; home: RepoHome }): string {
  return shell({
    title: `${p.home.repo} · diff`, css: p.css,
    boot: `window.__prvBoot={mode:'index'};window.__repoHome=${scriptData(p.home)};`,
    head: `<link rel="stylesheet" href="/home.css?v=${p.homeHash}">\n`,
    // Keep the original app's export-drop support on the landing page. Deferred
    // modules execute in order, so the enhancement follows the index renderer.
    body: `<script type="module" src="/app.js?v=${p.hash}"></script>\n<script type="module" src="/home.js?v=${p.homeHash}"></script>`,
  });
}

export function repoPage(p: { owner: string; repo: string; css: string; hash: string; workerHash: string }): string {
  return shell({
    title: `${p.owner}/${p.repo} · Code`, css: p.css,
    boot: `window.__repoBoot=${scriptData({ owner: p.owner, repo: p.repo, workerHash: p.workerHash })};`,
    head: `<link rel="stylesheet" href="/repo.css?v=${p.hash}">\n`,
    body: `<script type="module" src="/repo.js?v=${p.hash}"></script>`,
  });
}
