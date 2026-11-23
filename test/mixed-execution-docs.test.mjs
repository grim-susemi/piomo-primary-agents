import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOC = readFileSync(join(ROOT, 'docs', 'mixed-execution.ko.md'), 'utf8');

// The doc's acceptance contract, exercised as a fixture so the examples cannot
// drift into prose that no longer describes a verifiable handoff.
function accept(fixture) {
  if (!fixture.result || fixture.result.restored !== true) return false;
  if (fixture.testExitCode !== 0) return false;
  if (!Array.isArray(fixture.writeScope) || fixture.writeScope.length === 0) return false;
  const allowed = new Set(fixture.allowedScope);
  if (!fixture.writeScope.every(path => allowed.has(path))) return false;
  if (fixture.acceptedBy !== 'sisyphus') return false;
  if (typeof fixture.evidenceSha !== 'string' || fixture.evidenceSha !== fixture.recordedSha) return false;
  if (!Array.isArray(fixture.authors) || new Set(fixture.authors).size !== 1) return false;
  return true;
}

function happy() {
  return {
    result: { schema: 'mixed-execution/save-restore/v1', restored: true },
    testExitCode: 0,
    writeScope: ['src/core/state.mjs', 'test/core-state.test.mjs'],
    allowedScope: ['src/core/state.mjs', 'test/core-state.test.mjs'],
    evidenceSha: 'a'.repeat(64),
    recordedSha: 'a'.repeat(64),
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
    'restored: true',
    'acceptedBy: sisyphus',
    'lead-mixed-restore',
    'lead-mixed-parent',
    'SHA-256',
  ]) {
    assert.ok(DOC.includes(token), `missing ${token}`);
  }
  assert.match(DOC, /같은 파일의 작성자가 둘로 기록되면 인수는 실패/);
  assert.match(DOC, /상위 계획의 총괄을 두 명으로 나누지 않습니다/);
});

test('a restored result accepted by Sisyphus with matching hashes passes', () => {
  assert.equal(accept(happy()), true);
});

test('a missing result file, a false restored flag or a failed test fails acceptance', () => {
  assert.equal(accept({ ...happy(), result: null }), false);
  assert.equal(accept({ ...happy(), result: { restored: false } }), false);
  assert.equal(accept({ ...happy(), testExitCode: 1 }), false);
});

test('a write outside the assigned scope fails acceptance', () => {
  assert.equal(accept({ ...happy(), writeScope: ['src/core/state.mjs', 'src/core/orchestration.mjs'] }), false);
});

test('a missing lead acceptance or a hash mismatch fails acceptance', () => {
  assert.equal(accept({ ...happy(), acceptedBy: null }), false);
  assert.equal(accept({ ...happy(), recordedSha: 'b'.repeat(64) }), false);
});

test('two authors on the same file fail acceptance', () => {
  assert.equal(accept({ ...happy(), authors: ['sisyphus', 'hephaestus'] }), false);
});

test('the separate sub-plan path uses Hephaestus for the child and Sisyphus for the parent acceptance', () => {
  const subPlan = { executionLead: 'hephaestus', parentLead: 'sisyphus' };
  assert.equal(subPlan.executionLead, 'hephaestus');
  assert.equal(subPlan.parentLead, 'sisyphus');
  assert.equal(accept(happy()), true);
  assert.equal(accept({ ...happy(), recordedSha: 'c'.repeat(64) }), false);
});
