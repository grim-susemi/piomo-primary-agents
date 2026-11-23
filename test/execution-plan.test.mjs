import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LEAD,
  parseExecutionLead,
  resolveExecutionLead,
  selectExecutionPlan,
} from '../src/core/execution-plan.mjs';

const plan = (fields, extra = '') => `# example\n\n## TL;DR (For humans)\n목표 한 줄.\n${fields}\n\n${extra}## Scope\n본문\n\n## Todos\n- [ ] 1. 일\n`;

test('a requested lead with a reason is declared as written', () => {
  for (const lead of ['sisyphus', 'hephaestus']) {
    const parsed = parseExecutionLead(plan(`Execution lead: ${lead}\nExecution rationale: 저장 복구를 끝까지 검수`));
    assert.equal(parsed.status, 'declared');
    assert.equal(parsed.lead, lead);
    assert.equal(parsed.rationale, '저장 복구를 끝까지 검수');
    assert.deepEqual(resolveExecutionLead(plan(`Execution lead: ${lead}\nExecution rationale: 이유`)), {
      ok: true,
      lead,
      rationale: '이유',
    });
  }
});

test('plans without the fields keep the historical default and are not invalid', () => {
  assert.deepEqual(resolveExecutionLead(plan('')), { ok: true, lead: DEFAULT_LEAD, rationale: null, defaulted: true });
  assert.deepEqual(resolveExecutionLead('# no tldr\n\n## Scope\n'), {
    ok: true,
    lead: DEFAULT_LEAD,
    rationale: null,
    defaulted: true,
  });
});

test('one field, an unknown role, a duplicate, or an empty reason is invalid', () => {
  const cases = [
    ['Execution lead: hephaestus', 'rationale-missing'],
    ['Execution rationale: 이유', 'lead-missing'],
    ['Execution lead: atlas\nExecution rationale: 이유', 'lead-invalid'],
    ['Execution lead: hephaestus\nExecution rationale:    ', 'rationale-empty'],
    ['Execution lead: hephaestus\nExecution lead: sisyphus\nExecution rationale: 이유', 'lead-duplicate'],
    ['Execution lead: hephaestus\nExecution rationale: 하나\nExecution rationale: 둘', 'rationale-duplicate'],
  ];
  for (const [fields, reason] of cases) {
    const parsed = parseExecutionLead(plan(fields));
    assert.equal(parsed.status, 'invalid', fields);
    assert.equal(parsed.reason, reason, fields);
    assert.equal(resolveExecutionLead(plan(fields)).ok, false, fields);
  }
});

test('only column-0 fields inside the TL;DR section count', () => {
  const indented = plan('  Execution lead: hephaestus\n  Execution rationale: 이유');
  assert.equal(parseExecutionLead(indented).status, 'unspecified');

  const outside = plan('', '## Scope\nExecution lead: hephaestus\nExecution rationale: 이유\n');
  assert.equal(parseExecutionLead(outside).status, 'unspecified');

  const fenced = plan('```text\nExecution lead: hephaestus\nExecution rationale: 이유\n```');
  assert.equal(parseExecutionLead(fenced).status, 'unspecified');

  const heading = '# x\n## TL;DR\n본문\n### 하위 제목\nExecution lead: hephaestus\nExecution rationale: 이유\n';
  assert.equal(parseExecutionLead(heading).status, 'declared');
});

test('selection prefers an explicit name and never falls through when it is missing', () => {
  assert.deepEqual(
    selectExecutionPlan({ explicitName: 'lead-hephaestus', availablePlans: ['lead-sisyphus', 'lead-hephaestus'] }),
    { kind: 'explicit', slug: 'lead-hephaestus' },
  );
  assert.deepEqual(
    selectExecutionPlan({ explicitName: 'lead-missing', availablePlans: ['lead-sisyphus'], activePlans: ['lead-sisyphus'] }),
    { kind: 'blocked', reason: 'explicit-not-found' },
  );
});

test('selection order is active Boulder, paused Boulder, single plan, choice, new plan', () => {
  assert.deepEqual(selectExecutionPlan({ activePlans: ['lead-a'], availablePlans: ['lead-a', 'lead-b'] }), {
    kind: 'active',
    slug: 'lead-a',
  });
  assert.deepEqual(
    selectExecutionPlan({ activePlans: ['lead-a', 'lead-b'], availablePlans: ['lead-a', 'lead-b'] }),
    { kind: 'blocked', reason: 'active-multiple' },
  );
  assert.deepEqual(selectExecutionPlan({ pausedPlans: ['lead-c'], availablePlans: ['lead-c'] }), {
    kind: 'paused',
    slug: 'lead-c',
  });
  assert.deepEqual(selectExecutionPlan({ pausedPlans: ['a', 'b'] }), { kind: 'blocked', reason: 'paused-multiple' });
  assert.deepEqual(selectExecutionPlan({ availablePlans: ['solo'] }), { kind: 'single', slug: 'solo' });
  assert.deepEqual(selectExecutionPlan({ availablePlans: ['a', 'b'] }), { kind: 'choose', candidates: ['a', 'b'] });
  assert.deepEqual(selectExecutionPlan({}), { kind: 'new' });
});

test('the same bytes always produce the same verdict', () => {
  const bytes = plan('Execution lead: hephaestus\nExecution rationale: 같은 이유');
  assert.deepEqual(parseExecutionLead(bytes), parseExecutionLead(bytes));
  assert.deepEqual(resolveExecutionLead(bytes), resolveExecutionLead(bytes));
  assert.equal(parseExecutionLead(bytes).lead, 'hephaestus');
});
