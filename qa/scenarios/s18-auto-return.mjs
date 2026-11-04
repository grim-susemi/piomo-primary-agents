// S18 - deterministic sandbox host-event replay against the built extension.
// TUI rendering/completion is exercised by S1/S2/S4/S11/S14/S15. Here the host
// event boundaries are controlled so both revision races have a fixed order.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createSandbox } from '../harness.mjs';
import { MOCK_MODELS } from '../mock-extension.mjs';
import { expect, writeEvidence, writeText } from './lib.mjs';
import { createOrchestrator } from '../../dist/src/core/orchestration.mjs';
import { atomicWriteJson, writeRoster } from '../../dist/contract/atomic.mjs';
import {
  memoryPath, readRoster, rosterPath, setAgentPin,
} from '../../dist/contract/schema.mjs';

class Editor {
  constructor() { this.text = ''; }
  getText() { return this.text; }
  setText(text) { this.text = text; }
  getLines() { return this.text.split('\n'); }
  getCursor() { return { line: 0, col: this.text.length }; }
  isShowingAutocomplete() { return false; }
  handleInput() {}
}

async function hostCase(body) {
  const sandbox = createSandbox();
  const branch = [];
  const warnings = [];
  const submitted = [];
  const handlers = new Map();
  let editor;
  const models = MOCK_MODELS.map(model => ({ ...model, provider: 'qa-mock' }));
  const ctx = {
    mode: 'tui', hasUI: true, cwd: sandbox.workDir, agentDir: sandbox.agentDir,
    model: models.find(model => model.id === 'claude-mock-medium'),
    thinkingLevel: 'off', isIdle: () => true,
    modelRegistry: {
      find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
      getAvailable: () => models,
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => 's18' },
    ui: {
      setEditorComponent(factory) {
        editor = factory({}, {}, {
          matches: (data, action) => data === '\t' && action === 'tui.input.tab',
        });
        editor.onSubmit = text => submitted.push(text);
      },
      getEditorComponent: () => null,
      setWidget() {}, setStatus() {}, setTitle() {},
      notify: (message, type) => warnings.push({ message, type }),
    },
  };
  const append = entry => branch.push({ ...entry, id: `s18-${branch.length}` });
  const pi = {
    sessionKind: 'interactive',
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {},
    async setSessionModel(model) {
      ctx.model = model;
      append({ type: 'model_change', source: 'extension', provider: model.provider, modelId: model.id });
      return true;
    },
    setSessionThinkingLevel(level) {
      ctx.thinkingLevel = level;
      append({ type: 'thinking_level_change', thinkingLevel: level,
        thinkingSelection: { source: 'explicit', level } });
    },
    appendEntry: (customType, data) => append({ type: 'custom', customType, data }),
  };
  const core = createOrchestrator(pi, { EditorBase: Editor });
  const fire = (name, event = {}) => handlers.get(name)(event, ctx);
  const pin = (agentId, modelId) => {
    const before = readRoster(sandbox.agentDir).roster;
    const result = writeRoster(sandbox.agentDir, setAgentPin(before, agentId, {
      provider: 'qa-mock', modelId, thinking: 'high',
    }), before.revision);
    expect(result.revision === before.revision + 1, `sandbox pin failed: ${JSON.stringify(result)}`);
  };
  const select = (modelId) => {
    fire('model_select', { source: 'command' });
    ctx.model = models.find(model => model.id === modelId);
    append({ type: 'model_change', source: 'command', provider: 'qa-mock', modelId });
  };
  const assertState = (agentId, modelId) => {
    const actual = core.snapshot();
    expect(actual.agentId === agentId && actual.modelId === modelId && !actual.pending,
      `expected ${agentId}/${modelId}; actual ${JSON.stringify(actual)}`);
    return actual;
  };
  const tab = async () => {
    editor.setText('');
    editor.handleInput('\t');
    await core.settled();
  };
  const submit = async text => {
    editor.setText(text);
    await editor.onSubmit(text);
    editor.setText('');
  };
  const boulder = status => atomicWriteJson(join(sandbox.workDir, '.omo', 'boulder.json'), {
    works: { demo: { session_ids: ['senpi:s18'], status } },
  });
  const host = { sandbox, core, ctx, branch, warnings, submitted, fire, pin,
    select, assertState, tab, submit, boulder };
  try {
    return await body(host);
  } finally {
    await fire('session_shutdown');
    sandbox.cleanup();
  }
}

export async function runRace({ out, race }) {
  expect(['a', 'b'].includes(race), `unknown race ${race}`);
  const result = await hostCase(async h => {
    await h.fire('session_start', { reason: 'new' });
    await h.core.switchTo('hephaestus');
    if (race === 'a') h.pin('hephaestus', 'gpt-mock-astra');
    h.select('gpt-mock-sol');
    if (race === 'b') h.pin('hephaestus', 'gpt-mock-astra');
    await h.fire('input', { source: 'interactive', text: 'reconcile' });
    const memory = JSON.parse(readFileSync(memoryPath(h.sandbox.agentDir, 'hephaestus'), 'utf8'));
    const roster = readRoster(h.sandbox.agentDir).roster;
    expect(memory.rosterRev === (race === 'a' ? 1 : 0),
      `race ${race} learned revision ${memory.rosterRev}`);
    await h.core.switchTo('sisyphus');
    await h.core.switchTo('hephaestus');
    const state = h.assertState('hephaestus', race === 'a' ? 'gpt-mock-sol' : 'gpt-mock-astra');
    return { ok: true, order: race === 'a' ? 'pin -> /model -> reconcile'
      : '/model intent+commit -> pin -> reconcile', memory, rosterRev: roster.agents.hephaestus.rev, state };
  });
  writeText(out, `race-${race}.txt`, JSON.stringify(result, null, 2));
  console.log(`S18 race-${race}: PASS ${result.order}; ${result.state.agentId}/${result.state.modelId}`);
  return result;
}

