// Board store -> extension orchestrator, with no SDK, credentials or model calls.
// Like t14-e2e and lib.mjs, keep the agent dir disposable and retain only receipts.
// The fixture host follows test/orchestration.test.mjs; the real editor handles Tab.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_IDS } from '../../contract/constants.mjs';
import { defaultRoster, memoryPath, rosterPath } from '../../contract/schema.mjs';
import { createOrchestrator } from '../../src/core/orchestration.mjs';
import { MOCK_MODELS, PROVIDER_ID } from '../mock-extension.mjs';

const BOARD_REPO = process.env.BOARD_REPO;
assert.ok(BOARD_REPO, 'BOARD_REPO must name the board worktree');
const OUT = 'C:/Users/USER/orca/projects/기타 작업/.omo/evidence/profile-agent-switcher-v2/task-9';
const PROFILE = 'gpt-kimi-deepseek';
const PROFILE_KEY = 'native-gpt-kimi-deepseek';
const STAMP = '2026-11-04T00:00:00Z';
const PIN = { provider: PROVIDER_ID, modelId: 'gpt-mock-sol', thinking: 'medium' };
const MAIN = { provider: PROVIDER_ID, modelId: 'claude-mock-max', thinking: 'medium' };
const LEGACY_PIN = { provider: PROVIDER_ID, modelId: 'gpt-mock-astra', thinking: 'high' };
const MEMORY = { provider: PROVIDER_ID, modelId: 'claude-mock-xhigh' };
const models = MOCK_MODELS.map(model => ({ ...model, provider: PROVIDER_ID }));
const registry = {
  find: (provider, id) => models.find(model => model.provider === provider && model.id === id),
  getAvailable: () => models,
};
const served = {
  models: models.map(model => ({
    provider: model.provider, modelId: `${model.provider}/${model.id}`, levels: ['medium', 'high'],
  })),
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function selection(value) {
  return { provider: value.provider, modelId: value.modelId, thinking: value.thinking };
}
function assertTemporary(directory) {
  const rel = relative(realpathSync(tmpdir()), realpathSync(directory));
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(rel), `refusing a path outside tmpdir: ${directory}`);
}
function snapshot(directory) {
  const files = {};
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of Object.entries(snapshot(file))) files[`${entry.name}/${name}`] = bytes;
    } else {
      files[entry.name] = readFileSync(file).toString('base64');
    }
  }
  return files;
}

class FixtureEditor {
  handleInput() {}
  isShowingAutocomplete() { return false; }
  getText() { return ''; }
  getLines() { return ['']; }
  getCursor() { return { line: 0, col: 0 }; }
}

// Run production resolution and switching, replacing only the host API. The host
// starts a fresh session with settings main, as the native runtime does.
async function extensionSession(agentDir, root, reason = 'resume') {
  const handlers = new Map();
  const branch = [];
  const calls = [];
  let editor = null;
  let editorFactory = null;
  const settings = json(join(agentDir, 'settings.json'));
  const ctx = {
    mode: 'tui', hasUI: true, cwd: root, agentDir,
    model: registry.find(settings.defaultProvider, settings.defaultModel),
    thinkingLevel: settings.defaultThinkingLevel,
    modelRegistry: registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => `s19-${reason}` },
    isIdle: () => true,
    loadedExtensionPaths: [],
    ui: {
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory) {
        editorFactory = factory;
        editor = factory({}, {}, {
          matches: (data, action) => data === '\t' && action === 'tui.input.tab',
        });
        editor.onSubmit = () => {};
      },
      setWidget() {}, setStatus() {}, setTitle() {},
      notify(message, type) { calls.push({ kind: 'notice', message, type }); },
    },
  };
  const pi = {
    sessionKind: 'interactive',
    on(event, handler) { handlers.set(event, handler); },
    registerCommand() {},
    async setSessionModel(model) {
      calls.push({ kind: 'model', provider: model.provider, modelId: model.id });
      ctx.model = model;
      return true;
    },
    setSessionThinkingLevel(level) {
      ctx.thinkingLevel = level;
      branch.push({
        type: 'thinking_level_change', id: `thinking-${branch.length}`,
        thinkingLevel: level, thinkingSelection: { level, source: 'explicit' },
      });
    },
    appendEntry(customType, data) {
      branch.push({ type: 'custom', customType, id: `identity-${branch.length}`, data });
    },
  };
  const orchestrator = createOrchestrator(pi, { EditorBase: FixtureEditor });
  await handlers.get('session_start')({ type: 'session_start', reason }, ctx);
  assert.equal(orchestrator.active, true);
  assert.ok(editor, 'the extension installed its production Tab editor');
  return {
    orchestrator, calls,
    actual: () => ({ provider: ctx.model.provider, modelId: ctx.model.id, thinking: ctx.thinkingLevel }),
    async tab() {
      editor.handleInput('\t');
      await orchestrator.settled();
    },
    shutdown: () => handlers.get('session_shutdown')({ type: 'session_shutdown' }, ctx),
  };
}

