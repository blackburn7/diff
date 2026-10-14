// Small DOM helpers and the gzip+base64 codec for exports.

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const nf = new Intl.NumberFormat('en-US');
export const fmt = (n: number) => nf.format(n);

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const from = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (from) return from(clean);
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function gunzipBase64(b64: string): Promise<string> {
  const stream = new Blob([base64ToBytes(b64) as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Pull the embedded bundle out of an exported HTML file's text. */
export function extractEmbedded(html: string, id: string): string | null {
  const m = new RegExp(`<script type="application/octet-stream" id="${id}">([^<]*)</script>`).exec(html);
  return m ? m[1]! : null;
}
