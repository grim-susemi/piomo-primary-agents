import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGENT_IDS, BUILTIN_CHAINS, COLORS, DEFAULT_LANE, DISPLAY, LANES, THINKING,
} from '../contract/constants.mjs';
import {
  defaultRoster, memoryPath, readMemory, readRoster, resetAgentMemory,
  rosterPath, setAgentLane, setAgentPin, validateMemory, validateRoster,
} from '../contract/schema.mjs';
import { resolve } from '../contract/resolve.mjs';
import { parseJsonc, readLaneOverrides } from '../contract/jsonc.mjs';

const NOW = new Date('2026-10-20T00:00:00.000Z');

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'piomo-contract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function registry(models, authed = []) {
  return {
    find(provider, modelId) {
      return models.filter(model => (provider === undefined || provider === null || model.provider === provider)
        && model.modelId === modelId);
    },
    hasAuth(provider) {
      return authed.includes(provider);
    },
  };
}

function rosterWith(mutate) {
  const roster = defaultRoster(NOW);
  mutate(roster);
  return roster;
}

function memoryFor(agentId, revision, model, thinking) {
  return {
    v: 1,
    agentId,
    model,
    thinking,
    rosterRev: revision,
    updatedAt: NOW.toISOString(),
  };
}

const BUILTIN_DAILY = [{ provider: 'anthropic-subscription', modelId: 'claude-opus-5-5' }];
const BUILTIN_GEEKY = [{ provider: 'chatgpt-subscription', modelId: 'gpt-6.1-sol-fast' }];

