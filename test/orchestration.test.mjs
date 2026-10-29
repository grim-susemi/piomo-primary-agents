import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultRoster, memoryPath, rosterPath, setAgentLane, setAgentPin,
} from '../contract/schema.mjs';
import {
  ADAPTER_MISSING_NOTICE, STREAMING_EXECUTE_NOTICE, createOrchestrator,
} from '../src/core/orchestration.mjs';
import {
  createGateMirror, isPlanRequest, isUlwExecute, isUlwExecuteSkillPath,
} from '../src/core/gate-mirror.mjs';
import extension from '../src/index.mjs';

const LANE_CONFIG = {
  '[native]': {
    model_profiles: {
      'daily-normal': { models: [{ providers: ['sub'], model: 'lane-daily', variant: 'medium' }] },
      'daily-heavy': { models: [{ providers: ['sub'], model: 'lane-daily-heavy', variant: 'high' }] },
      'geeky-normal': { models: [{ providers: ['gpt'], model: 'gpt-lane-geeky', variant: 'medium' }] },
      'geeky-heavy': { models: [{ providers: ['gpt'], model: 'gpt-lane-heavy', variant: 'high' }] },
    },
  },
};

const MODELS = [
  { provider: 'sub', id: 'lane-daily' },
  { provider: 'sub', id: 'lane-daily-heavy' },
  { provider: 'gpt', id: 'gpt-lane-geeky' },
  { provider: 'gpt', id: 'gpt-lane-heavy' },
];

function fakeRegistry(models = MODELS) {
  const list = models.map(model => ({ provider: model.provider, id: model.id }));
  return {
    find(provider, modelId) {
      return list.find(model => model.provider === provider && model.id === modelId);
    },
    getAvailable() { return list; },
    getAll() { return list; },
  };
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'piomo-orchestration-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const homeDir = join(root, '.omo');
  const agentDir = join(homeDir, 'agent');
  mkdirSync(join(agentDir, 'primary-agents', 'memory'), { recursive: true });
  writeFileSync(join(homeDir, 'omo.jsonc'), JSON.stringify(LANE_CONFIG), 'utf8');
  return { root, homeDir, agentDir };
}

class FakeBase {
  constructor(tui, theme, keybindings) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.text = '';
    this.borderColor = '#123456';
    this.inputs = [];
  }

  handleInput(data) { this.inputs.push(data); }

  isShowingAutocomplete() { return false; }

  getText() { return this.text; }

  getLines() { return this.text.split('\n'); }

  getCursor() { return { line: 0, col: 0 }; }

  setText(text) { this.text = text; }
}

function fakeUi(log) {
  const calls = {
    notify: [], status: [], title: [], widget: [], editorSet: 0, select: [], hostSubmit: [],
  };
  let factory = null;
  let editor = null;
  let selectResult = null;
  const keybindings = { matches: (data, action) => data === '\t' && action === 'tui.input.tab' };
  const ui = {
    getEditorComponent() { return factory; },
    setEditorComponent(next) {
      calls.editorSet += 1;
      factory = next;
      if (next) {
        editor = next({}, {}, keybindings);
        // The host assigns onSubmit after the factory returns (P7).
        editor.onSubmit = (text, details) => calls.hostSubmit.push({ text, details });
      }
    },
    setWidget(_key, content, options) { calls.widget.push({ key: _key, content, options }); },
    setStatus(key, text) { calls.status.push(text); log.push({ kind: 'label' }); },
    setTitle(title) { calls.title.push(title); },
    notify(message, type) { calls.notify.push({ message, type }); },
    async select(title, names) {
      calls.select.push({ title, names });
      return typeof selectResult === 'function' ? selectResult(names) : selectResult;
    },
  };
  return {
    ui,
    calls,
    get editor() { return editor; },
    setSelect(value) { selectResult = value; },
  };
}

function identity(agentId, id = 'identity') {
  return { type: 'custom', customType: 'primary-agent/v1', id, data: { schemaVersion: 1, agentId } };
}

function messageEntry(id = 'message-1') {
  return { type: 'message', id, role: 'user', content: [] };
}

function initialBranch() {
  return [
    { type: 'model_change', id: 'initial-model', provider: 'runtime', modelId: 'default-x' },
    {
      type: 'thinking_level_change',
      id: 'initial-thinking',
      thinkingLevel: 'off',
      thinkingSelection: { level: 'off', source: 'explicit' },
    },
  ];
}

function resumedBranch(agentId) {
  return [...initialBranch(), identity(agentId), messageEntry()];
}

