// GitHub's "Files changed" file tree (ActionList--tree markup). It is built
// once from every file; hiding flips rows, and folders left without a visible
// file go too.
import { esc, svg } from './diff.ts';
import type { IconName } from './icons.ts';

export interface TreeFile {
  /** Index into the app's file list. */
  i: number;
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  reviewed: boolean;
}

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  /** Children in first-appearance order (diff order). */
  order: (Dir | TreeFile)[];
}

// GitHub's new tree shows the change type in the file icon itself.
const STATUS: Record<TreeFile['status'], [IconName, string]> = {
  added: ['file-added', 'added'],
  deleted: ['file-removed', 'removed'],
  modified: ['file-diff', 'modified'],
  renamed: ['file-moved', 'renamed'],
};

function build(files: TreeFile[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), order: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let c = d.dirs.get(parts[i]!);
      if (!c) {
        c = { name: parts[i]!, path: `${d.path}${parts[i]}/`, dirs: new Map(), order: [] };
        d.dirs.set(parts[i]!, c);
        d.order.push(c);
      }
      d = c;
    }
    d.order.push(f);
  }
  return root;
}

export class FileTree {
  el: HTMLElement;
  /** Slot next to the filter input (the app puts its category menu here). */
  extra: HTMLElement;
  private list: HTMLElement;
  private input: HTMLInputElement;
  private active: string | null = null;
  private fileRows: HTMLElement[] = [];
  /** Folder rows, deepest first, with their direct child rows. */
  private dirRows: [HTMLElement, HTMLElement[]][] = [];
  private collapsed = new Set<string>();

