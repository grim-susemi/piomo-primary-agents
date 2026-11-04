import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRoster, memoryPath, rosterPath } from '../contract/schema.mjs';
import { createOrchestrator } from '../src/core/orchestration.mjs';

function setup(t, { models = [], available = models, settings, roster = defaultRoster(), memory, lanes } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'model-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, '.omo');
  const agentDir = join(home, 'agent');
  mkdirSync(join(agentDir, 'primary-agents', 'memory'), { recursive: true });
  if (settings) writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings));
  writeFileSync(rosterPath(agentDir), JSON.stringify(roster));
  if (memory) writeFileSync(memoryPath(agentDir, memory.agentId), JSON.stringify(memory));
  if (lanes) writeFileSync(join(home, 'omo.jsonc'), JSON.stringify({ '[native]': { model_profiles: lanes } }));
  const branch = [];
  const handlers = new Map();
  const notices = [];
  const calls = [];
  const registry = {
    find: (provider, id) => models.find(m => m.provider === provider && m.id === id),
    getAvailable: () => available,
  };
  const ctx = {
    mode: 'tui', hasUI: true, cwd: root, agentDir, model: { provider: 'host', id: 'host' },
    modelRegistry: registry, sessionManager: { getBranch: () => branch, getSessionId: () => 'test' },
    ui: { notify: (message, type) => notices.push({ message, type }) },
  };
  const pi = {
    sessionKind: 'interactive', on: (event, handler) => handlers.set(event, handler),
    registerCommand() {},
    async setSessionModel(model) { calls.push(model); ctx.model = model; return true; },
    setSessionThinkingLevel() {},
    appendEntry(type, data) { branch.push({ type: 'custom', customType: type, data, id: `e${branch.length}` }); },
  };
  const orch = createOrchestrator(pi);
  const fire = (name, event = {}) => handlers.get(name)(event, ctx);
  return { orch, fire, ctx, branch, calls, notices, agentDir };
}

const A = { provider: 'p', id: 'A' };
const B = { provider: 'q', id: 'B' };
const main = { defaultProvider: 'p', defaultModel: 'A', defaultThinkingLevel: 'high' };
const mem = (agentId, model, rosterRev = 0) => ({
  v: 1, agentId, model: { provider: model.provider, modelId: model.id },
  thinking: 'high', rosterRev, updatedAt: '2026-01-01T00:00:00.000Z',
});
const lane = (...models) => ({ 'daily-normal': { models: models.map(m => ({ model: m.id, providers: [m.provider] })) } });

test('no-pin Sisyphus follows settings main without applying it on a fresh session', async t => {
  const s = setup(t, { models: [A], settings: main });
  await s.fire('session_start', { reason: 'new' });
  assert.equal(s.orch.availability().sisyphus.origin, 'main');
  assert.equal(s.orch.availability().sisyphus.modelId, 'A');
  assert.equal(s.calls.length, 0);
});

test('pinned Sisyphus and matching memory take precedence on fresh sessions', async t => {
  const roster = defaultRoster();
  roster.agents.sisyphus.pin = { provider: 'p', modelId: 'A', thinking: 'high' };
  const s = setup(t, { models: [A, B], roster, memory: mem('sisyphus', B), settings: main });
  await s.fire('session_start', { reason: 'new' });
  assert.equal(s.orch.availability().sisyphus.origin, 'memory');
  assert.equal(s.calls[0].id, 'B');
  const p = setup(t, { models: [A], roster, settings: main });
  await p.fire('session_start', { reason: 'new' });
  assert.equal(p.orch.availability().sisyphus.origin, 'pin');
  assert.equal(p.calls[0].id, 'A');
});

test('incomplete settings uses lane', async t => {
  const s = setup(t, { models: [A], settings: { ...main, defaultThinkingLevel: undefined }, lanes: lane(A) });
  await s.fire('session_start', { reason: 'resume' });
  assert.equal(s.orch.availability().sisyphus.origin, 'lane');
});

test('opencode-go kimi rung skipped', async t => {
  const kimi = { provider: 'opencode-go', id: 'kimi' };
  const s = setup(t, { models: [kimi, A], lanes: lane(kimi, A) });
  await s.fire('session_start', { reason: 'resume' });
  assert.equal(s.orch.availability().sisyphus.modelId, 'A');
});

test('opencode-go muse allowed and explicit kimi pin is not guarded', async t => {
  const muse = { provider: 'opencode-go', id: 'Muse-1' };
  const kimi = { provider: 'opencode-go', id: 'kimi' };
  const s = setup(t, { models: [muse], lanes: lane(muse) });
  await s.fire('session_start', { reason: 'resume' });
  assert.equal(s.orch.availability().sisyphus.modelId, 'Muse-1');
  const roster = defaultRoster();
  roster.agents.sisyphus.pin = { provider: kimi.provider, modelId: kimi.id, thinking: 'high' };
  const p = setup(t, { models: [kimi], roster });
  await p.fire('session_start', { reason: 'resume' });
  assert.equal(p.orch.availability().sisyphus.origin, 'pin');
  const m = setup(t, { models: [kimi], memory: mem('sisyphus', kimi) });
  await m.fire('session_start', { reason: 'resume' });
  assert.equal(m.orch.availability().sisyphus.origin, 'memory');
});

