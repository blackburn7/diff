import { h } from './dom.ts';
import type { RepoHome } from '../repository-types.ts';

function renderIndex(home?: RepoHome) {
  const input = h('input', { class: 'form-control', placeholder: 'https://github.com/owner/repo/pull/123 or owner/repo#123', autofocus: true }) as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    let v = input.value.trim();
    if (home && /^#?\d+$/.test(v)) v = `${home.repo}#${v.replace('#', '')}`;
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(v) ?? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(v);
    if (m) location.href = `/${m[1]}/${m[2]}/pull/${m[3]}`;
  });
  const page = h('div', { class: 'index' }, h('h1', {}, home?.repo ?? 'diff'), input);
  if (home) {
    page.append(h('p', {}, h('a', { class: 'btn', href: `/${home.repo}/tree` }, 'Code · Browse repository')));
    input.placeholder = 'PR number or GitHub pull request URL';
    page.append(h('p', {}, 'Recently updated open pull requests'), h('a', { href: `https://github.com/${home.repo}/pulls` }, 'View all on GitHub'));
    if (home.error) page.append(h('p', { class: 'flash flash-error', role: 'alert' }, home.error));
    else if (!home.pulls.length) page.append(h('p', {}, 'No open pull requests.'));
    for (const p of home.pulls) page.append(h('a', { class: 'repo-pull', href: `/${home.repo}/pull/${p.number}` },
      h('strong', {}, p.title), h('small', {}, `#${p.number} · ${p.author}${p.draft ? ' · Draft' : ''}`)));
  }
  document.getElementById('app')!.replaceChildren(page);
}

// A slow enhancement must not replace an export the user has already dropped.
if (document.querySelector('.index')) renderIndex((window as unknown as { __repoHome: RepoHome }).__repoHome);
