// Headless runtime probes P1-P4. Usage:
//   node qa/probes/run-headless.mjs --out <evidence dir> [--only P1,P2]
// Every probe creates its own temp agent dir/home via qa/harness.mjs and
// writes its raw log plus a JSON summary under <out>/probe-raw/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  PROBE_DIR, evidencePath, runHeadlessProbe, summarizeRun, writeJson,
} from './lib.mjs';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    only: { type: 'string', default: 'P1,P2,P3,P4' },
  },
});

if (!values.out) {
  console.error('usage: node qa/probes/run-headless.mjs --out <evidence dir> [--only P1,P2,P3,P4]');
  process.exit(2);
}

const OUT = values.out;
const RAW = join(OUT, 'probe-raw');
mkdirSync(RAW, { recursive: true });
const only = new Set(values.only.split(',').map(entry => entry.trim().toUpperCase()));
const results = {};

function freshLog(name) {
  const path = evidencePath(RAW, name);
  writeFileSync(path, '', 'utf8');
  return path;
}

function readLog(path) {
  try {
    return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

const SAFE_SETTINGS = {
  quietStartup: true,
  packages: [],
  extensions: [],
  compaction: { enabled: false },
  retry: { enabled: false, maxRetries: 0, modelFallback: false, provider: { maxRetries: 0 } },
  defaultProjectTrust: 'always',
};

async function p1() {
  const log = freshLog('p1.log');
  const probe = join(PROBE_DIR, 'p1-overlay.mjs');
  const run = await runHeadlessProbe({
    prompt: 'P1 probe turn',
    extensions: [probe],
    extraEnv: { PIOMO_P1_LOG: log },
    settings: SAFE_SETTINGS,
    steps: [
      { tool: 'p1_noop', arguments: {} },
      { tool: 'p1_switch', arguments: {} },
      { text: 'P1 final answer' },
    ],
  });
  const records = readLog(log);
  const requests = records.filter(record => record.event === 'provider_request');
  const markerLast = requests.length >= 3 && requests.every(record => record.markerPresent && record.markerLast);
  const switched = records.find(record => record.event === 'setSessionModel');
  results.P1 = {
    verdict: markerLast && switched?.result === true ? 'PASS' : 'FAIL',
    decision: markerLast
      ? 'append: the marker is present and last in every captured provider system prompt (2 pre-switch requests + 1 post-switch request)'
      : 'context_with_system rewrite required (marker missing or not last)',
    log,
    run: summarizeRun(run.run),
    temp: { agentDir: run.sandbox.agentDir, home: run.sandbox.home, stateDir: run.sandbox.stateDir },
    requests: requests.map(record => ({
      index: record.index,
      model: record.model,
      shape: record.systemShape,
      length: record.systemLength,
      markerPresent: record.markerPresent,
      markerLast: record.markerLast,
      tail: record.systemTail,
    })),
    modelSwitch: switched ?? null,
    requestCount: run.requests.length,
  };
}

async function p2() {
  const probe = join(PROBE_DIR, 'p2-preview.mjs');
  const safeLog = freshLog('p2-safe.log');
  const unsafeLog = freshLog('p2-unsafe.log');
  const omoLog = freshLog('p2-omo.log');
  const safe = await runHeadlessProbe({
    prompt: 'P2 safe probe',
    extensions: [probe],
    extraEnv: { PIOMO_P2_LOG: safeLog },
    settings: SAFE_SETTINGS,
    includePlugin: false,
    steps: [{ tool: 'p2_preview', arguments: {} }, { text: 'P2 safe answer' }],
  });
  const unsafe = await runHeadlessProbe({
    prompt: 'P2 unsafe probe',
    extensions: [probe],
    extraEnv: { PIOMO_P2_LOG: unsafeLog, PIOMO_P2_UNSAFE: '1' },
    settings: SAFE_SETTINGS,
    includePlugin: false,
    steps: [{ tool: 'p2_preview', arguments: {} }, { text: 'P2 unsafe answer' }],
  });
  const withOmo = await runHeadlessProbe({
    prompt: 'P2 omo probe',
    extensions: [probe],
    extraEnv: { PIOMO_P2_LOG: omoLog },
    settings: SAFE_SETTINGS,
    steps: [{ tool: 'p2_preview', arguments: {} }, { text: 'P2 omo answer' }],
  });
  const count = records => ({
    preview: records.filter(record => record.event === 'handler' && record.preview === true).length,
    real: records.filter(record => record.event === 'handler' && record.preview !== true).length,
    unsafePreview: records.filter(record => record.event === 'handler' && record.handler === 'unsafe' && record.preview === true).length,
  });
  const safeRecords = readLog(safeLog);
  const unsafeRecords = readLog(unsafeLog);
  const omoRecords = readLog(omoLog);
  const safeCounts = count(safeRecords);
  const unsafeCounts = count(unsafeRecords);
  const omoCounts = count(omoRecords);
  const safeRequest = safeRecords.find(record => record.event === 'preview_request') ?? null;
  const unsafeRequest = unsafeRecords.find(record => record.event === 'preview_request') ?? null;
  const omoRequest = omoRecords.find(record => record.event === 'preview_request') ?? null;
  results.P2 = {
    verdict: safeCounts.preview > 0 && safeCounts.real > 0 && unsafeCounts.preview === 0 &&
      safeRequest?.status === 'ready' && unsafeRequest?.status === 'skipped' &&
      /not registered previewSafe/.test(unsafeRequest?.reason ?? '')
      ? 'PASS'
      : 'FAIL',
    decision: 'handler must stay pure: a preview-safe handler is invoked with preview=true when the host builds the prompt-cache prefix, so it must not read or mutate one-shot state; one non-preview-safe handler skips the whole preview pass (runner.js:1748-1757)',
    logs: { safe: safeLog, unsafe: unsafeLog, omo: omoLog },
    safe: { ...safeCounts, previewRequest: safeRequest, run: summarizeRun(safe.run), temp: { agentDir: safe.sandbox.agentDir, home: safe.sandbox.home, stateDir: safe.sandbox.stateDir } },
    unsafe: { ...unsafeCounts, previewRequest: unsafeRequest, run: summarizeRun(unsafe.run), temp: { agentDir: unsafe.sandbox.agentDir, home: unsafe.sandbox.home, stateDir: unsafe.sandbox.stateDir } },
    withOmo: { ...omoCounts, previewRequest: omoRequest, run: summarizeRun(withOmo.run), temp: { agentDir: withOmo.sandbox.agentDir, home: withOmo.sandbox.home, stateDir: withOmo.sandbox.stateDir } },
  };
}

async function p3() {
  const log = freshLog('p3-headless.log');
  const probe = join(PROBE_DIR, 'p3-origins.mjs');
  const safeLog = join(RAW, 'p3-session.jsonl');
  const run = await runHeadlessProbe({
    prompt: 'P3 probe turn',
    extensions: [probe],
    extraEnv: { PIOMO_P3_LOG: log },
    settings: SAFE_SETTINGS,
    collectSession: true,
    steps: [
      { tool: 'p3_switch', arguments: {} },
      { text: 'P3 final answer' },
    ],
  });
  if (run.sessionText) writeFileSync(safeLog, run.sessionText, 'utf8');
  const records = readLog(log);
  const start = records.find(record => record.event === 'session_start');
  const switchRecord = records.find(record => record.event === 'setSessionModel');
  const modelSelect = records.find(record => record.event === 'model_select');
  results.P3 = {
    verdict: start && switchRecord?.result === true && modelSelect?.source === 'set'
      ? 'PASS'
      : 'FAIL',
    decision: 'extension-originated switches must be attributed by the committed model_change source/actor; headless setSessionModel origin measured here, TUI origins in probe-raw/p3-tui.log',
    log,
    sessionFile: run.sessionText ? safeLog : null,
    factory: records.find(record => record.event === 'factory') ?? null,
    sessionStart: start ?? null,
    setSessionModel: switchRecord ?? null,
    modelSelect: modelSelect ?? null,
    run: summarizeRun(run.run),
    temp: { agentDir: run.sandbox.agentDir, home: run.sandbox.home, stateDir: run.sandbox.stateDir },
  };
}

async function p4() {
  const log = freshLog('p4.log');
  const probe = join(PROBE_DIR, 'p4-child.mjs');
  const omoConfig = {
    task: { default_execution_mode: 'process', process_runner: 'child-process' },
    categories: {
      quick: {
        description: 'P4 quick child',
        model: 'qa-mock/claude-mock-medium',
        variant: 'medium',
      },
    },
  };
  const run = await runHeadlessProbe({
    prompt: 'P4 parent probe',
    extensions: [probe],
    extraEnv: { PIOMO_P4_LOG: log },
    settings: {
      ...SAFE_SETTINGS,
      task: { default_execution_mode: 'process', process_runner: 'child-process' },
    },
    omoConfig,
    route(body) {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const last = messages.at(-1);
      const lastText = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      if (last?.role === 'user' && lastText.includes('P4 child marker')) {
        return { text: 'P4 child done' };
      }
      if (messages.some(message => message.role === 'tool')) {
        return { text: 'P4 parent done' };
      }
      return {
        tool: 'task',
        arguments: {
          category: 'quick',
          prompt: 'P4 child marker',
          description: 'P4 child probe',
          run_in_background: false,
        },
      };
    },
  });
  const records = readLog(log);
  const factories = records.filter(record => record.event === 'factory');
  const starts = records.filter(record => record.event === 'session_start');
  const taskResults = records.filter(record => record.event === 'task_result');
  results.P4 = {
    verdict: starts.some(record => record.sessionKindAtFactory === 'worker' || record.mode !== 'print')
      ? 'PASS'
      : 'FAIL',
    decision: 'isPrimaryMain = interactive sessionKind at factory AND ctx.mode === "tui" AND ctx.hasUI; children are never primary main',
    log,
    factories,
    starts,
    taskResults,
    run: summarizeRun(run.run),
    temp: { agentDir: run.sandbox.agentDir, home: run.sandbox.home, stateDir: run.sandbox.stateDir },
  };
}

try {
  if (only.has('P1')) await p1();
  if (only.has('P2')) await p2();
  if (only.has('P3')) await p3();
  if (only.has('P4')) await p4();
  const path = join(RAW, 'headless-results.json');
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const merged = { ...previous, ...results };
  delete merged.error;
  writeJson(path, merged);
  for (const [name, result] of Object.entries(results)) {
    console.log(`${name}: ${result.verdict} - ${result.decision}`);
  }
} catch (error) {
  const path = join(RAW, 'headless-results.json');
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeJson(path, { ...previous, ...results, error: String(error?.stack ?? error) });
  throw error;
}
