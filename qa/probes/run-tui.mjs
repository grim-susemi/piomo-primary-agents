// TUI runtime probes (P3 origins, P5 gate, P6 Tab, P7 submit wrap).
// Each probe runs in its own owned Herdr pane with a temp agent dir/home and a
// temp copy of the plugin where the probe needs isolation (P5).
// Usage: node qa/probes/run-tui.mjs --out <evidence dir> [--only P3,P5,P6,P7]
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { PROBE_DIR, writeJson } from './lib.mjs';
import {
  PLUGIN, closePane, createPane, createTuiSandbox, killTree, readText, run, sendKeys, sendText,
  startMock, waitOutput,
} from './tui-lib.mjs';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    only: { type: 'string', default: 'P3,P5,P6,P7' },
  },
});
if (!values.out) {
  console.error('usage: node qa/probes/run-tui.mjs --out <evidence dir> [--only P3,P5,P6,P7]');
  process.exit(2);
}
const OUT = values.out;
const RAW = join(OUT, 'probe-raw');
mkdirSync(RAW, { recursive: true });
const only = new Set(values.only.split(',').map(entry => entry.trim().toUpperCase()));
const results = {};

function freshLog(name) {
  const path = join(RAW, name);
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

// Wait for a record the probe appended to its own log. Subscribe before the
// action; the existing records are checked immediately, then every file change.
function waitLog(path, predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher = null;
    const finish = (value, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* closed */ }
      if (timedOut) reject(new Error(`log timeout waiting for ${path}`));
      else resolve(value);
    };
    const check = () => {
      const hit = readLog(path).find(predicate);
      if (hit) finish(hit, false);
    };
    const timer = setTimeout(() => finish(null, true), timeout);
    try {
      watcher = watch(path, { persistent: false }, check);
    } catch {
      // Missing file: the timeout still bounds the wait.
    }
    check();
  });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function paneProcesses(marker) {
  const command = [
    'Get-CimInstance Win32_Process',
    `| Where-Object { $_.CommandLine -like '*${marker.replaceAll("'", "''")}*' }`,
    '| Select-Object ProcessId,ParentProcessId,CommandLine',
    '| ConvertTo-Json -Compress',
  ].join(' ');
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
    }).trim();
    if (!output) return [];
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function withPane({
  name,
  label,
  extensions,
  settings,
  omoConfig,
  extraEnv,
  pluginPath,
  pluginCopy = false,
  mockOptions,
  setup,
  script,
}) {
  const mock = await startMock(mockOptions);
  const tui = createTuiSandbox({
    name,
    extensions,
    settings,
    omoConfig,
    extraEnv,
    pluginPath,
    pluginCopy,
    mockUrl: mock.baseUrl,
  });
  const pane = createPane(tui.sandbox.workDir, label);
  const record = {
    name,
    pane,
    agentDir: tui.sandbox.agentDir,
    home: tui.sandbox.home,
    stateDir: tui.sandbox.stateDir,
    sessionFile: tui.sandbox.sessionFile,
    command: tui.command,
    pluginCopy: pluginCopy ? join(tui.dir, 'plugin') : null,
    pluginTaskSha256: pluginCopy ? sha256(join(tui.dir, 'plugin', 'extensions', 'omo-task.js')) : null,
    pluginSourceTaskSha256: sha256(join(PLUGIN, 'extensions', 'omo-task.js')),
  };
  let error = null;
  try {
    setup?.(tui.sandbox);
    run(pane, tui.command);
    const ready = await waitOutput(pane, 'claude-mock-medium', { timeout: 60000 });
    if (ready.code !== 0) throw new Error(`pane never reached the model footer: ${ready.stderr || ready.stdout}`);
    // The footer renders before session_start handlers and the editor settle;
    // wait for the welcome block that follows settings resolution.
    const welcomed = await waitOutput(pane, 'Welcome to OmO', { timeout: 60000 });
    if (welcomed.code !== 0) throw new Error(`pane never reached the welcome block: ${welcomed.stderr || welcomed.stdout}`);
    record.processesBeforeClose = paneProcesses(tui.sandbox.stateDir);
    await script({ pane, tui, mock, record });
    record.frame = readText(pane);
  } catch (caught) {
    error = String(caught?.stack ?? caught);
    record.frame = (() => { try { return readText(pane); } catch { return ''; } })();
    throw caught;
  } finally {
    try { closePane(pane); } catch { /* already gone */ }
    // Herdr close should take the tree down; kill anything still carrying this
    // run's unique state dir before deleting it.
    const leftovers = paneProcesses(tui.sandbox.stateDir);
    record.processesAfterClose = leftovers;
    for (const entry of leftovers) {
      if (typeof entry.ProcessId === 'number') killTree(entry.ProcessId);
    }
    record.processesAfterKill = paneProcesses(tui.sandbox.stateDir);
    record.cleanup = tui.sandbox.cleanup();
    record.error = error;
    writeJson(join(RAW, `${name}-run.json`), record);
    if (mock) await mock.close();
  }
}

