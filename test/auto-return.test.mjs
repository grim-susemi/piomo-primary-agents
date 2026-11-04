import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestration.mjs';

function setup(t, { gpt = true, idle = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'auto-return-'));
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
  const models = [{ provider: 'sub', id: 'daily' }, { provider: 'sub', id: 'heavy' }];
  if (gpt) models.push({ provider: 'gpt', id: 'gpt-geeky' });
  const handlers = new Map(), branch = [], notices = [], calls = [], submissions = [];
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
    model: models[0], thinkingLevel: 'off', isIdle: () => idle,
    modelRegistry: { find: (p, id) => models.find(m => m.provider === p && m.id === id), getAvailable: () => models },
    sessionManager: { getBranch: () => branch, getSessionId: () => 'one' },
    ui: {
      getEditorComponent: () => null,
      setEditorComponent(factory) {
        editor = factory({}, {}, { matches: (data, action) => data === '\t' && action === 'tui.input.tab' });
        editor.onSubmit = text => submissions.push({ text, role: orchestration.current });
      },
      setWidget() {}, setStatus() {}, setTitle() {}, notify: message => notices.push(message),
    },
  };
  const pi = {
    sessionKind: 'interactive',
    on: (name, fn) => handlers.set(name, fn),
    registerCommand() {},
    async setSessionModel(model) { calls.push(model); if (model) ctx.model = model; return true; },
    setSessionThinkingLevel() {},
    appendEntry(type, data) { branch.push({ type: 'custom', customType: type, id: String(branch.length), data }); },
  };
  const orchestration = createOrchestrator(pi, { EditorBase: Editor });
  const fire = (name, event = {}) => handlers.get(name)(event, ctx);
  const start = reason => fire('session_start', { reason });
  const tab = async () => { editor.handleInput('\t'); await orchestration.settled(); };
  const submit = text => editor.onSubmit(text);
  const boulder = works => writeFileSync(join(root, '.omo', 'boulder.json'), JSON.stringify({ works }));
  const work = status => ({ session_ids: ['senpi:one'], status });
  const end = event => fire('agent_end', { type: 'agent_end', ...event });
  return { root, orchestration, start, tab, submit, boulder, work, end, notices, calls, submissions };
}

test('plan entry switches before submission and preserves origin from Atlas', async t => {
  const s = setup(t); await s.start('resume'); await s.tab();
  await s.submit('/ulw-execute p'); await s.submit('/skill:ulw-plan p');
  assert.equal(s.submissions.at(-1).role, 'prometheus');
  await s.tab(); assert.equal(s.orchestration.current, 'hephaestus');
  const busy = setup(t, { idle: false }); await busy.start('resume');
  await busy.submit('/skill:ulw-plan p');
  assert.equal(busy.orchestration.current, 'sisyphus');
  assert.equal(busy.submissions.length, 0);
});
test('execute entry switches to Atlas before submission', async t => {
  const s = setup(t); await s.start('resume'); await s.submit('/ulw-execute p');
  assert.equal(s.submissions.at(-1).role, 'atlas');
});
test('returns after observed work removal', async t => {
  const s = setup(t); await s.start('resume'); await s.submit('/ulw-execute p');
  s.boulder({ a: s.work('active') }); await s.end(); s.boulder({}); await s.end();
  assert.equal(s.orchestration.current, 'sisyphus');
});
test('returns after observed work completes', async t => {
  const s = setup(t); await s.start('resume'); await s.tab(); await s.submit('/ulw-execute p');
  s.boulder({ a: s.work('active') }); await s.end(); s.boulder({ a: s.work('completed') }); await s.end();
  assert.equal(s.orchestration.current, 'hephaestus');
});
for (const status of ['paused', 'blocked']) test(`stays on Atlas when ${status}`, async t => {
  const s = setup(t); await s.start('resume'); await s.submit('/ulw-execute p');
  s.boulder({ a: s.work('active') }); await s.end(); s.boulder({ a: s.work(status) }); await s.end();
  assert.equal(s.orchestration.current, 'atlas');
});
test('ignores retry and user cancellation', async t => {
  const s = setup(t); await s.start('resume'); await s.submit('/ulw-execute p');
  s.boulder({ a: s.work('active') }); await s.end(); s.boulder({});
  await s.end({ willRetry: true }); await s.end({ aborted: true, abortSource: 'user' });
  assert.equal(s.orchestration.current, 'atlas');
});
test('never-observed work, missing file, malformed data and active work do not return', async t => {
  const s = setup(t); await s.start('resume'); await s.submit('/ulw-execute p');
  await s.end(); s.boulder({ other: { session_ids: ['senpi:other'], status: 'active' } }); await s.end();
  s.boulder({}); await s.end();
  writeFileSync(join(s.root, '.omo', 'boulder.json'), '{'); await s.end();
  s.boulder({ a: s.work('active') }); await s.end(); await s.end();
  assert.equal(s.orchestration.current, 'atlas');
  rmSync(join(s.root, '.omo', 'boulder.json')); await s.end();
  assert.equal(s.orchestration.current, 'atlas');
});
test('Tab toggles two primary roles', async t => {
  const s = setup(t); await s.start('resume'); await s.tab();
  assert.equal(s.orchestration.current, 'hephaestus'); await s.tab();
  assert.equal(s.orchestration.current, 'sisyphus');
});
test('Tab returns from Prometheus and Atlas', async t => {
  const s = setup(t); await s.start('resume'); await s.tab();
  await s.submit('/skill:ulw-plan p'); await s.tab(); assert.equal(s.orchestration.current, 'hephaestus');
  await s.submit('/ulw-execute p'); await s.tab(); assert.equal(s.orchestration.current, 'hephaestus');
});
test('unavailable Hephaestus leaves Sisyphus and sends one notice without model calls', async t => {
  const s = setup(t, { gpt: false }); await s.start('resume'); await s.tab();
  assert.equal(s.orchestration.current, 'sisyphus'); assert.equal(s.calls.length, 0); assert.equal(s.notices.length, 1);
});
test('reload does not restore arming', async t => {
  const s = setup(t); await s.start('resume'); await s.submit('/ulw-execute p');
  s.boulder({ a: s.work('active') }); await s.end(); await s.start('reload');
  s.boulder({}); await s.end(); assert.equal(s.orchestration.current, 'atlas');
});
