// S19 - the real board store and built extension share one isolated agentDir.
// Host events are replayed in process: no server, PTY, credentials or model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createSandbox } from '../harness.mjs';
import { createOrchestrator } from '../../dist/src/core/orchestration.mjs';
import { readLaneOverrides } from '../../dist/contract/jsonc.mjs';
import { resolve } from '../../dist/contract/resolve.mjs';
import {
  defaultRoster, memoryPath, readMemory, readRoster, rosterPath,
} from '../../dist/contract/schema.mjs';

const ROLES = ['sisyphus', 'hephaestus', 'prometheus', 'atlas'];
const STAMP = '2026-11-04T00:00:00.000Z';
const A = { provider: 'kimi-coding', modelId: 'k3', thinking: 'medium' };
const B = { provider: 'openai', modelId: 'gpt-6-astra', thinking: 'low' };
const P = { provider: 'openai', modelId: 'gpt-5.6-sol', thinking: 'high' };
const ATLAS = { provider: 'openai', modelId: 'gpt-6-sol', thinking: 'high' };
const MODELS = [A, B, P, ATLAS,
  { provider: 'qa-mock', modelId: 'gpt-mock-fast' },
  { provider: 'qa-mock', modelId: 'claude-mock-medium' },
  { provider: 'qa-mock', modelId: 'claude-mock-heavy' },
].map(({ provider, modelId }) => ({ provider, id: modelId }));
const registry = {
  find: (provider, id) => provider
    ? MODELS.find(model => model.provider === provider && model.id === id)
    : MODELS.filter(model => model.id === id),
  getAvailable: () => MODELS,
  hasAuth: provider => MODELS.some(model => model.provider === provider),
};
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function tree(root, prefix = '') {
  const files = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, tree(root, key));
    else files[key] = createHash('sha256').update(readFileSync(join(root, key))).digest('hex');
  }
  return files;
}
function tuple(value) {
  return { provider: value.provider, modelId: value.modelId, thinking: value.thinking };
}

class Editor {
  handleInput() {}
  isShowingAutocomplete() { return false; }
  getText() { return ''; }
  getLines() { return ['']; }
  getCursor() { return { line: 0, col: 0 }; }
  setText() {}
}

function host(sandbox) {
  const handlers = new Map();
  const branch = [];
  let editor;
  const append = entry => branch.push({ ...entry, id: `s19-${branch.length}` });
  const ctx = {
    mode: 'tui', hasUI: true, cwd: sandbox.workDir, agentDir: sandbox.agentDir,
    model: registry.find(A.provider, A.modelId), thinkingLevel: A.thinking,
    isIdle: () => true, modelRegistry: registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => 's19' },
    ui: {
      setEditorComponent(factory) {
        editor = factory({}, {}, { matches: (data, action) => data === '\t' && action === 'tui.input.tab' });
      },
      getEditorComponent: () => null,
      setWidget() {}, setStatus() {}, setTitle() {}, notify() {},
    },
  };
  const pi = {
    sessionKind: 'interactive',
    on: (name, handler) => handlers.set(name, handler),
    registerCommand() {},
    async setSessionModel(model) {
      handlers.get('model_select')?.({ source: 'extension' }, ctx);
      ctx.model = model;
      append({ type: 'model_change', source: 'extension', provider: model.provider, modelId: model.id });
      return true;
    },
    setSessionThinkingLevel(thinkingLevel) {
      ctx.thinkingLevel = thinkingLevel;
      append({ type: 'thinking_level_change', thinkingLevel,
        thinkingSelection: { source: 'explicit', level: thinkingLevel } });
    },
    appendEntry: (customType, data) => append({ type: 'custom', customType, data }),
  };
  const core = createOrchestrator(pi, { EditorBase: Editor });
  const fire = (name, event = {}) => handlers.get(name)(event, ctx);
  return {
    core,
    start: () => fire('session_start', { reason: 'new' }),
    close: () => fire('session_shutdown'),
    async tab() { editor.handleInput('\t'); await core.settled(); },
    value() {
      const state = core.snapshot();
      assert.equal(state.pending, false);
      assert.equal(ctx.model.id, state.modelId);
      assert.equal(ctx.thinkingLevel, state.thinking);
      return { provider: ctx.model.provider, modelId: state.modelId, thinking: state.thinking };
    },
  };
}

