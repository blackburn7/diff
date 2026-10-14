import { CATEGORIES, defaultEnabledCategories } from '../geld.ts';
import type { ExportBundle, ExportRequest, FileEntry, Manifest, ManualState, ReviewedState } from '../types.ts';
import {
  buildRows,
  colgroup,
  diffstatBlocks,
  esc,
  expand,
  parsePatch,
  patchDocs,
  renderRows,
  svg,
  type Line,
  type Parsed,
  type Row,
  type Tokens,
} from './diff.ts';
import { extractEmbedded, fmt, gunzipBase64, h } from './dom.ts';
import { Highlighter } from './highlight.ts';
import { FileTree } from './tree.ts';

type Boot =
  | { mode: 'live'; owner: string; repo: string; number: number; manifest: Promise<Manifest> }
  | { mode: 'export' }
  | { mode: 'index' };
type DiffStyle = 'split' | 'unified';

declare global {
  interface Window {
    __prvBoot: Boot;
    __prvTimings?: Record<string, unknown>;
    /** The running viewer, for debugging from the console. */
    __prvApp?: App;
  }
}

/** v2: unified became the default; choices saved under the old key (written
 *  when split was the default) are ignored. */
const PREFS_KEY = 'prv:prefs:v2';
/** v2: Agent config is hidden by default too; selections saved under the old
 *  key (Geld's default, Tests only) are ignored. */
const CATS_KEY = 'prv:cats:v2';
const DEFAULT_HIDDEN = [...defaultEnabledCategories(), 'agents'];
/** Patches bigger than this start behind "Load diff", like GitHub's large diffs. */
const LARGE_PATCH = 150_000;
const CAT_TITLE = new Map(CATEGORIES.map((c) => [c.id as string, c.title]));

const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const marks: Record<string, number> = {};
const mark = (k: string) => (marks[k] ??= Math.round(performance.now()));

interface Source {
  mode: 'live' | 'export';
  manifest: Manifest;
  /** Patch text by file index; `null` means omitted from an export. */
  patches: Map<number, string | null>;
  bundle?: ExportBundle;
}

async function decodeBundle(b64: string): Promise<ExportBundle> {
  const bundle = JSON.parse(await gunzipBase64(b64)) as ExportBundle;
  if (bundle.v !== 1) throw new Error(`unsupported export version ${bundle.v}`);
  return bundle;
}

function sourceFromBundle(bundle: ExportBundle): Source {
  const patches = new Map<number, string | null>();
  bundle.patches.forEach((p, i) => patches.set(i, p));
  return { mode: 'export', manifest: bundle.manifest, patches, bundle };
}

let workerUrl: string | undefined;
async function highlightWorkerUrl(): Promise<string> {
  if (workerUrl) return workerUrl;
  const embedded = document.getElementById('prv-worker')?.textContent;
  // file:// pages cannot start workers from disk; a blob URL works everywhere.
  workerUrl = embedded
    ? URL.createObjectURL(new Blob([await gunzipBase64(embedded)], { type: 'text/javascript' }))
    : '/hl-worker.js';
  return workerUrl;
}