function textOf(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map(part => part?.text ?? '').join('');
  }
  return '';
}

function lastToolName(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return message.tool_calls[0]?.function?.name ?? null;
    }
  }
  return null;
}

async function p5a() {
  const log = freshLog('p5a.log');
  const record = { log };
  await withPane({
    name: 'p5a',
    label: 'PiOMO P5a gate',
    extensions: [join(PROBE_DIR, 'p5-gate.mjs')],
    extraEnv: { PIOMO_P5_LOG: log },
    pluginCopy: true,
    setup(sandbox) {
      mkdirSync(join(sandbox.workDir, '.omo', 'plans'), { recursive: true });
      writeFileSync(join(sandbox.workDir, '.omo', 'plans', 'probe.md'), '# probe plan\n');
    },
    mockOptions: {
      route(body) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const last = messages.at(-1);
        if (last?.role === 'tool') {
          const tool = lastToolName(messages);
          if (tool === 'read') {
            return {
              tool: 'task',
              arguments: { subagent_type: 'plan-consultant', prompt: 'P5 plan review', run_in_background: false },
            };
          }
          return { text: 'P5a final answer' };
        }
        if (messages.length <= 2 && !textOf(last).includes('probe request')) {
          return { text: 'P5 child answer' };
        }
        return { tool: 'read', arguments: { path: '.omo/plans/probe.md' } };
      },
    },
    async script({ pane, record: runRecord }) {
      sendText(pane, '/probe-install');
      sendKeys(pane, 'enter');
      const install = await waitOutput(pane, 'P5INSTALL:', { timeout: 30000 });
      runRecord.installWait = install.code;
      runRecord.installResult = /P5INSTALL:(\w+)/.exec(install.stdout)?.[1] ?? null;
      sendText(pane, 'probe request');
      sendKeys(pane, 'enter');
      const wrap = await waitOutput(pane, 'P5WRAP:rewritten', { timeout: 30000 });
      runRecord.wrap = wrap.code;
      const verdict = await waitOutput(pane, 'P5TASK:', { timeout: 45000 });
      runRecord.verdictWait = verdict.code;
      runRecord.taskVerdict = /P5TASK:(\w+)/.exec(verdict.stdout)?.[1] ?? null;
      // The refusal/admission notification is a pane transition; the log is the raw evidence.
      runRecord.logRecords = readLog(log);
    },
  });
  const records = readLog(log);
  const taskVerdict = records.find(entry => entry.event === 'task_verdict') ?? null;
  const taskCancel = records.find(entry => entry.event === 'task_cancel') ?? null;
  results.P5a = {
    verdict: taskVerdict?.verdict === 'admitted' ? 'PASS' : 'FAIL',
    decision: 'the gate admits plan-consultant only after the owner-typed /skill:ulw-plan request, so the rewrite must happen in the onSubmit wrap (todo 9)',
    log,
    wrap: records.find(entry => entry.event === 'submit_wrap') ?? null,
    taskCall: records.find(entry => entry.event === 'tool_call' && entry.toolName === 'task') ?? null,
    taskResult: records.find(entry => entry.event === 'tool_result' && entry.toolName === 'task') ?? null,
    taskVerdict,
    taskCancel,
    run: record,
  };
}

