import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADAPTER_MISSING_NOTICE,
  EXECUTE_PICKER_TITLE,
  PLAN_BOOTSTRAP_TEXT,
  STREAMING_EXECUTE_NOTICE,
  SUBMIT_LOCKED_NOTICE,
  createOrchestrator,
} from '../src/core/orchestration.mjs';
import {
  createGateMirror, isUlwExecute, isUlwExecuteSkillPath,
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

function planBody(slug, fields = '') {
  return `# ${slug}\n\n## TL;DR (For humans)\n목표 한 줄.\n${fields}\n\n## Todos\n- [ ] 1. 일\n`;
}

function writePlan(sandbox, slug, fields = '') {
  mkdirSync(join(sandbox.root, '.omo', 'plans'), { recursive: true });
  const body = planBody(slug, fields);
  writeFileSync(join(sandbox.root, '.omo', 'plans', `${slug}.md`), body, 'utf8');
  return body;
}

function planPath(sandbox, slug) {
  return join(sandbox.root, '.omo', 'plans', `${slug}.md`);
}

async function readPlan(session, path, body, toolCallId = 'read-1', input = { path }) {
  await session.fire('tool_call', {
    type: 'tool_call', toolName: 'read', toolCallId, input,
  });
  return session.fire('tool_result', {
    type: 'tool_result',
    toolName: 'read',
    toolCallId,
    input,
    content: [{ type: 'text', text: body }],
    isError: false,
    details: undefined,
  });
}

function taskCall(session, toolCallId = 'task-1', toolName = 'task') {
  return session.fire('tool_call', {
    type: 'tool_call', toolName, toolCallId, input: { category: 'deep-low' },
  });
}

test('factory registers handlers and the agent command without an agent_end hook', () => {
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
  assert.equal(handlers.has('agent_end'), false);
  assert.equal(handlers.get('before_agent_start').options.previewSafe, true);
  assert.equal(typeof commands.get('agent')?.handler, 'function');
});

test('switch order is model -> thinking -> entry -> label and ctx owns no switch method', async t => {
  const session = makeSession(t);
  await session.start('resume');
  assert.equal(session.ctx.setSessionModel, undefined);
  assert.equal(session.ctx.appendEntry, undefined);
  session.log.length = 0;

  const result = await session.orchestration.switchTo('prometheus');

  assert.equal(result.switched, true);
  assert.deepEqual(session.log.map(item => item.kind), ['model', 'thinking', 'entry', 'label']);
  assert.deepEqual(entryAgents(session), ['prometheus']);
  assert.equal(session.orchestration.current, 'prometheus');
});

test('the submit wrapper survives the host restoring it', async t => {
  const session = makeSession(t);
  await session.start('resume');
  const editor = session.ui.editor;
  assert.ok(editor, 'custom editor installed');

  const own = editor.onSubmit;
  editor.onSubmit = own;
  assert.equal(editor.onSubmit, own, 'restoring our wrapper must not grow a new one');

  await editor.onSubmit('hello');
  assert.equal(session.ui.calls.hostSubmit.length, 1);
  assert.equal(session.ui.calls.hostSubmit[0].text, 'hello');
});

test('a worker or rpc session stays inert', async t => {
  const session = makeSession(t, { mode: 'rpc' });
  await session.start('resume');
  const result = await session.orchestration.switchTo('hephaestus');
  assert.equal(result.reason, 'inactive');
  assert.deepEqual(entryAgents(session), []);
});

test('a resumed legacy Atlas identity moves to Sisyphus and keeps its history', async t => {
  const session = makeSession(t, { branch: resumedBranch('atlas') });
  await session.start('resume');

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.deepEqual(entryAgents(session), ['sisyphus']);
  assert.ok(session.branch.some(entry => entry.data?.agentId === 'atlas'), 'old identity entry is preserved');
});

test('/agent: the picker lists three selectable agents, Atlas is refused, unknown names list them', async t => {
  const session = makeSession(t);
  await session.start('resume');
  const command = session.commands.get('agent');

  session.ui.setSelect(() => 'Prometheus');
  await command.handler('', session.ctx);
  assert.equal(session.orchestration.current, 'prometheus');
  assert.deepEqual(session.ui.calls.select.at(-1).names, ['Sisyphus', 'Hephaestus', 'Prometheus']);

  await command.handler('atlas', session.ctx);
  assert.equal(session.orchestration.current, 'prometheus');
  assert.match(session.ui.calls.notify.at(-1).message, /Atlas는 퇴역/);
  const direct = await session.orchestration.switchTo('atlas');
  assert.equal(direct.reason, 'retired');

  const entriesBefore = entryAgents(session).length;
  await command.handler('nobody', session.ctx);
  assert.match(session.ui.calls.notify.at(-1).message, /알 수 없는 에이전트/);
  assert.match(session.ui.calls.notify.at(-1).message, /Sisyphus, Hephaestus, Prometheus/);
  assert.equal(entryAgents(session).length, entriesBefore);
});

test('an /ulw-execute with no selectable plan asks Native for a plan and does not switch or execute', async t => {
  const session = makeSession(t);
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute');

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.deepEqual(entryAgents(session), []);
  assert.equal(session.ui.calls.hostSubmit.length, 1);
  assert.equal(session.ui.calls.hostSubmit[0].text, PLAN_BOOTSTRAP_TEXT);
});

test('an explicit plan switches to its declared lead and forwards the slug once', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 저장 복구 검증');
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  assert.equal(session.orchestration.current, 'hephaestus');
  assert.deepEqual(entryAgents(session), ['hephaestus']);
  assert.equal(session.ui.calls.hostSubmit.length, 1);
  assert.equal(session.ui.calls.hostSubmit[0].text, '/ulw-execute lead-hephaestus');
  assert.equal(session.ui.editor.getText(), '');
});

