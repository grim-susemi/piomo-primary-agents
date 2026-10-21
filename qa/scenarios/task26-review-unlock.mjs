// Current plan-review-unlock policy. Historical S14/Task23 remain unchanged.
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  expect, isTitleRequest, processesFor, readRecent, runTuiScenario,
  sessionEntries, startMock, switchAgent, textOfMessage, toolResults, userMessages,
} from './lib.mjs';
import * as T from '../probes/tui-lib.mjs';
import {
  PLUGIN, ROOT, SENPI_CLI, SEEDED_MODEL_PROFILES,
} from '../harness.mjs';
import { writeJson } from '../probes/lib.mjs';
import {
  MARKER_BEGIN, hasUnlockedReviewPolicy,
} from '../../src/gate-adapter/adapter.mjs';
import { ADAPTER_MISSING_NOTICE } from '../../src/core/orchestration.mjs';

const CURRENT = '1149550465cbfde272891e27d78087ecb8003c0a3dbf32bef7aaa8dbc237cef0';
const BACKUP = '2b559bb11f0285072722cffbb7f322756c81aec867f6fb4a683278f075d7f783';
const EXPECTED = {
  'src/gate-adapter/adapter.mjs':
    '167606360ce0c47a9aed9c8f8c9b94364f64fae84f1212fdeb17e5e81e21b587',
  'dist/src/gate-adapter/adapter.mjs':
    '167606360ce0c47a9aed9c8f8c9b94364f64fae84f1212fdeb17e5e81e21b587',
  'src/core/orchestration.mjs':
    '6ff3f3b196427fe2ccd78b1de39a808619340ec00bcd1789440245326cf35190',
  'dist/src/core/orchestration.mjs':
    '6ff3f3b196427fe2ccd78b1de39a808619340ec00bcd1789440245326cf35190',
  'dist/extension.js':
    '7acba8c4079f43177f72e623508da50b4674be8dba0f3bfc61443af05ebdf8a4',
};
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const identities = () => Object.fromEntries(
  Object.keys(EXPECTED).map(file => [file, sha(join(ROOT, file))]),
);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function handled(promise) {
  promise.catch(() => {});
  return promise;
}

