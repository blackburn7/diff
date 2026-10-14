import { expect, test } from 'bun:test';
import { pathOrder, splitPatch } from '../src/patch.ts';

test('pathOrder matches git and GitHub: plain byte order of the path', () => {
  const paths = ['a/b/c.ts', 'a/b.ts', 'B.md', 'a/b10.ts', 'a/b2.ts', 'a.ts'];
  paths.sort(pathOrder);
  expect(paths).toEqual(['B.md', 'a.ts', 'a/b.ts', 'a/b/c.ts', 'a/b10.ts', 'a/b2.ts']);
});

test('splitPatch keeps each section with its own stats and kinds', () => {
  const patch = [
    'diff --git a/src/b.ts b/src/b.ts',
    'index 1111111..2222222 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1,2 +1,2 @@',
    '-const a = 1;',
    '+const a  =  1;',
    ' x',
    'diff --git a/old.md b/docs/new.md',
    'similarity index 100%',
    'rename from old.md',
    'rename to docs/new.md',
    'diff --git a/src/a.ts b/src/a.ts',
    'deleted file mode 100644',
    'index 3333333..0000000',
    '--- a/src/a.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    '',
  ].join('\n');
  const { files, sections } = splitPatch(patch);
  expect(files.map((f) => f.path)).toEqual(['docs/new.md', 'src/a.ts', 'src/b.ts']);
  const [renamed, deleted, ws] = files;
  expect(renamed).toMatchObject({ status: 'renamed', prevPath: 'old.md', kinds: ['renames'], cats: ['docs', 'trivial'] });
  expect(deleted).toMatchObject({ status: 'deleted', deletions: 1, kinds: ['deleted'] });
  expect(ws).toMatchObject({ status: 'modified', additions: 1, deletions: 1, kinds: ['whitespace'] });
  expect(sections[2]!.startsWith('diff --git a/src/b.ts')).toBe(true);
  expect(sections[2]!.includes('a/src/a.ts')).toBe(false);
});