async function p5b() {
  const log = freshLog('p5b.log');
  const record = { log };
  await withPane({
    name: 'p5b',
    label: 'PiOMO P5b gate',
    extensions: [join(PROBE_DIR, 'p5-gate.mjs')],
    extraEnv: { PIOMO_P5_LOG: log },
    pluginCopy: true,
    setup(sandbox) {
      mkdirSync(join(sandbox.workDir, '.omo', 'plans'), { recursive: true });
      writeFileSync(join(sandbox.workDir, '.omo', 'plans', 'probe.md'), '# probe plan\n');
    },
    mockOptions: {
      route(body) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const last = messages.at(-1);
        if (last?.role === 'tool') {
          const tool = lastToolName(messages);
          if (tool === 'read') {
            return {
              tool: 'task',
              arguments: { subagent_type: 'plan-consultant', prompt: 'P5 plan review', run_in_background: false },
            };
          }
          return { text: 'P5b final answer' };
        }
        if (messages.length <= 2 && !textOf(last).includes('probe request')) {
          return { text: 'P5 child answer' };
        }
        return { tool: 'read', arguments: { path: '.omo/plans/probe.md' } };
      },
    },
    async script({ pane, record: runRecord }) {
      sendText(pane, '/probe-send');
      sendKeys(pane, 'enter');
      const verdict = await waitOutput(pane, 'P5TASK:', { timeout: 45000 });
      runRecord.verdictWait = verdict.code;
      runRecord.taskVerdict = /P5TASK:(\w+)/.exec(verdict.stdout)?.[1] ?? null;
      runRecord.logRecords = readLog(log);
    },
  });
  const records = readLog(log);
  const taskVerdict = records.find(entry => entry.event === 'task_verdict') ?? null;
  const taskResult = records.find(entry => entry.event === 'tool_result' && entry.toolName === 'task') ?? null;
  results.P5b = {
    verdict: taskVerdict?.verdict === 'refused' && /no such request was made/.test(taskResult?.result ?? '')
      ? 'PASS'
      : 'FAIL',
    decision: 'source "extension" is ignored by the gate, so pi.sendUserMessage can never open plan review',
    log,
    send: records.find(entry => entry.event === 'send_user_message') ?? null,
    taskResult,
    taskVerdict,
    run: record,
  };
}

async function p3() {
  const log = freshLog('p3-tui.log');
  const record = { log };
  await withPane({
    name: 'p3',
    label: 'PiOMO P3 origins',
    extensions: [join(PROBE_DIR, 'p3-origins.mjs')],
    extraEnv: { PIOMO_P3_LOG: log },
    settings: { favoriteModels: ['qa-mock/claude-mock-medium', 'qa-mock/gpt-mock-fast'] },
    mockOptions: { route: () => ({ text: 'P3 tui answer' }) },
    async script({ pane, record: runRecord }) {
      sendText(pane, '/model gpt-mock-fast');
      sendKeys(pane, 'enter');
      const slash = await waitOutput(pane, '(qa-mock) gpt-mock-fast', { timeout: 30000 });
      runRecord.slashModelWait = slash.code;
      sendText(pane, '/probe-dump after-slash-model');
      sendKeys(pane, 'enter');
      await waitOutput(pane, 'P3DUMP:after-slash-model', { timeout: 20000 });
      sendKeys(pane, 'ctrl+p');
      const cycle = await waitOutput(pane, '(qa-mock) claude-mock-medium', { timeout: 30000 });
      runRecord.cycleWait = cycle.code;
      sendText(pane, '/probe-dump after-cycle');
      sendKeys(pane, 'enter');
      await waitOutput(pane, 'P3DUMP:after-cycle', { timeout: 20000 });
      sendKeys(pane, 'ctrl+l');
      sendText(pane, 'max');
      sendKeys(pane, 'enter');
      const picker = await waitOutput(pane, '(qa-mock) claude-mock-max', { timeout: 30000 });
      runRecord.pickerWait = picker.code;
      sendText(pane, '/probe-dump after-picker');
      sendKeys(pane, 'enter');
      await waitOutput(pane, 'P3DUMP:after-picker', { timeout: 20000 });
      sendKeys(pane, 'shift+tab');
      const thinking = await waitOutput(pane, 'Thinking level: minimal', { timeout: 30000 });
      runRecord.thinkingWait = thinking.code;
      sendText(pane, '/probe-dump after-thinking');
      sendKeys(pane, 'enter');
      await waitOutput(pane, 'P3DUMP:after-thinking', { timeout: 20000 });
      runRecord.logRecords = readLog(log);
    },
  });
  const records = readLog(log);
  const dumps = records.filter(entry => entry.event === 'probe_dump');
  const byLabel = label => dumps.find(entry => entry.label === label) ?? null;
  const shapes = entry => ({
    type: entry.type,
    source: entry.source,
    actor: entry.actor,
    provider: entry.provider,
    modelId: entry.modelId,
    thinkingLevel: entry.thinkingLevel,
    triggerSource: entry.triggerSource,
    triggerActor: entry.triggerActor,
  });
  results.P3 = {
    verdict: dumps.length >= 4 &&
      byLabel('after-slash-model')?.entries?.some(entry => entry.type === 'model_change' && entry.source === 'command') &&
      byLabel('after-cycle')?.entries?.some(entry => entry.type === 'model_change' && entry.source === 'cycle') &&
      byLabel('after-picker')?.entries?.some(entry => entry.type === 'model_change' && entry.source === 'picker' && entry.actor === 'model-selector')
      ? 'PASS'
      : 'FAIL',
    decision: 'model entries carry source command|picker|cycle and thinking_level_change entries carry only thinkingSelection; the initial model_change precedes every message',
    log,
    startup: byLabel('startup') ?? records.find(entry => entry.event === 'session_start') ?? null,
    dumps: dumps.map(entry => ({
      label: entry.label,
      model: entry.model,
      thinkingLevel: entry.thinkingLevel,
      entries: entry.entries.map(shapes),
    })),
    run: record,
  };
}