export async function run({ out }) {
  const record = { startedAt: new Date().toISOString(), checks: {}, frames: [], pane: null };
  try {
    record.checks.workflow = await hostCase(async h => {
      atomicWriteJson(join(h.sandbox.agentDir, 'settings.json'), {
        defaultProvider: 'qa-mock', defaultModel: 'claude-mock-max', defaultThinkingLevel: 'low',
      });
      await h.fire('session_start', { reason: 'new' });
      const initial = h.assertState('sisyphus', 'claude-mock-max');
      expect(initial.thinking === 'low', 'Sisyphus settings thinking not applied');
      await h.tab();
      h.assertState('hephaestus', 'gpt-mock-fast');
      await h.submit('/skill:ulw-plan S18 plan');
      h.assertState('prometheus', 'claude-mock-xhigh');
      expect(h.submitted.at(-1) === '/skill:ulw-plan S18 plan', 'plan entry was not submitted');
      await h.tab();
      h.assertState('hephaestus', 'gpt-mock-fast');
      await h.submit('/ulw-execute demo');
      h.assertState('atlas', 'claude-mock-medium');
      h.boulder('active');
      await h.fire('agent_end');
      const stale = h.assertState('atlas', 'claude-mock-medium');
      // Completion-looking output is irrelevant while the owned work is active.
      await h.fire('agent_end', { messages: [{ role: 'assistant', content: 'SUCCESS all done' }] });
      h.assertState('atlas', 'claude-mock-medium');
      const held = [];
      for (const status of ['paused', 'blocked', 'retry', 'cancelled']) {
        h.boulder(status);
        await h.fire('agent_end');
        held.push({ status, state: h.assertState('atlas', 'claude-mock-medium') });
      }
      h.boulder('completed');
      for (const event of [{ willRetry: true }, { aborted: true }]) {
        await h.fire('agent_end', event);
        held.push({ event, state: h.assertState('atlas', 'claude-mock-medium') });
      }
      await h.fire('agent_end');
      const returned = h.assertState('hephaestus', 'gpt-mock-fast');
      await h.tab();
      const settings = h.assertState('sisyphus', 'claude-mock-max');
      expect(settings.thinking === 'low', 'Sisyphus return lost settings thinking');
      await h.submit('/ulw-execute from-sisyphus');
      h.assertState('atlas', 'claude-mock-medium');
      h.boulder('active');
      await h.fire('agent_end');
      h.boulder('completed');
      await h.fire('agent_end');
      const autoSettings = h.assertState('sisyphus', 'claude-mock-max');
      expect(autoSettings.thinking === 'low', 'automatic Sisyphus return lost settings thinking');
      return { initial, stale, held, returned, settings, autoSettings };
    });
    record.checks.memory = await hostCase(async h => {
      atomicWriteJson(memoryPath(h.sandbox.agentDir, 'hephaestus'), {
        v: 1, agentId: 'hephaestus', model: { provider: 'qa-mock', modelId: 'gpt-mock-sol' },
        thinking: 'medium', rosterRev: 0, updatedAt: new Date().toISOString(),
      });
      h.pin('hephaestus', 'gpt-mock-astra');
      await h.fire('session_start', { reason: 'new' });
      await h.tab();
      const pinned = h.assertState('hephaestus', 'gpt-mock-astra');
      h.select('gpt-mock-sol');
      await h.tab();
      await h.tab();
      const learned = h.assertState('hephaestus', 'gpt-mock-sol');
      atomicWriteJson(rosterPath(h.sandbox.agentDir), { v: 999 });
      await h.tab();
      await h.tab();
      const warnings = h.warnings.filter(entry => entry.message.includes('ROSTER_INVALID'));
      expect(warnings.length === 1, `broken roster should warn once: ${JSON.stringify(warnings)}`);
      const fallback = h.assertState('hephaestus', 'gpt-mock-fast');
      return { pinned, learned, warnings, fallback };
    });
    record.checks.raceA = await runRace({ out, race: 'a' });
    record.checks.raceB = await runRace({ out, race: 'b' });
    record.ok = true;
    record.cleanup = { removed: true, processesStarted: 0, portsOpened: 0 };
    console.log('S18: PASS workflow, memory, warning, stale/cancel/retry guards and both revision races');
    return record;
  } catch (error) {
    record.ok = false;
    record.error = String(error.stack ?? error);
    throw error;
  } finally {
    record.endedAt = new Date().toISOString();
    writeEvidence(out, 'task-11-piomo-primary-agents-S18', record);
  }
}

if (process.argv[1]?.endsWith('s18-auto-return.mjs')) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, race: { type: 'string' } } });
  if (!values.out) throw new Error('usage: node qa/scenarios/s18-auto-return.mjs --out <dir> [--race a|b]');
  try {
    if (values.race) await runRace({ out: values.out, race: values.race });
    else await run({ out: values.out });
  } catch (error) {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  }
}
