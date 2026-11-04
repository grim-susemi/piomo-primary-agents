import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRoster, memoryPath, rosterPath, setAgentPin } from '../contract/schema.mjs';
import { createOrchestrator } from '../src/core/orchestration.mjs';

const stamp = '2026-11-04T00:00:00.000Z';
const model = (provider, id) => ({ provider, id });
const pin = (provider, modelId, thinking = null) => ({ provider, modelId, thinking });
const baseModels = [
  model('sub', 'main'), model('sub', 'A'), model('sub', 'B'),
  model('sub', 'lane'), model('sub', 'gpt-geek'),
];

function sandbox(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'piomo-model-rules-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const home = join(root, '.omo');
  const agentDir = join(home, 'agent');
  mkdirSync(join(agentDir, 'primary-agents', 'memory'), { recursive: true });
  let roster = defaultRoster();
  const saveRoster = value => {
    roster = value;
    writeFileSync(rosterPath(agentDir), JSON.stringify(roster));
  };
  saveRoster(roster);
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'sub', defaultModel: 'sub/main', defaultThinkingLevel: 'medium',
    ...options.settings,
  }));
  const daily = options.daily ?? [{ providers: ['sub'], model: 'lane' }];
  writeFileSync(join(home, 'omo.jsonc'), JSON.stringify({ model_profiles: {
    'daily-normal': { models: daily },
    'daily-heavy': { models: daily },
    'geeky-normal': { models: options.geeky ?? [{ providers: ['sub'], model: 'gpt-geek' }] },
  } }));
  const all = options.models ?? baseModels;
  const available = all.filter(item => !options.noAuth?.includes(item.provider));
  const handlers = new Map();
  const branch = [];
  const warnings = [];
  let editor;
  const ctx = {
    mode: 'tui', hasUI: true, agentDir, cwd: root,
    model: options.hostModel ?? model('sub', 'main'), thinkingLevel: 'medium',
    modelRegistry: {
      find: (provider, id) => all.find(item => item.provider === provider && item.id === id),
      getAvailable: () => available,
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => 'model-rules' },
    ui: {
      notify: (message, type) => { if (type === 'warning') warnings.push(message); },
      setEditorComponent(factory) {
        editor = factory({}, {}, { matches: (data, action) => data === 'think' && action === 'app.thinking.cycle' });
      },
      setWidget() {}, setStatus() {}, setTitle() {},
    },
    isIdle: () => true,
  };
  const append = entry => branch.push({ id: `entry-${branch.length}`, ...entry });
  const pi = {
    sessionKind: 'interactive',
    on: (event, handler) => handlers.set(event, handler),
    registerCommand() {},
    async setSessionModel(value) {
      handlers.get('model_select')?.({ source: 'extension' }, ctx);
      ctx.model = value;
      append({ type: 'model_change', source: 'extension', provider: value.provider, modelId: value.id });
      return true;
    },
    setSessionThinkingLevel(level) {
      ctx.thinkingLevel = level;
      append({ type: 'thinking_level_change', thinkingLevel: level, thinkingSelection: { source: 'explicit', level } });
    },
    appendEntry: (customType, data) => append({ type: 'custom', customType, data }),
  };
  class Editor {
    handleInput(data) {
      if (data === 'think') pi.setSessionThinkingLevel('high');
    }
    isShowingAutocomplete() { return false; }
    getText() { return ''; }
    getCursor() { return { line: 0, col: 0 }; }
    getLines() { return ['']; }
    setText() {}
  }
  const orchestrator = createOrchestrator(pi, { EditorBase: Editor });
  const fire = (name, event = {}) => handlers.get(name)(event, ctx);
  const memory = (agentId, provider, modelId, rev = 0) => {
    writeFileSync(memoryPath(agentDir, agentId), JSON.stringify({
      v: 1, agentId, model: { provider, modelId }, thinking: 'low', rosterRev: rev, updatedAt: stamp,
    }));
  };
  return {
    ctx, branch, warnings, orchestrator, agentDir,
    get roster() { return roster; },
    saveRoster, memory, fire,
    start: () => fire('session_start', { reason: 'new' }),
    pick: async (provider, id) => {
      await fire('model_select', { source: 'command', model: model(provider, id) });
      ctx.model = model(provider, id);
      append({ type: 'model_change', source: 'command', provider, modelId: id });
    },
    think: () => editor.handleInput('think'),
    flush: () => fire('input', { source: 'interactive', text: '' }),
    readMemory: () => JSON.parse(readFileSync(memoryPath(agentDir, 'sisyphus'), 'utf8')),
    reenter: async () => {
      await orchestrator.switchTo('hephaestus');
      await orchestrator.switchTo('sisyphus');
    },
  };
}