/** GitHub renders `code` spans in PR titles. */
function titleHtml(t: string): string {
  return t
    .split(/(`[^`]+`)/)
    .map((p) => (p.length > 2 && p.startsWith('`') && p.endsWith('`') ? `<code class="notranslate">${esc(p.slice(1, -1))}</code>` : esc(p)))
    .join('');
}

// ------------------------------------------------------------- one file

/** One file's box: header plus an empty body, sized for content-visibility
 *  (`auto` makes the browser remember the real height once it renders). */
function fileShellHtml(f: FileEntry, i: number, hidden: boolean, reviewed: boolean): string {
  const binary = f.kinds?.includes('binary');
  const name = f.prevPath ? `${f.prevPath} → ${f.path}` : f.path;
  const stat =
    (f.additions ? `<span class="color-fg-success">+${fmt(f.additions)}</span>` : '') +
    (f.deletions ? `<span class="color-fg-danger">−${fmt(f.deletions)}</span>` : '');
  const est = Math.min(40000, (f.additions + f.deletions) * 20 + 60);
  return (
    `<div class="file${reviewed ? ' collapsed is-reviewed' : ''}" data-i="${i}"${hidden ? ' hidden' : ''} style="contain-intrinsic-size:auto ${est + 38}px"><div class="file-header"><div class="file-info">` +
    `<button type="button" class="btn-octicon js-details-target" data-act="toggle" aria-label="Toggle diff contents" aria-expanded="${!reviewed}">${svg('chevron-down', 'Details-content--shown')}${svg('chevron-right', 'Details-content--hidden')}</button>` +
    `<span class="Truncate"><a class="Link--primary Truncate-text" title="${esc(name)}" href="#" data-act="top"><bdi>${esc(name)}</bdi></a></span>` +
    `</div><div class="file-actions">` +
    `<span class="diffstat">${binary ? 'BIN' : stat} ${diffstatBlocks(f.additions, f.deletions, f.status === 'added')}</span>` +
    `<label class="btn btn-sm reviewed-toggle" title="Mark reviewed (v)"><input type="checkbox" data-act="review"${reviewed ? ' checked' : ''}> Reviewed</label>` +
    `<button type="button" class="btn-octicon" data-act="hide" aria-label="Hide file" title="Hide file (h)">${svg('eye-closed')}</button></div></div>` +
    `<div class="js-file-content" style="contain-intrinsic-size:auto ${est}px"></div></div>`
  );
}

class FileView {
  body: HTMLElement;
  rendered = false;
  parsed: Parsed | null = null;
  rows: Row[] = [];
  tokens: Tokens | null = null;
  full: { old: string[]; new: string[] } | null = null;
  private hydrating: Promise<void> | null = null;

  constructor(
    private app: App,
    readonly i: number,
    readonly el: HTMLElement,
  ) {
    this.body = el.lastElementChild as HTMLElement;
  }

  get f() {
    return this.app.files[this.i]!;
  }

  get collapsed() {
    return this.el.classList.contains('collapsed');
  }

  message(html: string) {
    this.body.innerHTML = `<div class="data highlight empty">${html}</div>`;
  }

  render() {
    this.rendered = true;
    const f = this.f;
    const patch = this.app.src.patches.get(this.i);
    if (patch === null) return this.message('Not included in this export.');
    if (f.size > LARGE_PATCH && !this.app.forceLoad.has(this.i)) {
      return this.message(
        `<button type="button" class="btn-link load-diff" data-act="load">Load diff</button><div class="load-note">Large diffs are not rendered by default.</div>`,
      );
    }
    if (patch === undefined) {
      this.rendered = false;
      this.app.requestPatch(this.i);
      return;
    }
    if (!this.parsed) {
      this.parsed = parsePatch(patch);
      const expandable = this.app.live && f.status !== 'added' && f.status !== 'deleted';
      this.rows = buildRows(this.parsed, expandable, expandable);
    }
    if (this.parsed.binary) return this.message('Binary file not shown.');
    if (!this.parsed.hunks.length) {
      if (f.kinds?.includes('renames')) return this.message('File renamed without changes.');
      if (f.kinds?.includes('modes')) return this.message('File mode changed.');
      return this.message(f.status === 'added' ? 'Empty file.' : 'File without changes.');
    }
    this.paint();
    if (!this.tokens) void this.highlight();
  }

  paint() {
    if (!this.parsed?.hunks.length) return;
    const mode = this.app.diffStyle;
    let max = 0;
    for (const r of this.rows) if (r.type === 'line') max = Math.max(max, r.line.o, r.line.n);
    this.body.innerHTML = `<div class="diff-table-wrap"><table class="diff-table js-diff-table tab-size${mode === 'split' ? ' file-diff-split' : ''}" data-tab-size="8">${colgroup(mode, max)}<tbody>${renderRows(this.rows, mode, this.tokens)}</tbody></table></div>`;
  }

  async highlight() {
    const f = this.f;
    if (f.lang === 'text') return;
    let docs: [string, string];
    let oldIdx: (l: Line) => number;
    let newIdx: (l: Line) => number;
    if (this.full) {
      docs = [this.full.old.join('\n'), this.full.new.join('\n')];
      oldIdx = (l) => l.o - 1;
      newIdx = (l) => l.n - 1;
    } else {
      const d = patchDocs(this.rows);
      docs = [d.old, d.new];
      oldIdx = (l) => d.oldIdx.get(l) ?? -1;
      newIdx = (l) => d.newIdx.get(l) ?? -1;
    }
    if (docs[0].length + docs[1].length > 2_000_000) return;
    const full = this.full;
    const out = await this.app.hl.tokenize(f.lang, docs);
    if (!out || this.full !== full) return;
    this.tokens = { old: out[0]!, new: out[1]!, oldIdx, newIdx };
    if (!this.collapsed) this.app.paintWhenIdle(this);
  }

  /** Fetch both full files once; expansion and full-file highlighting need them. */
  hydrate(): Promise<void> {
    this.hydrating ??= (async () => {
      const f = this.f;
      const [o, n] = await Promise.all([this.app.fetchFile('old', f.prevPath ?? f.path), this.app.fetchFile('new', f.path)]);
      const split = (s: string) => {
        const a = s.split('\n');
        if (a[a.length - 1] === '') a.pop();
        return a.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
      };
      this.full = { old: split(o), new: split(n) };
      this.tokens = null;
      void this.highlight();
    })();
    return this.hydrating;
  }

  async expand(row: number, dir: 'up' | 'down' | 'all') {
    await this.hydrate();
    expand(this.rows, row, dir, this.full!.new);
    this.paint();
  }

  setCollapsed(c: boolean) {
    this.el.classList.toggle('collapsed', c);
    this.el.querySelector('.js-details-target')!.setAttribute('aria-expanded', String(!c));
  }
}

// ------------------------------------------------------------- the page

class App {
  m!: Manifest;
  files!: FileEntry[];
  enabled: Set<string>;
  manual: ManualState = {};
  reviewed: ReviewedState = {};
  diffStyle: DiffStyle;
  reasons: (string | null)[] = [];
  visible: number[] = [];
  views = new Map<number, FileView>();
  forceLoad = new Set<number>();
  hl!: Highlighter;
  tree: FileTree;
  current = -1;
  el = {
    root: h('div', { class: 'prv' }),
    header: h('header', { class: 'pr-header' }),
    flash: h('div', { class: 'flash-container' }),
    layout: h('div', { class: 'diff-layout' }),
    sidebar: h('div', { class: 'diff-sidebar' }),
    list: h('div', { class: 'js-diff-progressive-container' }),
  };
  private io: IntersectionObserver;
  private refreshing = false;
  /** Detaches window/document listeners when a dropped export replaces this view. */
  readonly ac = new AbortController();

  constructor(readonly src: Source) {
    this.diffStyle = store.get<{ diffStyle?: DiffStyle }>(PREFS_KEY, {}).diffStyle ?? src.bundle?.prefs.diffStyle ?? 'unified';
    if (src.mode === 'export') {
      this.enabled = new Set(src.bundle!.enabledCats);
      this.manual = { ...src.bundle!.manual };
      this.reviewed = { ...(src.bundle!.reviewed ?? {}) };
    } else {
      this.enabled = new Set(store.get<string[]>(CATS_KEY, DEFAULT_HIDDEN));
    }
    this.tree = new FileTree((p) => this.jumpTo(this.files.findIndex((f) => f.path === p)));
    // Bodies render only as they come near the viewport.
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const v = this.view(Number((e.target as HTMLElement).dataset.i));
          if (!v.rendered) this.queueRender(v);
        }
      },
      { rootMargin: '1200px 0px' },
    );
    this.setManifest(src.manifest);
  }

  get live() {
    return this.src.mode === 'live';
  }
  get reviewedKey() {
    const { owner, repo, number } = this.m.meta;
    return `prv:reviewed:${owner}/${repo}#${number}`;
  }
  get manualKey() {
    const { owner, repo, number } = this.m.meta;
    return `prv:manual:${owner}/${repo}#${number}`;
  }

  setManifest(m: Manifest) {
    this.m = m;
    this.files = m.files;
    if (this.live) {
      this.manual = store.get<ManualState>(this.manualKey, {});
      this.reviewed = store.get<ReviewedState>(this.reviewedKey, {});
    }
    // A mark holds only while the file's diff is the one that was reviewed.
    const hashes = new Map(m.files.map((f) => [f.path, f.hash]));
    let dropped = 0;
    for (const [path, h] of Object.entries(this.reviewed)) if (hashes.get(path) !== h) (delete this.reviewed[path], dropped++);
    if (dropped && this.live) store.set(this.reviewedKey, this.reviewed);
    this.views.clear();
    this.forceLoad.clear();
    this.renderQueue.length = 0;
    this.reasons = [];
  }

  /** One shell per file, in one parse. Hiding and showing only flips `hidden`. */
  mountShells() {
    this.io.disconnect();
    const reasons = this.files.map((f) => this.reasonFor(f));
    this.el.list.innerHTML = this.files.map((f, i) => fileShellHtml(f, i, reasons[i] !== null, this.isReviewed(i))).join('');
    for (const el of this.el.list.children) this.io.observe(el);
    this.tree.setFiles(this.files.map((f, i) => ({ i, path: f.path, status: f.status, reviewed: this.isReviewed(i) })));
    this.renderFilterMenu();
  }

  // ----------------------------------------------------------- hide model

  manualFor(path: string): 'hide' | 'show' | undefined {
    const m = this.manual;
    if (m[path]) return m[path];
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      const v = m[path.slice(0, i + 1)];
      if (v) return v;
    }
    return undefined;
  }

  reasonFor(f: FileEntry): string | null {
    const m = this.manualFor(f.path);
    if (m === 'show') return null;
    if (m === 'hide') return 'manual';
    return f.cats.find((c) => this.enabled.has(c)) ?? null;
  }

  saveManual() {
    if (this.live) store.set(this.manualKey, this.manual);
  }

  hideFile(path: string) {
    delete this.manual[path];
    const f = this.files.find((x) => x.path === path);
    if (f && this.reasonFor(f) === null) this.manual[path] = 'hide';
    this.saveManual();
    this.update();
  }

  unhide(key: string) {
    delete this.manual[key];
    this.saveManual();
    this.update();
  }

  unhideAll() {
    for (const [k, v] of Object.entries(this.manual)) if (v === 'hide') delete this.manual[k];
    this.saveManual();
    this.update();
  }

  isReviewed(i: number): boolean {
    const f = this.files[i]!;
    return this.reviewed[f.path] === f.hash;
  }

  /** Mark or unmark one file: collapse or expand it, and update its tree row. */
  setReviewed(i: number, on: boolean) {
    const f = this.files[i]!;
    if (on) this.reviewed[f.path] = f.hash;
    else delete this.reviewed[f.path];
    if (this.live) store.set(this.reviewedKey, this.reviewed);
    const v = this.view(i);
    const wasAbove = v.el.getBoundingClientRect().top < this.landTop();
    v.el.classList.toggle('is-reviewed', on);
    v.el.querySelector<HTMLInputElement>('input[data-act=review]')!.checked = on;
    v.setCollapsed(on);
    // Keep the file's header in place when it collapses under you.
    if (on && wasAbove) window.scrollTo({ top: v.el.getBoundingClientRect().top + window.scrollY - this.landTop() });
    this.tree.setReviewed(i, on);
  }

  toggleCategory(id: string) {
    if (this.enabled.has(id)) this.enabled.delete(id);
    else this.enabled.add(id);
    if (this.live) store.set(CATS_KEY, [...this.enabled]);
    this.update();
  }

  // ----------------------------------------------------------- data

  async loadPatches(idx: number[]) {
    const missing = idx.filter((i) => !this.src.patches.has(i) && (this.files[i]!.size <= LARGE_PATCH || this.forceLoad.has(i)));
    if (!missing.length || !this.live) return;
    const key = this.m.key;
    const res = await fetch('/api/patches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, ids: missing }),
    });
    if (!res.ok) throw new Error(`patches: ${res.status} ${await res.text()}`);
    const out = (await res.json()) as (string | null)[];
    if (key !== this.m.key) return;
    missing.forEach((i, j) => this.src.patches.set(i, out[j] ?? null));
  }

  /** Batch patch requests from files about to render. */
  private wantPatch = new Set<number>();
  requestPatch(i: number) {
    if (this.wantPatch.has(i)) return;
    this.wantPatch.add(i);
    if (this.wantPatch.size > 1) return;
    setTimeout(async () => {
      const ids = [...this.wantPatch];
      try {
        await this.loadPatches(ids);
      } catch (e) {
        this.flash(e instanceof Error ? e.message : String(e));
      }
      this.wantPatch.clear();
      for (const i of ids) {
        const v = this.views.get(i);
        if (v && !v.rendered && this.reasons[i] === null) this.queueRender(v);
      }
    }, 0);
  }

  /** Render (or repaint) bodies a few milliseconds per frame, so no frame stalls. */
  private renderQueue: FileView[] = [];
  private renderScheduled = false;
  queueRender(v: FileView, repaint = false) {
    if (!this.renderQueue.includes(v)) this.renderQueue.push(v);
    (v as { repaint?: boolean }).repaint ||= repaint;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    const step = () => {
      const t = performance.now();
      while (this.renderQueue.length && performance.now() - t < 8) {
        const next = this.renderQueue.shift()! as FileView & { repaint?: boolean };
        if (next.repaint) {
          next.repaint = false;
          if (next.rendered) next.paint();
        } else if (!next.rendered && this.reasons[next.i] === null) next.render();
      }
      if (this.renderQueue.length) requestAnimationFrame(step);
      else this.renderScheduled = false;
    };
    requestAnimationFrame(step);
  }

  async fetchFile(side: 'old' | 'new', path: string): Promise<string> {
    const r = await fetch(`/api/file?key=${encodeURIComponent(this.m.key)}&side=${side}&path=${encodeURIComponent(path)}`);
    if (!r.ok) throw new Error(`could not load ${path}`);
    return r.text();
  }

  view(i: number): FileView {
    let v = this.views.get(i);
    if (!v) {
      v = new FileView(this, i, this.el.list.children[i] as HTMLElement);
      this.views.set(i, v);
    }
    return v;
  }

  /** Apply the hide state: flip `hidden` on the files and tree rows that
   *  changed, and refresh the header counts. Nothing else is rebuilt. */
  update() {
    const prev = this.reasons;
    this.reasons = this.files.map((f) => this.reasonFor(f));
    this.visible = [];
    const list = this.el.list.children;
    this.reasons.forEach((r, i) => {
      if (r === null) this.visible.push(i);
      if ((prev[i] === null) !== (r === null) || prev.length === 0) (list[i] as HTMLElement).hidden = r !== null;
    });
    this.tree.setHidden((i) => this.reasons[i] !== null);
    for (const input of this.tree.extra.querySelectorAll<HTMLInputElement>('input[data-cat]')) input.checked = this.enabled.has(input.dataset.cat!);
    this.tree.extra.querySelector('summary')?.classList.toggle('is-filtering', this.enabled.size > 0);
    this.renderHeaderStats();
  }

  /** Repaint a file with fresh tokens, but never under a live selection or drag. */
  private deferred = new Set<FileView>();
  private pointerDown = false;
  paintWhenIdle(v: FileView) {
    if (!this.selectionIn(v)) return this.queueRender(v, true);
    this.deferred.add(v);
  }
  private selectionIn(v: FileView): boolean {
    if (this.pointerDown) return true;
    const sel = document.getSelection();
    return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && v.body.contains(sel.getRangeAt(0).commonAncestorContainer);
  }
  flushDeferred() {
    for (const v of [...this.deferred]) {
      if (this.selectionIn(v)) continue;
      this.deferred.delete(v);
      this.queueRender(v, true);
    }
  }

  // ----------------------------------------------------------- navigation

  stickyTop() {
    return this.el.header.getBoundingClientRect().height;
  }

  /** Where a file lands when you jump to it: level with the sidebar's first row. */
  landTop() {
    return this.stickyTop() + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--land-gap')) || 0);
  }

  jumpTo(i: number) {
    if (i < 0 || this.reasons[i] !== null) return;
    const v = this.view(i);
    if (!v.rendered) v.render();
    this.holdAt(v.el);
    this.el.list.querySelector('.is-target')?.classList.remove('is-target');
    v.el.classList.add('is-target');
    this.current = this.visible.indexOf(i);
    this.tree.setActive(this.files[i]!.path);
  }

  /** Scroll `el` to the landing line and keep it there for a moment: files
   *  near the viewport render and replace their estimated heights, which would
   *  otherwise push it away. Any user scroll input ends the hold. */
  private holdToken = 0;
  holdAt(el: HTMLElement) {
    const token = ++this.holdToken;
    const stop = () => (this.holdToken = token + 1);
    for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(ev, stop, { once: true, capture: true, signal: this.ac.signal });
    let stable = 0;
    let frames = 0;
    const align = () => {
      if (this.holdToken !== token) return;
      const d = el.getBoundingClientRect().top - this.landTop();
      if (Math.abs(d) > 0.5) {
        window.scrollBy(0, d);
        stable = 0;
      } else stable++;
      if (stable < 6 && ++frames < 90) requestAnimationFrame(align);
    };
    align();
  }

  currentIndex(): number {
    const top = this.landTop() + 2;
    let lo = 0;
    let hi = this.visible.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.view(this.visible[mid]!).el.getBoundingClientRect().top <= top) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  go(delta: number) {
    if (!this.visible.length) return;
    const cur = this.currentIndex();
    let next = cur + delta;
    if (delta < 0 && this.view(this.visible[cur]!).el.getBoundingClientRect().top < this.landTop() - 4) next = cur;
    next = Math.max(0, Math.min(this.visible.length - 1, next));
    this.jumpTo(this.visible[next]!);
  }

  onScroll() {
    if (!this.visible.length) return;
    const idx = this.currentIndex();
    if (idx === this.current) return;
    this.current = idx;
    this.tree.setActive(this.files[this.visible[idx]!]!.path);
  }

  // ----------------------------------------------------------- actions

  async refresh() {
    if (!this.live || this.refreshing) return;
    this.refreshing = true;
    this.el.root.classList.add('is-refreshing');
    const t = performance.now();
    try {
      const { owner, repo, number } = this.m.meta;
      const res = await fetch(`/api/pr/${owner}/${repo}/${number}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText);
      const m = (await res.json()) as Manifest;
      const changed = m.key !== this.m.key;
      if (changed) {
        this.src.patches.clear();
        this.setManifest(m);
        this.mountShells();
        this.update();
        this.renderHeader();
      } else if (JSON.stringify(m.meta) !== JSON.stringify(this.m.meta)) {
        this.m = { ...this.m, meta: m.meta };
        this.renderHeader();
      }
      if (this.el.flash.firstChild) this.flash(null);
      console.info(`prv: refresh ${changed ? `→ ${m.headSha.slice(0, 7)}` : 'unchanged'} in ${Math.round(performance.now() - t)} ms`, m.timings);
    } catch (e) {
      this.flash(`Refresh failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.refreshing = false;
      this.el.root.classList.remove('is-refreshing');
    }
  }

  flash(msg: string | null) {
    this.el.flash.replaceChildren(...(msg ? [h('div', { class: 'flash flash-error' }, msg)] : []));
  }

  async exportHtml(btn: HTMLButtonElement) {
    btn.disabled = true;
    try {
      const req: ExportRequest = {
        key: this.m.key,
        enabledCats: [...this.enabled],
        manual: this.manual,
        reviewed: this.reviewed,
        omit: this.files.map((_, i) => i).filter((i) => this.reasons[i] !== null),
        prefs: { diffStyle: this.diffStyle },
      };
      const t = performance.now();
      const res = await fetch('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'prv-export.html';
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      console.info(`prv: exported ${name} (${(blob.size / 1e6).toFixed(2)} MB) in ${Math.round(performance.now() - t)} ms`);
    } catch (e) {
      this.flash(`Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      btn.disabled = false;
    }
  }

  setDiffStyle(s: DiffStyle) {
    if (s === this.diffStyle) return;
    this.diffStyle = s;
    store.set(PREFS_KEY, { diffStyle: s });
    this.el.root.dataset.diffStyle = s;
    for (const v of this.views.values()) if (v.rendered) this.queueRender(v, true);
    this.renderHeader();
  }

  onListClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const fileEl = t.closest<HTMLElement>('.file');
    if (!fileEl) return;
    const v = this.views.get(Number(fileEl.dataset.i));
    if (!v) return;
    const exp = t.closest<HTMLElement>('[data-expand]');
    if (exp) return void v.expand(Number(exp.dataset.row), exp.dataset.expand as 'up' | 'down' | 'all');
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'review') return this.setReviewed(v.i, (t as HTMLInputElement).checked);
    e.preventDefault();
    if (act === 'toggle') v.setCollapsed(!v.collapsed);
    else if (act === 'hide') this.hideFile(v.f.path);
    else if (act === 'top') this.jumpTo(v.i);
    else if (act === 'load') {
      this.forceLoad.add(v.i);
      void this.loadPatches([v.i]).then(() => v.render());
    }
  }

  // ----------------------------------------------------------- chrome

  /** Re-render a chrome region, keeping any of its menus open. */
  private paintKeepingMenus(el: HTMLElement, html: string) {
    const open = [...el.querySelectorAll<HTMLElement>('details[open][data-menu]')].map((d) => d.dataset.menu);
    el.innerHTML = html;
    for (const m of open) el.querySelector(`details[data-menu="${m}"]`)?.setAttribute('open', '');
  }

  /** The parts of the header that follow the hide state: diffstat and "N hidden". */
  renderHeaderStats() {
    const slot = this.el.header.querySelector<HTMLElement>('.pr-dyn');
    if (!slot) return;
    const hidden = this.files.length - this.visible.length;
    const manualKeys = Object.entries(this.manual)
      .filter(([, v]) => v === 'hide')
      .map(([k]) => k);
    const manualRows = manualKeys.length
      ? manualKeys
          .map((k) => `<li class="ActionListItem"><span class="ActionListItem-label" title="${esc(k)}"><bdi>${esc(k)}</bdi></span><button type="button" class="btn-link" data-unhide="${esc(k)}">Unhide</button></li>`)
          .join('') +
        `<li class="ActionList-sectionDivider" role="presentation"></li><li><button type="button" class="btn-link unhide-all" data-unhide-all>Unhide all</button></li>`
      : `<li class="menu-note">Nothing hidden by hand. Press <kbd>h</kbd> or use a file's ${svg('eye-closed')} to hide it.</li>`;
    this.paintKeepingMenus(
      slot,
      this.diffstatHtml() +
        (hidden
          ? `<details class="details-reset details-overlay select-menu hidden-menu" data-menu="hidden"><summary class="btn btn-sm">${fmt(hidden)} hidden <span class="dropdown-caret"></span></summary><div class="select-menu-modal right"><div class="select-menu-header">Hidden by hand</div><ul class="ActionList">${manualRows}</ul></div></details>`
          : ''),
    );
  }

  renderHeader() {
    const { meta } = this.m;
    const repo = `https://github.com/${esc(meta.owner)}/${esc(meta.repo)}`;
    const verb = meta.state === 'merged' ? 'merged' : 'wants to merge';
    const radio = (v: DiffStyle, label: string) =>
      `<button type="button" class="ActionListItem" role="menuitemradio" aria-checked="${this.diffStyle === v}" data-style="${v}"><span class="check">${this.diffStyle === v ? svg('check') : ''}</span>${label}</button>`;
    const actions = this.live
      ? `<button type="button" class="btn btn-sm" data-act="refresh" title="Re-fetch and re-diff (r)">${svg('sync', 'refresh-icon')} Refresh</button><button type="button" class="btn btn-sm" data-act="export" title="Download this view as one .html file">${svg('download')} Export</button>`
      : '';
    const exportedAt = this.live ? null : new Date(this.src.bundle!.exportedAt);
    const snapshot = exportedAt
      ? `<span class="snapshot" title="Exported from prv ${esc(exportedAt.toLocaleString())}">· snapshot ${esc(exportedAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</span>`
      : '';
    this.paintKeepingMenus(
      this.el.header,
      `<h1 class="pr-title-line"><bdi class="pr-title">${titleHtml(meta.title)}</bdi> <span class="pr-number">#${meta.number}</span></h1>` +
        `<div class="pr-meta-row"><div class="pr-meta">${this.stateBadge()}` +
        `<a class="author" href="https://github.com/${esc(meta.author)}" target="_blank" rel="noreferrer">${esc(meta.author)}</a><span>${verb} ${fmt(meta.commits)} commit${meta.commits === 1 ? '' : 's'} into</span>` +
        `<a class="commit-ref base-ref" href="${repo}/tree/${esc(meta.baseRef)}" target="_blank" rel="noreferrer" title="${esc(meta.baseRef)}">${esc(meta.baseRef)}</a><span>from</span>` +
        `<a class="commit-ref head-ref" href="${repo}/tree/${esc(meta.headRef)}" target="_blank" rel="noreferrer" title="${esc(meta.headRef)}">${esc(meta.headRef)}</a>${snapshot}</div>` +
        `<div class="pr-header-actions"><div class="pr-dyn"></div>` +
        `<details class="details-reset details-overlay select-menu" data-menu="view"><summary class="btn btn-sm btn-icon" aria-label="Diff view settings" title="Diff view">${svg('gear')}</summary><div class="select-menu-modal right settings-menu"><div class="select-menu-header">Diff view</div><div class="ActionList">${radio('unified', 'Unified')}${radio('split', 'Split')}</div></div></details>` +
        actions +
        `</div></div>`,
    );
    this.renderHeaderStats();
    document.title = `${meta.title} by ${meta.author} · Pull Request #${meta.number} · ${meta.owner}/${meta.repo}`;
  }

  /** "Files changed N +A −D ▪▪▪▪▪" over visible files. Hovering shows the
   *  all-file totals and what is hidden, by category and by hand. */
  diffstatHtml(): string {
    const sum = (idx: number[]): [number, number] => {
      let a = 0;
      let d = 0;
      for (const i of idx) (a += this.files[i]!.additions), (d += this.files[i]!.deletions);
      return [a, d];
    };
    const [adds, dels] = sum(this.visible);
    const stat = (a: number, d: number) => `<span class="color-fg-success">+${fmt(a)}</span> <span class="color-fg-danger">−${fmt(d)}</span>`;
    const byReason = new Map<string, number[]>();
    this.reasons.forEach((r, i) => r && (byReason.get(r) ?? byReason.set(r, []).get(r)!).push(i));
    const row = (label: string, idx: number[], cls = '') => {
      const [a, d] = sum(idx);
      return `<div class="ds-row${cls}"><span class="ds-label">${label}</span><span class="ds-count">${fmt(idx.length)}</span><span class="ds-stat">${stat(a, d)}</span></div>`;
    };
    const hiddenIdx = [...byReason.values()].flat();
    const reasons = ['manual', ...CATEGORIES.map((c) => c.id as string)].filter((r) => byReason.has(r));
    const pop =
      `<div class="diffstat-popover" role="tooltip">` +
      row('Shown', this.visible) +
      (hiddenIdx.length ? row('Hidden', hiddenIdx) + reasons.map((r) => row(r === 'manual' ? 'Hidden by hand' : esc(CAT_TITLE.get(r) ?? r), byReason.get(r)!, ' ds-sub')).join('') : '') +
      `<div class="ds-divider"></div>` +
      row('All files', this.files.map((_, i) => i), ' ds-total') +
      `</div>`;
    return (
      `<div class="pr-diffstat" tabindex="0"><span class="files-changed">Files changed<span class="Counter">${fmt(this.visible.length)}</span></span>` +
      `<span class="diffstat">${stat(adds, dels)} ${diffstatBlocks(adds, dels)}</span>${pop}</div>`
    );
  }

  /** The Geld categories, as a checkbox menu behind the tree's filter button. */
  renderFilterMenu() {
    const counts = new Map<string, number>();
    for (const f of this.files) for (const c of f.cats) counts.set(c, (counts.get(c) ?? 0) + 1);
    const rows = CATEGORIES.filter((c) => counts.get(c.id))
      .map(
        (c) =>
          `<label class="ActionListItem" title="${esc(c.description)}"><input type="checkbox" data-cat="${c.id}"${this.enabled.has(c.id) ? ' checked' : ''}><span class="ActionListItem-text">${esc(c.title)}</span><span class="ActionListItem-count">${fmt(counts.get(c.id)!)}</span></label>`,
      )
      .join('');
    this.paintKeepingMenus(
      this.tree.extra,
      `<details class="details-reset details-overlay select-menu" data-menu="filter"><summary class="btn btn-sm btn-icon${this.enabled.size ? ' is-filtering' : ''}" aria-label="Hide files by category" title="Hide files by category">${svg('filter')}</summary><div class="select-menu-modal right filter-menu"><div class="select-menu-header">Hide files</div><div class="ActionList">${rows || '<div class="menu-note">No categories match these files.</div>'}</div></div></details>`,
    );
  }

  stateBadge(): string {
    const s = this.m.meta.state;
    const icon = s === 'merged' ? 'git-merge' : s === 'closed' ? 'git-pull-request-closed' : s === 'draft' ? 'git-pull-request-draft' : 'git-pull-request';
    const label = s[0]!.toUpperCase() + s.slice(1);
    return `<span class="State State--${s}" title="Status: ${label}">${svg(icon)} ${label}</span>`;
  }

  onChromeClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const un = t.closest<HTMLElement>('[data-unhide]');
    if (un) return this.unhide(un.dataset.unhide!);
    if (t.closest('[data-unhide-all]')) return this.unhideAll();
    const style = t.closest<HTMLElement>('[data-style]');
    if (style) {
      style.closest('details')?.removeAttribute('open');
      return this.setDiffStyle(style.dataset.style as DiffStyle);
    }
    const btn = t.closest<HTMLButtonElement>('[data-act]');
    const act = btn?.dataset.act;
    if (act === 'refresh') void this.refresh();
    else if (act === 'export') void this.exportHtml(btn!);
  }

  // ----------------------------------------------------------- mount

  async mount(container: HTMLElement) {
    this.hl = new Highlighter(await highlightWorkerUrl(), (lang) => this.grammar(lang));
    const main = h('div', { class: 'diff-view' }, h('div', { class: 'land-mask' }), this.el.flash, this.el.list);
    this.el.sidebar.append(this.tree.el);
    this.el.layout.append(this.el.sidebar, main);
    this.el.root.append(this.el.header, this.el.layout);
    this.el.root.dataset.diffStyle = this.diffStyle;
    container.replaceChildren(this.el.root);
    this.renderHeader();
    this.el.list.addEventListener('click', (e) => this.onListClick(e));
    this.el.header.addEventListener('click', (e) => this.onChromeClick(e));
    this.tree.extra.addEventListener('change', (e) => {
      const cat = (e.target as HTMLElement).dataset.cat;
      if (cat) this.toggleCategory(cat);
    });
    // Everything sticky sits under the header; its height drives the offsets.
    new ResizeObserver(() => document.documentElement.style.setProperty('--hdr-h', `${this.stickyTop()}px`)).observe(this.el.header);
    document.documentElement.style.setProperty('--hdr-h', `${this.stickyTop()}px`);
    // Close an open menu on outside click, like GitHub's details menus.
    const signal = this.ac.signal;
    document.addEventListener(
      'click',
      (e) => {
        for (const d of document.querySelectorAll('details[data-menu][open]')) if (!d.contains(e.target as Node)) d.removeAttribute('open');
      },
      { signal },
    );
    window.addEventListener('pointerdown', () => (this.pointerDown = true), { signal, capture: true });
    window.addEventListener('pointerup', () => ((this.pointerDown = false), this.flushDeferred()), { signal, capture: true });
    document.addEventListener('selectionchange', () => this.deferred.size && this.flushDeferred(), { signal });
    let raf = 0;
    window.addEventListener(
      'scroll',
      () => {
        if (!raf) raf = requestAnimationFrame(() => ((raf = 0), this.onScroll()));
      },
      { signal },
    );
    this.mountShells();
    this.update();
    // Paint the first screen now rather than on the observer's next tick.
    const first = this.visible.slice(0, 6);
    await this.loadPatches(first);
    for (const i of first) this.view(i).render();
    mark('items');
    this.bindKeys();
  }

  grammar(lang: string): Promise<unknown[] | null> {
    if (this.src.mode === 'export') return Promise.resolve(this.src.bundle!.langs[lang] ?? null);
    return fetch(`/api/lang/${encodeURIComponent(lang)}`).then((r) => (r.ok ? (r.json() as Promise<unknown[]>) : null));
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName) || (t instanceof HTMLInputElement && t.type !== 'checkbox'))) return;
      if (e.key === 'j') this.go(1);
      else if (e.key === 'k') this.go(-1);
      else if (e.key === 'r') void this.refresh();
      else if (e.key === 'h') {
        if (this.visible.length) this.hideFile(this.files[this.visible[this.currentIndex()]!]!.path);
      } else if (e.key === 'v') {
        if (this.visible.length) {
          const i = this.visible[this.currentIndex()]!;
          this.setReviewed(i, !this.isReviewed(i));
        }
      } else return;
      e.preventDefault();
    }, { signal: this.ac.signal });
  }

  destroy() {
    this.ac.abort();
    this.io.disconnect();
  }
}

