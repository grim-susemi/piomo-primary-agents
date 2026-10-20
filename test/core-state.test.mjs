import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AGENT_ID,
  IDENTITY_ENTRY_TYPE,
  appendIdentity,
  identityData,
  initialCursor,
  reconcileMemory,
  restoreAgentId,
} from '../src/core/state.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const branch = JSON.parse(
  readFileSync(join(ROOT, 'test', 'fixtures', 'core', 'p3-branch.json'), 'utf8'),
);

function identity(agentId, extra = {}) {
  return {
    type: 'custom',
    customType: IDENTITY_ENTRY_TYPE,
    id: `id-${agentId}`,
    parentId: null,
    timestamp: '2026-10-20T00:00:00.000Z',
    data: { schemaVersion: 1, agentId, ...extra },
  };
}

test('state: appendIdentity writes the primary-agent/v1 entry', () => {
  const calls = [];
  const pi = { appendEntry: (...args) => calls.push(args) };
  appendIdentity(pi, 'prometheus');
  assert.deepEqual(calls, [[IDENTITY_ENTRY_TYPE, { schemaVersion: 1, agentId: 'prometheus' }]]);
  assert.deepEqual(identityData('atlas'), { schemaVersion: 1, agentId: 'atlas' });
  assert.throws(() => identityData('nobody'), RangeError);
});

test('state: restore takes the last identity entry on the branch', () => {
  assert.equal(restoreAgentId(branch), 'atlas');
  assert.equal(restoreAgentId([identity('prometheus'), identity('hephaestus')]), 'hephaestus');
});

test('state: restore ignores previousSessionFile', () => {
  const ownBranch = [identity('sisyphus')];
  assert.equal(
    restoreAgentId(ownBranch, { previousSessionFile: 'C:/tmp/other-session.jsonl' }),
    'sisyphus',
  );
});

test('state: missing identity restores sisyphus', () => {
  assert.equal(restoreAgentId([]), DEFAULT_AGENT_ID);
  assert.equal(restoreAgentId(undefined), DEFAULT_AGENT_ID);
  assert.equal(restoreAgentId(branch.slice(0, 3)), DEFAULT_AGENT_ID);
});

test('state: invalid identity restores sisyphus instead of an earlier entry', () => {
  const invalidVersion = {
    type: 'custom',
    customType: IDENTITY_ENTRY_TYPE,
    data: { schemaVersion: 2, agentId: 'atlas' },
  };
  const unknownAgent = {
    type: 'custom',
    customType: IDENTITY_ENTRY_TYPE,
    data: { schemaVersion: 1, agentId: 'nobody' },
  };
  const notAnObject = { type: 'custom', customType: IDENTITY_ENTRY_TYPE, data: 'atlas' };
  assert.equal(restoreAgentId([identity('prometheus'), invalidVersion]), DEFAULT_AGENT_ID);
  assert.equal(restoreAgentId([identity('prometheus'), unknownAgent]), DEFAULT_AGENT_ID);
  assert.equal(restoreAgentId([identity('prometheus'), notAnObject]), DEFAULT_AGENT_ID);
});

test('state: reconcile learns only command, picker and cycle model changes', () => {
  const result = reconcileMemory(branch, initialCursor());
  const models = result.updates.filter(update => update.kind === 'model');
  assert.deepEqual(models.map(update => update.model.modelId), [
    'gpt-mock-fast',
    'claude-mock-max',
    'claude-mock-medium',
    'gpt-6-astra',
  ]);
  assert.deepEqual(models.map(update => update.agentId), [
    'prometheus',
    'prometheus',
    'prometheus',
    'atlas',
  ]);
  assert.ok(!models.some(update => update.model.modelId === 'gpt-6-astra' && update.agentId === 'prometheus'));
});

test('state: reconcile learns only explicit or editor thinking changes', () => {
  const result = reconcileMemory(branch, initialCursor());
  const thinking = result.updates.filter(update => update.kind === 'thinking');
  assert.deepEqual(thinking.map(update => [update.agentId, update.thinking]), [
    ['prometheus', 'minimal'],
    ['prometheus', 'high'],
    ['atlas', 'xhigh'],
  ]);
});

test('state: reconcile ignores entries before the first known agent', () => {
  const result = reconcileMemory(branch.slice(0, 3), initialCursor());
  assert.deepEqual(result.updates, []);
  assert.deepEqual(result.cursor, { index: 3, agentId: null });
});

test('state: reconcile resumes from its cursor without relearning', () => {
  const first = reconcileMemory(branch, initialCursor());
  assert.equal(first.cursor.index, branch.length);
  const second = reconcileMemory(branch, first.cursor);
  assert.deepEqual(second.updates, []);
  assert.deepEqual(second.cursor, first.cursor);
});

test('state: stale cursor past the branch is clamped and learns nothing new', () => {
  const result = reconcileMemory(branch, { index: 9999, agentId: 'atlas' });
  assert.deepEqual(result.updates, []);
  assert.deepEqual(result.cursor, { index: branch.length, agentId: 'atlas' });
});

test('state: compacted branch falls back to the cursor agent', () => {
  const compacted = branch.slice(branch.findIndex(entry => entry.id === 'm1'));
  const result = reconcileMemory(compacted, { index: 0, agentId: 'prometheus' });
  assert.equal(result.updates.length > 0, true);
  assert.ok(result.updates.every(update => update.agentId === 'prometheus' || update.agentId === 'atlas'));
  assert.equal(result.updates[0].agentId, 'prometheus');
});

test('state: reconcile tolerates malformed entries', () => {
  const result = reconcileMemory([
    identity('atlas'),
    { type: 'model_change', source: 'command', provider: '', modelId: 'x' },
    { type: 'thinking_level_change', thinkingLevel: 'high', thinkingSelection: { source: 'explicit' } },
    { type: 'thinking_level_change', thinkingLevel: 'bogus', thinkingSelection: { source: 'explicit' } },
    null,
  ], initialCursor());
  assert.deepEqual(result.updates, []);
  assert.deepEqual(result.cursor, { index: 5, agentId: 'atlas' });
});
