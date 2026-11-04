// S18 - deterministic sandbox with the production orchestrator and label widget.
// The mock editor submits through the installed onSubmit wrapper. The host mock
// records model provenance and fires model_select BEFORE committing /model,
// matching the measured host contract. No process or model request is started.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createSandbox } from '../harness.mjs';
import { MOCK_MODELS, PROVIDER_ID } from '../mock-extension.mjs';
import {
  defaultRoster, memoryPath, readMemory, rosterPath, setAgentPin,
} from '../../contract/schema.mjs';
import { createOrchestrator } from '../../src/core/orchestration.mjs';
import { expect, writeText } from './lib.mjs';

class MockEditor {
  constructor() { this.text = ''; this.borderColor = '#123456'; }
  handleInput() {}
  isShowingAutocomplete() { return false; }
  getText() { return this.text; }
  getLines() { return [this.text]; }
  getCursor() { return { line: 0, col: this.text.length }; }
  setText(text) { this.text = text; }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createSession() {
  const sandbox = createSandbox();
  const models = MOCK_MODELS.map(model => ({ ...model, provider: PROVIDER_ID }));
  const branch = [];
  const handlers = new Map();
  const submissions = [];
  const notices = [];
  let editor;
  let widget;
  let factory;
  const append = entry => branch.push({ id: `e${branch.length}`, ...entry });
  const ctx = {
    mode: 'tui', hasUI: true, cwd: sandbox.workDir, agentDir: sandbox.agentDir,
    model: models[0], thinkingLevel: 'medium', isIdle: () => true,
    modelRegistry: {
      find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
      getAvailable: () => models,
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => 's18-session' },
    ui: {
      getEditorComponent: () => factory,
      setEditorComponent(next) {
        factory = next;
        editor = next({}, {}, { matches: (data, action) => data === '\t' && action === 'tui.input.tab' });
        editor.onSubmit = async text => {
          submissions.push(text);
          if (!text.startsWith('/model ')) return;
          const modelId = text.slice('/model '.length);
          await handlers.get('model_select')({ source: 'command' }, ctx);
          ctx.model = models.find(model => model.id === modelId);
          expect(ctx.model, `unregistered mock model ${modelId}`);
          append({ type: 'model_change', provider: PROVIDER_ID, modelId, source: 'command' });
        };
      },
      setWidget(_key, makeWidget) { widget = makeWidget(); },
      setStatus() {}, setTitle() {},
      notify(message, type) { notices.push({ message, type }); },
    },
  };
  const pi = {
    sessionKind: 'interactive',
    on(name, handler) { handlers.set(name, handler); return () => {}; },
    registerCommand() {},
    async setSessionModel(model) {
      ctx.model = model;
      append({ type: 'model_change', provider: model.provider, modelId: model.id, source: 'extension' });
      return true;
    },
    setSessionThinkingLevel(level) {
      ctx.thinkingLevel = level;
      append({ type: 'thinking_level_change', thinkingLevel: level,
        thinkingSelection: { level, source: 'explicit' } });
    },
    appendEntry(customType, data) { append({ type: 'custom', customType, data }); },
  };
  const orchestration = createOrchestrator(pi, { EditorBase: MockEditor });
  const fire = (name, payload = {}) => handlers.get(name)(payload, ctx);
  const label = () => widget.render(160).join('\n');
  const checkAgent = (id, display) => {
    expect(orchestration.current === id, `expected ${id}, got ${orchestration.current}`);
    expect(label().includes(display), `label did not render ${display}: ${label()}`);
  };
  const submit = async text => {
    editor.setText(text);
    await editor.onSubmit(text);
    expect(submissions.at(-1) === text, `host did not receive ${text}`);
    editor.setText('');
  };
  const tab = async () => {
    editor.handleInput('\t');
    await orchestration.settled();
  };
  // Keep the main settings distinguishable from both the lane and Atlas pin.
  writeJson(join(sandbox.agentDir, 'settings.json'), {
    defaultProvider: PROVIDER_ID, defaultModel: 'claude-mock-max', defaultThinkingLevel: 'high',
  });
  await fire('session_start', { reason: 'new' });
  return {
    sandbox, branch, notices, orchestration, ctx, fire, label, checkAgent, submit, tab,
    select: modelId => submit(`/model ${modelId}`),
    boulder(status) {
      writeJson(join(sandbox.workDir, '.omo', 'boulder.json'), {
        works: [{ session_ids: ['senpi:s18-session'], status }],
      });
    },
  };
}

export async function run({ out }) {
  const s = await createSession();
  const receipt = { scenario: 'S18', surface: 'production orchestrator + mock TUI', scenes: [], ok: false };
  const pass = (scene, description, evidence) => {
    receipt.scenes.push({ scene, description, ok: true, ...evidence });
    console.log(`S18 scene ${scene}: PASS - ${description}`);
  };
  let roster = defaultRoster();
  const boardApply = () => {
    roster = setAgentPin(roster, 'atlas', {
      provider: PROVIDER_ID, modelId: 'claude-mock-medium', thinking: 'medium',
    });
    roster.revision += 1;
    writeJson(rosterPath(s.sandbox.agentDir), roster);
    return roster.agents.atlas.rev;
  };
  const atlasMemory = () => readMemory(s.sandbox.agentDir, 'atlas').memory;
  try {
    s.checkAgent('sisyphus', 'Sisyphus');
    await s.submit('/skill:ulw-plan x');
    s.checkAgent('prometheus', 'Prometheus');
    pass(1, 'ulw-plan enters Prometheus', { label: s.label() });

    await s.submit('/ulw-execute p');
    s.checkAgent('atlas', 'Atlas');
    s.boulder('active');
    await s.fire('agent_end');
    s.checkAgent('atlas', 'Atlas');
    s.boulder('completed');
    await s.fire('agent_end');
    s.checkAgent('sisyphus', 'Sisyphus');
    pass(2, 'active then completed boulder returns to Sisyphus', { label: s.label() });

    await s.submit('/ulw-execute p');
    s.boulder('active');
    const identities = s.branch.filter(entry => entry.customType === 'primary-agent/v1').length;
    for (let i = 0; i < 3; i += 1) await s.fire('agent_end');
    s.checkAgent('atlas', 'Atlas');
    expect(s.branch.filter(entry => entry.customType === 'primary-agent/v1').length === identities,
      'active boulder appended a return identity');
    pass('negative', 'held-active boulder never returns', { agentEndEvents: 3, label: s.label() });
    await s.tab();

    writeJson(memoryPath(s.sandbox.agentDir, 'atlas'), {
      v: 1, agentId: 'atlas', model: { provider: PROVIDER_ID, modelId: 'claude-mock-max' },
      thinking: 'high', rosterRev: 0, updatedAt: new Date().toISOString(),
    });
    boardApply();
    await s.submit('/ulw-execute p');
    expect(s.ctx.model.id === 'claude-mock-medium', 'pin did not beat older Atlas memory');
    await s.select('claude-mock-xhigh');
    await s.tab();
    await s.submit('/ulw-execute p');
    expect(s.ctx.model.id === 'claude-mock-xhigh', 'later command did not beat Atlas pin');
    expect(atlasMemory()?.rosterRev === roster.agents.atlas.rev, 'memory did not retain selection rev');
    pass(3, 'rev pin beats old memory; later /model command wins', { memory: atlasMemory(), label: s.label() });
    await s.tab();

    s.checkAgent('sisyphus', 'Sisyphus');
    expect(roster.agents.sisyphus.pin === null, 'Sisyphus unexpectedly pinned');
    expect(s.ctx.model.id === 'claude-mock-max' && s.ctx.thinkingLevel === 'high',
      'Sisyphus did not resolve settings main model and thinking');
    expect(readMemory(s.sandbox.agentDir, 'sisyphus').memory === null, 'Sisyphus return learned extension model');
    pass(4, 'unpinned Sisyphus returns to settings main', { model: s.ctx.model.id, thinking: s.ctx.thinkingLevel });

    writeFileSync(rosterPath(s.sandbox.agentDir), '{broken', 'utf8');
    const beforeWarnings = s.notices.filter(notice => notice.message.includes('roster.json')).length;
    for (let i = 0; i < 4; i += 1) await s.tab();
    const warnings = s.notices.filter(notice => notice.message.includes('roster.json')).slice(beforeWarnings);
    expect(warnings.length === 1, `broken roster warned ${warnings.length} times`);
    pass(5, 'broken roster warns exactly once across repeated switches', { warnings });
    writeJson(rosterPath(s.sandbox.agentDir), roster);

    boardApply();
    await s.submit('/ulw-execute p');
    expect(s.ctx.model.id === 'claude-mock-medium', 'scene 6 did not begin on board model A');
    await s.select('claude-mock-xhigh');
    const selectionRev = roster.agents.atlas.rev;
    const appliedRev = boardApply();
    await s.tab();
    expect(atlasMemory()?.rosterRev === selectionRev, 'save time incorrectly replaced selection rev');
    await s.submit('/ulw-execute p');
    expect(s.ctx.model.id === 'claude-mock-medium', 'new board pin lost to earlier command');
    pass(6, '/model B -> board apply A -> return: A wins', {
      selectionRev, appliedRev, memory: atlasMemory(), label: s.label(),
    });

    const latestRev = boardApply();
    await s.select('claude-mock-xhigh');
    await s.tab();
    expect(atlasMemory()?.rosterRev === latestRev, 'selection did not read new roster rev');
    await s.submit('/ulw-execute p');
    expect(s.ctx.model.id === 'claude-mock-xhigh', 'later command lost to earlier board pin');
    pass(7, 'board apply A -> /model B -> return: B wins', {
      selectionRev: latestRev, memory: atlasMemory(), label: s.label(),
    });
    receipt.ok = true;
  } catch (error) {
    receipt.error = String(error?.stack ?? error);
    throw error;
  } finally {
    await s.fire('session_shutdown');
    receipt.entries = s.branch;
    receipt.notices = s.notices;
    receipt.cleanup = s.sandbox.cleanup();
    writeText(out, 'task-11-piomo-primary-agents-S18.json', JSON.stringify(receipt, null, 2));
  }
  return receipt;
}

if (process.argv[1]?.endsWith('s18-auto-return.mjs')) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s18-auto-return.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch(error => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
