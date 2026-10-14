# prv

a local, private, very fast github "files changed" view. point it at any PR, including private repos and PRs too big for github's diff API (it refuses anything over 300 files).

```sh
prv https://github.com/owner/repo/pull/123
prv owner/repo#123
prv owner/repo#123 --no-open   # print the url instead of opening it
prv --restart                  # restart the background server
prv --stop
```

needs `bun`, `git`, and `gh` (logged in). auth is just `gh auth token`, so whatever you can see on github, prv can see.

## why

github's diff viewer is slow on big PRs and doesn't let you hide the stuff you don't care about. geld (the browser extension) fixes the second part but still sits on top of github's page. i wanted the github UI 1:1 minus the extra buttons, with geld-style hiding baked in — and "hidden" meaning actually gone, sidebar included.

## how it works

prv keeps a blobless bare clone per repo in `~/.cache/prv/<owner>/<repo>.git`. on load it fetches the PR head and base, takes the merge base, and runs `git diff -M` locally — no diff API, no file limits. the patch gets split per file and classified with geld's catalog (ported verbatim from geld 0.1.2). results are cached by `<merge-base>..<head>`, so an unchanged head is basically free.

a background server on `127.0.0.1:7717` (or `PRV_PORT`) serves the page. the page paints from cache immediately, then refreshes in the background. it renders github's own diff markup with primer styling, shiki runs in a worker, and file bodies only render near the viewport.

rough #'s on a ~1000-file PR: ~80ms warm, ~0.9s on a new head, ~8s the very first time (mostly the clone).

## hiding

hidden files disappear from the tree and the diff list, and folders that end up empty go with them.

- categories: the filter button next to "filter files…" lists geld's categories w/ counts. tests and agent config are hidden by default. global setting.
- by hand: the eye button on a file header, or `h`. saved per PR. the "N hidden" menu lists these with unhide / unhide all.

the header diffstat only counts visible files. hover it for totals and what's hidden.

## reviewed

the reviewed checkbox on a file header, or `v`, marks a file done and collapses it. its tree row stays, tinted. marks are keyed by a hash of that file's diff, so if a refresh changes the file, the mark clears and you look at it again.

## export

export writes one self-contained `.html` w/ your hides and reviewed marks. hidden files' contents are left out. send it to someone and they just open it — no install, no network, no github access. hunk expansion and refresh are off in an export. you can also drop an export onto a live prv page.

## keys

`j` / `k` next / prev file · `h` hide · `v` reviewed · `r` refresh

## develop

```sh
bun install
bun test
bunx tsc --noEmit
```
