import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrimaryMain, isPrimaryMainSession } from '../src/core/gate.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = JSON.parse(
  readFileSync(join(ROOT, 'test', 'fixtures', 'core', 'p4-gate.json'), 'utf8'),
);

test('gate: P4 fixtures decide primary main', () => {
  for (const entry of fixtures.cases) {
    const signals = { sessionKind: entry.sessionKind, mode: entry.mode, hasUI: entry.hasUI };
    assert.equal(isPrimaryMain(signals), entry.primaryMain, entry.name);
  }
});

test('gate: parent print session is not primary main', () => {
  assert.equal(isPrimaryMain({ sessionKind: 'interactive', mode: 'print', hasUI: false }), false);
});

test('gate: task child rpc session with a UI is not primary main', () => {
  assert.equal(isPrimaryMain({ sessionKind: 'interactive', mode: 'rpc', hasUI: true }), false);
});

test('gate: worker session is not primary main', () => {
  assert.equal(isPrimaryMain({ sessionKind: 'worker', mode: 'tui', hasUI: true }), false);
});

test('gate: interactive tui main session is primary main', () => {
  assert.equal(isPrimaryMain({ sessionKind: 'interactive', mode: 'tui', hasUI: true }), true);
});

test('gate: missing signals are never primary main', () => {
  assert.equal(isPrimaryMain(), false);
  assert.equal(isPrimaryMain({}), false);
  assert.equal(isPrimaryMain({ sessionKind: 'interactive', mode: 'tui' }), false);
  assert.equal(isPrimaryMainSession({}, {}), false);
});

test('gate: live pi/ctx adapter reads sessionKind, mode and hasUI', () => {
  assert.equal(isPrimaryMainSession(
    { sessionKind: 'interactive' },
    { mode: 'tui', hasUI: true },
  ), true);
  assert.equal(isPrimaryMainSession(
    { sessionKind: 'interactive' },
    { mode: 'rpc', hasUI: true },
  ), false);
});