function resolved(t, s, expected, agentId = 'sisyphus', origin) {
  const actual = s.orchestrator.availability()[agentId];
  assert.equal(`${actual.provider}/${actual.modelId}`, expected);
  if (origin) assert.equal(actual.origin, origin);
  t.diagnostic(`resolved ${agentId}=${expected}; origin=${actual.origin}`);
}

test('unpinned Sisyphus injects settings main and labels its origin main', async t => {
  const s = sandbox(t, { hostModel: model('sub', 'B') });
  await s.start();
  resolved(t, s, 'sub/main', 'sisyphus', 'main');
  assert.deepEqual(s.ctx.model, model('sub', 'main'));
  assert.equal(s.ctx.thinkingLevel, 'medium');
});

test('a valid roster pin beats settings main', async t => {
  const s = sandbox(t);
  s.saveRoster(setAgentPin(s.roster, 'sisyphus', pin('sub', 'A')));
  await s.start();
  resolved(t, s, 'sub/A', 'sisyphus', 'pin');
  assert.deepEqual(s.ctx.model, model('sub', 'A'));
});

test('matching memory beats main and applies on a fresh session', async t => {
  const s = sandbox(t);
  s.memory('sisyphus', 'sub', 'B');
  await s.start();
  resolved(t, s, 'sub/B', 'sisyphus', 'memory');
  assert.deepEqual(s.ctx.model, model('sub', 'B'));
  assert.equal(s.ctx.thinkingLevel, 'low');
});

test('host-started main is not reapplied or learned', async t => {
  const s = sandbox(t);
  await s.start();
  await s.flush();
  resolved(t, s, 'sub/main');
  assert.deepEqual(s.ctx.model, model('sub', 'main'));
  assert.deepEqual(s.branch, [], 'reapplying main would append a model or thinking entry');
});

test('unregistered main falls through to a lane with an actionable warning', async t => {
  const s = sandbox(t, { settings: { defaultModel: 'sub/missing' } });
  await s.start();
  resolved(t, s, 'sub/lane', 'sisyphus', 'lane');
  assert.deepEqual(s.ctx.model, model('sub', 'lane'));
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /main sub\/missing: unregistered; using sub\/lane/);
});

test('old memory revision loses to main', async t => {
  const s = sandbox(t);
  const next = defaultRoster();
  next.agents.sisyphus.rev = 1;
  s.saveRoster(next);
  s.memory('sisyphus', 'sub', 'B', 0);
  await s.start();
  resolved(t, s, 'sub/main', 'sisyphus', 'main');
  assert.deepEqual(s.ctx.model, model('sub', 'main'));
});

test('/model B then board A revision bump returns to A using the staged old revision', async t => {
  const s = sandbox(t);
  await s.start();
  await s.pick('sub', 'B');
  s.saveRoster(setAgentPin(s.roster, 'sisyphus', pin('sub', 'A')));
  await s.reenter();
  assert.equal(s.readMemory().rosterRev, 0);
  assert.deepEqual(s.ctx.model, model('sub', 'A'));
  resolved(t, s, 'sub/A', 'sisyphus', 'pin');
});

test('board A then /model B returns to B using the selection-time new revision', async t => {
  const s = sandbox(t);
  await s.start();
  s.saveRoster(setAgentPin(s.roster, 'sisyphus', pin('sub', 'A')));
  await s.pick('sub', 'B');
  await s.reenter();
  assert.equal(s.readMemory().rosterRev, 1);
  assert.deepEqual(s.ctx.model, model('sub', 'B'));
  resolved(t, s, 'sub/B', 'sisyphus', 'memory');
});

