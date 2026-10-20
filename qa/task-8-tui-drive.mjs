// Todo 8 visual QA driver. One owned Herdr pane, a temporary agent dir/home,
// the local mock provider and no OMO extension: the pane shows only the
// primary-agent label under the editor.
//
// Usage: node qa/task-8-tui-drive.mjs <evidence dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './harness.mjs';
import {
  closePane, createPane, createTuiSandbox, herdr, killTree, readRaw, readText, run,
  sendKeys, sendText, startMock, waitOutput,
} from './probes/tui-lib.mjs';

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node qa/task-8-tui-drive.mjs <evidence dir>');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const LOG = join(OUT, 'task-8-piomo-primary-agents-tui.jsonl');
const FRAMES = join(OUT, 'task-8-piomo-primary-agents-tui-frames.txt');
const FRAMES_ANSI = join(OUT, 'task-8-piomo-primary-agents-tui-frames-ansi.txt');
const RESULT = join(OUT, 'task-8-piomo-primary-agents-tui-run.json');
writeFileSync(LOG, '', 'utf8');

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function readLog() {
  try {
    return readFileSync(LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function cycleCount() {
  return readLog().filter(entry => entry.event === 'cycle').length;
}

// Event-driven wait on the extension's JSONL log. Subscribe first, then check
// the records already present; the timeout is the only bound.
function waitLog(predicate, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* closed */ }
      if (error) reject(error);
      else resolve(value);
    };
    const check = () => {
      const hit = readLog().find(predicate);
      if (hit) finish(null, hit);
    };
    const timer = setTimeout(() => finish(new Error(`log timeout waiting for ${LOG}`)), timeout);
    try {
      watcher = watch(LOG, { persistent: false }, check);
    } catch {
      // The log should exist by now; the timeout still bounds the wait.
    }
    check();
  });
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
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.filter(entry => !String(entry.CommandLine ?? '').includes('Get-CimInstance'));
  } catch {
    return [];
  }
}

const frames = [];
function capture(name, pane) {
  const raw = readRaw(pane);
  const text = readText(pane);
  frames.push({ text: `===== ${name} =====\n${text}`, raw: `===== ${name} =====\n${raw}` });
  return { name, text, raw };
}

function labelLine(text) {
  return text.split(/\r?\n/).filter(line => line.includes('▌')).at(-1) ?? '';
}

const mock = await startMock({ route: () => ({ text: 'QA mock response.' }) });
const tui = createTuiSandbox({
  name: 'task8',
  extensions: [join(ROOT, 'qa', 'task-8-tui.mjs')],
  pluginPath: null,
  omoFlags: false,
  mockUrl: mock.baseUrl,
  settings: { quietStartup: false },
  extraEnv: { PIOMO_T8_LOG: LOG },
});
writeFileSync(join(tui.sandbox.workDir, 'alpha.txt'), 'a\n', 'utf8');
mkdirSync(join(tui.sandbox.workDir, 'folder'), { recursive: true });
writeFileSync(join(tui.sandbox.workDir, 'folder', 'beta.txt'), 'b\n', 'utf8');

const pane = createPane(tui.sandbox.workDir, 'PiOMO T8 UI');
const record = {
  pane,
  agentDir: tui.sandbox.agentDir,
  home: tui.sandbox.home,
  stateDir: tui.sandbox.stateDir,
  command: tui.command,
  steps: [],
  checks: {},
};
let error = null;