test('options and the original command form are preserved in the forwarded command', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');

  await session.ui.editor.onSubmit('/skill:ulw-execute --light lead-hephaestus --make-pr');

  assert.equal(session.ui.calls.hostSubmit.length, 1);
  assert.equal(session.ui.calls.hostSubmit[0].text, '/skill:ulw-execute --light lead-hephaestus --make-pr');
});

test('an explicit name that does not exist never falls through to another plan', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute missing-plan');

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.equal(session.ui.calls.hostSubmit.length, 0);
  assert.match(session.ui.calls.notify.at(-1).message, /찾지 못했어요/);
  assert.equal(session.ui.editor.getText(), '/ulw-execute missing-plan');
});

test('multiple plans ask one selection question; cancel submits nothing', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-sisyphus', 'Execution lead: sisyphus\nExecution rationale: 이유');
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');

  session.ui.setSelect(() => 'lead-hephaestus');
  await session.ui.editor.onSubmit('/ulw-execute');
  assert.equal(session.ui.calls.select.at(-1).title, EXECUTE_PICKER_TITLE);
  assert.deepEqual(session.ui.calls.select.at(-1).names, ['lead-hephaestus', 'lead-sisyphus']);
  assert.equal(session.orchestration.current, 'hephaestus');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/ulw-execute lead-hephaestus');

  const before = session.ui.calls.hostSubmit.length;
  session.ui.setSelect(() => undefined);
  await session.ui.editor.onSubmit('/ulw-execute');
  assert.equal(session.ui.calls.hostSubmit.length, before);
  assert.match(session.ui.calls.notify.at(-1).message, /취소/);
});

test('an active Boulder plan for this session is selected without a question', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-sisyphus', 'Execution lead: sisyphus\nExecution rationale: 이유');
  mkdirSync(join(session.sandbox.root, '.omo'), { recursive: true });
  writeFileSync(join(session.sandbox.root, '.omo', 'boulder.json'), JSON.stringify({
    works: {
      'lead-sisyphus': {
        session_ids: ['senpi:session-1'],
        status: 'active',
        plan_name: 'lead-sisyphus',
      },
    },
  }), 'utf8');
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute');

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.equal(session.ui.calls.select.length, 0);
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/ulw-execute lead-sisyphus');
});

test('an invalid execution-lead declaration blocks the handoff', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-broken', 'Execution lead: hephaestus');
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute lead-broken');

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.equal(session.ui.calls.hostSubmit.length, 0);
  assert.match(session.ui.calls.notify.at(-1).message, /무효/);
});

test('a role whose model is unavailable blocks the handoff', async t => {
  const session = makeSession(t, { registry: fakeRegistry(MODELS.filter(model => model.provider === 'sub')) });
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.equal(session.ui.calls.hostSubmit.length, 0);
  assert.match(session.ui.calls.notify.at(-1).message, /사용할 수 없어/);
});

test('streaming keeps the execute text and does not submit', async t => {
  const session = makeSession(t, { isIdle: () => false });
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute later');

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.equal(session.ui.calls.hostSubmit.length, 0);
  assert.equal(session.ui.editor.getText(), '/ulw-execute later');
  assert.equal(session.ui.calls.notify.at(-1).message, STREAMING_EXECUTE_NOTICE);
});

