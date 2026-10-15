<img src="src/logo.svg" width="48" alt="">

# diff

a local, private, very fast github "files changed" view. point it at any PR, including private repos and PRs too big for github's diff API (it refuses anything over 300 files).

```sh
diff https://github.com/owner/repo/pull/123
diff owner/repo#123
diff owner/repo#123 --no-open   # print the url instead of opening it
diff --restart                  # restart the background server
diff --stop
```

it shadows `/usr/bin/diff` through a tiny shim in `~/.local/bin/diff` — anything that isn't a PR ref or one of the flags above just falls through to the real diff, so `diff a b` still works.

needs `bun`, `git`, and `gh` (logged in). auth is just `gh auth token`, so whatever you can see on github, this can see.

## why

github's diff viewer is slow on big PRs and doesn't let you hide the stuff you don't care about. geld (the browser extension) fixes the second part but still sits on top of github's page. i wanted the github UI 1:1 minus the extra buttons, with geld-style hiding baked in — and "hidden" meaning actually gone, sidebar included.

## how it works

it keeps a blobless bare clone per repo in `~/.cache/prv/<owner>/<repo>.git`. on load it fetches the PR head and base, takes the merge base, and runs `git diff -M` locally — no diff API, no file limits. the patch gets split per file and classified with geld's catalog (ported verbatim from geld 0.1.2). results are cached by `<merge-base>..<head>`, so an unchanged head is basically free.

a background server on `127.0.0.1:7717` (or `PRV_PORT`) serves the page. the page paints from cache immediately, then refreshes in the background. it renders github's own diff markup with primer styling, shiki runs in a worker, and file bodies only render near the viewport.

rough #'s on a ~1000-file PR: ~80ms warm, ~0.9s on a new head, ~8s the very first time (mostly the clone).

## hiding

hidden files disappear from the tree and the diff list, and folders that end up empty go with them.

- categories: the filter button next to "filter files…" lists geld's categories w/ counts. tests, agent config, and docs are hidden by default. global setting.
- by hand: the eye button on a file header, or `h`. saved per PR. the "N hidden" menu lists these with unhide / unhide all.

the header diffstat only counts visible files. hover it for totals and what's hidden.

## reviewed

the reviewed checkbox on a file header, or `v`, marks a file done and collapses it. its tree row fades out, and a folder collapses once everything in it is reviewed. clicking a reviewed file in the tree opens it, and it collapses again once you move on to another file. "N / M viewed" in the header tracks progress. marks are keyed by a hash of that file's diff, so if a refresh changes the file, the mark clears and you look at it again.

## export

export writes one self-contained `.html` w/ your hides baked in (hidden files' contents are left out). reviewed marks deliberately don't carry over — whoever opens it gets a clean slate to click through, and their own marks persist in their browser. no install, no network, no github access. hunk expansion and refresh are off in an export. you can also drop an export onto a live page.

## keys

`j` / `k` next / prev file · `h` hide · `v` reviewed · `r` refresh

## firefox extension

`extension/` sends github's "files changed" tab here: clicking it, or opening a `…/pull/N/files` link from anywhere, lands on `127.0.0.1:7717` instead. if the server isn't running, github loads as usual. the toolbar button turns it off and on. links to a single commit's diff stay on github.

release firefox only keeps signed extensions, so sign it once as unlisted (free, automatic, not published) with an [AMO API key](https://addons.mozilla.org/developers/addon/api/key/):

```sh
WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… bunx web-ext sign -s extension --channel unlisted
```

then open the `.xpi` from `web-ext-artifacts/` in firefox. bump `version` in the manifest before signing again. for a quick try, `about:debugging` → load temporary add-on → `extension/manifest.json` (gone on restart).

## develop

```sh
bun install
bun run check     # types, tests, then the bundle and perf budgets
```

`checks/budget.json` holds hard budgets, and they only go down. `checks/bundle.ts` checks the size of the app, the worker, and the stylesheet. `checks/perf.ts` serves a synthetic 1,471-file PR (`checks/fixture.ts`, same bytes every run) on its own port and cache, drives headless Firefox through first load, scrolling, a scrollbar drag, `j`, tree jumps, reviewing, category toggles, the tree filter, and unified → split, and compares the median of 5 runs. Timings come from Event Timing (input → next paint) and a frame recorder (time past 50 ms per frame). If one trips, make it faster; don't raise the number. When a change makes things faster, `bun run ratchet` lowers the budgets to the new numbers plus headroom.

`bun checks/perf.ts owner/repo#N` runs the same scenarios against a real PR from `~/.cache/prv` (open it with `diff` once first) and only reports. The first run needs Firefox for Playwright: `bunx playwright-core install firefox`.