test('constants: agent ids, display names, colours, lanes and thinking are fixed', () => {
  assert.deepEqual(AGENT_IDS, ['sisyphus', 'hephaestus', 'prometheus', 'atlas']);
  assert.deepEqual(AGENT_IDS.map(id => DISPLAY[id]), ['Sisyphus', 'Hephaestus', 'Prometheus', 'Atlas']);
  assert.deepEqual(AGENT_IDS.map(id => COLORS[id]), ['#00CED1', '#D97706', '#A78BFA', '#10B981']);
  assert.deepEqual(LANES, ['daily-normal', 'daily-heavy', 'geeky-normal', 'geeky-heavy']);
  assert.deepEqual(AGENT_IDS.map(id => DEFAULT_LANE[id]), [
    'daily-normal', 'geeky-normal', 'daily-heavy', 'daily-normal',
  ]);
  assert.deepEqual(THINKING, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('constants: builtin chains keep the switcher order, variants and provider lists', () => {
  assert.deepEqual(Object.keys(BUILTIN_CHAINS), ['daily-normal', 'daily-heavy', 'geeky-normal', 'geeky-heavy']);
  assert.deepEqual(BUILTIN_CHAINS['daily-normal'].map(rung => [rung.model, rung.variant]), [
    ['claude-opus-5-5', 'medium'], ['kimi-k3', 'max'], ['glm-5.3', 'max'],
  ]);
  assert.deepEqual(BUILTIN_CHAINS['daily-heavy'].map(rung => [rung.model, rung.variant]), [
    ['claude-fable-5-1', 'xhigh'],
  ]);
  assert.deepEqual(BUILTIN_CHAINS['geeky-normal'].map(rung => [rung.model, rung.variant]), [
    ['gpt-6.1-sol-fast', 'medium'], ['gpt-6.1-sol', 'medium'], ['gpt-5.6-sol', 'medium'],
  ]);
  assert.deepEqual(BUILTIN_CHAINS['geeky-heavy'].map(rung => [rung.model, rung.variant]), [
    ['gpt-6-astra', 'high'],
  ]);
  assert.deepEqual(BUILTIN_CHAINS['daily-normal'][0].providers, [
    'anthropic-subscription', 'anthropic', 'anthropic-api', 'github-copilot', 'opencode',
  ]);
  assert.deepEqual(BUILTIN_CHAINS['daily-normal'][1].providers, [
    'kimi-coding', 'kimi-for-coding', 'moonshotai', 'opencode-go',
  ]);
  assert.deepEqual(BUILTIN_CHAINS['daily-normal'][2].providers, ['zai', 'zai-coding-cn', 'opencode-go']);
  assert.deepEqual(BUILTIN_CHAINS['daily-heavy'][0].providers, [
    'anthropic-subscription', 'anthropic', 'anthropic-api', 'github-copilot', 'opencode',
  ]);
  assert.deepEqual(BUILTIN_CHAINS['geeky-normal'][0].providers, ['chatgpt-subscription', 'openai']);
  assert.deepEqual(BUILTIN_CHAINS['geeky-normal'][2].providers, [
    'chatgpt-subscription', 'openai', 'github-copilot', 'opencode',
  ]);
  assert.deepEqual(BUILTIN_CHAINS['geeky-heavy'][0].providers, [
    'chatgpt-subscription', 'openai', 'github-copilot', 'opencode',
  ]);
});

test('resolve origin builtin: first authenticated rung of the default lane', () => {
  const result = resolve({
    agentId: 'sisyphus',
    roster: defaultRoster(NOW),
    memory: null,
    laneOverrides: {},
    registry: registry(BUILTIN_DAILY, ['anthropic-subscription']),
  });
  assert.deepEqual(result, {
    provider: 'anthropic-subscription',
    modelId: 'claude-opus-5-5',
    thinking: 'medium',
    origin: 'builtin',
  });
});

test('resolve origin lane: a P8 lane override replaces the builtin chain', () => {
  const result = resolve({
    agentId: 'sisyphus',
    roster: defaultRoster(NOW),
    memory: null,
    laneOverrides: { 'daily-normal': { models: [{ model: 'custom-heavy', variant: 'high' }] } },
    registry: registry([
      ...BUILTIN_DAILY,
      { provider: 'anthropic-subscription', modelId: 'custom-heavy' },
    ], ['anthropic-subscription']),
  });
  assert.deepEqual(result, {
    provider: 'anthropic-subscription',
    modelId: 'custom-heavy',
    thinking: 'high',
    origin: 'lane',
  });
});

test('resolve origin pin: the roster pin beats the lane chain', () => {
  const roster = rosterWith(current => {
    current.agents.sisyphus.pin = { provider: 'zai', modelId: 'glm-5.3', thinking: 'max' };
  });
  const result = resolve({
    agentId: 'sisyphus',
    roster,
    memory: null,
    laneOverrides: {},
    registry: registry([
      ...BUILTIN_DAILY,
      { provider: 'zai', modelId: 'glm-5.3' },
    ], ['anthropic-subscription', 'zai']),
  });
  assert.deepEqual(result, {
    provider: 'zai',
    modelId: 'glm-5.3',
    thinking: 'max',
    origin: 'pin',
  });
});

test('resolve origin memory: memory written for the current rev wins', () => {
  const roster = defaultRoster(NOW);
  roster.agents.sisyphus.rev = 4;
  const result = resolve({
    agentId: 'sisyphus',
    roster,
    memory: memoryFor('sisyphus', 4, { provider: 'kimi-coding', modelId: 'kimi-k3' }, 'high'),
    laneOverrides: {},
    registry: registry([
      ...BUILTIN_DAILY,
      { provider: 'kimi-coding', modelId: 'kimi-k3' },
    ], ['anthropic-subscription', 'kimi-coding']),
  });
  assert.deepEqual(result, {
    provider: 'kimi-coding',
    modelId: 'kimi-k3',
    thinking: 'high',
    origin: 'memory',
  });
});

test('resolve stale rosterRev is ignored and the pin wins', () => {
  const roster = rosterWith(current => {
    current.agents.sisyphus.rev = 4;
    current.agents.sisyphus.pin = { provider: 'zai', modelId: 'glm-5.3', thinking: 'medium' };
  });
  const result = resolve({
    agentId: 'sisyphus',
    roster,
    memory: memoryFor('sisyphus', 3, { provider: 'kimi-coding', modelId: 'kimi-k3' }, 'high'),
    laneOverrides: {},
    registry: registry([
      { provider: 'kimi-coding', modelId: 'kimi-k3' },
      { provider: 'zai', modelId: 'glm-5.3' },
    ], ['kimi-coding', 'zai']),
  });
  assert.equal(result.origin, 'pin');
  assert.equal(result.modelId, 'glm-5.3');
});

test('pin and lane changes bump rev and beat older memory', () => {
  let roster = defaultRoster(NOW);
  roster.agents.sisyphus.rev = 2;
  const memory = memoryFor('sisyphus', 2, { provider: 'kimi-coding', modelId: 'kimi-k3' }, 'high');
  const reg = registry([
    { provider: 'kimi-coding', modelId: 'kimi-k3' },
    { provider: 'zai', modelId: 'glm-5.3' },
    { provider: 'anthropic-subscription', modelId: 'claude-fable-5-1' },
  ], ['kimi-coding', 'zai', 'anthropic-subscription']);

  const before = resolve({ agentId: 'sisyphus', roster, memory, laneOverrides: {}, registry: reg });
  assert.equal(before.origin, 'memory');

  roster = setAgentPin(roster, 'sisyphus', { provider: 'zai', modelId: 'glm-5.3', thinking: 'low' });
  assert.equal(roster.agents.sisyphus.rev, 3);
  const afterPin = resolve({ agentId: 'sisyphus', roster, memory, laneOverrides: {}, registry: reg });
  assert.equal(afterPin.origin, 'pin');
  assert.equal(afterPin.thinking, 'low');

  roster = setAgentLane(roster, 'sisyphus', 'daily-heavy');
  assert.equal(roster.agents.sisyphus.rev, 4);
  const afterLane = resolve({ agentId: 'sisyphus', roster, memory, laneOverrides: {}, registry: reg });
  assert.equal(afterLane.origin, 'pin');
  assert.equal(afterLane.modelId, 'glm-5.3');

  const noPin = {
    ...roster,
    agents: { ...roster.agents, sisyphus: { ...roster.agents.sisyphus, pin: null } },
  };
  const afterHeavyLane = resolve({ agentId: 'sisyphus', roster: noPin, memory, laneOverrides: {}, registry: reg });
  assert.equal(afterHeavyLane.origin, 'builtin');
  assert.equal(afterHeavyLane.modelId, 'claude-fable-5-1');
  assert.equal(afterHeavyLane.thinking, 'xhigh');

  roster = resetAgentMemory(roster, 'sisyphus');
  assert.equal(roster.agents.sisyphus.rev, 5);
});

test('resolve prefers anthropic-subscription over anthropic for the same model', () => {
  const result = resolve({
    agentId: 'sisyphus',
    roster: defaultRoster(NOW),
    memory: null,
    laneOverrides: {},
    registry: registry([
      { provider: 'anthropic', modelId: 'claude-opus-5-5' },
      { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5' },
    ], ['anthropic-subscription']),
  });
  assert.equal(result.provider, 'anthropic-subscription');
  assert.equal(result.origin, 'builtin');
});

test('resolve walks providers in order and skips a provider without auth', () => {
  const result = resolve({
    agentId: 'sisyphus',
    roster: defaultRoster(NOW),
    memory: null,
    laneOverrides: {},
    registry: registry([
      { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5' },
      { provider: 'anthropic', modelId: 'claude-opus-5-5' },
    ], ['anthropic']),
  });
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.origin, 'builtin');
});

test('resolve skips an unauthenticated rung and uses the next one', () => {
  const result = resolve({
    agentId: 'sisyphus',
    roster: defaultRoster(NOW),
    memory: null,
    laneOverrides: {},
    registry: registry([
      { provider: 'anthropic', modelId: 'claude-opus-5-5' },
      { provider: 'opencode', modelId: 'claude-opus-5-5' },
      { provider: 'kimi-coding', modelId: 'kimi-k3' },
    ], ['kimi-coding']),
  });
  assert.deepEqual(result, {
    provider: 'kimi-coding',
    modelId: 'kimi-k3',
    thinking: 'max',
    origin: 'builtin',
  });
});

test('resolve skips an ambiguous unqualified pin and falls through to the lane', () => {
  const roster = rosterWith(current => {
    current.agents.sisyphus.pin = { provider: null, modelId: 'shared-model', thinking: 'low' };
  });
  const result = resolve({
    agentId: 'sisyphus',
    roster,
    memory: null,
    laneOverrides: {},
    registry: registry([
      { provider: 'openai', modelId: 'shared-model' },
      { provider: 'chatgpt-subscription', modelId: 'shared-model' },
      ...BUILTIN_DAILY,
    ], ['openai', 'chatgpt-subscription', 'anthropic-subscription']),
  });
  assert.equal(result.origin, 'builtin');
  assert.equal(result.modelId, 'claude-opus-5-5');
});

test('resolve reports ambiguous when an unqualified id matches two providers and no lane resolves', () => {
  const roster = rosterWith(current => {
    current.agents.sisyphus.pin = { provider: null, modelId: 'shared-model', thinking: 'low' };
  });
  const result = resolve({
    agentId: 'sisyphus',
    roster,
    memory: null,
    laneOverrides: {},
    registry: registry([
      { provider: 'openai', modelId: 'shared-model' },
      { provider: 'chatgpt-subscription', modelId: 'shared-model' },
    ], ['openai', 'chatgpt-subscription']),
  });
  assert.deepEqual(result, { unavailable: true, reason: 'ambiguous' });
});

test('hephaestus rejects a non-GPT pin and is unavailable without a GPT lane', () => {
  const roster = rosterWith(current => {
    current.agents.hephaestus.pin = { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5', thinking: 'medium' };
  });
  const result = resolve({
    agentId: 'hephaestus',
    roster,
    memory: null,
    laneOverrides: {},
    registry: registry([
      { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5' },
    ], ['anthropic-subscription']),
  });
  assert.deepEqual(result, { unavailable: true, reason: 'non-gpt' });
});

test('hephaestus ignores non-GPT memory and resolves a GPT lane rung', () => {
  const roster = defaultRoster(NOW);
  roster.agents.hephaestus.rev = 1;
  const result = resolve({
    agentId: 'hephaestus',
    roster,
    memory: memoryFor('hephaestus', 1, { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5' }, 'high'),
    laneOverrides: {},
    registry: registry([
      { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5' },
      ...BUILTIN_GEEKY,
    ], ['anthropic-subscription', 'chatgpt-subscription']),
  });
  assert.deepEqual(result, {
    provider: 'chatgpt-subscription',
    modelId: 'gpt-6.1-sol-fast',
    thinking: 'medium',
    origin: 'builtin',
  });
});

test('hephaestus accepts a GPT pin', () => {
  const roster = rosterWith(current => {
    current.agents.hephaestus.pin = { provider: 'openai', modelId: 'gpt-6.1-sol', thinking: 'high' };
  });
  const result = resolve({
    agentId: 'hephaestus',
    roster,
    memory: null,
    laneOverrides: {},
    registry: registry([
      { provider: 'openai', modelId: 'gpt-6.1-sol' },
      ...BUILTIN_GEEKY,
    ], ['openai', 'chatgpt-subscription']),
  });
  assert.equal(result.origin, 'pin');
  assert.equal(result.provider, 'openai');
});

test('default roster is valid and has every agent at rev 0', () => {
  const roster = defaultRoster(NOW);
  assert.deepEqual(validateRoster(roster), { ok: true });
  assert.equal(roster.v, 1);
  assert.equal(roster.revision, 0);
  assert.deepEqual(AGENT_IDS.map(id => roster.agents[id].rev), [0, 0, 0, 0]);
  assert.deepEqual(AGENT_IDS.map(id => roster.agents[id].pin), [null, null, null, null]);
});

test('a missing roster file is defaults with every rev 0 and no warning', t => {
  const dir = tempDir(t);
  const { roster, warning } = readRoster(dir);
  assert.equal(warning, null);
  assert.deepEqual(AGENT_IDS.map(id => roster.agents[id].rev), [0, 0, 0, 0]);
  assert.equal(roster.revision, 0);
  assert.equal(rosterPath(dir).endsWith(join('primary-agents', 'roster.json')), true);
});

test('an invalid roster file yields defaults plus exactly one warning', t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'primary-agents'), { recursive: true });
  writeFileSync(rosterPath(dir), '{ not json', 'utf8');
  const invalidJson = readRoster(dir);
  assert.equal(invalidJson.warning.code, 'ROSTER_INVALID');
  assert.deepEqual(AGENT_IDS.map(id => invalidJson.roster.agents[id].rev), [0, 0, 0, 0]);

  writeFileSync(rosterPath(dir), JSON.stringify({ ...defaultRoster(NOW), v: 2 }), 'utf8');
  const wrongVersion = readRoster(dir);
  assert.equal(wrongVersion.warning.code, 'ROSTER_INVALID');
  assert.equal(wrongVersion.roster.v, 1);
  assert.deepEqual(AGENT_IDS.map(id => wrongVersion.roster.agents[id].rev), [0, 0, 0, 0]);
});

test('an invalid memory file is ignored with exactly one warning', t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'primary-agents', 'memory'), { recursive: true });
  writeFileSync(memoryPath(dir, 'atlas'), JSON.stringify({ v: 1, agentId: 'atlas' }), 'utf8');
  const { memory, warning } = readMemory(dir, 'atlas');
  assert.equal(memory, null);
  assert.equal(warning.code, 'MEMORY_INVALID');

  const missing = readMemory(dir, 'prometheus');
  assert.deepEqual(missing, { memory: null, warning: null });
});

test('roster validator rejects every rejection class', async t => {
  const base = defaultRoster(NOW);
  const cases = [
    ['non-object root', () => []],
    ['wrong version', roster => ({ ...roster, v: 2 })],
    ['negative revision', roster => ({ ...roster, revision: -1 })],
    ['non-integer revision', roster => ({ ...roster, revision: 1.5 })],
    ['invalid updatedAt', roster => ({ ...roster, updatedAt: 'yesterday' })],
    ['unknown top-level key', roster => ({ ...roster, extra: true })],
    ['credential-like top-level key', roster => ({ ...roster, apiKey: 'x' })],
    ['unknown agent id', roster => ({
      ...roster,
      agents: { ...roster.agents, extra: { lane: 'daily-normal', pin: null, rev: 0 } },
    })],
    ['missing agent id', roster => {
      const agents = { ...roster.agents };
      delete agents.atlas;
      return { ...roster, agents };
    }],
    ['unknown lane', roster => ({
      ...roster,
      agents: { ...roster.agents, sisyphus: { ...roster.agents.sisyphus, lane: 'weekly' } },
    })],
    ['unknown agent key', roster => ({
      ...roster,
      agents: { ...roster.agents, sisyphus: { ...roster.agents.sisyphus, extra: 1 } },
    })],
    ['credential-like agent key', roster => ({
      ...roster,
      agents: { ...roster.agents, sisyphus: { ...roster.agents.sisyphus, token: 'x' } },
    })],
    ['invalid pin shape', roster => ({
      ...roster,
      agents: { ...roster.agents, sisyphus: { ...roster.agents.sisyphus, pin: { provider: 'zai' } } },
    })],
    ['invalid pin modelId', roster => ({
      ...roster,
      agents: { ...roster.agents, sisyphus: { ...roster.agents.sisyphus, pin: { provider: 'zai', modelId: '', thinking: 'max' } } },
    })],
    ['invalid pin thinking', roster => ({
      ...roster,
      agents: { ...roster.agents, sisyphus: { ...roster.agents.sisyphus, pin: { provider: 'zai', modelId: 'glm-5.3', thinking: 'ultra' } } },
    })],
    ['credential-like pin key', roster => ({
      ...roster,
      agents: { ...roster.agents, sisyphus: { ...roster.agents.sisyphus, pin: { provider: 'zai', modelId: 'glm-5.3', thinking: 'max', accessToken: 'x' } } },
    })],
    ['negative agent rev', roster => ({
      ...roster,
      agents: { ...roster.agents, sisyphus: { ...roster.agents.sisyphus, rev: -1 } },
    })],
  ];
  for (const [name, make] of cases) {
    await t.test(name, () => {
      const result = validateRoster(make(base));
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
      assert.equal(typeof result.errors[0].path, 'string');
      assert.equal(typeof result.errors[0].message, 'string');
    });
  }
});

test('memory validator rejects every rejection class', async t => {
  const base = memoryFor('atlas', 3, { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5' }, 'high');
  const cases = [
    ['non-object root', () => 'memory'],
    ['wrong version', memory => ({ ...memory, v: 2 })],
    ['unknown agent id', memory => ({ ...memory, agentId: 'zeus' })],
    ['unknown key', memory => ({ ...memory, extra: 1 })],
    ['credential-like key', memory => ({ ...memory, password: 'x' })],
    ['invalid model', memory => ({ ...memory, model: { provider: 'zai' } })],
    ['invalid model modelId', memory => ({ ...memory, model: { provider: 'zai', modelId: '' } })],
    ['credential-like model key', memory => ({ ...memory, model: { ...memory.model, apiKey: 'x' } })],
    ['invalid thinking', memory => ({ ...memory, thinking: 'ultra' })],
    ['negative rosterRev', memory => ({ ...memory, rosterRev: -1 })],
    ['non-integer rosterRev', memory => ({ ...memory, rosterRev: 1.5 })],
    ['invalid updatedAt', memory => ({ ...memory, updatedAt: 'now' })],
    ['missing model', memory => {
      const copy = { ...memory };
      delete copy.model;
      return copy;
    }],
  ];
  for (const [name, make] of cases) {
    await t.test(name, () => {
      const result = validateMemory(make(base));
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0);
    });
  }
});

test('parseJsonc accepts line comments, block comments and trailing commas', () => {
  const parsed = parseJsonc(`{
    // a line comment
    "a": 1,
    /* a block
       comment */
    "url": "http://example.com/a//b",
    "quoted": "he said \\"/* not a comment */\\"",
    "list": [1, 2, 3,],
    "object": {"x": true, /* tail */ },
  }`);
  assert.deepEqual(parsed, {
    a: 1,
    url: 'http://example.com/a//b',
    quoted: 'he said "/* not a comment */"',
    list: [1, 2, 3],
    object: { x: true },
  });
});

test('parseJsonc rejects a document that is still invalid after comment stripping', () => {
  assert.throws(() => parseJsonc('{ "a": 1, // comment\n "b": }'), SyntaxError);
  assert.throws(() => parseJsonc('{ "a": 1 } /* unterminated'), SyntaxError);
});

test('readLaneOverrides reads root lanes and merges [native] partial lanes', t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'omo.jsonc'), `{
    // complete lane at the root
    "model_profiles": {
      "daily-normal": {
        "display_name": "Daily",
        "family": "daily",
        "tier": "normal",
        "models": ["plain-model", {"model": "rung-model", "variant": "high"}],
      },
    },
    "[native]": {
      "model_profiles": {
        "daily-normal": {"tier": "heavy"},
        "geeky-normal": {"models": ["gpt-6.1-sol"]},
      },
    },
  }`);
  const { overrides, warning } = readLaneOverrides(dir);
  assert.equal(warning, null);
  assert.deepEqual(overrides['daily-normal'], {
    display_name: 'Daily',
    family: 'daily',
    tier: 'heavy',
    models: ['plain-model', { model: 'rung-model', variant: 'high' }],
  });
  assert.deepEqual(overrides['geeky-normal'], { models: ['gpt-6.1-sol'] });
});

test('readLaneOverrides returns {} plus one warning on a parse failure', t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'omo.jsonc'), '{ "native": ', 'utf8');
  const { overrides, warning } = readLaneOverrides(dir);
  assert.deepEqual(overrides, {});
  assert.equal(warning.code, 'OMO_JSONC_INVALID');
});

