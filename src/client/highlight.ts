// Main-thread side of the Shiki worker pool.
import type { Tok } from './diff.ts';

interface Slot {
  w: Worker;
  langs: Set<string>;
  pending: number;
}

export class Highlighter {
  private slots: Slot[] = [];
  private waiters = new Map<number, (v: Tok[][][] | null) => void>();
  private grammars = new Map<string, Promise<unknown[] | null>>();
  private nextId = 1;

  constructor(
    url: string,
    private loadGrammar: (lang: string) => Promise<unknown[] | null>,
    size = 2,
  ) {
    for (let i = 0; i < size; i++) {
      let w: Worker;
      try {
        w = new Worker(url);
      } catch {
        continue;
      }
      const slot: Slot = { w, langs: new Set(), pending: 0 };
      w.onmessage = (e: MessageEvent<{ id: number; out?: Tok[][][]; error?: string }>) => {
        slot.pending--;
        if (e.data.error) console.warn('diff highlight:', e.data.error);
        this.waiters.get(e.data.id)?.(e.data.out ?? null);
        this.waiters.delete(e.data.id);
      };
      w.onerror = (e) => console.warn('diff highlight worker:', e.message);
      this.slots.push(slot);
    }
  }

  private grammar(lang: string) {
    let p = this.grammars.get(lang);
    if (!p) {
      p = this.loadGrammar(lang).catch(() => null);
      this.grammars.set(lang, p);
    }
    return p;
  }

  /** Token lines for each doc, or null (no grammar, no worker, or an error). */
  async tokenize(lang: string, docs: string[]): Promise<Tok[][][] | null> {
    if (lang === 'text' || !this.slots.length) return null;
    const grammar = await this.grammar(lang);
    if (!grammar?.length) return null;
    const slot = this.slots.reduce((a, b) => (b.pending < a.pending ? b : a));
    const id = this.nextId++;
    const send = !slot.langs.has(lang);
    slot.langs.add(lang);
    slot.pending++;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      slot.w.postMessage({ id, lang, grammar: send ? grammar : undefined, docs });
    });
  }
}