test('provider-free lane lookup filters non-Muse opencode-go models', async t => {
  const kimi = { provider: 'opencode-go', id: 'kimi' };
  const s = setup(t, { models: [kimi], lanes: { 'daily-normal': { models: [{ model: 'kimi' }] } } });
  await s.fire('session_start', { reason: 'resume' });
  assert.equal(s.orch.availability().sisyphus.unavailable, true);
});

test('invalid memory file warns once across refreshes', async t => {
  const s = setup(t);
  writeFileSync(memoryPath(s.agentDir, 'atlas'), '{');
  await s.fire('session_start', { reason: 'resume' });
  await s.orch.switchTo('atlas');
  assert.equal(s.notices.filter(n => n.message.includes('atlas.json')).length, 1);
});

test('broken roster warns once across refreshes', async t => {
  const s = setup(t);
  writeFileSync(rosterPath(s.agentDir), '{');
  await s.fire('session_start', { reason: 'resume' });
  await s.orch.switchTo('atlas');
  assert.equal(s.notices.filter(n => n.message.includes('roster.json')).length, 1);
});

test('invalid higher-priority candidates warn once even with fallback', async t => {
  const roster = defaultRoster();
  roster.agents.sisyphus.pin = { provider: 'p', modelId: 'A', thinking: 'high' };
  const s = setup(t, { models: [A, B], available: [A], roster, memory: mem('sisyphus', B) });
  await s.fire('session_start', { reason: 'new' });
  const warnings = s.notices.filter(n => n.message.includes('기억'));
  assert.equal(s.orch.availability().sisyphus.origin, 'pin');
  assert.equal(warnings.length, 1);
  for (const text of ['B', '미인증', 'A']) assert.ok(warnings[0].message.includes(text));
});

test('unregistered pin and unauthenticated main warn when lane succeeds', async t => {
  const roster = defaultRoster();
  roster.agents.sisyphus.pin = { provider: 'missing', modelId: 'missing', thinking: 'high' };
  const s = setup(t, { models: [A], roster, lanes: lane(A) });
  await s.fire('session_start', { reason: 'new' });
  assert.ok(s.notices.some(n => n.message.includes('핀') && n.message.includes('미등록')));
  const m = setup(t, { models: [A, B], available: [A], settings: { ...main, defaultProvider: 'q', defaultModel: 'B' }, lanes: lane(A) });
  await m.fire('session_start', { reason: 'new' });
  assert.ok(m.notices.some(n => n.message.includes('메인') && n.message.includes('미인증')));
});

test('fresh invalid pin warning names the unchanged host model, not the lane fallback', async t => {
  const roster = defaultRoster();
  roster.agents.sisyphus.pin = { provider: 'missing', modelId: 'missing', thinking: 'high' };
  const s = setup(t, { models: [A], roster, lanes: lane(A) });
  await s.fire('session_start', { reason: 'new' });
  assert.equal(s.orch.availability().sisyphus.modelId, 'A');
  assert.equal(s.calls.length, 0);
  const warning = s.notices.find(n => n.message.includes('핀') && n.message.includes('미등록'));
  assert.ok(warning);
  assert.match(warning.message, /host\/host/);
  assert.doesNotMatch(warning.message, /p\/A/);
});

test('repeated switches deduplicate skipped candidate warnings', async t => {
  const roster = defaultRoster();
  roster.agents.atlas.pin = { provider: 'missing', modelId: 'missing', thinking: 'high' };
  const s = setup(t, { models: [A], roster, lanes: lane(A) });
  await s.fire('session_start', { reason: 'resume' });
  await s.orch.switchTo('atlas');
  await s.orch.switchTo('sisyphus');
  await s.orch.switchTo('atlas');
  assert.equal(s.notices.filter(n => n.message.includes('Atlas: 핀')).length, 1);
});

for (const boardFirst of [false, true]) {
  test(`selection revision is captured ${boardFirst ? 'after' : 'before'} board apply`, async t => {
    const roster = defaultRoster();
    const s = setup(t, { models: [A, B], settings: main, lanes: lane(A), roster });
    await s.fire('session_start', { reason: 'resume' });
    const apply = () => {
      roster.agents.sisyphus.rev += 1;
      writeFileSync(rosterPath(s.agentDir), JSON.stringify(roster));
    };
    if (boardFirst) apply();
    s.fire('model_select', {});
    s.branch.push({ type: 'model_change', id: 'chosen', source: 'command', provider: B.provider, modelId: B.id });
    if (!boardFirst) apply();
    await s.orch.switchTo('atlas');
    await s.orch.switchTo('sisyphus');
    assert.equal(s.ctx.model.id, boardFirst ? 'B' : 'A');
    assert.equal(s.orch.availability().sisyphus.origin, boardFirst ? 'memory' : 'main');
  });
}
