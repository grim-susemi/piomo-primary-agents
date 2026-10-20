// Todo 9 failure QA: `resolve` returns unavailable for Prometheus.
//
// Deterministic orchestration run (no provider, no credentials, no live agent
// dir): a temp agent dir/home, a fake ExtensionAPI and a fake ExtensionContext
// that owns only `model`, `thinkingLevel`, `modelRegistry`, `sessionManager`
// and `ui`. Proves: from `/agent` the agent stays, one notice names the reason,
// and no identity entry is written; from Tab the unavailable agent is skipped
// with one notice.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrchestrator } from '../src/core/orchestration.mjs';

const LANES = {
  '[native]': {
    model_profiles: {
      'daily-normal': { models: [{ providers: ['sub'], model: 'lane-daily', variant: 'medium' }] },
      'daily-heavy': { models: [{ providers: ['sub'], model: 'lane-prom-missing', variant: 'high' }] },
      'geeky-normal': { models: [{ providers: ['gpt'], model: 'gpt-lane-geeky', variant: 'medium' }] },
      'geeky-heavy': { models: [{ providers: ['gpt'], model: 'gpt-lane-heavy', variant: 'high' }] },
    },
  },
};

class Base {
  constructor() { this.text = ''; }
  handleInput() {}
  isShowingAutocomplete() { return false; }
  getText() { return this.text; }
  getLines() { return [this.text]; }
  getCursor() { return { line: 0, col: 0 }; }
  setText(text) { this.text = text; }
}

const root = mkdtempSync(join(tmpdir(), 'piomo-task9-unavailable-'));
try {
  const homeDir = join(root, '.omo');
  const agentDir = join(homeDir, 'agent');
  mkdirSync(join(agentDir, 'primary-agents', 'memory'), { recursive: true });
  writeFileSync(join(homeDir, 'omo.jsonc'), JSON.stringify(LANES), 'utf8');

  const models = [{ provider: 'sub', id: 'lane-daily' }, { provider: 'gpt', id: 'gpt-lane-geeky' }];
  const registry = {
    find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
    getAvailable: () => models,
    getAll: () => models,
  };
  const branch = [
    { type: 'model_change', id: 'm0', provider: 'runtime', modelId: 'default-x' },
    { type: 'thinking_level_change', id: 't0', thinkingLevel: 'off', thinkingSelection: { level: 'off', source: 'explicit' } },
    { type: 'custom', customType: 'primary-agent/v1', id: 'i0', data: { schemaVersion: 1, agentId: 'sisyphus' } },
    { type: 'message', id: 'msg', role: 'user', content: [] },
  ];
  const notices = [];
  const keybindings = { matches: (data, action) => data === '\t' && action === 'tui.input.tab' };
  let editor = null;
  const ui = {
    getEditorComponent: () => undefined,
    setEditorComponent(factory) {
      editor = factory({}, {}, keybindings);
      editor.onSubmit = () => {};
    },
    setWidget() {},
    setStatus() {},
    setTitle() {},
    notify(message, type) { notices.push({ message, type }); },
    async select() { return undefined; },
  };
  const ctx = {
    mode: 'tui',
    hasUI: true,
    cwd: root,
    agentDir,
    model: { provider: 'runtime', id: 'default-x' },
    thinkingLevel: 'off',
    modelRegistry: registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => 'qa-session' },
    ui,
    isIdle: () => true,
    loadedExtensionPaths: [],
  };
  const calls = [];
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    sessionKind: 'interactive',
    on(event, handler) { handlers.set(event, handler); return () => {}; },
    registerCommand(name, command) { commands.set(name, command); },
    async setSessionModel(model) {
      calls.push(['model', model.id]);
      ctx.model = { provider: model.provider, id: model.id };
      return true;
    },
    setSessionThinkingLevel(level) { calls.push(['thinking', level]); ctx.thinkingLevel = level; },
    appendEntry(type, data) {
      calls.push(['entry', data.agentId]);
      branch.push({ type: 'custom', customType: type, data });
    },
    getAllTools() { return []; },
  };

  const orchestration = createOrchestrator(pi, { EditorBase: Base });
  await handlers.get('session_start')({ type: 'session_start', reason: 'resume' }, ctx);

  const entriesBefore = calls.filter(call => call[0] === 'entry').length;
  notices.length = 0;
  await commands.get('agent').handler('Prometheus', ctx);
  const fromAgent = {
    current: orchestration.current,
    entryWritten: calls.filter(call => call[0] === 'entry').length !== entriesBefore,
    notice: notices.at(-1)?.message ?? null,
  };

  await commands.get('agent').handler('Hephaestus', ctx);
  assertCurrent(orchestration.current, 'hephaestus');
  notices.length = 0;
  editor.handleInput('\t');
  await orchestration.settled();
  const fromTab = {
    current: orchestration.current,
    notices: notices.map(item => item.message),
  };

  const ok = fromAgent.current === 'sisyphus'
    && fromAgent.entryWritten === false
    && /Prometheus는 지금 사용할 수 없어요/.test(fromAgent.notice ?? '')
    && fromTab.current === 'atlas'
    && fromTab.notices.length === 1
    && /Prometheus/.test(fromTab.notices[0])
    && /Atlas로 전환했어요/.test(fromTab.notices[0]);

  console.log(JSON.stringify({
    scenario: 'resolve returns unavailable for Prometheus',
    agentDir,
    fromAgent,
    fromTab,
    entries: calls.filter(call => call[0] === 'entry').map(call => call[1]),
    ok,
  }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

function assertCurrent(actual, expected) {
  if (actual !== expected) throw new Error(`expected current ${expected}, got ${actual}`);
}