// ------------------------------------------------------------- boot

let app: App | undefined;

async function start(src: Source) {
  app?.destroy();
  app = new App(src);
  window.__prvApp = app;
  await app.mount(document.getElementById('app')!);
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  mark('firstPaint');
  const t0 = Number(new URLSearchParams(location.search).get('t0'));
  const t = {
    mode: src.mode,
    pr: `${app.m.meta.owner}/${app.m.meta.repo}#${app.m.meta.number}`,
    stale: !!src.manifest.stale,
    files: app.files.length,
    visible: app.visible.length,
    marks: { ...marks },
    server: src.manifest.timings,
    e2eFromCli: t0 ? Date.now() - t0 : undefined,
  };
  window.__prvTimings = t;
  console.info('prv timings', t);
  if (src.mode === 'live') {
    void fetch('/api/timing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t) }).catch(() => {});
    if (src.manifest.stale) void app.refresh();
  }
}

function showError(msg: string) {
  document.getElementById('app')!.replaceChildren(h('div', { class: 'flash flash-error boot-error' }, msg));
}

function renderIndex() {
  const input = h('input', { class: 'form-control', placeholder: 'https://github.com/owner/repo/pull/123 or owner/repo#123', autofocus: true }) as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = input.value.trim();
    const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(v) ?? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(v);
    if (m) location.href = `/${m[1]}/${m[2]}/pull/${m[3]}`;
  });
  document.getElementById('app')!.replaceChildren(h('div', { class: 'index' }, h('h1', {}, 'prv'), input));
}

// Drop an exported .html onto the live page to view it.
function enableDrop() {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    try {
      const b64 = extractEmbedded(await file.text(), 'prv-bundle');
      if (!b64) throw new Error(`${file.name} is not a prv export`);
      await start(sourceFromBundle(await decodeBundle(b64)));
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });
}

async function main() {
  const boot = window.__prvBoot;
  try {
    if (boot.mode === 'export') {
      const bundle = await decodeBundle(document.getElementById('prv-bundle')!.textContent!);
      mark('bundle');
      return await start(sourceFromBundle(bundle));
    }
    enableDrop();
    if (boot.mode === 'index') return renderIndex();
    const manifest = await boot.manifest;
    mark('manifest');
    await start({ mode: 'live', manifest, patches: new Map() });
  } catch (e) {
    console.error(e);
    showError(e instanceof Error ? e.message : String(e));
  }
}

void main();