test('a concurrent execute submission is consumed while the first one is in flight', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const session = makeSession(t, { beforeModel: () => gate });
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');

  const first = session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');
  await Promise.resolve();
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');
  assert.equal(session.ui.calls.hostSubmit.length, 0, 'second submission must not reach the host');
  assert.equal(session.ui.calls.notify.at(-1).message, SUBMIT_LOCKED_NOTICE);

  release();
  await first;
  assert.equal(session.ui.calls.hostSubmit.length, 1);
});

test('a plan changed between the router read and the handoff is not executed', async t => {
  const session = makeSession(t, {
    beforeModel: () => {
      writeFileSync(planPath(session.sandbox, 'lead-hephaestus'),
        `${planBody('lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유')}\nchanged\n`, 'utf8');
    },
  });
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  assert.equal(session.ui.calls.hostSubmit.length, 0);
  assert.match(session.ui.calls.notify.at(-1).message, /바뀌어/);
});

test('the first delegation is blocked until the selected plan is read in full', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  const blocked = await taskCall(session);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /읽어야/);

  // A failure is final for this request: reading now cannot revive it.
  await readPlan(session, planPath(session.sandbox, 'lead-hephaestus'), body);
  const stillBlocked = await taskCall(session, 'task-2');
  assert.equal(stillBlocked.block, true);
});

test('a matching full read allows the first task and workflow delegation', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  await readPlan(session, planPath(session.sandbox, 'lead-hephaestus'), body);
  assert.equal(await taskCall(session, 'task-1'), undefined);
  assert.equal(await taskCall(session, 'task-2', 'workflow'), undefined);
});

test('the handoff record is discarded after the first delegation succeeds', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  const path = planPath(session.sandbox, 'lead-hephaestus');
  writePlan(session.sandbox, 'other-plan', '');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  await readPlan(session, path, body);
  assert.equal(await taskCall(session, 'task-1'), undefined);
  await session.fire('tool_result', {
    type: 'tool_result', toolName: 'task', toolCallId: 'task-1', input: {}, content: [], isError: false,
  });

  await readPlan(session, planPath(session.sandbox, 'other-plan'), 'anything', 'read-other');
  assert.equal(await taskCall(session, 'task-2'), undefined);
});

test('a failed delegation keeps the check active for the retry', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  const path = planPath(session.sandbox, 'lead-hephaestus');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  await readPlan(session, path, body);
  assert.equal(await taskCall(session, 'task-1'), undefined);
  await session.fire('tool_result', {
    type: 'tool_result', toolName: 'task', toolCallId: 'task-1', input: {}, content: [], isError: true,
  });

  writeFileSync(path, `${body}\nchanged\n`, 'utf8');
  const blocked = await taskCall(session, 'task-2');
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /바뀌었어요/);
});

test('a truncated read does not cover the lines it did not return', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  const path = planPath(session.sandbox, 'lead-hephaestus');
  const lines = body.split('\n');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  await session.fire('tool_call', {
    type: 'tool_call', toolName: 'read', toolCallId: 'read-1', input: { path, offset: 1, limit: lines.length },
  });
  await session.fire('tool_result', {
    type: 'tool_result',
    toolName: 'read',
    toolCallId: 'read-1',
    input: { path },
    content: [{ type: 'text', text: lines.slice(0, 2).join('\n') }],
    isError: false,
    details: { truncation: { truncated: true, truncatedBy: 'lines', outputLines: 2, totalLines: lines.length, content: '', totalBytes: 0 } },
  });

  const blocked = await taskCall(session);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /읽어야/);
});

test('a second delegation after admission re-checks the plan bytes', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  const path = planPath(session.sandbox, 'lead-hephaestus');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');
  await readPlan(session, path, body);

  assert.equal(await taskCall(session, 'task-1'), undefined);
  writeFileSync(path, `${body}\nchanged\n`, 'utf8');
  const blocked = await taskCall(session, 'task-2');
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /바뀌었어요/);
});

test('a relative plan read is resolved against the session cwd', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  await readPlan(session, '.omo/plans/lead-hephaestus.md', body);
  assert.equal(await taskCall(session), undefined);
});

test('an option value before the plan name is not parsed as the plan name', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute --worktree C:/tmp/wt lead-hephaestus --light');

  assert.equal(session.orchestration.current, 'hephaestus');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/ulw-execute --worktree C:/tmp/wt lead-hephaestus --light');
});

