// Todo 14 - cross-package end-to-end in a temporary agent dir with a Herdr pane.
//
// 1. install the built board generation into the temp agent dir (BWT scripts/install.mjs)
// 2. TUI session A: /agent hephaestus, /model gpt-mock-sol -> the extension itself
//    writes memory/hephaestus.json
// 3. POST /profiles setAgentPin -> Hephaestus pinned to gpt-mock-fast / medium, rev bump
// 4. TUI session B: /agent hephaestus -> the pin wins over the seeded memory
// 5. POST /profiles setAgentPin(null) then resetAgentMemory -> rev bumps
// 6. TUI session C: /agent hephaestus -> the stale memory file is ignored (lane rung)
// 7. POST /profiles with a non-GPT Hephaestus pin -> 400 INVALID_PIN, roster unchanged
//
// Every file lives under a fresh OS temp dir; the live agent dirs are never written.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { memoryPath, readRoster } from '../../contract/schema.mjs';
import { ROOT, createSandbox, startMockProvider } from '../harness.mjs';
import {
  createTuiScenario, exitCli, expect, lastModelChange, modelChanges, readRecent, readText,
  run as runCommand, sessionEntries, submitText, switchAgent, waitReady, waitRestartReady,
  waitSessionEntry, withTuiScenario, writeText,
} from './lib.mjs';