export async function run({ out }) {
  expect(out, '--out is required');
  const sourceTarget = join(PLUGIN, 'extensions', 'omo-task.js');
  expect(sha(sourceTarget) === CURRENT, 'current plugin input drifted');
  expect(sha(sourceTarget + '.plan-review-unlock.bak') === BACKUP,
    'original backup input drifted');
  expect(JSON.stringify(identities()) === JSON.stringify(EXPECTED),
    'source/dist inputs drifted');

  const held = deferred();
  const release = deferred();
  const controller = new AbortController();
  let surfaceRecord;
  let scenario;
  let pane;
  let heldRequest;
  let backgroundId;
  let reviewRequests = 0;
  let parentId;
  let record;
  let failure;
  const events = [];
  const event = (kind, data = {}) => events.push({
    at: new Date().toISOString(), kind, ...data,
  });

  function bounded(promise, label, timeout) {
    const signal = controller.signal;
    return handled(new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(signal.reason);
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new Error(`timeout: ${label}`)), timeout);
      promise.then(value => finish(null, value), error => finish(error));
    }));
  }

  function subscribe(predicate, label, timeout = 18000) {
    const file = scenario.sessionFile;
    event('subscribe-session', { file, label });
    return handled(new Promise((resolve, reject) => {
      let settled = false;
      let watcher;
      let timer;
      const signal = controller.signal;
      const finish = (error, entries) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        watcher?.close();
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(entries);
      };
      const abort = () => finish(signal.reason);
      const inspect = () => {
        try {
          const entries = sessionEntries(file);
          if (predicate(entries)) finish(null, entries);
        } catch (error) {
          finish(error);
        }
      };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      watcher = watch(dirname(file), inspect);
      timer = setTimeout(() => finish(new Error(`timeout: ${label}`)), timeout);
      inspect();
    }));
  }

  function capture(name) {
    const raw = T.readRaw(pane);
    const text = T.stripAnsi(raw);
    surfaceRecord.frames.push({ name, raw, text });
    expect(!readRecent(pane).includes(ADAPTER_MISSING_NOTICE),
      'false adapter-missing notice on recognized current policy');
  }

  async function input(text) {
    event('invocation', { surface: 'Herdr native TUI', pane, text });
    console.log(JSON.stringify({ surface: 'Herdr native TUI', pane, invocation: text }));
    const echoed = handled(T.waitOutput(pane, text, {
      timeout: 5000, source: 'visible',
    }));
    expect(T.sendText(pane, text).code === 0, 'send-text failed');
    expect((await echoed).code === 0, 'input echo missing');
    if (text.startsWith('/')) {
      expect(T.sendKeys(pane, 'escape').code === 0, 'autocomplete escape failed');
    }
    expect(T.sendKeys(pane, 'enter').code === 0, 'input enter failed');
  }

  async function parentTurn(text, marker) {
    const before = sessionEntries(scenario.sessionFile).length;
    const resultBefore = toolResults(sessionEntries(scenario.sessionFile)).length;
    const committed = subscribe(entries => {
      const fresh = entries.slice(before);
      const user = fresh.findIndex(entry => entry.type === 'message'
        && entry.message.role === 'user'
        && textOfMessage(entry.message).includes(marker));
      return user !== -1 && fresh.slice(user + 1).some(entry =>
        entry.type === 'message' && entry.message.role === 'assistant'
        && entry.message.stopReason === 'stop');
    }, `committed parent turn: ${marker}`);
    await input(text);
    const entries = await committed;
    if (parentId) expect(entries[0]?.id === parentId, 'parent session changed');
    capture(marker);
    const result = {
      entries,
      results: toolResults(entries).slice(resultBefore),
      user: userMessages(entries).at(-1),
    };
    surfaceRecord.checks[marker] = result;
    return result;
  }
  const lastTask = turn => turn.results.filter(x => x.toolName === 'task').at(-1);
  const gated = result => result && /plan-gated/.test(result.text);
  const admitted = result => result && !result.isError
    && result.text.includes('T26_REVIEW_DONE');

  const mock = await startMock({
    captureBody: true,
    route: body => {
      if (isTitleRequest(body)) return { text: 'Task26 title' };
      const messages = body.messages ?? [];
      const index = messages.findLastIndex(message => message.role === 'user');
      const text = index < 0 ? '' : textOfMessage(messages[index]);
      const tools = messages.slice(index + 1).filter(message => message.role === 'tool');
      if (text.includes('T26_REVIEW_CHILD')) {
        reviewRequests += 1;
        return { text: 'T26_REVIEW_DONE' };
      }
      if (text.includes('T26_BG_WORK') && !text.includes('T26_BG_DONE')) {
        return { text: 'T26_BG_DONE' };
      }
      if (text.includes('T26_BG_DONE')) return { text: 'T26_COMPLETION_ACK' };
      if (text.includes('T26_SPAWN_BG')) {
        return tools.length ? { text: 'T26_PARENT_DONE' } : {
          tool: 'task',
          arguments: {
            category: 'quick', prompt: 'T26_BG_WORK',
            description: 'Task26 held child', run_in_background: true,
          },
        };
      }
      const owner = text.includes('T26_OWNER_REPLAN');
      if (owner || /T26_FIRST_EXECUTE|T26_SECOND_EXECUTE|T26_MISSING_ARTIFACT|T26_RESET_AFTER_NEGATIVE/.test(text)) {
        if (owner && tools.length === 0) {
          return {
            tool: 'write',
            arguments: { path: '.omo/plans/demo.md', content: '# Task26 real plan\n' },
          };
        }
        if (tools.length === (owner ? 1 : 0)) {
          return {
            tool: 'task',
            arguments: {
              subagent_type: 'plan-consultant',
              prompt: 'T26_REVIEW_CHILD',
              description: 'Task26 guarded review',
              run_in_background: false,
            },
          };
        }
      }
      return { text: 'T26_PARENT_DONE' };
    },
  });
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const body = bytes.length ? JSON.parse(bytes.toString()) : null;
      const user = body?.messages?.findLast(message => message.role === 'user');
      const text = user ? textOfMessage(user) : '';
      if (!heldRequest && body && !isTitleRequest(body)
        && text.includes('T26_BG_WORK') && !text.includes('T26_BG_DONE')) {
        heldRequest = { heldAt: new Date().toISOString(), body, released: false };
        event('actual-child-request-held');
        held.resolve();
        await bounded(release.promise, 'release after admission', 22000);
        heldRequest.released = true;
        heldRequest.releasedAt = new Date().toISOString();
      }
      const target = new URL(request.url, mock.baseUrl);
      const upstream = httpRequest(target, {
        method: request.method,
        headers: { ...request.headers, host: target.host, connection: 'close' },
      }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      });
      upstream.on('error', error => response.destroy(error));
      upstream.end(bytes);
    } catch (error) {
      response.destroy(error);
    }
  });
  const listening = once(proxy, 'listening');
  proxy.listen(0, '127.0.0.1');
  await listening;
  const localMock = {
    ...mock,
    baseUrl: `http://127.0.0.1:${proxy.address().port}/v1`,
  };
  const deadline = setTimeout(() => {
    controller.abort(new Error('Task26 runtime deadline: 48 seconds'));
  }, 48000);
  try {
    record = await runTuiScenario({
      out,
      name: 'Task26-current-review-unlock',
      evidenceName: 'task26-current-review-unlock',
      label: 'Task26 current policy QA',
      requireEditor: true,
      mock: localMock,
      scenarioOptions: {
        pluginCopy: true,
        modelProfiles: {
          model_profiles: SEEDED_MODEL_PROFILES,
          task: { default_execution_mode: 'in-process' },
          agents: {
            'plan-consultant': {
              model: 'qa-mock/claude-mock-medium', variant: 'medium',
            },
          },
          categories: {
            quick: {
              description: 'Task26 local child',
              model: 'qa-mock/claude-mock-medium', variant: 'medium',
            },
          },
        },
      },
      body: async (ownedPane, rec, ownedScenario) => {
        pane = ownedPane;
        scenario = ownedScenario;
        surfaceRecord = rec;
        rec.events = events;
        rec.sourceBefore = identities();
        const target = join(scenario.pluginPath, 'extensions', 'omo-task.js');
        const planDir = join(scenario.workDir, '.omo', 'plans');
        rec.plugin = {
          sourceTarget, sourceHash: sha(sourceTarget),
          target, copiedHash: sha(target),
          guardedPolicy: hasUnlockedReviewPolicy(readFileSync(target)),
          legacyMarker: readFileSync(target, 'utf8').includes(MARKER_BEGIN),
        };
        expect(rec.plugin.copiedHash === CURRENT, 'temp plugin drifted');
        expect(rec.plugin.guardedPolicy && !rec.plugin.legacyMarker,
          'must exercise current guarded policy without legacy adapter');
        rec.loadedProcesses = processesFor(scenario.sandbox.stateDir);
        expect(rec.loadedProcesses.some(process =>
          String(process.CommandLine).replaceAll('\\', '/').toLowerCase()
            .includes(SENPI_CLI.replaceAll('\\', '/').toLowerCase())),
        'actual CLI provenance missing');
        rec.cliArgs = scenario.args;
        rec.processInfo = T.herdr(['pane', 'process-info', '--pane', pane]);
        try {
          await parentTurn('T26_BOOTSTRAP', 'T26_BOOTSTRAP');
          parentId = sessionEntries(scenario.sessionFile)[0]?.id;
          expect(parentId, 'persisted parent identity missing');

          mkdirSync(planDir, { recursive: true });
          // Real temporary artifact, without an owner plan request.
          const write = await import('node:fs');
          write.writeFileSync(join(planDir, 'demo.md'), '# Task26 existing plan\n');
          rec.artifactBeforeInitialExecute = existsSync(join(planDir, 'demo.md'));
          const initial = await parentTurn(
            '/ulw-execute T26_FIRST_EXECUTE', 'T26_FIRST_EXECUTE');
          expect(gated(lastTask(initial)) && reviewRequests === 0,
            'review admitted without an explicit owner plan request');

          rmSync(planDir, { recursive: true, force: true });
          const missing = await parentTurn(
            '/skill:ulw-plan T26_MISSING_ARTIFACT', 'T26_MISSING_ARTIFACT');
          rec.artifactsAfterMissing = existsSync(planDir) ? readdirSync(planDir) : [];
          expect(rec.artifactsAfterMissing.length === 0,
            'missing-artifact control unexpectedly created a plan');
          expect(gated(lastTask(missing)) && reviewRequests === 0,
            'review admitted without a real plan artifact');

          const reset = await parentTurn(
            '/ulw-execute T26_RESET_AFTER_NEGATIVE', 'T26_RESET_AFTER_NEGATIVE');
          expect(gated(lastTask(reset)) && reviewRequests === 0,
            'missing artifact stopped being required after another execution');
          const started = bounded(held.promise, 'actual held child start', 15000);
          const completion = subscribe(entries => backgroundId && entries.some(entry =>
            entry.type === 'custom_message' && entry.customType === 'omo-senpi:wake'
            && JSON.stringify(entry).includes(backgroundId)
            && JSON.stringify(entry).includes('T26_BG_DONE')),
          'same-parent child completion', 23000);
          const background = await parentTurn('T26_SPAWN_BG', 'T26_SPAWN_BG');
          await started;
          const task = lastTask(background);
          backgroundId = /st_[a-z0-9]+/.exec(task?.text ?? '')?.[0];
          expect(task && !task.isError && backgroundId, 'background child did not start');
          expect(!heldRequest.released, 'child completed before replan');
          rec.backgroundId = backgroundId;

          await switchAgent(pane, scenario.sessionFile, 'prometheus');
          const replan = await parentTurn(
            '방향 다시 잡자 T26_OWNER_REPLAN', 'T26_OWNER_REPLAN');
          expect(replan.user.includes('<skill-instruction name="ulw-plan"'),
            'Prometheus did not rewrite the plain owner request into ulw-plan');
          expect(admitted(lastTask(replan)) && reviewRequests === 1,
            'genuine owner replan was not admitted after execution');
          expect(existsSync(join(planDir, 'demo.md')), 'real positive artifact missing');
          expect(!heldRequest.released, 'held child released before admission');
          rec.admittedAt = new Date().toISOString();
          event('release-only-after-admission', { backgroundId, parentId });
          release.resolve();
          const completed = await completion;
          expect(completed[0]?.id === parentId, 'child completion changed parent');
          rec.backgroundCompletion = completed.find(entry =>
            entry.type === 'custom_message'
            && JSON.stringify(entry).includes(backgroundId)
            && JSON.stringify(entry).includes('T26_BG_DONE'));

          const again = await parentTurn(
            '/ulw-execute T26_SECOND_EXECUTE', 'T26_SECOND_EXECUTE');
          expect(admitted(lastTask(again)) && reviewRequests === 2,
            'another execution relocked previously requested review');
          capture('final-current-policy');
          rec.heldRequest = heldRequest;
          rec.parentId = parentId;
          rec.reviewRequests = reviewRequests;
          return { ok: true };
        } finally {
          rec.pluginHashAfter = sha(target);
          rec.sourceAfter = identities();
          expect(rec.pluginHashAfter === CURRENT, 'temp plugin was modified');
          expect(JSON.stringify(rec.sourceAfter) === JSON.stringify(EXPECTED),
            'source/dist changed during observation');
        }
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(deadline);
    controller.abort(new Error('Task26 closing'));
    release.resolve();
    const closed = once(proxy, 'close');
    proxy.close();
    proxy.closeAllConnections();
    await closed;
    await mock.close();
    record ??= surfaceRecord ?? { ok: false };
    record.events = events;
    record.heldRequest = heldRequest;
    record.mockBodies = mock.requests;
    record.mockClosed = true;
    record.sourceInputAfter = sha(sourceTarget);
    record.backupInputAfter = sha(sourceTarget + '.plan-review-unlock.bak');
    record.panesAfter = T.herdr(['pane', 'list']);
    if (failure) {
      record.ok = false;
      record.error = String(failure.stack ?? failure);
    }
    if (!record.cleanup?.removed || record.cleanup?.processesAfterKill !== 0) {
      record.ok = false;
      record.cleanupFailure = 'owned temp root or processes not confirmed closed';
    }
    writeJson(join(out, 'task26-runtime.json'), record);
  }
  if (!record.ok) throw failure ?? new Error('Task26 failed; inspect task26-runtime.json');
  return record;
}

if (process.argv[1]?.endsWith('task26-review-unlock.mjs')) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  run({ out: values.out }).catch(error => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
