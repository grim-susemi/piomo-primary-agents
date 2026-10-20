// Every relative link in the user docs of both repos must resolve to a file.
// Absolute filesystem links are refused because they break on any other machine.
// DOCS_LINKS_EXT / DOCS_LINKS_BWT point the test at other copies (used by the
// broken-link negative check on a temp copy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(process.env.DOCS_LINKS_EXT ?? join(here, '..'));
const BWT = resolve(process.env.DOCS_LINKS_BWT
  ?? join(EXT, '..', 'piomo-briefing-wt', 'primary-agents-profiles'));

const DOCS = [
  [EXT, 'README.ko.md'],
  [EXT, 'README.md'],
  [EXT, 'docs/winforms-archive.ko.md'],
  [EXT, 'docs/gate-adapter.ko.md'],
  [BWT, 'docs/profiles.ko.md'],
];

function links(markdown) {
  const text = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]);
}

for (const [root, rel] of DOCS) {
  test(`links resolve in ${rel} (${root})`, () => {
    const file = join(root, rel);
    assert.ok(existsSync(file), `missing doc ${file}`);
    const found = links(readFileSync(file, 'utf8'));
    for (const link of found) {
      if (/^(https?:|mailto:)/i.test(link) || link.startsWith('#')) continue;
      assert.ok(!/^([A-Za-z]:|\/|\\|file:)/.test(link), `absolute link in ${rel}: ${link}`);
      const target = resolve(dirname(file), decodeURIComponent(link.split('#')[0]));
      assert.ok(existsSync(target), `broken link in ${rel}: ${link}`);
    }
  });
}