async function p6() {
  const log = freshLog('p6.log');
  const record = { log };
  await withPane({
    name: 'p6',
    label: 'PiOMO P6 tab',
    extensions: [join(PROBE_DIR, 'p6-tab.mjs')],
    extraEnv: { PIOMO_P6_LOG: log },
    mockOptions: { route: () => ({ text: 'P6 answer' }) },
    setup(sandbox) {
      writeFileSync(join(sandbox.workDir, 'alpha.txt'), 'a\n');
      mkdirSync(join(sandbox.workDir, 'folder'), { recursive: true });
      writeFileSync(join(sandbox.workDir, 'folder', 'beta.txt'), 'b\n');
    },
    async script({ pane, record: runRecord }) {
      await waitLog(log, entry => entry.event === 'editor_installed', 30000);
      const caseNames = ['empty', 'hello', 'hello-dot', 'time', 'korean', 'dot-slash', 'slash-sk', 'cdrive', 'list-open'];
      for (const name of caseNames) {
        const setWait = waitLog(log, entry => entry.event === 'case_set' && entry.case === name, 20000);
        sendKeys(pane, 'ctrl+shift+y');
        await setWait;
        if (name === 'list-open') {
          const firstTab = waitLog(log, entry => entry.event === 'tab' && entry.case === name && entry.autocompleteBefore === false, 15000);
          const firstRender = waitLog(log, entry => entry.event === 'tab_render' && entry.case === name && entry.autocompleteAfterRender === true, 8000).catch(() => null);
          sendKeys(pane, 'tab');
          await firstTab;
          await firstRender;
          const secondTab = waitLog(log, entry => entry.event === 'tab' && entry.case === name && entry.autocompleteBefore === true, 15000);
          sendKeys(pane, 'tab');
          await secondTab;
          continue;
        }
        const tabWait = waitLog(log, entry => entry.event === 'tab' && entry.case === name, 15000);
        const renderWait = (name === 'dot-slash' || name === 'slash-sk')
          ? waitLog(log, entry => entry.event === 'tab_render' && entry.case === name && entry.autocompleteAfterRender === true, 8000).catch(() => null)
          : Promise.resolve(null);
        sendKeys(pane, 'tab');
        await tabWait;
        await renderWait;
        sendKeys(pane, 'right');
        await waitLog(log, entry => entry.event === 'next_input' && entry.case === name, 10000).catch(() => null);
      }
      runRecord.logRecords = readLog(log);
    },
  });
  const records = readLog(log);
  const tabs = records.filter(entry => entry.event === 'tab');
  const nexts = records.filter(entry => entry.event === 'next_input');
  const afterSuper = records.filter(entry => entry.event === 'tab_after_super');
  const renders = records.filter(entry => entry.event === 'tab_render' && entry.autocompleteAfterRender === true);
  const byCase = name => tabs.filter(entry => entry.case === name);
  const listOpenSecond = byCase('list-open')[1] ?? null;
  const pathCases = ['empty', 'hello', 'hello-dot', 'time', 'korean', 'dot-slash', 'slash-sk', 'cdrive'];
  const tokenShapes = Object.fromEntries(pathCases.map(name => {
    const tab = byCase(name)[0] ?? null;
    return [name, tab ? { token: tab.tokenBefore, pathLike: tab.pathLike, autocompleteBefore: tab.autocompleteBefore } : null];
  }));
  const completionOpened = name => nexts.some(entry => entry.case === name && entry.autocompleteBefore === true) ||
    afterSuper.some(entry => entry.case === name && entry.autocompleteAfterSuper === true) ||
    renders.some(entry => entry.case === name);
  results.P6 = {
    verdict: tabs.length === 10 && tokenShapes.empty.token === '' && tokenShapes['slash-sk'].token === '/sk' &&
      tokenShapes['dot-slash'].token === './' && tokenShapes.cdrive.token === 'C:\\' &&
      pathCases.every(name => byCase(name).length === 1) && listOpenSecond?.autocompleteBefore === true &&
      completionOpened('dot-slash') && completionOpened('slash-sk')
      ? 'PASS'
      : 'FAIL',
    decision: 'Tab may cycle only when the token before the cursor is empty or not path/command-like; every path/slash-like token is passed to super.handleInput, which still opens completion',
    log,
    tokenShapes,
    listOpenSecond,
    completion: Object.fromEntries(pathCases.map(name => [name, completionOpened(name)])),
    tabs,
    nexts,
    afterSuper,
    renders,
    run: record,
  };
}