const BWT = process.env.PIOMO_BWT ?? 'C:/Users/USER/orca/projects/piomo-briefing-wt/primary-agents-profiles';
const TOKEN = 't14-board-token';
const PORT_BASE = Number(process.env.OMO_T14_PORT_BASE ?? 49720);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function request({ port, path: pathname, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, agent: false,
      headers: { Connection: 'close', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

function postProfiles(port, value) {
  const body = JSON.stringify(value);
  return request({
    port,
    path: '/profiles',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: `http://127.0.0.1:${port}`,
      'sec-fetch-site': 'same-origin',
      'x-board-token': TOKEN,
    },
    body,
  });
}

function agentEntry(roster, id) {
  return roster?.agents?.[id] ?? null;
}

function modelEntry(entries, modelId, source) {
  return entries.find(entry => entry?.type === 'model_change'
    && entry.modelId === modelId && (source === undefined || entry.source === source)) ?? null;
}

function identityEntry(entries, id) {
  return entries.find(entry => entry?.type === 'custom' && entry.customType === 'primary-agent/v1'
    && entry.data?.agentId === id) ?? null;
}

function brief(entry) {
  if (!entry) return null;
  if (entry.type === 'model_change') {
    return { type: entry.type, modelId: entry.modelId, provider: entry.provider ?? null, source: entry.source ?? null, thinking: entry.thinking ?? null };
  }
  if (entry.type === 'custom') {
    return { type: entry.type, customType: entry.customType, data: entry.data ?? null };
  }
  return { type: entry.type };
}

export async function run({ out }) {
  const mock = await startMockProvider({ captureBody: true });
  const sandbox = createSandbox();
  const transcript = [];
  const push = (line) => { transcript.push(line); console.log(line); };
  let scenario;
  let boardServer = null;
  let recordResult = null;
  let failure = null;
  try {
    // ------------------------------------------------------------------ install
    const install = spawnSync(process.execPath, [join(BWT, 'scripts', 'install.mjs'), '--agent-dir', sandbox.agentDir], {
      encoding: 'utf8', timeout: 60000, windowsHide: true,
    });
    push(`install: exit=${install.status}`);
    push(`install stdout: ${(install.stdout ?? '').trim()}`);
    push(`install stderr: ${(install.stderr ?? '').trim()}`);
    expect(install.status === 0, `board install failed: ${install.stderr || install.stdout}`);

    const currentPath = join(sandbox.agentDir, 'briefing', 'current.json');
    const current = readJson(currentPath);
    const generationDir = join(sandbox.agentDir, 'briefing', 'integration', current.generation);
    const shimPath = join(sandbox.agentDir, 'extensions', 'omo-briefing.js');
    expect(existsSync(join(generationDir, 'extension.mjs')), 'installed generation has no extension.mjs');
    expect(existsSync(shimPath), 'installed board shim missing');
    push(`install: generation=${current.generation} extension.mjs=${existsSync(join(generationDir, 'extension.mjs'))} shim=${existsSync(shimPath)}`);
    push(`install: current.json sha256=${sha256(readFileSync(currentPath))}`);

    scenario = createTuiScenario({
      name: 'T14',
      sandbox,
      mockUrl: mock.baseUrl,
      packages: [ROOT],
      model: 'claude-mock-medium',
      thinking: 'off',
    });
    const settings = readJson(join(sandbox.agentDir, 'settings.json'));
    expect(settings.packages.includes(ROOT), 'EXT package was not added to the temp settings');
    push(`settings.packages=${JSON.stringify(settings.packages)}`);

    // Board server over the temp roots only: stableHome/agent IS this temp agent dir.
    const { createBoardServer } = await import(pathToFileURL(join(BWT, 'src', 'server.mjs')).href);
    const { openProfilesStore } = await import(pathToFileURL(join(BWT, 'src', 'profiles', 'store.mjs')).href);
    const store = openProfilesStore({
      primaryHome: join(sandbox.home, '.omo'),
      stableHome: join(sandbox.home, '.omo'),
      mirrorHomes: [],
    });
    boardServer = createBoardServer({
      getPage: () => '<!doctype html><meta charset="utf-8"><title>t14</title>',
      getViewModel: () => ({ seq: 1, sessions: [] }),
      generation: 1,
      portBase: PORT_BASE,
      portCount: 20,
      token: TOKEN,
      onProfiles: (body) => store.handle(body),
      profilesState: () => store.state(),
    });
    const { port } = await boardServer.start();
    push(`board server: http://127.0.0.1:${port} (temp roots primaryHome=${join(sandbox.home, '.omo')} stableHome=${join(sandbox.home, '.omo')})`);
    const initialState = store.state();
    push(`board state: readOnly=${initialState.readOnly} rosterRevision=${initialState.roster.revision} targets=${Object.keys(initialState.targets).length}`);
    expect(initialState.readOnly === false, `board store is read-only: ${initialState.readOnlyReason}`);

    const apply = async (change, label) => {
      const state = store.state();
      const res = await postProfiles(port, {
        action: 'apply',
        changes: [change],
        expected: state.targets,
        rosterRevision: state.roster.revision,
      });
      let parsed = null;
      try { parsed = JSON.parse(res.body); } catch { /* keep text */ }
      push(`POST /profiles ${label}: http=${res.status} ok=${parsed?.ok} code=${parsed?.code ?? null} rosterRevision=${parsed?.rosterRevision ?? null}`);
      return { res, parsed, beforeRevision: state.roster.revision };
    };

    const rosterPath = join(sandbox.agentDir, 'primary-agents', 'roster.json');
    const hephMemory = memoryPath(sandbox.agentDir, 'hephaestus');

    recordResult = await withTuiScenario({
      name: 'T14',
      out,
      evidenceName: 'task-14-piomo-primary-agents-e2e-support',
      scenario,
      mock,
      label: 'PiOMO T14 e2e',
      body: async (pane, record) => {
        await waitReady(pane);
        record.checks.install = { generation: current.generation, shim: existsSync(shimPath) };
        record.checks.settingsPackages = settings.packages;

        // ---------------------------------------------------------- session A
        push('--- session A (temp TUI pane) ---');
        await switchAgent(pane, scenario.sessionFile, 'hephaestus');
        await waitSessionEntry(scenario.sessionFile,
          entry => entry?.type === 'model_change' && entry.modelId === 'gpt-mock-fast',
          { timeout: 25000, label: 'session A hephaestus default model' });
        const aAfterSwitch = sessionEntries(scenario.sessionFile);
        push(`A identity=${JSON.stringify(brief(identityEntry(aAfterSwitch, 'hephaestus')))}`);
        push(`A model_change=${JSON.stringify(brief(modelEntry(aAfterSwitch, 'gpt-mock-fast')))}`);

        await submitText(pane, '/model gpt-mock-sol');
        await waitSessionEntry(scenario.sessionFile,
          entry => entry?.type === 'model_change' && entry.modelId === 'gpt-mock-sol' && entry.source === 'command',
          { timeout: 25000, label: 'session A /model gpt-mock-sol' });
        push('A /model gpt-mock-sol accepted (model_change source=command)');

        // A normal turn is a non-preview before_agent_start/input event: the
        // extension reconciles and writes memory/hephaestus.json itself.
        await submitText(pane, '메모 기록 확인');
        await waitSessionEntry(scenario.sessionFile,
          entry => entry?.type === 'message' && entry.message?.role === 'assistant',
          { timeout: 30000, label: 'session A turn end' });
        expect(existsSync(hephMemory), 'the extension did not write memory/hephaestus.json');
        const memoryA = readJson(hephMemory);
        // The board has not applied anything yet, so roster.json may not exist: the
        // extension and the store both treat a missing roster as rev 0 defaults.
        const rosterA = existsSync(rosterPath) ? readJson(rosterPath) : readRoster(sandbox.agentDir).roster;
        push(`A memory=${JSON.stringify(memoryA)}`);
        push(`A roster hephaestus=${JSON.stringify(agentEntry(rosterA, 'hephaestus'))}`);
        expect(memoryA.agentId === 'hephaestus', 'memory file names another agent');
        expect(memoryA.model?.modelId === 'gpt-mock-sol', `memory model is ${memoryA.model?.modelId}, want gpt-mock-sol`);
        expect(memoryA.rosterRev === agentEntry(rosterA, 'hephaestus').rev,
          `memory rosterRev ${memoryA.rosterRev} != agent rev ${agentEntry(rosterA, 'hephaestus').rev}`);
        record.checks.sessionA = {
          memory: memoryA,
          rosterEntry: agentEntry(rosterA, 'hephaestus'),
          modelChanges: modelChanges(sessionEntries(scenario.sessionFile)).map(entry => ({
            modelId: entry.modelId, provider: entry.provider ?? null, source: entry.source ?? null,
          })),
        };

        await exitCli(pane);

        // ---------------------------------------------------------- pin
        push('--- POST /profiles setAgentPin ---');
        const pin = await apply({
          kind: 'setAgentPin',
          agentId: 'hephaestus',
          pin: { provider: 'qa-mock', modelId: 'gpt-mock-fast', thinking: 'medium' },
        }, 'setAgentPin hephaestus gpt-mock-fast/medium');
        expect(pin.res.status === 200 && pin.parsed?.ok === true, `pin refused: ${pin.res.body}`);
        const rosterB = readJson(rosterPath);
        push(`pin roster revision=${rosterB.revision} hephaestus=${JSON.stringify(agentEntry(rosterB, 'hephaestus'))}`);
        expect(agentEntry(rosterB, 'hephaestus').rev === agentEntry(rosterA, 'hephaestus').rev + 1,
          'setAgentPin did not bump the agent rev');
        expect(rosterB.revision === pin.beforeRevision + 1, 'setAgentPin did not bump the roster revision');
        expect(agentEntry(rosterB, 'hephaestus').pin?.modelId === 'gpt-mock-fast', 'pin not stored');

        // ---------------------------------------------------------- session B
        push('--- session B (new TUI process, same temp agent dir) ---');
        const second = createTuiScenario({
          name: 'T14-pin',
          sandbox,
          mockUrl: mock.baseUrl,
          packages: [ROOT],
          sessionName: 'pinned',
        });
        runCommand(pane, second.command);
        await waitRestartReady(pane, second.sessionFile);
        await switchAgent(pane, second.sessionFile, 'hephaestus');
        await waitSessionEntry(second.sessionFile,
          entry => entry?.type === 'model_change' && entry.modelId === 'gpt-mock-fast' && entry.source === 'extension',
          { timeout: 25000, label: 'session B pinned model_change' });
        const entriesB = sessionEntries(second.sessionFile);
        const lastB = lastModelChange(entriesB);
        push(`B model_change=${JSON.stringify(brief(lastB))}`);
        push(`B footer=${readRecent(pane).split(/\r?\n/).filter(line => line.includes('(qa-mock)')).at(-1) ?? ''}`);
        expect(lastB?.modelId === 'gpt-mock-fast', `session B last model is ${lastB?.modelId}`);
        expect(lastB?.source === 'extension', `session B model_change source is ${lastB?.source}`);
        expect(identityEntry(entriesB, 'hephaestus') !== null, 'session B has no hephaestus identity entry');
        const memoryB = readJson(hephMemory);
        push(`B memory still ${memoryB.model?.modelId} rosterRev=${memoryB.rosterRev} (agent rev=${agentEntry(rosterB, 'hephaestus').rev})`);
        expect(memoryB.model?.modelId === 'gpt-mock-sol', 'unexpected memory change after pin');
        expect(memoryB.rosterRev !== agentEntry(rosterB, 'hephaestus').rev,
          'the seeded memory is not stale after the pin rev bump');
        record.checks.sessionB = {
          lastModelChange: brief(lastB),
          identity: brief(identityEntry(entriesB, 'hephaestus')),
          memory: memoryB,
          rosterEntry: agentEntry(rosterB, 'hephaestus'),
        };
        await exitCli(pane);

        // ---------------------------------------------------------- pin null + reset
        push('--- POST /profiles setAgentPin(null) then resetAgentMemory ---');
        const unpin = await apply({ kind: 'setAgentPin', agentId: 'hephaestus', pin: null }, 'setAgentPin hephaestus null');
        expect(unpin.res.status === 200 && unpin.parsed?.ok === true, `unpin refused: ${unpin.res.body}`);
        const reset = await apply({ kind: 'resetAgentMemory', agentId: 'hephaestus' }, 'resetAgentMemory hephaestus');
        expect(reset.res.status === 200 && reset.parsed?.ok === true, `reset refused: ${reset.res.body}`);
        const rosterC = readJson(rosterPath);
        push(`reset roster revision=${rosterC.revision} hephaestus=${JSON.stringify(agentEntry(rosterC, 'hephaestus'))}`);
        expect(agentEntry(rosterC, 'hephaestus').pin === null, 'pin is not null after unpin');
        expect(agentEntry(rosterC, 'hephaestus').rev === agentEntry(rosterB, 'hephaestus').rev + 2,
          'unpin + reset did not bump the agent rev twice');
        expect(rosterC.revision === rosterB.revision + 2, 'unpin + reset did not bump the roster revision twice');

        // ---------------------------------------------------------- session C
        push('--- session C (new TUI process; stale memory must be ignored) ---');
        const third = createTuiScenario({
          name: 'T14-reset',
          sandbox,
          mockUrl: mock.baseUrl,
          packages: [ROOT],
          sessionName: 'reset',
        });
        runCommand(pane, third.command);
        await waitRestartReady(pane, third.sessionFile);
        await switchAgent(pane, third.sessionFile, 'hephaestus');
        await waitSessionEntry(third.sessionFile,
          entry => entry?.type === 'model_change' && entry.modelId === 'gpt-mock-fast' && entry.source === 'extension',
          { timeout: 25000, label: 'session C lane model_change' });
        const entriesC = sessionEntries(third.sessionFile);
        const lastC = lastModelChange(entriesC);
        const memoryC = readJson(hephMemory);
        push(`C model_change=${JSON.stringify(brief(lastC))}`);
        push(`C memory still ${memoryC.model?.modelId} rosterRev=${memoryC.rosterRev} (agent rev=${agentEntry(rosterC, 'hephaestus').rev})`);
        expect(lastC?.modelId === 'gpt-mock-fast', `session C last model is ${lastC?.modelId}`);
        expect(lastC?.source === 'extension', `session C model_change source is ${lastC?.source}`);
        expect(memoryC.model?.modelId === 'gpt-mock-sol', 'the old memory file disappeared instead of being ignored');
        expect(memoryC.rosterRev !== agentEntry(rosterC, 'hephaestus').rev,
          'the old memory file still matches the current roster rev after reset');
        record.checks.sessionC = {
          lastModelChange: brief(lastC),
          identity: brief(identityEntry(entriesC, 'hephaestus')),
          memory: memoryC,
          rosterEntry: agentEntry(rosterC, 'hephaestus'),
        };
        await exitCli(pane);

        // ---------------------------------------------------------- non-GPT refusal
        push('--- POST /profiles non-GPT Hephaestus pin (failure path) ---');
        const rosterHashBefore = sha256(readFileSync(rosterPath));
        const bad = await apply({
          kind: 'setAgentPin',
          agentId: 'hephaestus',
          pin: { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5', thinking: 'medium' },
        }, 'setAgentPin hephaestus claude-opus-5-5 (must refuse)');
        const rosterHashAfter = sha256(readFileSync(rosterPath));
        const badBody = JSON.parse(bad.res.body);
        // The route's refusal JSON carries the code only (store.handle omits `message`);
        // call the same store once more to record the validation text it refused with.
        const badState = store.state();
        const directBad = store.apply({
          action: 'apply',
          changes: [{ kind: 'setAgentPin', agentId: 'hephaestus', pin: { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5', thinking: 'medium' } }],
          expected: badState.targets,
          rosterRevision: badState.roster.revision,
        });
        push(`nongpt http=${bad.res.status} code=${badBody.code} routeBody=${bad.res.body}`);
        push(`nongpt store message=${directBad.message}`);
        push(`nongpt roster sha256 before=${rosterHashBefore} after=${rosterHashAfter} unchanged=${rosterHashBefore === rosterHashAfter}`);
        expect(bad.res.status === 400, `non-GPT pin returned ${bad.res.status}, want 400`);
        expect(badBody.code === 'INVALID_PIN', `non-GPT pin code ${badBody.code}, want INVALID_PIN`);
        expect(directBad.code === 'INVALID_PIN' && /gpt-/.test(String(directBad.message)),
          `store validation message does not name gpt-: ${directBad.message}`);
        expect(rosterHashBefore === rosterHashAfter, 'the refused pin changed the roster');
        expect(readJson(rosterPath).revision === rosterC.revision, 'the refused pin bumped the roster revision');
        writeText(out, 'task-14-piomo-primary-agents-nongpt.txt', [
          'Task 14 failure path: pinning a non-GPT model for Hephaestus is refused with a validation error',
          `command: POST /profiles (temp board server on 127.0.0.1:${port})`,
          `change: ${JSON.stringify({ kind: 'setAgentPin', agentId: 'hephaestus', pin: { provider: 'anthropic-subscription', modelId: 'claude-opus-5-5', thinking: 'medium' } })}`,
          `http: ${bad.res.status}`,
          `response: ${bad.res.body}`,
          `store validation message: ${directBad.message}`,
          `roster before sha256: ${rosterHashBefore}`,
          `roster after  sha256: ${rosterHashAfter}`,
          `roster unchanged: ${rosterHashBefore === rosterHashAfter}`,
          `roster revision before/after: ${rosterC.revision}/${readJson(rosterPath).revision}`,
          'result: PASS',
        ].join('\n'));
        record.checks.nonGpt = {
          http: bad.res.status, body: badBody,
          rosterSha256Before: rosterHashBefore, rosterSha256After: rosterHashAfter,
          rosterUnchanged: rosterHashBefore === rosterHashAfter,
        };

        return { ok: true, checks: record.checks };
      },
    });

    await boardServer.close();
    boardServer = null;
    push(`board server closed (port ${port})`);
  } catch (error) {
    failure = error;
    push(`FAIL: ${error?.stack ?? error}`);
  } finally {
    if (boardServer) {
      try { await boardServer.close(); push('board server closed after failure'); } catch { /* closed */ }
    }
    try { await mock.close(); } catch { /* closed */ }
    const cleanup = (() => {
      try { return sandbox.cleanup(); } catch (error) { return { removed: false, error: String(error?.message ?? error) }; }
    })();
    push(`temp cleanup: ${JSON.stringify(cleanup)}`);
    writeText(out, 'task-14-piomo-primary-agents-e2e.txt', [
      'Task 14 cross-package e2e (temp agent dir + Herdr TUI panes + temp board server)',
      `attemptDir: ${out}`,
      `temp agent dir: ${sandbox.agentDir}`,
      `temp home: ${sandbox.home}`,
      '',
      ...transcript,
      '',
      `result: ${failure ? 'FAIL' : 'PASS'}`,
      ...(failure ? ['', `error: ${failure?.stack ?? failure}`] : []),
    ].join('\n'));
  }
  if (failure) throw failure;
  return recordResult;
}

const invokedDirectly = process.argv[1]?.endsWith('t14-e2e.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/t14-e2e.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