test('thinking before a board edit preserves its selection-time revision', async t => {
  const s = sandbox(t);
  await s.start();
  s.think();
  s.saveRoster(setAgentPin(s.roster, 'sisyphus', pin('sub', 'A')));
  await s.reenter();
  assert.equal(s.readMemory().rosterRev, 0);
  assert.equal(s.readMemory().thinking, 'high');
  assert.deepEqual(s.ctx.model, model('sub', 'A'));
  resolved(t, s, 'sub/A');
});

test('thinking after a board edit captures the new revision', async t => {
  const s = sandbox(t);
  await s.start();
  s.saveRoster(setAgentPin(s.roster, 'sisyphus', pin('sub', 'A')));
  s.think();
  await s.reenter();
  assert.equal(s.readMemory().rosterRev, 1);
  assert.equal(s.ctx.thinkingLevel, 'high');
  assert.deepEqual(s.ctx.model, model('sub', 'main'));
  resolved(t, s, 'sub/main', 'sisyphus', 'memory');
});

test('broken roster and unauthenticated memory warn once, including with a valid replacement pin', async t => {
  const s = sandbox(t, { models: [...baseModels, model('locked', 'private')], noAuth: ['locked'] });
  s.memory('sisyphus', 'locked', 'private');
  writeFileSync(rosterPath(s.agentDir), '{broken');
  await s.start();
  resolved(t, s, 'sub/main');
  const repaired = defaultRoster();
  repaired.agents.sisyphus.pin = pin('sub', 'A');
  s.saveRoster(repaired);
  await s.reenter();
  resolved(t, s, 'sub/A');
  await s.reenter();
  assert.equal(s.warnings.filter(text => text.startsWith('ROSTER_INVALID:')).length, 1);
  assert.equal(s.warnings.filter(text => text.includes('memory locked/private: unauthenticated')).length, 1);
  for (const text of s.warnings) t.diagnostic(`warning ${text}`);
  assert.deepEqual(s.ctx.model, model('sub', 'A'));
});

test('unusable memory warns even while a valid pin supplies the model', async t => {
  const s = sandbox(t, { models: [...baseModels, model('locked', 'private')], noAuth: ['locked'] });
  s.saveRoster(setAgentPin(s.roster, 'sisyphus', pin('sub', 'A')));
  s.memory('sisyphus', 'locked', 'private', 1);
  await s.start();
  resolved(t, s, 'sub/A');
  assert.equal(s.warnings.length, 1);
  assert.match(s.warnings[0], /memory locked\/private: unauthenticated; using sub\/A/);
  t.diagnostic(`warning ${s.warnings[0]}`);
});

test('every unusable higher-priority candidate is visible before a valid lane substitute', async t => {
  const s = sandbox(t);
  const roster = defaultRoster();
  roster.agents.sisyphus.pin = pin('sub', 'absent-pin');
  s.saveRoster(roster);
  s.memory('sisyphus', 'sub', 'absent-memory');
  await s.start();
  resolved(t, s, 'sub/lane');
  assert.equal(s.warnings.length, 2);
  assert.match(s.warnings[0], /memory sub\/absent-memory: unregistered; using sub\/lane/);
  assert.match(s.warnings[1], /pin sub\/absent-pin: unregistered; using sub\/lane/);
});

test('Muse is admitted for an opencode-go lane', async t => {
  const s = sandbox(t, {
    models: [...baseModels, model('opencode-go', 'muse')],
    daily: [{ providers: ['opencode-go'], model: 'muse' }],
  });
  await s.start();
  resolved(t, s, 'opencode-go/muse', 'atlas', 'lane');
  await s.orchestrator.switchTo('atlas');
  assert.deepEqual(s.ctx.model, model('opencode-go', 'muse'));
  assert.equal(s.warnings.length, 0);
});

test('non-Muse opencode-go lane candidates are filtered while other providers remain', async t => {
  const s = sandbox(t, {
    models: [...baseModels, model('opencode-go', 'kimi-k3'), model('sub', 'kimi-k3')],
    daily: [{ providers: ['opencode-go', 'sub'], model: 'kimi-k3' }],
  });
  await s.start();
  resolved(t, s, 'sub/kimi-k3', 'atlas', 'lane');
  await s.orchestrator.switchTo('atlas');
  assert.deepEqual(s.ctx.model, model('sub', 'kimi-k3'));
  const warning = s.warnings.filter(text => text.startsWith('Atlas lane'));
  assert.equal(warning.length, 1);
  assert.match(warning[0], /opencode-go\/kimi-k3: Muse-only lane; using sub\/kimi-k3/);
  t.diagnostic(`warning ${warning[0]}`);
});

