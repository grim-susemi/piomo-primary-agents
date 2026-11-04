import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestration.mjs';

const models = [
  { provider: 'sub', id: 'lane-daily' },
  { provider: 'sub', id: 'lane-daily-heavy' },
  { provider: 'gpt', id: 'gpt-lane-geeky' },
  { provider: 'gpt', id: 'gpt-lane-heavy' },
];

class FakeBase {
  constructor() { this.text = ''; this.borderColor = '#123456'; }
  handleInput() {}
  isShowingAutocomplete() { return false; }
  getText() { return this.text; }
  getLines() { return [this.text]; }
  getCursor() { return { line: 0, col: 0 }; }
  setText(text) { this.text = text; }
}

async function session(t, gpt = true) {
  const root = mkdtempSync(join(tmpdir(), 'auto-return-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const home = join(root, '.omo');
  const agentDir = join(home, 'agent');
  mkdirSync(join(agentDir, 'primary-agents', 'memory'), { recursive: true });
  const profiles = {};
  for (const [lane, model] of Object.entries({
    'daily-normal': models[0], 'daily-heavy': models[1],
    'geeky-normal': models[2], 'geeky-heavy': models[3],
  })) profiles[lane] = { models: [{ providers: [model.provider], model: model.id, variant: 'medium' }] };
  writeFileSync(join(home, 'omo.jsonc'), JSON.stringify({ '[native]': { model_profiles: profiles } }));
  const available = models.filter(model => gpt || model.provider !== 'gpt');
  const branch = [{ type: 'custom', customType: 'primary-agent/v1', id: 'identity',
    data: { schemaVersion: 1, agentId: 'sisyphus' } }];
  const handlers = new Map();
  const notices = [];
  const calls = [];
  let editor;
  const ctx = {
    mode: 'tui', hasUI: true, cwd: root, agentDir, model: models[0], thinkingLevel: 'off',
    modelRegistry: { find: (provider, id) => available.find(m => m.provider === provider && m.id === id),
      getAvailable: () => available },
    sessionManager: { getBranch: () => branch, getSessionId: () => 'session-1' },
    isIdle: () => true,
    ui: {
      getEditorComponent: () => null,
      setEditorComponent(factory) {
        editor = factory({}, {}, { matches: (data, action) => data === '\t' && action === 'tui.input.tab' });
        editor.onSubmit = text => calls.push({ kind: 'submit', text });
      },
      setWidget() {}, setStatus() {}, setTitle() {},
      notify: (message, type) => notices.push({ message, type }),
    },
  };
  const pi = {
    sessionKind: 'interactive',
    on: (name, handler) => { handlers.set(name, handler); return () => {}; },
    registerCommand() {},
    setSessionModel: async model => { calls.push({ kind: 'model', model }); ctx.model = model; return true; },
    setSessionThinkingLevel() {},
    appendEntry: (type, data) => branch.push({ type: 'custom', customType: type, data, id: `e${branch.length}` }),
  };
  const orchestrator = createOrchestrator(pi, { EditorBase: FakeBase });
  const fire = (name, event = {}) => handlers.get(name)(event, ctx);
  await fire('session_start', { reason: 'resume' });
  const board = works => writeFileSync(join(home, 'boulder.json'), JSON.stringify({ works }));
  const work = status => ({ session_ids: ['senpi:session-1'], status });
  const tab = async () => { editor.handleInput('\t'); await orchestrator.settled(); };
  return { orchestrator, fire, board, work, tab, calls, notices, submit: text => editor.onSubmit(text) };
}

test('plan request enters Prometheus and submits', async t => {
  const s = await session(t);
  await s.submit('/skill:ulw-plan request');
  assert.equal(s.orchestrator.current, 'prometheus');
  assert.equal(s.calls.at(-1).text, '/skill:ulw-plan request');
});

test('prometheus execute keeps return target', async t => {
  const s = await session(t);
  await s.tab();
  await s.submit('/skill:ulw-plan request');
  await s.submit('/ulw-execute plan');
  s.board([s.work('active')]); await s.fire('agent_end');
  s.board([s.work('completed')]); await s.fire('agent_end');
  assert.equal(s.orchestrator.current, 'hephaestus');
});

test('armed work returns only after terminal state or removal', async t => {
  const s = await session(t);
  await s.submit('/ulw-execute plan');
  s.board([s.work('active')]); await s.fire('agent_end');
  for (const status of ['paused', 'blocked']) {
    s.board([s.work(status)]); await s.fire('agent_end');
    assert.equal(s.orchestrator.current, 'atlas');
  }
  s.board([]); await s.fire('agent_end', { willRetry: true });
  assert.equal(s.orchestrator.current, 'atlas');
  await s.fire('agent_end');
  assert.equal(s.orchestrator.current, 'sisyphus');
});

test('never armed stays on Atlas', async t => {
  const s = await session(t);
  await s.submit('/ulw-execute plan');
  s.board([]); await s.fire('agent_end');
  assert.equal(s.orchestrator.current, 'atlas');
});

test('missing boulder and reload do not restore armed state or return target', async t => {
  const s = await session(t);
  await s.tab(); await s.submit('/ulw-execute plan');
  await s.fire('agent_end');
  assert.equal(s.orchestrator.current, 'atlas');
  s.board([s.work('active')]); await s.fire('agent_end');
  await s.fire('session_start', { reason: 'reload' });
  s.board([]); await s.fire('agent_end');
  assert.equal(s.orchestrator.current, 'atlas');
  await s.tab();
  assert.equal(s.orchestrator.current, 'sisyphus');
});

test('Tab ring contains only two main agents', async t => {
  const s = await session(t);
  await s.tab(); assert.equal(s.orchestrator.current, 'hephaestus');
  await s.tab(); assert.equal(s.orchestrator.current, 'sisyphus');
});

test('Tab from Atlas returns to previous main agent', async t => {
  const s = await session(t);
  await s.tab(); await s.submit('/ulw-execute plan'); await s.tab();
  assert.equal(s.orchestrator.current, 'hephaestus');
});

test('unavailable Hephaestus leaves Sisyphus with one notice and no model switch', async t => {
  const s = await session(t, false);
  s.notices.length = 0; s.calls.length = 0;
  await s.tab();
  assert.equal(s.orchestrator.current, 'sisyphus');
  assert.equal(s.notices.length, 1);
  assert.equal(s.calls.filter(call => call.kind === 'model').length, 0);
});