function makeSession(t, options = {}) {
  const sandbox = makeSandbox(t);
  const log = [];
  const branch = options.branch ?? resumedBranch('sisyphus');
  const uiCtl = fakeUi(log);
  const registry = options.registry === undefined ? fakeRegistry() : options.registry;
  const ctx = {
    mode: options.mode ?? 'tui',
    hasUI: options.hasUI ?? true,
    cwd: sandbox.root,
    agentDir: sandbox.agentDir,
    model: { provider: 'runtime', id: 'default-x' },
    thinkingLevel: 'off',
    modelRegistry: registry,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => options.sessionId ?? 'session-1',
    },
    ui: uiCtl.ui,
    isIdle: () => (typeof options.isIdle === 'function' ? options.isIdle() : true),
    loadedExtensionPaths: typeof options.loadedExtensionPaths === 'function'
      ? options.loadedExtensionPaths(sandbox)
      : (options.loadedExtensionPaths ?? []),
  };
  const calls = [];
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    sessionKind: 'interactive',
    on(event, handler, handlerOptions) {
      handlers.set(event, { handler, options: handlerOptions });
      return () => {};
    },
    registerCommand(name, command) { commands.set(name, command); },
    async setSessionModel(model) {
      log.push({ kind: 'model' });
      calls.push({ kind: 'model', provider: model.provider, modelId: model.id });
      if (typeof options.beforeModel === 'function') await options.beforeModel(model);
      if (options.holdModel !== true) ctx.model = { provider: model.provider, id: model.id };
      return options.modelResult ?? true;
    },
    setSessionThinkingLevel(level) {
      log.push({ kind: 'thinking' });
      calls.push({ kind: 'thinking', level });
      ctx.thinkingLevel = level;
      // The host records an extension call as an explicit pick (no trigger).
      branch.push({
        type: 'thinking_level_change',
        id: `thinking-${branch.length}`,
        thinkingLevel: level,
        thinkingSelection: { level, source: 'explicit' },
      });
    },
    appendEntry(type, data) {
      log.push({ kind: 'entry' });
      calls.push({ kind: 'entry', type, data });
      branch.push({ type: 'custom', customType: type, id: `entry-${branch.length}`, data });
    },
    getAllTools() {
      return [{ name: 'edit', parameters: { properties: { path: { type: 'string' } } } }];
    },
    sendUserMessage() {
      throw new Error('pi.sendUserMessage must never be used');
    },
  };

  const orchestration = createOrchestrator(pi, { EditorBase: FakeBase });
  const fire = (event, payload) => {
    const entry = handlers.get(event);
    assert.ok(entry, `${event} handler registered`);
    return entry.handler(payload, ctx);
  };
  const start = (reason = 'resume') => fire('session_start', { type: 'session_start', reason });

  return {
    sandbox, branch, ctx, pi, calls, handlers, commands, orchestration, fire, start, ui: uiCtl, log,
  };
}

function entryAgents(session) {
  return session.calls
    .filter(call => call.kind === 'entry')
    .map(call => call.data.agentId);
}

test('factory registers every handler, command and the preview-safe overlay hook', () => {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(event, handler, options) { handlers.set(event, { handler, options }); return () => {}; },
    registerCommand(name, command) { commands.set(name, command); },
  };
  assert.equal(extension(pi), undefined);
  for (const event of ['session_start', 'input', 'model_select', 'before_agent_start', 'tool_call', 'tool_result', 'session_shutdown']) {
    assert.equal(typeof handlers.get(event)?.handler, 'function', `${event} registered at factory time`);
  }
  assert.equal(handlers.get('before_agent_start').options.previewSafe, true);
  assert.equal(typeof commands.get('agent')?.handler, 'function');
});

test('switch order is model -> thinking -> entry -> label and ctx owns no switch method', async t => {
  const session = makeSession(t);
  await session.start('resume');
  assert.equal(session.ctx.setSessionModel, undefined);
  assert.equal(session.ctx.appendEntry, undefined);
  session.log.length = 0;

  const result = await session.orchestration.switchTo('atlas');

  assert.equal(result.switched, true);
  assert.deepEqual(session.log.map(item => item.kind), ['model', 'thinking', 'entry', 'label']);
  assert.deepEqual(entryAgents(session), ['atlas']);
  assert.equal(session.orchestration.current, 'atlas');
});

test('submit wrap survives the host restoring a wrapper (no self-recursion)', async t => {
  const session = makeSession(t);
  await session.start('resume');
  const editor = session.ui.editor;
  assert.ok(editor, 'custom editor installed');

  const own = editor.onSubmit;
  editor.onSubmit = own;
  assert.equal(editor.onSubmit, own, 'restoring our wrapper must not grow a new one');

  // Replays the host composer observer: read the callback, install a temporary
  // wrapper, submit through the editor, then restore what was read.
  for (let index = 0; index < 5; index += 1) {
    const previous = editor.onSubmit;
    editor.onSubmit = (...args) => previous?.(...args);
    editor.onSubmit('hello there', { rawText: 'hello there' });
    editor.onSubmit = previous;
  }

  assert.equal(session.ui.calls.hostSubmit.length, 5);
  assert.deepEqual(session.ui.calls.hostSubmit.at(-1), {
    text: 'hello there', details: { rawText: 'hello there' },
  });
});

test('held switch keeps the model pending while identity and policy switch immediately', async t => {
  const session = makeSession(t, { holdModel: true });
  await session.start('resume');

  const result = await session.orchestration.switchTo('prometheus');

  assert.equal(result.pending, true);
  assert.equal(session.orchestration.snapshot().pending, true);
  assert.equal(session.orchestration.current, 'prometheus');
  assert.deepEqual(entryAgents(session), ['prometheus']);
  assert.equal(session.ctx.model.id, 'default-x');
  const widget = session.ui.calls.widget.at(-1);
  const label = widget.content().render(200)[0];
  assert.match(label, /\(대기\)/);

  const blocked = await session.fire('tool_call', {
    type: 'tool_call', toolName: 'edit', input: { path: join(session.sandbox.root, 'src', 'a.js') },
  });
  assert.equal(blocked.block, true, 'policy switches immediately even while the model is pending');

  session.branch.push({
    type: 'model_change', id: 'committed', provider: 'sub', modelId: 'lane-daily-heavy',
  });
  await session.fire('input', { type: 'input', text: '', source: 'interactive' });

  assert.equal(session.orchestration.snapshot().pending, false);
  const refreshed = session.ui.calls.widget.at(-1).content().render(200)[0];
  assert.doesNotMatch(refreshed, /\(대기\)/);
});

