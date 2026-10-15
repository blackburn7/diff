// Main-thread side of the Shiki worker pool.
import type { Tok } from './diff.ts';

/** A Shiki grammar, or the URL the worker fetches it from: then neither the
 *  fetch nor a big grammar's JSON.parse waits on (or holds up) the main thread. */
export type Grammar = unknown[] | string;

interface Slot {
  w: Worker;
  langs: Set<string>;
  pending: number;
}

export class Highlighter {
  private slots: Slot[] = [];
  private waiters = new Map<number, (v: Tok[][][] | null) => void>();
  private nextId = 1;

  constructor(
    workers: Worker[],
    private grammar: (lang: string) => Grammar | null,
  ) {
    for (const w of workers) {
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

  /** The grammar for `slot`, the first time it needs `lang`. */
  private grammarFor(slot: Slot, lang: string): Grammar | undefined {
    if (slot.langs.has(lang)) return undefined;
    slot.langs.add(lang);
    return this.grammar(lang) ?? undefined;
  }

  /** Have every worker load a grammar before anything needs it. */
  preload(lang: string) {
    if (lang === 'text' || !this.grammar(lang)?.length) return;
    for (const slot of this.slots) {
      const grammar = this.grammarFor(slot, lang);
      if (grammar) slot.w.postMessage({ lang, grammar });
    }
  }

  /** Token lines for each doc, or null (no grammar, no worker, or an error). */
  tokenize(lang: string, docs: string[]): Promise<Tok[][][] | null> {
    if (lang === 'text' || !this.slots.length || !this.grammar(lang)?.length) return Promise.resolve(null);
    const slot = this.slots.reduce((a, b) => (b.pending < a.pending ? b : a));
    const id = this.nextId++;
    const grammar = this.grammarFor(slot, lang);
    slot.pending++;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      slot.w.postMessage({ id, lang, grammar, docs });
    });
  }
}
