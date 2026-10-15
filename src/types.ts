import type { PrMeta } from './github.ts';
import type { FileEntry } from './patch.ts';

export type { FileEntry, PrMeta };

export interface RepoHome {
  repo: string;
  pulls: { number: number; title: string; author: string; draft: boolean }[];
  error?: string;
}

/** What the client needs before any patch text: metadata and the file list. */
export interface Manifest {
  meta: PrMeta;
  key: string;
  baseSha: string;
  headSha: string;
  files: FileEntry[];
  timings: Record<string, number>;
  checkedAt: number;
  /** True when served from cache without checking GitHub. */
  stale?: boolean;
}

export type ManualState = Record<string, 'hide' | 'show'>;
/** Reviewed files: path → the patch fingerprint it was reviewed at. */
export type ReviewedState = Record<string, string>;

export interface Prefs {
  diffStyle: 'split' | 'unified';
  overflow: 'scroll' | 'wrap';
  theme: 'light' | 'dark';
}

/** The JSON payload embedded (gzipped, base64) in an exported HTML file. */
export interface ExportBundle {
  v: 1;
  manifest: Manifest;
  /** Patch text per file, aligned with manifest.files; null when omitted. */
  patches: (string | null)[];
  enabledCats: string[];
  manual: ManualState;
  /** Shiki grammars by language name, for the languages of included files. */
  langs: Record<string, unknown[]>;
  prefs: Partial<Prefs>;
  exportedAt: number;
  omitHidden: boolean;
}

export interface ExportRequest {
  key: string;
  enabledCats: string[];
  manual: ManualState;
  /** File indexes whose contents to leave out. */
  omit: number[];
  prefs: Partial<Prefs>;
}