test('a failed Atlas model switch keeps its existing behaviour', async t => {
  const session = makeSession(t, { holdModel: true, modelResult: false });
  await session.start('resume');
  session.ui.calls.notify.length = 0;

  const result = await session.orchestration.switchTo('atlas');

  assert.equal(result.switched, true);
  assert.equal(result.pending, false);
  assert.equal(session.orchestration.snapshot().pending, false);
  assert.equal(session.orchestration.current, 'atlas');
  assert.deepEqual(entryAgents(session), ['atlas']);
  assert.equal(session.ui.calls.notify.length, 1);
  assert.match(session.ui.calls.notify[0].message, /모델을 바꾸지 못했어요/);
});

test('a refused Hephaestus model switch keeps the current agent and appends nothing', async t => {
  const session = makeSession(t, { holdModel: true, modelResult: false });
  await session.start('resume');
  session.ui.calls.notify.length = 0;

  const result = await session.orchestration.switchTo('hephaestus');

  assert.deepEqual(result, { switched: false, reason: 'model-switch-failed' });
  assert.equal(session.orchestration.current, 'sisyphus');
  assert.equal(session.orchestration.snapshot().agentId, 'sisyphus');
  assert.equal(session.orchestration.snapshot().pending, false);
  assert.deepEqual(entryAgents(session), [], 'a failed Hephaestus switch must not append an identity entry');
  assert.equal(session.ctx.model.id, 'default-x', 'the runtime model stays non-GPT');
  assert.equal(session.calls.filter(call => call.kind === 'thinking').length, 0);
  assert.equal(session.ui.calls.notify.length, 1, 'exactly one notice');
  assert.match(session.ui.calls.notify[0].message, /모델을 바꾸지 못했어요: gpt\/gpt-lane-geeky/);
  const prompt = await session.fire('before_agent_start', {
    type: 'before_agent_start', systemPrompt: 'BASE', preview: false,
  });
  assert.equal(prompt, undefined, 'no Hephaestus overlay is installed');
});

test('a throwing Hephaestus model switch keeps the current agent and appends nothing', async t => {
  const session = makeSession(t, {
    holdModel: true,
    beforeModel: () => { throw new Error('auth expired'); },
  });
  await session.start('resume');
  session.ui.calls.notify.length = 0;

  const result = await session.orchestration.switchTo('hephaestus');

  assert.deepEqual(result, { switched: false, reason: 'model-switch-failed' });
  assert.equal(session.orchestration.current, 'sisyphus');
  assert.equal(session.orchestration.snapshot().agentId, 'sisyphus');
  assert.equal(session.orchestration.snapshot().pending, false);
  assert.deepEqual(entryAgents(session), [], 'a failed Hephaestus switch must not append an identity entry');
  assert.equal(session.ctx.model.id, 'default-x', 'the runtime model stays non-GPT');
  assert.equal(session.calls.filter(call => call.kind === 'thinking').length, 0);
  assert.equal(session.ui.calls.notify.length, 1, 'exactly one notice');
  assert.match(session.ui.calls.notify[0].message, /모델을 바꾸지 못했어요: auth expired/);
  const prompt = await session.fire('before_agent_start', {
    type: 'before_agent_start', systemPrompt: 'BASE', preview: false,
  });
  assert.equal(prompt, undefined, 'no Hephaestus overlay is installed');
});

