import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN_BOOTSTRAP_TEXT, createOrchestrator } from '../src/core/orchestration.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'piomo-return-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const agentDir = join(home, 'agent');
  mkdirSync(join(agentDir, 'primary-agents', 'memory'), { recursive: true });
  mkdirSync(join(root, '.omo'));
  writeFileSync(join(home, 'omo.jsonc'), JSON.stringify({ '[native]': { model_profiles: {
    'daily-normal': { models: [{ providers: ['sub'], model: 'daily' }] },
    'daily-heavy': { models: [{ providers: ['sub'], model: 'heavy' }] },
    'geeky-normal': { models: [{ providers: ['gpt'], model: 'gpt-geeky' }] },
  } } }));
  const models = [
    { provider: 'sub', id: 'daily' },
    { provider: 'sub', id: 'heavy' },
    { provider: 'gpt', id: 'gpt-geeky' },
  ];
  const handlers = new Map();
  const branch = [];
  const notices = [];
  const submissions = [];
  let editor;
  class Editor {
    constructor() { this.text = ''; }
    handleInput() {}
    isShowingAutocomplete() { return false; }
    getText() { return this.text; }
    getLines() { return [this.text]; }
    getCursor() { return { line: 0, col: 0 }; }
    setText(text) { this.text = text; }
  }
  const ctx = {
    mode: 'tui', hasUI: true, cwd: root, agentDir,
    model: models[0], thinkingLevel: 'off', isIdle: () => true,
    modelRegistry: {
      find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
      getAvailable: () => models,
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => 'one' },
    ui: {
      getEditorComponent: () => null,
      setEditorComponent(factory) {
        editor = factory({}, {}, { matches: (data, action) => data === '\t' && action === 'tui.input.tab' });
        editor.onSubmit = text => submissions.push({ text, role: orchestration.current });
      },
      setWidget() {}, setStatus() {}, setTitle() {}, notify: message => notices.push(message),
      async select() { return undefined; },
    },
  };
  const pi = {
    sessionKind: 'interactive',
    on: (name, fn) => { handlers.set(name, fn); return () => {}; },
    registerCommand() {},
    async setSessionModel(model) { if (model) ctx.model = model; return true; },
    setSessionThinkingLevel() {},
    appendEntry(type, data) { branch.push({ type: 'custom', customType: type, id: String(branch.length), data }); },
  };
  const orchestration = createOrchestrator(pi, { EditorBase: Editor });
  const fire = (name, event = {}) => handlers.get(name)(event, ctx);
  const start = reason => fire('session_start', { reason });
  const tab = async () => { editor.handleInput('\t'); await orchestration.settled(); };
  return { root, orchestration, start, tab, submissions, notices, handlers, get editor() { return editor; } };
}

test('Tab cycles Sisyphus and Hephaestus', async t => {
  const s = setup(t);
  await s.start('resume');
  await s.tab();
  assert.equal(s.orchestration.current, 'hephaestus');
  await s.tab();
  assert.equal(s.orchestration.current, 'sisyphus');
});

test('Tab from Prometheus returns to Sisyphus when no role was saved', async t => {
  const s = setup(t);
  await s.start('resume');
  await s.orchestration.switchTo('prometheus');
  await s.tab();
  assert.equal(s.orchestration.current, 'sisyphus');
});

test('an execute request without a plan submits the Native bootstrap and never enters Atlas', async t => {
  const s = setup(t);
  await s.start('resume');
  await s.editor.onSubmit('/ulw-execute');
  assert.equal(s.orchestration.current, 'sisyphus');
  assert.equal(s.submissions.length, 1);
  assert.equal(s.submissions[0].text, PLAN_BOOTSTRAP_TEXT);
  assert.equal(s.submissions[0].role, 'sisyphus');
});

test('agent_end and boulder changes no longer switch the role', async t => {
  const s = setup(t);
  await s.start('resume');
  await s.orchestration.switchTo('hephaestus');
  assert.equal(s.handlers.has('agent_end'), false);
  writeFileSync(join(s.root, '.omo', 'boulder.json'), JSON.stringify({
    works: { a: { session_ids: ['senpi:one'], status: 'completed' } },
  }));
  assert.equal(s.orchestration.current, 'hephaestus');
});