  constructor(private onSelect: (path: string) => void) {
    this.el = document.createElement('div');
    this.el.className = 'file-tree-panel';
    this.el.innerHTML = `<div class="file-tree-filter"><div class="filter-input"><span class="filter-icon">${svg('search')}</span><input type="text" class="form-control" placeholder="Filter files…" aria-label="Filter files"></div><div class="filter-extra"></div></div><nav aria-label="File Tree Navigation" class="file-tree-nav"></nav>`;
    this.input = this.el.querySelector('input')!;
    this.extra = this.el.querySelector('.filter-extra')!;
    this.list = this.el.querySelector('nav')!;
    this.input.addEventListener('input', () => this.applyFilter());
    this.list.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const dir = t.closest<HTMLElement>('[data-dir]');
      const file = t.closest<HTMLElement>('[data-path]');
      if (file) {
        e.preventDefault();
        this.onSelect(file.dataset.path!);
      } else if (dir && t.closest('.ActionList-content') === dir.firstElementChild) {
        const p = dir.dataset.dir!;
        if (this.collapsed.has(p)) this.collapsed.delete(p);
        else this.collapsed.add(p);
        dir.setAttribute('aria-expanded', String(!this.collapsed.has(p)));
      }
    });
  }

  setFiles(files: TreeFile[]) {
    const root = build(files);
    let html = '';
    const walk = (d: Dir, depth: number, sub: boolean) => {
      for (const c of d.order) {
        if ('status' in c) {
          const [ic, label] = STATUS[c.status];
          const name = c.path.slice(c.path.lastIndexOf('/') + 1);
          html += `<li class="ActionList-item${sub ? ' ActionList-item--subItem' : ''}${c.path === this.active ? ' is-active' : ''}${c.reviewed ? ' is-reviewed' : ''}" role="treeitem" data-path="${esc(c.path)}" data-i="${c.i}" style="--depth:${depth}"><a class="ActionList-content" href="#" tabindex="-1"><span class="ActionList-item-visual--leading" title="${label}">${svg(ic, `status-${label}`)}</span><span class="ActionList-item-label" title="${esc(c.path)}">${esc(name)}</span><span class="reviewed-check" title="Reviewed">${svg('check')}</span></a></li>`;
          continue;
        }
        // Collapse chains of directories that hold only one directory.
        let dir = c;
        let label = c.name;
        while (dir.order.length === 1 && !('status' in dir.order[0]!)) {
          dir = dir.order[0] as Dir;
          label += `/${dir.name}`;
        }
        const open = !this.collapsed.has(dir.path);
        html += `<li class="ActionList-item ActionList-item--hasSubItem${sub ? ' ActionList-item--subItem' : ''}" role="treeitem" aria-expanded="${open}" data-dir="${esc(dir.path)}" style="--depth:${depth}"><button class="ActionList-content" type="button" tabindex="-1"><span class="ActionList-item-action--leading">${svg('chevron-down', 'collapse-icon')}</span><span class="ActionList-item-visual--leading">${svg('file-directory-open-fill', 'icon-directory dir-open')}${svg('file-directory-fill', 'icon-directory dir-closed')}</span><span class="ActionList-item-label">${esc(label)}</span><span class="reviewed-check" title="All reviewed">${svg('check')}</span></button><ul class="ActionList ActionList--subGroup" role="group">`;
        walk(dir, depth + 1, true);
        html += '</ul></li>';
      }
    };
    walk(root, 1, false);
    this.list.innerHTML = `<ul class="ActionList ActionList--tree" role="tree" aria-label="File Tree">${html}</ul>`;
    this.fileRows = [];
    for (const li of this.list.querySelectorAll<HTMLElement>('li[data-path]')) this.fileRows[Number(li.dataset.i)] = li;
    this.dirRows = [...this.list.querySelectorAll<HTMLElement>('li[data-dir]')]
      .reverse()
      .map((li) => [li, [...li.lastElementChild!.children] as HTMLElement[]]);
    this.dirOf = new Map(this.dirRows.map(([li, kids]) => [li, kids]));
    this.applyFilter();
  }

  /** Mark one file row reviewed, then re-derive its folders. */
  private dirOf = new Map<HTMLElement, HTMLElement[]>();
  setReviewed(i: number, on: boolean) {
    const li = this.fileRows[i];
    if (!li) return;
    li.classList.toggle('is-reviewed', on);
    for (let d = li.parentElement?.closest<HTMLElement>('li[data-dir]'); d; d = d.parentElement?.closest<HTMLElement>('li[data-dir]')) this.deriveDirReviewed(d);
  }

  /** A folder looks done when every visible file under it is reviewed. */
  private deriveDirReviewed(li: HTMLElement) {
    const kids = (this.dirOf.get(li) ?? []).filter((k) => !k.classList.contains('is-gone'));
    const done = kids.length > 0 && kids.every((k) => k.classList.contains('is-reviewed'));
    if (li.classList.contains('is-reviewed') !== done) li.classList.toggle('is-reviewed', done);
  }

  /** Hide the rows of hidden files, and folders with nothing visible left. */
  setHidden(isHidden: (i: number) => boolean) {
    this.fileRows.forEach((li, i) => {
      const gone = isHidden(i);
      if (li.classList.contains('is-gone') !== gone) li.classList.toggle('is-gone', gone);
    });
    for (const [li, kids] of this.dirRows) {
      const gone = kids.every((k) => k.classList.contains('is-gone'));
      if (li.classList.contains('is-gone') !== gone) li.classList.toggle('is-gone', gone);
      this.deriveDirReviewed(li);
    }
  }

  setActive(path: string | null) {
    if (path === this.active) return;
    this.active = path;
    this.list.querySelector('.is-active')?.classList.remove('is-active');
    if (!path) return;
    const li = this.list.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    if (!li) return;
    li.classList.add('is-active');
    const r = li.getBoundingClientRect();
    const box = this.list.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) li.scrollIntoView({ block: 'nearest' });
  }

  private applyFilter() {
    const q = this.input.value.trim().toLowerCase();
    const items = this.list.querySelectorAll<HTMLElement>('li');
    if (!q) {
      items.forEach((li) => (li.hidden = false));
      return;
    }
    // Files match on their path; directories stay if any descendant matches.
    const rev = [...items].reverse();
    for (const li of rev) {
      if (li.dataset.path) li.hidden = !li.dataset.path.toLowerCase().includes(q);
      else li.hidden = !li.querySelector('li[data-path]:not([hidden]):not(.is-gone)');
    }
  }
}