test('resume ignores memory written for an older roster revision', async t => {
  const session = makeSession(t, { branch: resumedBranch('sisyphus') });
  const roster = setAgentLane(defaultRoster(), 'sisyphus', 'daily-normal');
  writeFileSync(rosterPath(session.sandbox.agentDir), `${JSON.stringify(roster, null, 2)}\n`, 'utf8');
  writeFileSync(memoryPath(session.sandbox.agentDir, 'sisyphus'), `${JSON.stringify({
    v: 1,
    agentId: 'sisyphus',
    model: { provider: 'sub', modelId: 'stale-memory' },
    thinking: 'low',
    rosterRev: 0,
    updatedAt: '2026-10-20T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8');

  await session.start('resume');
  await session.orchestration.switchTo('atlas');
  await session.orchestration.switchTo('sisyphus');

  assert.equal(session.ctx.model.id, 'lane-daily');
});

test('memory learns command, picker and cycle only, never extension or rpc', async t => {
  const session = makeSession(t);
  await session.start('resume');

  session.branch.push(
    { type: 'model_change', id: 'm1', source: 'command', provider: 'sub', modelId: 'learn-command' },
    { type: 'model_change', id: 'm2', source: 'picker', provider: 'sub', modelId: 'learn-picker' },
    { type: 'model_change', id: 'm3', source: 'cycle', provider: 'sub', modelId: 'learn-cycle' },
    { type: 'model_change', id: 'm4', source: 'extension', provider: 'sub', modelId: 'learn-extension' },
    { type: 'model_change', id: 'm5', source: 'rpc', provider: 'sub', modelId: 'learn-rpc' },
  );
  await session.fire('input', { type: 'input', text: 'hello', source: 'interactive' });

  const file = memoryPath(session.sandbox.agentDir, 'sisyphus');
  assert.ok(existsSync(file));
  const memory = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(memory.model.modelId, 'learn-cycle');
  assert.equal(memory.rosterRev, 0);
  assert.equal(memory.v, 1);
});

test('model_select only stages: no memory file until a reconciliation event', async t => {
  const session = makeSession(t);
  await session.start('resume');
  await session.fire('model_select', { type: 'model_select', source: 'set' });

  const file = memoryPath(session.sandbox.agentDir, 'sisyphus');
  assert.equal(existsSync(file), false);

  session.branch.push({ type: 'model_change', id: 'm1', source: 'command', provider: 'sub', modelId: 'learned' });
  await session.fire('before_agent_start', { type: 'before_agent_start', systemPrompt: 'BASE', preview: false });
  assert.ok(existsSync(file));
});

test('extension switch entries are never learned as agent memory', async t => {
  // Each switch writes its own thinking entry with the host's "explicit"
  // selection; only the extension's own-entry bookkeeping keeps it out of memory.
  const session = makeSession(t, { branch: initialBranch() });
  await session.start('startup');
  assert.equal(existsSync(memoryPath(session.sandbox.agentDir, 'sisyphus')), false);

  await session.orchestration.switchTo('hephaestus');
  assert.equal(existsSync(memoryPath(session.sandbox.agentDir, 'sisyphus')), false,
    'the switch attributed its own thinking entry to Sisyphus');
  await session.orchestration.switchTo('prometheus');
  await session.orchestration.switchTo('atlas');
  await session.orchestration.switchTo('sisyphus');

  for (const agentId of ['sisyphus', 'hephaestus', 'prometheus', 'atlas']) {
    assert.equal(existsSync(memoryPath(session.sandbox.agentDir, agentId)), false,
      `${agentId} memory must not be created by a switch`);
  }
});

test('a non-GPT /model pick on Hephaestus never touches Sisyphus memory', async t => {
  const session = makeSession(t, { branch: initialBranch() });
  await session.start('startup');
  await session.orchestration.switchTo('hephaestus');
  assert.equal(existsSync(memoryPath(session.sandbox.agentDir, 'sisyphus')), false,
    'the Hephaestus switch created Sisyphus memory before any /model pick');

  session.branch.push({
    type: 'model_change', id: 'gpt-pick', source: 'command', provider: 'gpt', modelId: 'gpt-lane-geeky',
  });
  await session.fire('input', { type: 'input', text: '', source: 'interactive' });

  const hephaestusFile = memoryPath(session.sandbox.agentDir, 'hephaestus');
  assert.equal(JSON.parse(readFileSync(hephaestusFile, 'utf8')).model.modelId, 'gpt-lane-geeky');
  const before = readFileSync(hephaestusFile, 'utf8');

  session.branch.push({
    type: 'model_change', id: 'non-gpt-pick', source: 'command', provider: 'sub', modelId: 'lane-daily',
  });
  await session.fire('input', { type: 'input', text: '', source: 'interactive' });

  assert.equal(readFileSync(hephaestusFile, 'utf8'), before, 'Hephaestus memory changed on a non-GPT pick');
  assert.equal(existsSync(memoryPath(session.sandbox.agentDir, 'sisyphus')), false,
    'Sisyphus memory was created by a Hephaestus pick');
  assert.match(session.ui.calls.notify.at(-1).message, /GPT 모델만 기억해요/);

  await session.orchestration.switchTo('sisyphus');
  assert.equal(existsSync(memoryPath(session.sandbox.agentDir, 'sisyphus')), false);
});

test('resume restores the branch identity', async t => {
  const session = makeSession(t, { branch: resumedBranch('prometheus') });
  await session.start('resume');
  assert.equal(session.orchestration.current, 'prometheus');
});

test('new session starts on Sisyphus', async t => {
  const session = makeSession(t, { branch: initialBranch() });
  await session.start('new');
  assert.equal(session.orchestration.current, 'sisyphus');
});

test('child session registers handlers but does nothing', async t => {
  const session = makeSession(t, { mode: 'rpc', branch: resumedBranch('prometheus') });
  await session.start('startup');

  assert.equal(session.orchestration.active, false);
  assert.equal(session.calls.length, 0);
  assert.equal(session.ui.calls.editorSet, 0);
  assert.equal(await session.fire('before_agent_start', {
    type: 'before_agent_start', systemPrompt: 'UNCHANGED', preview: false,
  }), undefined);
  assert.equal(await session.fire('tool_call', {
    type: 'tool_call', toolName: 'edit', input: { path: 'C:/x/src/a.js' },
  }), undefined);
  await session.fire('input', { type: 'input', text: '/ulw-execute x', source: 'interactive' });
  await session.commands.get('agent').handler('', session.ctx);
  assert.equal(session.ui.calls.select.length, 0);
  assert.deepEqual(entryAgents(session), []);
  assert.equal(existsSync(memoryPath(session.sandbox.agentDir, 'sisyphus')), false);
});

const SISYPHUS_PIN = { provider: 'sub', modelId: 'lane-daily-heavy', thinking: 'low' };

function writeSisyphusPin(agentDir, pin) {
  const roster = setAgentPin(defaultRoster(), 'sisyphus', pin);
  writeFileSync(rosterPath(agentDir), `${JSON.stringify(roster, null, 2)}\n`, 'utf8');
}

function writeSisyphusMemory(agentDir) {
  writeFileSync(memoryPath(agentDir, 'sisyphus'), `${JSON.stringify({
    v: 1,
    agentId: 'sisyphus',
    model: { provider: 'sub', modelId: 'lane-daily' },
    thinking: 'medium',
    rosterRev: 0,
    updatedAt: '2026-10-20T00:00:00.000Z',
  }, null, 2)}\n`, 'utf8');
}

test('a fresh session without a Sisyphus pin keeps the host model and writes no start-up entry', async t => {
  const session = makeSession(t, { branch: initialBranch() });
  await session.start('startup');

  assert.equal(session.ctx.model.id, 'default-x');
  assert.equal(session.calls.filter(call => call.kind === 'model').length, 0);
  assert.equal(session.calls.filter(call => call.kind === 'thinking').length, 0);
  assert.equal(session.orchestration.current, 'sisyphus');
});

test('a fresh session starts on the Sisyphus pin and its thinking', async t => {
  const session = makeSession(t, { branch: initialBranch() });
  writeSisyphusPin(session.sandbox.agentDir, SISYPHUS_PIN);
  await session.start('startup');

  assert.equal(session.ctx.model.id, 'lane-daily-heavy');
  assert.equal(session.calls.filter(call => call.kind === 'model').length, 1);
  assert.deepEqual(session.calls.filter(call => call.kind === 'thinking').map(call => call.level), ['low']);
});

test('a fresh session with Sisyphus memory and no pin keeps the host model', async t => {
  const session = makeSession(t, { branch: initialBranch() });
  writeSisyphusMemory(session.sandbox.agentDir);
  await session.start('startup');

  assert.equal(session.ctx.model.id, 'default-x');
  assert.equal(session.calls.filter(call => call.kind === 'model').length, 0);
  assert.equal(session.calls.filter(call => call.kind === 'thinking').length, 0);
});

test('a fresh session with Sisyphus memory and a pin starts on the pin', async t => {
  const session = makeSession(t, { branch: initialBranch() });
  writeSisyphusMemory(session.sandbox.agentDir);
  writeSisyphusPin(session.sandbox.agentDir, SISYPHUS_PIN);
  await session.start('startup');

  assert.equal(session.ctx.model.id, 'lane-daily-heavy');
  assert.deepEqual(session.calls.filter(call => call.kind === 'thinking').map(call => call.level), ['low']);
});

test('a fresh session with a pin the registry cannot serve makes no call and does not throw', async t => {
  const session = makeSession(t, { branch: initialBranch() });
  writeSisyphusPin(session.sandbox.agentDir, { provider: 'sub', modelId: 'missing-model', thinking: 'low' });
  await session.start('startup');

  assert.equal(session.ctx.model.id, 'default-x');
  assert.equal(session.calls.filter(call => call.kind === 'model').length, 0);
  assert.equal(session.calls.filter(call => call.kind === 'thinking').length, 0);
});

test('a fresh session with no model registry makes no call', async t => {
  const session = makeSession(t, { branch: initialBranch(), registry: null });
  writeSisyphusPin(session.sandbox.agentDir, SISYPHUS_PIN);
  await session.start('startup');

  assert.equal(session.ctx.model.id, 'default-x');
  assert.equal(session.calls.filter(call => call.kind === 'model').length, 0);
});

test('resume, reload and fork with a Sisyphus pin keep the host model', async t => {
  for (const reason of ['resume', 'reload', 'fork']) {
    const session = makeSession(t, { branch: initialBranch() });
    writeSisyphusPin(session.sandbox.agentDir, SISYPHUS_PIN);
    await session.start(reason);

    assert.equal(session.ctx.model.id, 'default-x', `${reason} keeps its model`);
    assert.equal(session.calls.filter(call => call.kind === 'model').length, 0, `${reason} makes no model call`);
  }
});

test('a pinned fresh session never learns its start-up entries as agent memory', async t => {
  const session = makeSession(t, { branch: initialBranch() });
  writeSisyphusPin(session.sandbox.agentDir, SISYPHUS_PIN);
  await session.start('startup');
  assert.equal(session.ctx.model.id, 'lane-daily-heavy');

  await session.fire('input', { type: 'input', text: '', source: 'interactive' });
  assert.equal(existsSync(memoryPath(session.sandbox.agentDir, 'sisyphus')), false,
    'the start-up thinking entry was learned as Sisyphus memory');

  await session.orchestration.switchTo('hephaestus');
  await session.orchestration.switchTo('sisyphus');
  for (const agentId of ['sisyphus', 'hephaestus']) {
    assert.equal(existsSync(memoryPath(session.sandbox.agentDir, agentId)), false,
      `${agentId} memory must not be created by a switch`);
  }
});

test('the identity entry payload has exactly the schemaVersion and agentId keys', async t => {
  const session = makeSession(t);
  await session.start('resume');
  await session.orchestration.switchTo('prometheus');

  const identityEntry = session.branch.filter(entry => entry.type === 'custom' && entry.customType === 'primary-agent/v1').at(-1);
  assert.deepEqual(Object.keys(identityEntry.data).sort(), ['agentId', 'schemaVersion']);
  assert.deepEqual(identityEntry.data, { schemaVersion: 1, agentId: 'prometheus' });
});

test('a branch with a message entry keeps its model', async t => {
  const session = makeSession(t, { branch: [...initialBranch(), messageEntry()] });
  await session.start('startup');

  assert.equal(session.calls.filter(call => call.kind === 'model').length, 0);
  assert.equal(session.ctx.model.id, 'default-x');
  assert.equal(session.orchestration.current, 'sisyphus');
});

test('resume, reload and fork never call setSessionModel', async t => {
  for (const reason of ['resume', 'reload', 'fork']) {
    const session = makeSession(t, { branch: [...resumedBranch('atlas')] });
    await session.start(reason);
    assert.equal(session.calls.filter(call => call.kind === 'model').length, 0, `${reason} keeps its model`);
    assert.equal(session.orchestration.current, 'atlas');
  }
});

test('a roster change between two switches is picked up', async t => {
  const session = makeSession(t);
  await session.start('resume');

  await session.orchestration.switchTo('atlas');
  assert.equal(session.ctx.model.id, 'lane-daily');

  const roster = setAgentLane(defaultRoster(), 'atlas', 'geeky-heavy');
  writeFileSync(rosterPath(session.sandbox.agentDir), `${JSON.stringify(roster, null, 2)}\n`, 'utf8');

  await session.orchestration.switchTo('prometheus');
  await session.orchestration.switchTo('atlas');
  assert.equal(session.ctx.model.id, 'gpt-lane-heavy');
});

test('Tab skips every unavailable agent with one notice', async t => {
  const session = makeSession(t, { registry: fakeRegistry(MODELS.filter(model => model.provider === 'sub')) });
  await session.start('resume');
  session.ui.calls.notify.length = 0;

  session.ui.editor.handleInput('\t');
  await session.orchestration.settled();

  assert.equal(session.orchestration.current, 'prometheus');
  assert.deepEqual(entryAgents(session), ['prometheus']);
  assert.equal(session.ui.calls.notify.length, 1);
  assert.match(session.ui.calls.notify[0].message, /Hephaestus/);
  assert.match(session.ui.calls.notify[0].message, /Prometheus로 전환했어요/);
});

test('Prometheus rewrite follows the mirror, not the text alone', async t => {
  const session = makeSession(t, { branch: resumedBranch('prometheus') });
  await session.start('resume');

  await session.fire('input', { type: 'input', text: '/skill:ulw-execute go', source: 'interactive' });
  await session.ui.editor.onSubmit('plan this');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan plan this');

  await session.ui.editor.onSubmit('plan again');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, 'plan again');
  assert.equal(session.ui.calls.hostSubmit.length, 2);
});

test('Prometheus rewrite triggers on /ulw-execute, a read of the skill and typed plan older than exec', async t => {
  const typed = makeSession(t, { branch: resumedBranch('prometheus') });
  await typed.start('resume');
  await typed.fire('input', { type: 'input', text: '/ulw-execute go', source: 'interactive' });
  await typed.ui.editor.onSubmit('typed exec');
  assert.equal(typed.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan typed exec');

  const read = makeSession(t, { branch: resumedBranch('prometheus') });
  await read.start('resume');
  await read.fire('tool_result', {
    type: 'tool_result',
    toolName: 'read',
    input: { path: 'C:/pkg/skills/ulw-execute/SKILL.md' },
    isError: false,
  });
  await read.ui.editor.onSubmit('read exec');
  assert.equal(read.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan read exec');

  const planThenExec = makeSession(t, { branch: resumedBranch('prometheus') });
  await planThenExec.start('resume');
  await planThenExec.fire('input', { type: 'input', text: '/skill:ulw-plan first', source: 'interactive' });
  await planThenExec.fire('input', { type: 'input', text: '/skill:ulw-execute go', source: 'interactive' });
  await planThenExec.ui.editor.onSubmit('after exec');
  assert.equal(planThenExec.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan after exec');
});

test('extension-originated ulw-execute never enables the rewrite', async t => {
  const session = makeSession(t, { branch: resumedBranch('prometheus') });
  await session.start('resume');
  // Consume the first-message rewrite so only the execute can enable it now.
  await session.fire('input', { type: 'input', text: '/skill:ulw-plan first', source: 'interactive' });
  await session.fire('input', { type: 'input', text: '/ulw-execute go', source: 'extension' });
  await session.ui.editor.onSubmit('plain request');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, 'plain request');
});

test('the first Prometheus plain request is rewritten once, then left alone', async t => {
  const session = makeSession(t, { branch: resumedBranch('prometheus') });
  await session.start('resume');
  await session.ui.editor.onSubmit('plain request');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan plain request');
  await session.ui.editor.onSubmit('second message');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, 'second message');
});

test('an empty Prometheus submission reaches the host unchanged and keeps the rewrite pending', async t => {
  const session = makeSession(t, { branch: resumedBranch('prometheus') });
  await session.start('resume');

  await session.ui.editor.onSubmit('');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '');
  assert.equal(session.ui.calls.hostSubmit.length, 1);

  await session.ui.editor.onSubmit('first real request');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan first real request');
});

test('a bang Prometheus submission reaches the host unchanged and keeps the rewrite pending', async t => {
  const session = makeSession(t, { branch: resumedBranch('prometheus') });
  await session.start('resume');

  await session.ui.editor.onSubmit('!git status');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '!git status');
  assert.equal(session.ui.calls.hostSubmit.length, 1);

  await session.ui.editor.onSubmit('first real request');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan first real request');
});

test('the first Prometheus request is rewritten after an /agent switch', async t => {
  const session = makeSession(t, { branch: resumedBranch('sisyphus') });
  await session.start('resume');
  await session.commands.get('agent').handler('prometheus', session.ctx);
  await session.ui.editor.onSubmit('계획 잡아줘 데모');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan 계획 잡아줘 데모');
});

test('adapter-missing notice appears only after ulw-execute and only without the marker', async t => {
  const bare = makeSession(t, {
    branch: resumedBranch('atlas'),
    loadedExtensionPaths: sandbox => {
      const file = join(sandbox.root, 'tools', 'omo-task.js');
      mkdirSync(join(sandbox.root, 'tools'), { recursive: true });
      writeFileSync(file, 'export default function () {}\n', 'utf8');
      return [file];
    },
  });
  await bare.start('resume');
  assert.equal(bare.ui.calls.notify.length, 0, 'no notice before an execute');
  await bare.fire('input', { type: 'input', text: '/ulw-execute go', source: 'interactive' });
  const notices = bare.ui.calls.notify.filter(item => item.message === ADAPTER_MISSING_NOTICE);
  assert.equal(notices.length, 1);
  await bare.fire('input', { type: 'input', text: '/ulw-execute again', source: 'interactive' });
  assert.equal(bare.ui.calls.notify.filter(item => item.message === ADAPTER_MISSING_NOTICE).length, 1);

  const marked = makeSession(t, {
    branch: resumedBranch('atlas'),
    loadedExtensionPaths: sandbox => {
      const file = join(sandbox.root, 'tools', 'omo-task.js');
      mkdirSync(join(sandbox.root, 'tools'), { recursive: true });
      writeFileSync(file, '/*piomo-primary-agents:gate-adapter:v1:begin*/x/*piomo-primary-agents:gate-adapter:v1:end*/\n', 'utf8');
      return [file];
    },
  });
  await marked.start('resume');
  await marked.fire('input', { type: 'input', text: '/ulw-execute go', source: 'interactive' });
  assert.equal(marked.ui.calls.notify.filter(item => item.message === ADAPTER_MISSING_NOTICE).length, 0);
});

test('recorded unlocked policies do not warn after repeated execution', async t => {
  const session = makeSession(t, {
    branch: resumedBranch('atlas'),
    loadedExtensionPaths: sandbox => {
      const file = join(sandbox.root, 'tools', 'omo-task.js');
      mkdirSync(join(sandbox.root, 'tools'), { recursive: true });
      const policies = ['plan-consultant', 'plan-reviewer'].map(name =>
        `"${name}":{requiresSkills:["ulw-plan"],requiresPlanArtifact:!0,forbidsSkills:[]}`);
      writeFileSync(file, policies.join(','), 'utf8');
      return [file];
    },
  });
  await session.start('resume');
  await session.fire('input', { type: 'input', text: '/ulw-execute first', source: 'interactive' });
  await session.fire('input', { type: 'input', text: '/ulw-execute second', source: 'interactive' });
  assert.equal(session.ui.calls.notify.filter(item => item.message === ADAPTER_MISSING_NOTICE).length, 0);
});

test('/agent: no argument opens the picker, a name switches, an unknown name lists names', async t => {
  const session = makeSession(t, { registry: fakeRegistry(MODELS.filter(model => model.provider === 'sub')) });
  await session.start('resume');
  const command = session.commands.get('agent');

  session.ui.setSelect(() => 'Atlas');
  await command.handler('', session.ctx);
  assert.equal(session.orchestration.current, 'atlas');
  assert.deepEqual(session.ui.calls.select.at(-1).names, ['Sisyphus', 'Prometheus', 'Atlas']);

  await command.handler('SISYPHUS', session.ctx);
  assert.equal(session.orchestration.current, 'sisyphus');

  const entriesBefore = entryAgents(session).length;
  await command.handler('nobody', session.ctx);
  assert.match(session.ui.calls.notify.at(-1).message, /알 수 없는 에이전트/);
  assert.match(session.ui.calls.notify.at(-1).message, /Sisyphus, Hephaestus, Prometheus, Atlas/);
  assert.equal(entryAgents(session).length, entriesBefore);
  assert.equal(session.orchestration.current, 'sisyphus');
});

test('/agent stays put when the target is unavailable', async t => {
  const session = makeSession(t, { registry: fakeRegistry(MODELS.filter(model => model.provider === 'sub')) });
  await session.start('resume');
  const entriesBefore = entryAgents(session).length;

  await session.commands.get('agent').handler('Hephaestus', session.ctx);

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.equal(entryAgents(session).length, entriesBefore);
  assert.match(session.ui.calls.notify.at(-1).message, /Hephaestus는 지금 사용할 수 없어요/);
});

test('idle /ulw-execute switches to Atlas and forwards the original text once', async t => {
  const session = makeSession(t);
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute do it');

  assert.equal(session.orchestration.current, 'atlas');
  assert.deepEqual(entryAgents(session), ['atlas']);
  assert.equal(session.ui.calls.hostSubmit.length, 1);
  assert.equal(session.ui.calls.hostSubmit[0].text, '/ulw-execute do it');
});

test('streaming /ulw-execute keeps the text and does not submit', async t => {
  const session = makeSession(t, { isIdle: () => false });
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute later');

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.deepEqual(entryAgents(session), []);
  assert.equal(session.ui.calls.hostSubmit.length, 0);
  assert.equal(session.ui.editor.getText(), '/ulw-execute later');
  assert.equal(session.ui.calls.notify.at(-1).message, STREAMING_EXECUTE_NOTICE);
});

test('tool policy blocks Prometheus code edits with Korean then English', async t => {
  const session = makeSession(t, { branch: resumedBranch('prometheus') });
  await session.start('resume');

  const blocked = await session.fire('tool_call', {
    type: 'tool_call', toolName: 'edit', input: { path: join(session.sandbox.root, 'src', 'a.js') },
  });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /^프로메테우스는/);
  assert.match(blocked.reason, /\/ Prometheus may only edit \.omo plan files\./);

  const allowed = await session.fire('tool_call', {
    type: 'tool_call', toolName: 'edit', input: { path: join(session.sandbox.root, '.omo', 'plans', 'a.md') },
  });
  assert.equal(allowed, undefined);
});

test('before_agent_start appends the overlay and previews stay pure', async t => {
  const session = makeSession(t, { branch: resumedBranch('prometheus') });
  await session.start('resume');

  const result = await session.fire('before_agent_start', {
    type: 'before_agent_start', systemPrompt: 'BASE', preview: false,
  });
  assert.match(result.systemPrompt, /^BASE/);
  assert.match(result.systemPrompt, /piomo-primary-agent:begin id=prometheus/);

  const before = existsSync(memoryPath(session.sandbox.agentDir, 'prometheus'));
  const preview = await session.fire('before_agent_start', {
    type: 'before_agent_start', systemPrompt: 'BASE', preview: true,
  });
  assert.equal(preview.systemPrompt, result.systemPrompt);
  assert.equal(existsSync(memoryPath(session.sandbox.agentDir, 'prometheus')), before);
});

test('Sisyphus before_agent_start leaves the host prompt untouched', async t => {
  const session = makeSession(t, { branch: resumedBranch('sisyphus') });
  await session.start('resume');

  const result = await session.fire('before_agent_start', {
    type: 'before_agent_start', systemPrompt: 'BASE', preview: false,
  });
  assert.equal(result, undefined, 'returning the base would drop the host MCP post-processing');

  const preview = await session.fire('before_agent_start', {
    type: 'before_agent_start', systemPrompt: 'BASE', preview: true,
  });
  assert.equal(preview, undefined);
});

test('rapid switches serialize through one chain', async t => {
  const session = makeSession(t, {
    beforeModel: () => new Promise(resolve => setImmediate(resolve)),
  });
  await session.start('resume');
  session.calls.length = 0;

  const first = session.orchestration.switchTo('atlas');
  const second = session.orchestration.switchTo('prometheus');
  await Promise.all([first, second]);

  assert.deepEqual(entryAgents(session), ['atlas', 'prometheus']);
  assert.equal(session.orchestration.current, 'prometheus');
});

test('gate mirror records only interactive plan/execute and forgets on shutdown', () => {
  assert.equal(isPlanRequest('/skill:ulw-plan x'), true);
  assert.equal(isPlanRequest('/skill:ulw-plan'), true);
  assert.equal(isPlanRequest('/skill:ulw-planning'), false);
  assert.equal(isUlwExecute('/skill:ulw-execute x'), true);
  assert.equal(isUlwExecute('/ulw-execute'), true);
  assert.equal(isUlwExecute('/ulw-execut'), false);
  assert.equal(isUlwExecuteSkillPath('C:\\pkg\\skills\\ulw-execute\\SKILL.md'), true);
  assert.equal(isUlwExecuteSkillPath('C:/pkg/skills/ulw-execute/SKILL.md.bak'), false);

  const mirror = createGateMirror();
  assert.equal(mirror.needsPlanRewrite('s'), true);
  mirror.observeInput('s', '/skill:ulw-execute x', 'extension');
  assert.equal(mirror.needsPlanRewrite('s'), true);
  mirror.observeInput('s', '/skill:ulw-execute x', 'interactive');
  assert.equal(mirror.needsPlanRewrite('s'), true);
  mirror.observeInput('s', '/skill:ulw-plan p', 'interactive');
  assert.equal(mirror.needsPlanRewrite('s'), false);
  mirror.forget('s');
  assert.deepEqual(mirror.snapshot('s'), { plan: 0, execute: 0 });
});
