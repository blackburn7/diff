// Shiki in a worker: GitHub light/dark default themes, grammars supplied per request.
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
// The *-default themes use Primer's current syntax palette, which is what
// github.com renders; plain github-light/dark are the older VS Code colors.
import githubDark from '@shikijs/themes/github-dark-default';
import githubLight from '@shikijs/themes/github-light-default';

interface Req {
  id: number;
  lang: string;
  grammar?: unknown[];
  docs: string[];
}

const hlP = createHighlighterCore({
  themes: [githubLight, githubDark],
  langs: [],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, lang, grammar, docs } = e.data;
  try {
    const hl = await hlP;
    if (grammar?.length && !hl.getLoadedLanguages().includes(lang)) await hl.loadLanguage(...(grammar as never[]));
    const out = docs.map((doc) =>
      hl
        .codeToTokens(doc, {
          lang,
          themes: { light: 'github-light-default', dark: 'github-dark-default' },
          defaultColor: false,
          tokenizeMaxLineLength: 1000,
        })
        .tokens.map((line) =>
          line.map((t) => {
            const s = (t.htmlStyle ?? {}) as Record<string, string>;
            return [t.content, s['--shiki-light'] ?? '', s['--shiki-dark'] ?? '', s['--shiki-light-font-style'] === 'italic' ? 1 : 0];
          }),
        ),
    );
    postMessage({ id, out });
  } catch (err) {
    postMessage({ id, error: String(err) });
  }
};