try {
  run(pane, tui.command);

  const initialLabel = await waitOutput(pane, '▌ Sisyphus', { timeout: 60000 });
  expect(initialLabel.code === 0, 'the Sisyphus label never painted');
  expect(readLog().some(entry => entry.event === 'install' && entry.reason === 'session_start'),
    'session_start never installed the UI');

  record.processesBeforeClose = paneProcesses(tui.sandbox.stateDir);

  sendKeys(pane, 'ctrl+shift+y');
  await waitLog(entry => entry.event === 'install' && entry.reason === 'shortcut', 15000);
  const labelWait = await waitOutput(pane, '▌ Sisyphus', { timeout: 15000 });
  expect(labelWait.code === 0, 'the label disappeared after the reinstall');

  let frame = capture('01-initial', pane);
  let label = labelLine(frame.text);
  expect(label.includes('▌ Sisyphus  claude-mock-medium · medium'), `initial label: ${JSON.stringify(label)}`);
  expect(label.includes('Tab 전환'), `initial label has no Tab hint: ${JSON.stringify(label)}`);
  record.checks.initialLabel = label;

  const listed = JSON.parse(herdr(['pane', 'list']).stdout);
  const paneInfo = (listed.result?.panes ?? []).find(entry => entry.pane_id === pane);
  record.checks.terminalTitle = paneInfo?.terminal_title ?? null;
  expect(String(paneInfo?.terminal_title ?? '').includes('PiOMO · Sisyphus'),
    `terminal title was not set: ${JSON.stringify(paneInfo?.terminal_title)}`);

  sendKeys(pane, 'tab');
  await waitLog(entry => entry.event === 'cycle' && entry.agentId === 'hephaestus', 15000);
  const hephaestus = await waitOutput(pane, '▌ Hephaestus', { timeout: 20000 });
  expect(hephaestus.code === 0, 'Tab did not cycle to Hephaestus');
  frame = capture('02-tab-hephaestus', pane);
  label = labelLine(frame.text);
  expect(label.includes('▌ Hephaestus  gpt-mock-fast · medium'), `hephaestus label: ${JSON.stringify(label)}`);
  record.checks.hephaestusLabel = label;

  sendText(pane, 'hello');
  sendKeys(pane, 'tab');
  await waitLog(entry => entry.event === 'cycle' && entry.agentId === 'prometheus', 15000);
  const prometheus = await waitOutput(pane, '▌ Prometheus', { timeout: 20000 });
  expect(prometheus.code === 0, 'Tab on plain text did not cycle to Prometheus');
  frame = capture('03-tab-hello-prometheus', pane);
  label = labelLine(frame.text);
  expect(label.includes('▌ Prometheus  claude-mock-xhigh · xhigh'), `prometheus label: ${JSON.stringify(label)}`);
  record.checks.prometheusLabel = label;

  sendKeys(pane, 'ctrl+shift+i');
  await waitLog(entry => entry.event === 'set_text' && entry.text === '', 15000);

  const cyclesBeforePath = cycleCount();
  sendKeys(pane, 'ctrl+shift+u');
  await waitLog(entry => entry.event === 'set_text' && entry.text === './', 15000);
  sendKeys(pane, 'tab');
  const completion = await waitOutput(pane, 'alpha.txt', { timeout: 15000 });
  expect(completion.code === 0, 'path Tab did not open completion');
  frame = capture('04-path-completion', pane);
  label = labelLine(frame.text);
  expect(label.includes('Prometheus'), `path Tab changed the agent: ${JSON.stringify(label)}`);
  expect(cycleCount() === cyclesBeforePath, 'path Tab cycled the agent');
  record.checks.pathCompletionLabel = label;

  sendKeys(pane, 'escape');
  sendKeys(pane, 'ctrl+shift+i');
  await waitLog(entry => entry.event === 'set_text' && entry.text === '', 15000);

  sendKeys(pane, 'shift+tab');
  await waitLog(entry => entry.event === 'thinking_intent', 15000);
  frame = capture('05-shift-tab-thinking', pane);
  record.checks.thinkingIntent = true;

  const cyclesBeforeStreaming = cycleCount();
  sendKeys(pane, 'ctrl+shift+o');
  await waitLog(entry => entry.event === 'stream' && entry.streaming === true, 15000);
  sendKeys(pane, 'tab');
  await waitLog(entry => entry.event === 'notice' && entry.message === '응답 중에는 에이전트를 바꿀 수 없어요', 15000);
  frame = capture('06-streaming-busy', pane);
  label = labelLine(frame.text);
  expect(label.includes('Prometheus'), `streaming Tab changed the agent: ${JSON.stringify(label)}`);
  expect(cycleCount() === cyclesBeforeStreaming, 'streaming Tab cycled the agent');
  record.checks.streamingLabel = label;
  record.checks.busyNotice = true;

  sendKeys(pane, 'ctrl+shift+o');
  await waitLog(entry => entry.event === 'stream' && entry.streaming === false, 15000);

  frame = capture('07-final', pane);
  record.checks.finalLabel = labelLine(frame.text);
  record.logRecords = readLog();
} catch (caught) {
  error = String(caught?.stack ?? caught);
  try { frames.push(`===== ERROR =====\n${readText(pane)}`); } catch { /* pane gone */ }
  throw caught;
} finally {
  try { record.finalFrame = readText(pane); } catch { record.finalFrame = ''; }
  writeFileSync(FRAMES, `${frames.map(entry => entry.text ?? entry).join('\n\n')}\n`, 'utf8');
  writeFileSync(FRAMES_ANSI, `${frames.map(entry => entry.raw ?? '').join('\n\n')}\n`, 'utf8');
  try { closePane(pane); } catch { /* already gone */ }
  const leftovers = paneProcesses(tui.sandbox.stateDir);
  record.processesAfterClose = leftovers;
  for (const entry of leftovers) {
    if (typeof entry.ProcessId === 'number') killTree(entry.ProcessId);
  }
  record.processesAfterKill = paneProcesses(tui.sandbox.stateDir);
  record.cleanup = tui.sandbox.cleanup();
  record.error = error;
  writeFileSync(RESULT, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await mock.close();
  if (error) process.exitCode = 1;
}