test('a unique partial plan stem is accepted and an ambiguous one is refused', async t => {
  const partial = makeSession(t);
  writePlan(partial.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  writePlan(partial.sandbox, 'lead-sisyphus', 'Execution lead: sisyphus\nExecution rationale: 이유');
  await partial.start('resume');
  await partial.ui.editor.onSubmit('/ulw-execute lead-heph');
  assert.equal(partial.orchestration.current, 'hephaestus');
  assert.equal(partial.ui.calls.hostSubmit.at(-1).text, '/ulw-execute lead-hephaestus');

  const ambiguous = makeSession(t);
  writePlan(ambiguous.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  writePlan(ambiguous.sandbox, 'lead-sisyphus', 'Execution lead: sisyphus\nExecution rationale: 이유');
  await ambiguous.start('resume');
  await ambiguous.ui.editor.onSubmit('/ulw-execute lead-');
  assert.equal(ambiguous.ui.calls.hostSubmit.length, 0);
  assert.match(ambiguous.ui.calls.notify.at(-1).message, /여러 계획/);
});

test('a late failure cannot revive an invalidated handoff', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  const path = planPath(session.sandbox, 'lead-hephaestus');
  writePlan(session.sandbox, 'other-plan', '');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');
  await readPlan(session, path, body);
  assert.equal(await taskCall(session, 'task-1'), undefined);

  await readPlan(session, planPath(session.sandbox, 'other-plan'), 'anything', 'read-other');
  await session.fire('tool_result', {
    type: 'tool_result', toolName: 'task', toolCallId: 'task-1', input: {}, content: [], isError: true,
  });
  const blocked = await taskCall(session, 'task-2');
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /다른 계획/);
});

test('a new explicit execution replaces a failed handoff record', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');
  const blocked = await taskCall(session);
  assert.equal(blocked.block, true);

  await session.ui.editor.onSubmit('/ulw-execute missing-plan');
  assert.equal(session.ui.calls.hostSubmit.length, 1);
  assert.equal(await taskCall(session, 'task-2'), undefined);
});

test('a quoted option value with spaces is preserved', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');

  await session.ui.editor.onSubmit('/ulw-execute --worktree "C:/tmp/a b" lead-hephaestus --light');

  assert.equal(session.orchestration.current, 'hephaestus');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/ulw-execute --worktree "C:/tmp/a b" lead-hephaestus --light');
});

test('a failed re-read cannot restore coverage for a later delegation', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  const path = planPath(session.sandbox, 'lead-hephaestus');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');
  await readPlan(session, path, body);
  assert.equal(await taskCall(session, 'task-1'), undefined);

  await session.fire('tool_call', {
    type: 'tool_call', toolName: 'read', toolCallId: 'read-2', input: { path },
  });
  await session.fire('tool_result', {
    type: 'tool_result', toolName: 'read', toolCallId: 'read-2', input: { path }, content: [], isError: true,
  });
  await session.fire('tool_result', {
    type: 'tool_result', toolName: 'task', toolCallId: 'task-1', input: {}, content: [], isError: true,
  });

  const blocked = await taskCall(session, 'task-2');
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /읽어야/);
});

test('an apostrophe in a Windows path is not treated as a quote', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'probe', 'Execution lead: sisyphus\nExecution rationale: 이유');
  await session.start('resume');

  await session.ui.editor.onSubmit("/ulw-execute probe --worktree C:/O'Neil --light");

  assert.equal(session.ui.calls.hostSubmit.at(-1).text, "/ulw-execute probe --worktree C:/O'Neil --light");
});

test('a read whose body differs from the stored plan blocks the delegation', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  await readPlan(session, planPath(session.sandbox, 'lead-hephaestus'), 'different bytes');
  const blocked = await taskCall(session);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /달라요/);
});

test('reading another plan invalidates the handoff evidence', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  writePlan(session.sandbox, 'other-plan', '');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  await readPlan(session, planPath(session.sandbox, 'other-plan'), 'anything', 'read-other');
  await readPlan(session, planPath(session.sandbox, 'lead-hephaestus'), body, 'read-main');
  const blocked = await taskCall(session);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /다른 계획/);
});

test('paged reads verify the plan only after every line is covered', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  const path = planPath(session.sandbox, 'lead-hephaestus');
  const lines = body.split('\n');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  await readPlan(session, path, lines.slice(0, 3).join('\n'), 'read-a', { path, offset: 1, limit: 3 });
  await readPlan(session, path, lines.slice(3).join('\n'), 'read-b', { path, offset: 4 });

  assert.equal(await taskCall(session, 'task-1'), undefined);
});

test('a read still in flight blocks a delegation in the same response batch', async t => {
  const session = makeSession(t);
  writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');

  await session.fire('tool_call', {
    type: 'tool_call', toolName: 'read', toolCallId: 'read-1',
    input: { path: planPath(session.sandbox, 'lead-hephaestus') },
  });
  const blocked = await taskCall(session);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /읽기가 끝나기 전/);
});