export async function run({ out, boardRepo = process.env.BOARD_REPO } = {}) {
  assert.ok(boardRepo, 'set BOARD_REPO to the board worktree');
  const board = resolvePath(boardRepo);
  const { openProfilesStore } = await import(pathToFileURL(join(board, 'src/profiles/store.mjs')).href);
  const sandbox = createSandbox();
  const home = dirname(sandbox.agentDir);
  const settingsFile = join(sandbox.agentDir, 'settings.json');
  const configFile = join(home, 'omo.jsonc');
  const result = { ok: false };
  const hosts = new Set();
  try {
    const config = {
      memory: { recall: { tool_budget: 12 } },
      '[native]': {
        models: { 'roundtrip-memory': { model: 'openai/gpt-6-sol', reasoning: 'high' } },
        agents: {}, categories: { quick: { model: 'roundtrip-memory' } },
        memory: { recall: { tool_budget: 7 }, reflection: { enabled: false } },
        model_profiles: {
          'daily-normal': { models: [{ model: 'claude-mock-medium', providers: ['qa-mock'], thinking: 'medium' }] },
          'daily-heavy': { models: [{ model: 'claude-mock-heavy', providers: ['qa-mock'], thinking: 'high' }] },
          'geeky-normal': { models: [{ model: 'gpt-mock-fast', providers: ['qa-mock'], thinking: 'medium' }] },
        },
      },
      profiles: { 'native-gpt-kimi-deepseek': { '[native]': { agents: {}, categories: {} } } },
    };
    writeJson(configFile, config);
    writeJson(settingsFile, {
      ...readJson(settingsFile), defaultProvider: A.provider, defaultModel: A.modelId,
      defaultThinkingLevel: A.thinking, theme: 'roundtrip-protected',
      compaction: { enabled: false, reserveTokens: 1234, model: 'openai/gpt-5.6-sol' },
      modelThinkingLevels: { 'protected/model': 'high' },
    });
    for (const selection of [join(home, 'native-profile-selection.json'),
      join(sandbox.agentDir, 'native-profile-selection.json')]) {
      writeJson(selection, { key: 'gpt-kimi-deepseek', profile: 'native-gpt-kimi-deepseek', appliedAt: STAMP });
    }
    const pluginPath = join(sandbox.stateDir, 'fixture-plugin.mjs');
    writeFileSync(pluginPath, 's19-isolated-plugin');
    const inventory = readJson(join(board, 'src/profiles/inventory.json'));
    inventory.sources.omo.sha256 = createHash('sha256').update(readFileSync(pluginPath)).digest('hex');
    const composed = { unknown: false, models: MODELS.map(model => ({
      provider: model.provider, modelId: `${model.provider}/${model.id}`,
      levels: ['off', 'low', 'medium', 'high', 'max', 'xhigh'],
    })) };
    const store = openProfilesStore({
      primaryHome: home, stableHome: home, mirrorHomes: [], pluginPath, inventory,
      recommendationManifest: null, registry,
      registries: { primary: composed, stable: composed },
      now: () => Date.parse(STAMP),
    });
    const seedRoster = () => {
      const roster = defaultRoster(new Date(STAMP));
      roster.agents.sisyphus.pin = P;
      writeJson(rosterPath(sandbox.agentDir), roster);
      return roster;
    };
    const request = changes => {
      const state = store.state();
      return { action: 'apply', changes, expected: state.targets, rosterRevision: state.roster.revision };
    };
    const apply = changes => {
      const before = readRoster(sandbox.agentDir).roster;
      const applied = store.apply(request(changes));
      assert.equal(applied.ok, true, JSON.stringify(applied));
      const after = readRoster(sandbox.agentDir).roster;
      assert.equal(applied.rosterRevision, after.revision, 'returned revision is authoritative');
      assert.equal(after.revision, before.revision + 1, 'one roster CAS per apply');
      return { applied, before, after };
    };
    const unchangedRoles = (before, after, changed) => {
      for (const role of ROLES.filter(role => role !== changed)) {
        assert.deepEqual(after.agents[role], before.agents[role], `${changed} apply changed ${role}`);
      }
    };
    const startHost = async () => {
      const h = host(sandbox); hosts.add(h); await h.start(); return h;
    };
    const closeHost = async h => { await h.close(); hosts.delete(h); };
    const parity = async () => {
      const state = store.state();
      const roster = readRoster(sandbox.agentDir).roster;
      const settings = readJson(settingsFile);
      const lanes = readLaneOverrides(home).overrides;
      const h = await startHost();
      const rows = [];
      for (const role of ROLES) {
        const agent = roster.agents[role];
        const effectiveRoster = role === 'sisyphus' && agent.pin === null
          ? { ...roster, agents: { ...roster.agents, [role]: { ...agent, pin: {
            provider: settings.defaultProvider, modelId: settings.defaultModel, thinking: settings.defaultThinkingLevel,
          } } } }
          : roster;
        const resolved = resolve({ agentId: role, roster: effectiveRoster,
          memory: readMemory(sandbox.agentDir, role).memory, laneOverrides: lanes, registry });
        assert.equal(resolved.unavailable, undefined, `${role} must resolve`);
        const effective = tuple(state.roster.agents[role].effective);
        assert.deepEqual(effective, tuple(resolved), `${role}: board effective must equal resolve(model)`);
        await h.core.switchTo(role);
        const extension = h.value();
        assert.deepEqual(extension, tuple(resolved), `${role}: extension must equal resolve(model)`);
        rows.push({ role, effective, resolved: tuple(resolved), extension, rev: agent.rev });
      }
      await closeHost(h);
      return rows;
    };

    seedRoster();
    assert.equal(existsSync(memoryPath(sandbox.agentDir, 'sisyphus')), false, 'missing memory fixture');
    const atlas = apply([{ kind: 'setAgentPin', agentId: 'atlas', pin: ATLAS }]);
    unchangedRoles(atlas.before, atlas.after, 'atlas');
    assert.equal(atlas.after.agents.atlas.rev, 1);
    assert.deepEqual(atlas.after.agents.atlas.pin, ATLAS);
    result.atlas = { returnedRevision: atlas.applied.rosterRevision, roles: await parity() };
    const main = apply([{ kind: 'setMain', provider: A.provider, model: A.modelId, thinking: 'high' }]);
    unchangedRoles(main.before, main.after, 'sisyphus');
    assert.equal(main.after.agents.sisyphus.pin, null);
    assert.equal(main.after.agents.sisyphus.rev, 1);
    result.main = { returnedRevision: main.applied.rosterRevision, roles: await parity() };
    result.roles = result.main.roles;

    const caseB = async change => {
      seedRoster();
      writeJson(memoryPath(sandbox.agentDir, 'sisyphus'), {
        v: 1, agentId: 'sisyphus', model: { provider: B.provider, modelId: B.modelId },
        thinking: B.thinking, rosterRev: 0, updatedAt: STAMP,
      });
      const memoryBefore = readFileSync(memoryPath(sandbox.agentDir, 'sisyphus'));
      const settingsBefore = readFileSync(settingsFile);
      const h = await startHost();
      assert.deepEqual(h.value(), B, 'matching memory B wins over pin P');
      assert.deepEqual(tuple(store.state().roster.agents.sisyphus.effective), B);
      await h.tab();
      assert.equal(h.core.current, 'hephaestus');
      const { applied, before, after } = apply([change]);
      unchangedRoles(before, after, 'sisyphus');
      assert.equal(after.agents.sisyphus.pin, null);
      assert.equal(after.agents.sisyphus.rev, 1);
      assert.deepEqual(readFileSync(settingsFile), settingsBefore, 'active main settings A are unchanged');
      assert.deepEqual(readFileSync(memoryPath(sandbox.agentDir, 'sisyphus')), memoryBefore,
        'board invalidates matching memory by rev, without writing extension memory');
      await h.tab();
      assert.equal(h.core.current, 'sisyphus');
      const tabReturn = h.value();
      assert.deepEqual(tabReturn, A, 'Tab return reads settings A, ignoring stale memory B');
      await closeHost(h);
      const fresh = await startHost();
      const freshRead = fresh.value();
      assert.deepEqual(freshRead, A, 'fresh extension read observes settings A');
      await closeHost(fresh);
      assert.deepEqual(tuple(store.state().roster.agents.sisyphus.effective), A);
      return { before: { pin: P, rev: 0, memory: B, memoryRev: 0, settings: A, effective: B },
        after: { pin: null, rev: 1, memoryRev: 0, tabReturn, freshRead,
          effective: tuple(store.state().roster.agents.sisyphus.effective) },
        returnedRevision: applied.rosterRevision };
    };
    result.caseB = await caseB({ kind: 'selectProfile', profileKey: 'gpt-kimi-deepseek' });
    result.sameMain = await caseB({ kind: 'setMain', provider: A.provider, model: A.modelId, thinking: 'high' });

    const configBefore = readJson(configFile);
    const settingsBefore = readJson(settingsFile);
    const rosterBefore = readFileSync(rosterPath(sandbox.agentDir));
    const memoryBefore = readFileSync(memoryPath(sandbox.agentDir, 'sisyphus'));
    const protectedBefore = tree(sandbox.stateDir);
    const writers = store.apply(request([
      { kind: 'setMemoryRow', row: 'kibitzer', mode: 'custom', model: 'openai/gpt-6-sol', reasoning: 'high' },
      { kind: 'setSummarizer', modelId: 'openai/gpt-6-sol' },
    ]));
    assert.equal(writers.ok, true, JSON.stringify(writers));
    const configAfter = readJson(configFile);
    const settingsAfter = readJson(settingsFile);
    assert.equal(configAfter['[native]'].memory.recall.category, 'desktop-kibitzer');
    const category = configAfter['[native]'].categories['desktop-kibitzer'];
    assert.equal(category.model, 'roundtrip-memory');
    assert.equal(category.reasoning, 'high');
    const digest = createHash('sha256').update(JSON.stringify([
      'roundtrip-memory', 'openai/gpt-6-sol', 'high',
    ])).digest('hex');
    assert.deepEqual(category, { description: `omo-native-profile-switcher:kibitzer:2:${digest}`,
      model: 'roundtrip-memory', reasoning: 'high' });
    const expectedConfig = structuredClone(configBefore);
    expectedConfig['[native]'].memory.recall.category = 'desktop-kibitzer';
    expectedConfig['[native]'].categories['desktop-kibitzer'] = category;
    assert.deepEqual(configAfter, expectedConfig, 'memory writer changes only its category and recall pointer');
    const expectedSettings = structuredClone(settingsBefore);
    expectedSettings.compaction.model = 'openai/gpt-6-sol';
    assert.deepEqual(settingsAfter, expectedSettings, 'summary keeps every protected setting key');
    assert.deepEqual(readFileSync(rosterPath(sandbox.agentDir)), rosterBefore);
    assert.deepEqual(readFileSync(memoryPath(sandbox.agentDir, 'sisyphus')), memoryBefore);
    assert.deepEqual(writers.writes.slice().sort(), ['agent/settings.json', 'omo.jsonc']);
    const protectedAfter = tree(sandbox.stateDir);
    for (const [file, hash] of Object.entries(protectedBefore)) {
      if (file.endsWith('/omo.jsonc') || file.endsWith('/agent/settings.json')
        || file.includes('/native-profile-switcher-backups/') || file.endsWith('/apply-journal.json')) continue;
      assert.equal(protectedAfter[file], hash, `unrelated fixture file changed: ${file}`);
    }
    result.writers = { targets: writers.writes.slice().sort(), otherKeysUnchanged: true,
      memory: { category: 'desktop-kibitzer', model: category.model, reasoning: category.reasoning },
      summary: settingsAfter.compaction.model };

    const pending = request([{ kind: 'setMain', provider: A.provider, model: A.modelId, thinking: 'high' }]);
    const previewBefore = tree(sandbox.stateDir);
    const preview = store.preview({ ...pending, action: 'preview' });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.deepEqual(tree(sandbox.stateDir), previewBefore, 'preview writes zero files, including journal and backups');
    // Another board apply moves the roster after the pending request was read.
    apply([{ kind: 'setAgentPin', agentId: 'atlas', pin: ATLAS }]);
    const staleBefore = tree(sandbox.stateDir);
    const stale = store.apply(pending);
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'STALE');
    assert.deepEqual(tree(sandbox.stateDir), staleBefore, 'STALE performs zero partial writes');
    result.stale = { ok: stale.ok, code: stale.code, zeroPartialWrites: true, previewZeroWrites: true };
    result.ok = true;
  } finally {
    try {
      for (const h of hosts) await h.close();
    } finally {
      const cleanup = sandbox.cleanup();
      assert.equal(existsSync(sandbox.agentDir), false, 'temporary agentDir must be removed');
      result.cleanup = { removed: cleanup.removed, agentDirExists: false, processesStarted: 0, portsOpened: 0 };
      if (out) {
        mkdirSync(out, { recursive: true });
        writeJson(join(out, 'roundtrip.json'), result);
        writeFileSync(join(out, 'cleanup-receipt.json'), `${JSON.stringify(result.cleanup, null, 2)}\n`);
        if (result.stale) writeFileSync(join(out, 'stale-case.txt'), `${JSON.stringify(result.stale, null, 2)}\n`);
      }
    }
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(import.meta.filename)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  await run({ out: values.out });
}