const record = {
  ok: false, startedAt: new Date().toISOString(), boardRepo: resolve(BOARD_REPO),
  command: `BOARD_REPO="${BOARD_REPO}" node qa/scenarios/s19-board-roundtrip.mjs`,
  host: 'fixture ExtensionAPI and registry; production orchestrator and Tab editor',
  modelCalls: 0,
};
let root;
try {
  const { openProfilesStore } = await import(pathToFileURL(join(resolve(BOARD_REPO), 'src/profiles/store.mjs')));
  record.boardHead = execFileSync('git', ['-C', BOARD_REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  root = mkdtempSync(join(tmpdir(), 'piomo-s19-roundtrip-'));
  assertTemporary(root);
  const home = join(root, 'home', '.omo');
  const agentDir = join(home, 'agent');
  mkdirSync(join(agentDir, 'primary-agents', 'memory'), { recursive: true });
  assertTemporary(home);
  assertTemporary(agentDir);
  record.sandbox = { root, home, agentDir, underTmpdir: true };

  const fixtures = join(BOARD_REPO, 'test/fixtures/profiles/goldens/apply-gpt-kimi-deepseek/files/primary');
  copyFileSync(join(fixtures, 'omo.jsonc.json'), join(home, 'omo.jsonc'));
  copyFileSync(join(fixtures, 'settings.json.json'), join(agentDir, 'settings.json'));
  const config = json(join(home, 'omo.jsonc'));
  config['[native]'].model_profiles = Object.fromEntries([
    ['daily-normal', 'claude-mock-medium'], ['daily-heavy', 'claude-mock-xhigh'],
    ['geeky-normal', 'gpt-mock-fast'], ['geeky-heavy', 'gpt-mock-astra'],
  ].map(([lane, model]) => [lane, { models: [{ providers: [PROVIDER_ID], model, variant: 'medium' }] }]));
  writeJson(join(home, 'omo.jsonc'), config);
  // Preserve copied fixture settings; replace only main values used in this run.
  const settings = json(join(agentDir, 'settings.json'));
  Object.assign(settings, {
    defaultProvider: PROVIDER_ID, defaultModel: 'claude-mock-medium', defaultThinkingLevel: 'medium',
  });
  writeJson(join(agentDir, 'settings.json'), settings);
  writeJson(join(home, 'native-profile-selection.json'), { key: PROFILE, profile: PROFILE_KEY });
  const roster = defaultRoster(STAMP);
  roster.revision = 4;
  AGENT_IDS.forEach((id, index) => { roster.agents[id].rev = index + 10; });
  roster.agents.sisyphus.pin = LEGACY_PIN;
  writeJson(rosterPath(agentDir), roster);
  writeJson(memoryPath(agentDir, 'sisyphus'), {
    v: 1, agentId: 'sisyphus', model: MEMORY, thinking: 'medium',
    rosterRev: roster.agents.sisyphus.rev, updatedAt: STAMP,
  });

  // Inject every root and registry, including the recommendation path and plugin
  // hash fixture, so store defaults cannot read the owner's installed home.
  const plugin = join(root, 'fixture-plugin.mjs');
  writeFileSync(plugin, '// s19 fixture plugin; never executed\n');
  const inventory = json(join(BOARD_REPO, 'src/profiles/inventory.json'));
  inventory.sources.omo.sha256 = sha256(readFileSync(plugin));
  const store = openProfilesStore({
    primaryHome: home, stableHome: home, mirrorHomes: [],
    pluginPath: plugin, inventory, registry,
    registries: { primary: served, stable: served },
    recommendationManifestPath: join(root, 'absent-recommendations.json'),
  });
  function request(changes, state = store.state()) {
    return { action: 'apply', changes, expected: state.targets, rosterRevision: state.roster.revision };
  }
  function apply(changes) {
    const response = store.handle(request(changes));
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.json.ok, true);
    return response.json;
  }
  const initial = store.state();
  assert.equal(initial.readOnly, false, initial.readOnlyReason);
  assert.equal(initial.activeProfile.key, PROFILE);
  record.apply = apply([
    { kind: 'setAgentPin', agentId: 'atlas', pin: PIN },
    { kind: 'setMain', profileKey: initial.activeProfile.key,
      provider: MAIN.provider, model: MAIN.modelId, thinking: MAIN.thinking },
  ]);
  const after = json(rosterPath(agentDir));
  record.revisions = AGENT_IDS.map(agentId => ({
    agentId, before: roster.agents[agentId].rev, after: after.agents[agentId].rev,
    delta: after.agents[agentId].rev - roster.agents[agentId].rev,
  }));
  for (const row of record.revisions) {
    assert.equal(row.delta, row.agentId === 'atlas' || row.agentId === 'sisyphus' ? 1 : 0);
  }
  assert.equal(after.revision, roster.revision + 1);
  record.legacyPinCleared = after.agents.sisyphus.pin === null;
  assert.equal(record.legacyPinCleared, true);
  assert.deepEqual(after.agents.atlas.pin, PIN);
  const appliedSettings = json(join(agentDir, 'settings.json'));
  assert.equal(appliedSettings.defaultProvider, MAIN.provider);
  assert.equal(appliedSettings.defaultModel, MAIN.modelId);
  const boardAgents = store.state().roster.agents;
  const session = await extensionSession(agentDir, root);
  try {
    record.agents = AGENT_IDS.map(agentId => {
      const boardEffective = boardAgents[agentId].effective;
      const extensionResolution = session.orchestrator.availability()[agentId];
      return {
        agentId, boardEffective, extensionResolution,
        equal: JSON.stringify(boardEffective) === JSON.stringify(extensionResolution),
      };
    });
    // Populate every row before refusing a mismatch, so the receipt names all disagreements.
    assert.deepEqual(record.agents.filter(row => !row.equal), [], 'board/extension disagreement; see receipt');
    assert.equal((await session.orchestrator.switchTo('atlas')).switched, true);
    record.atlasEntry = session.actual();
    assert.deepEqual(record.atlasEntry, PIN);
    assert.equal((await session.orchestrator.switchTo('sisyphus')).switched, true);
    record.sisyphusEntry = session.actual();
    assert.deepEqual(record.sisyphusEntry, MAIN);
  } finally {
    await session.shutdown();
  }

  // Binding case B: P pin + B memory at the current rev + A settings main.
  // Keep the extension session open across selectProfile, then use its real Tab handler.
  const beforeB = json(rosterPath(agentDir));
  beforeB.agents.sisyphus.pin = LEGACY_PIN;
  writeJson(rosterPath(agentDir), beforeB);
  writeJson(memoryPath(agentDir, 'sisyphus'), {
    v: 1, agentId: 'sisyphus', model: MEMORY, thinking: 'medium',
    rosterRev: beforeB.agents.sisyphus.rev, updatedAt: STAMP,
  });
  const memoryBeforeB = readFileSync(memoryPath(agentDir, 'sisyphus'));
  const returning = await extensionSession(agentDir, root);
  try {
    const beforeResolution = returning.orchestrator.availability().sisyphus;
    assert.equal(beforeResolution.origin, 'memory');
    assert.equal(beforeResolution.modelId, MEMORY.modelId);
    assert.equal((await returning.orchestrator.switchTo('atlas')).switched, true);
    const applied = apply([{ kind: 'selectProfile', profileKey: store.state().activeProfile.key }]);
    const afterB = json(rosterPath(agentDir));
    assert.equal(afterB.agents.sisyphus.pin, null);
    assert.equal(afterB.agents.sisyphus.rev, beforeB.agents.sisyphus.rev + 1);
    for (const id of AGENT_IDS.filter(id => id !== 'sisyphus')) {
      assert.deepEqual(afterB.agents[id], beforeB.agents[id]);
    }
    assert.ok(readFileSync(memoryPath(agentDir, 'sisyphus')).equals(memoryBeforeB));
    await returning.tab();
    assert.equal(returning.orchestrator.current, 'sisyphus');
    record.caseB = {
      before: { pin: LEGACY_PIN, memory: beforeResolution, settingsMain: MAIN },
      apply: applied, pinCleared: true,
      revBefore: beforeB.agents.sisyphus.rev, revAfter: afterB.agents.sisyphus.rev,
      memoryBytesUnchanged: true, tabReturn: returning.actual(),
      tabResolution: returning.orchestrator.availability().sisyphus,
    };
    assert.deepEqual(record.caseB.tabReturn, MAIN);
    const fresh = await extensionSession(agentDir, root, 'new');
    try {
      record.caseB.freshSession = fresh.actual();
      record.caseB.freshResolution = fresh.orchestrator.availability().sisyphus;
      assert.deepEqual(record.caseB.freshSession, MAIN);
      assert.deepEqual(selection(record.caseB.freshResolution), MAIN);
      assert.equal(record.caseB.freshResolution.origin, 'main');
    } finally {
      await fresh.shutdown();
    }
  } finally {
    await returning.shutdown();
  }

  // Reuse one session's expected bytes, then simulate a concurrent roster write.
  const staleRequest = request([{ kind: 'setAgentPin', agentId: 'atlas', pin: LEGACY_PIN }]);
  const concurrent = json(rosterPath(agentDir));
  concurrent.revision += 1;
  concurrent.agents.prometheus.rev += 1;
  writeJson(rosterPath(agentDir), concurrent);
  const beforeStale = snapshot(root);
  const refused = store.handle(staleRequest);
  const afterStale = snapshot(root);
  record.stale = {
    status: refused.status, code: refused.json.code, refused: !refused.json.ok,
    filesByteUnchanged: JSON.stringify(beforeStale) === JSON.stringify(afterStale),
    files: Object.keys(beforeStale).map(file => ({
      file, beforeSha256: sha256(Buffer.from(beforeStale[file], 'base64')),
      afterSha256: afterStale[file] === undefined ? null : sha256(Buffer.from(afterStale[file], 'base64')),
      equal: beforeStale[file] === afterStale[file],
    })),
  };
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'STALE');
  assert.equal(record.stale.refused, true);
  assert.deepEqual(afterStale, beforeStale, 'STALE refusal must leave the entire temp tree byte-unchanged');
  record.ok = true;
} catch (error) {
  record.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    record.cleanup = { root, removed: !existsSync(root) };
    if (!record.cleanup.removed) {
      record.ok = false;
      process.exitCode = 1;
    }
  }
  record.endedAt = new Date().toISOString();
  writeJson(join(OUT, 'roundtrip.json'), record);
  console.log(JSON.stringify({
    ok: record.ok, receipt: join(OUT, 'roundtrip.json'), agents: record.agents,
    caseB: record.caseB, stale: record.stale, cleanup: record.cleanup, error: record.error,
  }, null, 2));
}