test('a providerless lane retains non-opencode-go candidates', async t => {
  const s = sandbox(t, {
    models: [...baseModels, model('opencode-go', 'kimi-k3'), model('sub', 'kimi-k3')],
    daily: ['kimi-k3'],
  });
  await s.start();
  resolved(t, s, 'sub/kimi-k3', 'atlas');
  await s.orchestrator.switchTo('atlas');
  assert.deepEqual(s.ctx.model, model('sub', 'kimi-k3'));
});

test('explicit non-Muse opencode-go memory, pin and main bypass the lane guard', async t => {
  for (const candidate of ['memory', 'pin', 'main']) {
    const s = sandbox(t, {
      models: [...baseModels, model('opencode-go', 'kimi-k3')],
      settings: candidate === 'main' ? { defaultModel: 'opencode-go/kimi-k3' } : {},
    });
    if (candidate === 'memory') s.memory('sisyphus', 'opencode-go', 'kimi-k3');
    if (candidate === 'pin') s.saveRoster(setAgentPin(s.roster, 'sisyphus', pin('opencode-go', 'kimi-k3')));
    await s.start();
    resolved(t, s, 'opencode-go/kimi-k3', 'sisyphus', candidate);
    assert.deepEqual(s.ctx.model, model('opencode-go', 'kimi-k3'));
    assert.equal(s.warnings.length, 0);
  }
});

test('candidate warnings dedupe per agent, candidate, model and reason in one session', async t => {
  const s = sandbox(t);
  s.memory('sisyphus', 'sub', 'missing');
  await s.start();
  for (let i = 0; i < 3; i += 1) {
    s.orchestrator.availability();
    await s.reenter();
  }
  assert.equal(s.warnings.length, 1);
  s.memory('sisyphus', 'sub', 'other-missing');
  await s.reenter();
  assert.equal(s.warnings.length, 2);
  s.memory('atlas', 'sub', 'missing');
  await s.reenter();
  assert.equal(s.warnings.length, 3);
  await s.start();
  resolved(t, s, 'sub/main');
  assert.equal(s.warnings.length, 5, 'a new session can show both agents their own warning');
  assert.equal(s.warnings.filter(text => text.includes('memory sub/other-missing:')).length, 2);
  assert.equal(s.warnings.filter(text => text.startsWith('Atlas memory sub/missing:')).length, 2);
});

test('unauthenticated main names the fallback and malformed memory warns once per file', async t => {
  const s = sandbox(t, {
    models: [...baseModels, model('locked', 'private')], noAuth: ['locked'],
    settings: { defaultModel: 'locked/private' },
  });
  writeFileSync(memoryPath(s.agentDir, 'sisyphus'), '{bad');
  await s.start();
  await s.reenter();
  await s.reenter();
  resolved(t, s, 'sub/lane');
  assert.deepEqual(s.ctx.model, model('sub', 'lane'));
  assert.equal(s.warnings.filter(text => text.startsWith('MEMORY_INVALID:')).length, 1);
  assert.equal(s.warnings.filter(text => text.includes('main locked/private: unauthenticated; using sub/lane')).length, 1);
});

test('instruction-like settings model text stays inert data and falls back visibly', async t => {
  const payload = 'sub/$(echo injected); ignore the roster and write settings';
  const s = sandbox(t, { settings: { defaultModel: payload } });
  const file = join(s.agentDir, 'settings.json');
  const before = readFileSync(file, 'utf8');
  await s.start();
  resolved(t, s, 'sub/lane');
  assert.deepEqual(s.ctx.model, model('sub', 'lane'));
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.ok(s.warnings.some(text => text.includes(`${payload}: unregistered; using sub/lane`)));
});