async function p7() {
  const log = freshLog('p7.log');
  const record = { log };
  let streamStarted;
  const streaming = new Promise(resolveStream => { streamStarted = resolveStream; });
  await withPane({
    name: 'p7',
    label: 'PiOMO P7 submit',
    extensions: [join(PROBE_DIR, 'p7-submit.mjs')],
    extraEnv: { PIOMO_P7_LOG: log },
    mockOptions: {
      route(body) {
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const last = messages.at(-1);
        if (last?.role === 'user' && textOf(last).includes('P7 stream')) {
          return {
            chunks: Array.from({ length: 18 }, (_, index) => `stream-${index} `),
            delayMs: 220,
            onStart: () => streamStarted(),
          };
        }
        return { text: 'P7 final answer' };
      },
    },
    async script({ pane, record: runRecord }) {
      sendText(pane, '/probe-install');
      sendKeys(pane, 'enter');
      const install = await waitOutput(pane, 'P7INSTALL:', { timeout: 30000 });
      runRecord.installWait = install.code;
      runRecord.installResult = /P7INSTALL:(\w+)/.exec(install.stdout)?.[1] ?? null;
      // Idle submit.
      sendText(pane, '/ulw-execute x');
      sendKeys(pane, 'enter');
      await waitOutput(pane, 'P7 final answer', { timeout: 45000 }).catch(() => null);
      runRecord.idleFrame = readText(pane);
      // Streaming submit: start a slow stream, then submit while it is live.
      sendText(pane, 'P7 stream');
      sendKeys(pane, 'enter');
      await streaming;
      runRecord.streamingSeen = true;
      sendText(pane, '/ulw-execute y');
      sendKeys(pane, 'enter');
      await waitOutput(pane, 'stream-17', { timeout: 45000 }).catch(() => null);
      runRecord.logRecords = readLog(log);
    },
  });
  const records = readLog(log);
  const wraps = records.filter(entry => entry.event === 'submit_wrap');
  const inputs = records.filter(entry => entry.event === 'input_event');
  const idleWrap = wraps.find(entry => entry.text === '/ulw-execute x') ?? null;
  const streamWrap = wraps.find(entry => entry.text === '/ulw-execute y') ?? null;
  const inputAfter = wrap => wrap ? inputs.find(entry => entry.sequence > wrap.sequence) ?? null : null;
  const idleInput = inputAfter(idleWrap);
  const streamInput = inputAfter(streamWrap);
  results.P7 = {
    verdict: idleWrap && streamWrap && idleWrap.idle === true && streamWrap.idle === false &&
      idleWrap.sequence < idleInput?.sequence && streamWrap.sequence < streamInput?.sequence
      ? 'PASS'
      : 'FAIL',
    decision: 'the onSubmit wrap installed after setEditorComponent sees /ulw-execute before command dispatch, idle and while streaming',
    log,
    wrapped: records.find(entry => entry.event === 'editor_installed') ?? null,
    idleWrap,
    streamWrap,
    idleInput,
    streamInput,
    run: record,
  };
}

try {
  if (only.has('P5A')) await p5a();
  if (only.has('P5B')) await p5b();
  if (only.has('P3')) await p3();
  if (only.has('P6')) await p6();
  if (only.has('P7')) await p7();
  const path = join(RAW, 'tui-results.json');
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const merged = { ...previous, ...results };
  delete merged.error;
  writeJson(path, merged);
  for (const [name, result] of Object.entries(results)) {
    console.log(`${name}: ${result.verdict} - ${result.decision}`);
  }
} catch (error) {
  const path = join(RAW, 'tui-results.json');
  const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  writeJson(path, { ...previous, ...results, error: String(error?.stack ?? error) });
  throw error;
}
