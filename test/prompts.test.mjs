import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROMPTS_DIR = process.env.PIOMO_PROMPTS_DIR ?? join(ROOT, 'prompts');
const NAMES = ['prometheus.md', 'atlas.md', 'hephaestus.md'];
const NOTICE = "Portions adapted from oh-my-openagent 5.0.0 by code-yeongyu, licensed under the Sustainable Use License 1.0 (LICENSES/SUL-1.0.md). Modified for PiOMO by grim-susemi, 2026-10-20.";
const CLOSING = "When a workflow skill (ulw-plan, ulw-execute) is loaded, follow it; this block only adds role limits. Tool restrictions enforced by the harness always win.";

const lines = text => text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');

for (const name of NAMES) {
  test(`${name}: exists, starts with the notice, ends with the closing line`, () => {
    const path = join(PROMPTS_DIR, name);
    assert.ok(existsSync(path), `missing ${path}`);
    const all = lines(readFileSync(path, 'utf8'));
    assert.equal(all[0], NOTICE);
    assert.equal(all[all.length - 1], CLOSING);
  });
}

test('no sisyphus overlay', () => {
  assert.equal(existsSync(join(PROMPTS_DIR, 'sisyphus.md')), false);
});

test('built dist/prompts bytes equal the sources', () => {
  const out = mkdtempSync(join(tmpdir(), 'piomo-prompts-'));
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/build.mjs'), '--out', out], { stdio: 'ignore' });
    for (const name of NAMES) {
      assert.ok(readFileSync(join(out, 'prompts', name)).equals(readFileSync(join(ROOT, 'prompts', name))), name);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
