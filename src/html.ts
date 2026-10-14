// The HTML shell shared by the live page and exported files.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// Inline scripts must not contain `</script` or `<!--`; both escapes are
// no-ops inside JS strings, regexes, and template literals.
const inlineScript = (js: string) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');


interface ShellOptions {
  title: string;
  css: string;
  /** Inline script that runs first and sets `window.__prvBoot`. */
  boot: string;
  /** Extra markup at the end of <body> (the app script, embedded data). */
  body: string;
  head?: string;
}

function shell(o: ShellOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(o.title)}</title>
<script>${inlineScript(o.boot)}</script>
${o.head ?? ''}<style>${o.css}</style>
</head>
<body>
<div id="app"></div>
${o.body}
</body>
</html>`;
}

export function livePage(p: { owner: string; repo: string; number: number; css: string; hash: string }): string {
  const api = `/api/pr/${p.owner}/${p.repo}/${p.number}?cached=1`;
  const boot = `window.__prvBoot={mode:'live',owner:${JSON.stringify(p.owner)},repo:${JSON.stringify(p.repo)},number:${p.number},manifest:fetch(${JSON.stringify(api)}).then(function(r){return r.ok?r.json():r.text().then(function(t){throw new Error(t)})})};`;
  const src = `/app.js?v=${p.hash}`;
  return shell({
    title: `${p.owner}/${p.repo}#${p.number} · prv`,
    css: p.css,
    boot,
    head: `<link rel="modulepreload" href="${src}">\n`,
    body: `<script type="module" src="${src}"></script>`,
  });
}

export function indexPage(p: { css: string; hash: string }): string {
  const src = `/app.js?v=${p.hash}`;
  return shell({
    title: 'prv',
    css: p.css,
    boot: `window.__prvBoot={mode:'index'};`,
    body: `<script type="module" src="${src}"></script>`,
  });
}

export function exportPage(p: { title: string; css: string; js: string; bundleB64: string; workerB64: string }): string {
  return shell({
    title: p.title,
    css: p.css,
    boot: `window.__prvBoot={mode:'export'};`,
    body: `<script type="application/octet-stream" id="prv-bundle">${p.bundleB64}</script>
<script type="application/octet-stream" id="prv-worker">${p.workerB64}</script>
<script type="module">${inlineScript(p.js)}</script>`,
  });
}
