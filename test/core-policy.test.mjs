import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathNearestAncestor, verdict } from '../src/core/policy.mjs';

function root(t) {
  const dir = mkdtempSync(join(tmpdir(), 'piomo-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

test('policy: every known primary agent keeps its own tools', () => {
  for (const agentId of ['sisyphus', 'hephaestus', 'prometheus']) {
    assert.deepEqual(verdict('edit', { path: 'src/a.js' }, { agentId }), { allow: true });
    assert.deepEqual(verdict('bash', { command: 'rm -rf src' }, { agentId }), { allow: true });
    assert.deepEqual(verdict('task', { category: 'quick' }, { agentId }), { allow: true });
    assert.deepEqual(verdict('workflow', { name: 'mass-ulw' }, { agentId }), { allow: true });
  }
});

test('policy: an unknown agent id is refused instead of inheriting a permissive verdict', () => {
  const result = verdict('read', { path: 'a.md' }, { agentId: 'nobody' });
  assert.equal(result.block, true);
  assert.match(result.reason, /unknown agent id "nobody"/);
  assert.equal(verdict('read', { path: 'a.md' }, {}).block, true);
});

test('policy: realpathNearestAncestor resolves an existing path and keeps a missing tail', t => {
  const dir = root(t);
  const existing = join(dir, 'sub');
  mkdirSync(existing);
  writeFileSync(join(existing, 'file.md'), 'x', 'utf8');

  const file = realpathNearestAncestor(join(existing, 'file.md'));
  assert.ok(file.endsWith(join('sub', 'file.md')));

  const missing = realpathNearestAncestor(join(existing, 'deep', 'missing.md'));
  assert.ok(missing.endsWith(join('sub', 'deep', 'missing.md')));

  const real = realpathNearestAncestor(dir);
  assert.ok(typeof real === 'string' && real.length > 0);
});