test('readLaneOverrides returns {} plus one warning when omo.jsonc is missing', t => {
  const dir = tempDir(t);
  const { overrides, warning } = readLaneOverrides(join(dir, 'missing-home'));
  assert.deepEqual(overrides, {});
  assert.equal(warning.code, 'OMO_JSONC_MISSING');
});

test('readLaneOverrides ignores a non-object model_profiles without failing', t => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'omo.jsonc'), '{"model_profiles": 5, "[native]": {"model_profiles": []}}', 'utf8');
  const { overrides, warning } = readLaneOverrides(dir);
  assert.deepEqual(overrides, {});
  assert.equal(warning, null);
});

test('setAgentPin rejects an invalid pin and setAgentLane rejects an unknown lane', () => {
  const roster = defaultRoster(NOW);
  assert.throws(() => setAgentPin(roster, 'sisyphus', { provider: 'zai', modelId: '', thinking: 'max' }), /invalid pin/);
  assert.throws(() => setAgentLane(roster, 'sisyphus', 'weekly'), /unknown lane/);
  assert.throws(() => setAgentLane(roster, 'zeus', 'daily-normal'), /unknown agent/);
});

test('readMemory rejects a file whose agentId does not match the filename', t => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'primary-agents', 'memory'), { recursive: true });
  writeFileSync(memoryPath(dir, 'atlas'), JSON.stringify(
    memoryFor('prometheus', 0, { provider: 'zai', modelId: 'glm-5.3' }, 'high'),
  ), 'utf8');
  const { memory, warning } = readMemory(dir, 'atlas');
  assert.equal(memory, null);
  assert.equal(warning.code, 'MEMORY_AGENT_MISMATCH');
});