test('a role change after the read blocks the delegation', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');
  await readPlan(session, planPath(session.sandbox, 'lead-hephaestus'), body);

  await session.orchestration.switchTo('sisyphus');
  const blocked = await taskCall(session);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /역할/);
});

test('a plan changed after the read blocks the delegation', async t => {
  const session = makeSession(t);
  const body = writePlan(session.sandbox, 'lead-hephaestus', 'Execution lead: hephaestus\nExecution rationale: 이유');
  await session.start('resume');
  await session.ui.editor.onSubmit('/ulw-execute lead-hephaestus');
  await readPlan(session, planPath(session.sandbox, 'lead-hephaestus'), body);

  writeFileSync(planPath(session.sandbox, 'lead-hephaestus'), `${body}\nchanged\n`, 'utf8');
  const blocked = await taskCall(session);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /바뀌었어요/);
});

test('Prometheus keeps its preset and no longer rewrites or overlays input', async t => {
  const session = makeSession(t);
  await session.start('resume');
  await session.commands.get('agent').handler('Prometheus', session.ctx);
  assert.equal(session.orchestration.current, 'prometheus');

  const prompt = await session.fire('before_agent_start', {
    type: 'before_agent_start', systemPrompt: 'BASE', preview: false,
  });
  assert.equal(prompt, undefined, 'no Prometheus prompt overlay');

  await session.ui.editor.onSubmit('계획 잡아줘');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '계획 잡아줘');

  await session.ui.editor.onSubmit('/skill:ulw-plan 계획 잡아줘');
  assert.equal(session.orchestration.current, 'prometheus');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan 계획 잡아줘');
});

test('a Native plan request no longer switches to Prometheus', async t => {
  const session = makeSession(t);
  await session.start('resume');

  await session.ui.editor.onSubmit('/skill:ulw-plan 새 계획');

  assert.equal(session.orchestration.current, 'sisyphus');
  assert.equal(session.ui.calls.hostSubmit.at(-1).text, '/skill:ulw-plan 새 계획');
});

test('Hephaestus still receives its overlay and previews stay pure', async t => {
  const session = makeSession(t, { branch: resumedBranch('hephaestus') });
  await session.start('resume');

  const result = await session.fire('before_agent_start', {
    type: 'before_agent_start', systemPrompt: 'BASE', preview: false,
  });
  assert.match(result.systemPrompt, /^BASE/);
  assert.match(result.systemPrompt, /piomo-primary-agent:begin id=hephaestus/);
});

test('the adapter-missing notice appears once after an interactive execute', async t => {
  const session = makeSession(t, {
    loadedExtensionPaths: sandbox => {
      const file = join(sandbox.root, 'tools', 'omo-task.js');
      mkdirSync(join(sandbox.root, 'tools'), { recursive: true });
      writeFileSync(file, 'export default function () {}\n', 'utf8');
      return [file];
    },
  });
  await session.start('resume');
  await session.fire('input', { type: 'input', text: '/ulw-execute go', source: 'interactive' });
  assert.equal(session.ui.calls.notify.filter(item => item.message === ADAPTER_MISSING_NOTICE).length, 1);
  await session.fire('input', { type: 'input', text: '/ulw-execute again', source: 'interactive' });
  assert.equal(session.ui.calls.notify.filter(item => item.message === ADAPTER_MISSING_NOTICE).length, 1);
});

test('the gate mirror records interactive execute only and forgets on shutdown', () => {
  assert.equal(isUlwExecute('/skill:ulw-execute x'), true);
  assert.equal(isUlwExecute('/ulw-execute'), true);
  assert.equal(isUlwExecute('/ulw-execut'), false);
  assert.equal(isUlwExecuteSkillPath('C:\\pkg\\skills\\ulw-execute\\SKILL.md'), true);
  assert.equal(isUlwExecuteSkillPath('C:/pkg/skills/ulw-execute/SKILL.md.bak'), false);

  const mirror = createGateMirror();
  mirror.observeInput('s', '/ulw-execute x', 'extension');
  assert.equal(mirror.hasUlwExecute('s'), false);
  mirror.observeInput('s', '/ulw-execute x', 'interactive');
  assert.equal(mirror.hasUlwExecute('s'), true);
  assert.deepEqual(mirror.snapshot('s'), { execute: 1 });
  mirror.forget('s');
  assert.deepEqual(mirror.snapshot('s'), { execute: 0 });
});
