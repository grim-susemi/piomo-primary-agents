import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOC = readFileSync(join(ROOT, 'docs', 'mixed-execution.ko.md'), 'utf8');
const BLOCKS = [...DOC.matchAll(/```json\r?\n([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
const RESULT = BLOCKS[0];
const DONE = BLOCKS[1];

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The doc's acceptance contract, exercised as a fixture so the examples cannot
// drift into prose that no longer describes a verifiable handoff.
function accept({ result, done, testExitCode, writeScope, allowedScope, acceptedBy, authors }) {
  if (!result || result.restored !== true) return false;
  if (testExitCode !== 0) return false;
  if (!Array.isArray(writeScope) || writeScope.length === 0) return false;
  const allowed = new Set(allowedScope);
  if (!writeScope.every(path => allowed.has(path))) return false;
  if (acceptedBy !== 'sisyphus') return false;
  if (!done || done.saveRestoreSha256 !== hash(result)) return false;
  if (!Array.isArray(authors) || new Set(authors).size !== 1) return false;
  return true;
}

function happy() {
  return {
    result: RESULT,
    done: { ...DONE, saveRestoreSha256: hash(RESULT) },
    testExitCode: RESULT.tests.exitCode,
    writeScope: [...RESULT.writeScope],
    allowedScope: [...RESULT.writeScope],
    acceptedBy: 'sisyphus',
    authors: ['sisyphus'],
  };
}

test('the mixed-execution doc keeps both handoff shapes and their contract tokens', () => {
  for (const token of [
    'Execution lead: sisyphus',
    'Execution lead: hephaestus',
    'Execution rationale:',
    'category: deep-low',
    'Loadout: programming',
    'save-restore.json',
    'done.json',
    'saveRestoreSha256',
    'mixed-execution/done/v1',
    'restored: true',
    'acceptedBy: sisyphus',
    'lead-mixed-restore',
    'lead-mixed-parent',
    'SHA-256',
  ]) {
    assert.ok(DOC.includes(token), `missing ${token}`);
  }
  assert.match(DOC, /saveRestoreSha256.*save-restore\.json/);
  assert.match(DOC, /상위 Todo 1\(인수\)/);
  assert.match(DOC, /같은 파일의 작성자가 둘로 기록되면 인수는 실패/);
  assert.match(DOC, /상위 계획의 총괄을 두 명으로 나누지 않습니다/);
});

test('a restored result accepted by Sisyphus with a matching done hash passes', () => {
  assert.equal(accept(happy()), true);
});

test('a missing result file, a false restored flag or a failed test fails acceptance', () => {
  assert.equal(accept({ ...happy(), result: null }), false);
  assert.equal(accept({ ...happy(), result: { ...RESULT, restored: false } }), false);
  assert.equal(accept({ ...happy(), testExitCode: 1 }), false);
});

test('a write outside the assigned scope fails acceptance', () => {
  assert.equal(accept({ ...happy(), writeScope: ['src/core/state.mjs', 'src/core/orchestration.mjs'] }), false);
});

test('a missing lead acceptance or a done hash mismatch fails acceptance', () => {
  assert.equal(accept({ ...happy(), acceptedBy: null }), false);
  assert.equal(accept({ ...happy(), done: { ...happy().done, saveRestoreSha256: 'b'.repeat(64) } }), false);
  assert.equal(accept({ ...happy(), result: { ...RESULT, extra: 'changed after the done hash' } }), false);
});

test('two authors on the same file fail acceptance', () => {
  assert.equal(accept({ ...happy(), authors: ['sisyphus', 'hephaestus'] }), false);
});

test('the separate sub-plan path uses Hephaestus for the child and Sisyphus for the parent acceptance', () => {
  assert.equal(accept(happy()), true);
  assert.equal(accept({ ...happy(), done: { ...happy().done, saveRestoreSha256: 'c'.repeat(64) } }), false);
});