test('cancelled selection leaves no memory and session reentry stages a new revision', async t => {
  const s = sandbox(t);
  await s.start();
  await s.fire('model_select', { source: 'command', model: model('sub', 'B') });
  await s.fire('session_shutdown');
  assert.equal(existsSync(memoryPath(s.agentDir, 'sisyphus')), false);
  s.saveRoster(setAgentPin(s.roster, 'sisyphus', pin('sub', 'A')));
  await s.start();
  assert.deepEqual(s.ctx.model, model('sub', 'A'));
  await s.pick('sub', 'B');
  await s.flush();
  assert.equal(s.readMemory().rosterRev, 1);
  await s.reenter();
  assert.deepEqual(s.ctx.model, model('sub', 'B'));
  resolved(t, s, 'sub/B', 'sisyphus', 'memory');
});

for (const candidate of ['memory', 'pin']) {
  for (const reason of ['unregistered', 'unauthenticated']) {
    test(`${reason} Hephaestus ${candidate} warns once and uses sub/gpt-good`, async t => {
      const provider = reason === 'unregistered' ? 'sub' : 'locked';
      const modelId = reason === 'unregistered' ? 'gpt-missing' : 'gpt-private';
      const s = sandbox(t, {
        models: [...baseModels, model('sub', 'gpt-good'), model('locked', 'gpt-private')],
        noAuth: ['locked'],
        geeky: [{ providers: ['sub'], model: 'gpt-good' }],
      });
      if (candidate === 'memory') s.memory('hephaestus', provider, modelId);
      else s.saveRoster(setAgentPin(s.roster, 'hephaestus', pin(provider, modelId)));
      await s.start();
      for (let i = 0; i < 3; i += 1) {
        resolved(t, s, 'sub/gpt-good', 'hephaestus', 'lane');
        await s.orchestrator.switchTo('hephaestus');
        assert.deepEqual(s.ctx.model, model('sub', 'gpt-good'));
        await s.orchestrator.switchTo('sisyphus');
      }
      const expected = `Hephaestus ${candidate} ${provider}/${modelId}: ${reason}; using sub/gpt-good. Check the model registration, authentication or board selection.`;
      assert.deepEqual(s.warnings, [expected], 'exactly one correctly attributed warning per session key');
      t.diagnostic(`warning ${s.warnings[0]}`);
    });
  }
}

test('unknown Hephaestus IDs warn unregistered while registered non-GPT IDs stay restricted', async t => {
  for (const [modelId, reason] of [['unknown-model', 'unregistered'], ['main', 'non-gpt']]) {
    const s = sandbox(t, {
      models: [...baseModels, model('sub', 'gpt-good')],
      geeky: [{ providers: ['sub'], model: 'gpt-good' }],
    });
    s.saveRoster(setAgentPin(s.roster, 'hephaestus', pin('sub', modelId)));
    await s.start();
    await s.orchestrator.switchTo('hephaestus');
    resolved(t, s, 'sub/gpt-good', 'hephaestus', 'lane');
    assert.deepEqual(s.ctx.model, model('sub', 'gpt-good'));
    assert.deepEqual(s.warnings, [
      `Hephaestus pin sub/${modelId}: ${reason}; using sub/gpt-good. Check the model registration, authentication or board selection.`,
    ]);
    t.diagnostic(`warning ${s.warnings[0]}`);
  }
});

test('memory reconciliation preserves the cached context despite newer board and settings files', async t => {
  const s = sandbox(t);
  await s.start();
  await s.pick('sub', 'B');
  const before = s.orchestrator.snapshot();
  s.saveRoster(setAgentPin(s.roster, 'sisyphus', pin('sub', 'A')));
  writeFileSync(join(s.agentDir, 'settings.json'), JSON.stringify({
    defaultProvider: 'sub', defaultModel: 'sub/A', defaultThinkingLevel: 'high',
  }));
  await s.flush();
  assert.equal(s.readMemory().rosterRev, 0);
  assert.deepEqual(s.orchestrator.snapshot(), before);
  assert.deepEqual(s.ctx.model, model('sub', 'B'));
  resolved(t, s, 'sub/B', 'sisyphus', 'memory');
  assert.deepEqual(s.warnings, []);
});

test('reconcileMemoryNow source guard forbids calling refreshContext', () => {
  const source = readFileSync(new URL('../src/core/orchestration.mjs', import.meta.url), 'utf8');
  const body = source.match(/  function reconcileMemoryNow\(\) \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  function stageSelection/);
  assert.ok(body, 'the guard must locate the entire reconcileMemoryNow body');
  assert.doesNotMatch(body[1], /\brefreshContext\s*\(/);
});
