import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlanHandoff,
  sha256Bytes,
  sha256Text,
} from '../src/core/plan-handoff.mjs';

test('the handoff hash is over the exact bytes, not normalized text', () => {
  const crlf = Buffer.from('a\r\nb\r\n', 'utf8');
  const lf = Buffer.from('a\nb\n', 'utf8');
  assert.notEqual(sha256Bytes(crlf), sha256Bytes(lf));
  assert.equal(sha256Text(crlf), sha256Text(lf), 'normalized text alone would collapse the two');
});

test('a handoff keeps the raw-byte hash while comparing normalized lines', () => {
  const bytes = Buffer.from('Execution lead: sisyphus\r\nExecution rationale: 이유\r\n', 'utf8');
  const handoff = createPlanHandoff({
    sessionId: 's',
    path: 'C:/tmp/plan.md',
    text: bytes.toString('utf8'),
    sha256: sha256Bytes(bytes),
    role: 'sisyphus',
  });
  assert.equal(handoff.sha256, sha256Bytes(bytes));
  assert.equal(handoff.body, 'Execution lead: sisyphus\nExecution rationale: 이유\n');
  assert.deepEqual(handoff.lines, ['Execution lead: sisyphus', 'Execution rationale: 이유', '']);
});
