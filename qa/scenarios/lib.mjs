// Shared driver for the todo-11 real-run QA scenarios.
//
// Every scenario gets its own temporary agent dir/home, its own local mock
// provider, its own Herdr pane (TUI) and one evidence file. The package under
// test is installed the way a user installs it: a `packages` entry in the
// temporary `settings.json` (never a live agent dir).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MOCK_API_KEY, MOCK_MODELS,
} from '../mock-extension.mjs';
import {
  ROOT, SENPI_CLI, PLUGIN, SEEDED_MODEL_PROFILES, createSandbox, probeEnvironment, startMockProvider,
} from '../harness.mjs';
import {
  closePane, createPane, herdr, killTree, pidGone, readText, run, sendKeys,
  sendText, waitOutput, waitRegex,
} from '../probes/tui-lib.mjs';

export const MOCK_EXTENSION = join(ROOT, 'qa', 'mock-extension.mjs');
export const DEFAULT_SETTINGS = {
  quietStartup: true,
  packages: [],
  extensions: [],
  // The real TUI surface loads builtins; disable only the settings-file watcher
  // so a settings write at turn end cannot clear the editor mid-scenario.
  disabledBuiltinExtensions: ['config-reload'],
  compaction: { enabled: false },
  retry: { enabled: false, maxRetries: 0, modelFallback: false, provider: { maxRetries: 0 } },
  defaultProjectTrust: 'always',
  theme: 'dark',
};

export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Create the temp sandbox, settings, provider models and a space-free launcher. */
export function createTuiScenario({
  name,
  settings = {},
  omoConfig,
  pluginPath = PLUGIN,
  pluginCopy = false,
  patchPlugin,
  packages = [ROOT],
  model = 'claude-mock-medium',
  thinking = 'off',
  mockUrl,
  extraExtensions = [],
  extraEnv = {},
  sessionName = 'owned',
  sessionArg,
  extraArgs = [],
  noSkills = false,
  modelProfiles,
  sandbox: existingSandbox,
  workDir: requestedWorkDir,
} = {}) {
  const sandbox = existingSandbox ?? createSandbox();
  const workDir = requestedWorkDir ?? sandbox.workDir;
  const dir = join(sandbox.stateDir, 'tui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(sandbox.agentDir, 'settings.json'), `${JSON.stringify({
    ...DEFAULT_SETTINGS,
    ...settings,
    packages,
  }, null, 2)}\n`, 'utf8');
  if (omoConfig || modelProfiles) {
    writeFileSync(join(sandbox.home, '.omo', 'omo.jsonc'), `${JSON.stringify(
      modelProfiles ?? omoConfig, null, 2)}\n`, 'utf8');
  }
  if (mockUrl) {
    writeFileSync(join(sandbox.agentDir, 'models.json'), `${JSON.stringify({
      providers: {
        'qa-mock': {
          name: 'PiOMO local QA mock',
          api: 'openai-completions',
          baseUrl: mockUrl,
          apiKey: MOCK_API_KEY,
          models: MOCK_MODELS,
        },
      },
    }, null, 2)}\n`, 'utf8');
  }

  const env = probeEnvironment(sandbox, {
    ...(mockUrl ? { PIOMO_QA_MOCK_URL: mockUrl } : {}),
    ...extraEnv,
  });
  const unset = [
    'PI_SESSION_ID', 'PI_GOAL_ID', 'OMO_AGENT_TOOLKIT_SDK_ROOT', 'OMO_DAG_', 'OMO_HERDR_PANE_ID',
    'SENPI_HOST_ID', 'PI_HOST_ID',
  ];
  const lines = ['$ErrorActionPreference = "Stop"'];
  const setKeys = new Set([
    'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
    'OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR',
    'OMO_CODING_AGENT_SESSION_DIR', 'SENPI_CODING_AGENT_SESSION_DIR', 'PI_CODING_AGENT_SESSION_DIR',
    'OMO_RUNTIME', 'SENPI_RUNTIME', 'OMO_NATIVE', 'SENPI_BRAND', 'PI_OFFLINE', 'PI_TELEMETRY',
    'OMO_TELEMETRY', 'DO_NOT_TRACK', ...Object.keys(extraEnv),
  ]);
  for (const key of Object.keys(env)) {
    if (!setKeys.has(key)) continue;
    if ((extraEnv && Object.hasOwn(extraEnv, key)) || /^(PI_SESSION_|PI_GOAL_|OMO_AGENT_TOOLKIT_|OMO_DAG_|OMO_HERDR_|SENPI_HOST_|PI_HOST_)/.test(key)) {
      continue;
    }
    lines.push(`$env:${key} = ${psQuote(env[key])}`);
  }
  for (const key of Object.keys(extraEnv)) {
    lines.push(`$env:${key} = ${psQuote(extraEnv[key])}`);
  }
  for (const prefix of unset) {
    lines.push(`Get-ChildItem Env: | Where-Object { $_.Name -like ${psQuote(`${prefix}*`)} } | ForEach-Object { Remove-Item "Env:$($_.Name)" }`);
  }
  lines.push(`Set-Location ${psQuote(workDir)}`);

  let effectivePlugin = pluginPath;
  if (effectivePlugin && pluginCopy) {
    const copy = join(dir, 'plugin');
    cpSync(effectivePlugin, copy, { recursive: true });
    effectivePlugin = copy;
    patchPlugin?.(copy);
  }

  const sessionFile = join(sandbox.sessionDir, `${sessionName}.jsonl`);
  const args = [
    SENPI_CLI,
    '--offline',
    ...(noSkills ? ['--no-skills'] : []),
    '--no-prompt-templates',
    '--no-context-files',
    '--no-themes',
    '--no-approve',
    ...(effectivePlugin ? ['--extension', effectivePlugin] : []),
    '--extension', MOCK_EXTENSION,
    ...extraExtensions.flatMap(extension => ['--extension', extension]),
    '--provider', 'qa-mock',
    '--model', model,
    '--thinking', thinking,
    '--session-dir', sandbox.sessionDir,
    '--session', sessionArg ?? sessionFile,
    '--omo-senpi-memory-disabled',
    '--omo-senpi-builtin-mcps-disabled',
    '--omo-senpi-config-watch-disabled',
    '--omo-senpi-model-profile-disabled',
    '--omo-senpi-ulw-loop-disabled',
    '--omo-senpi-telemetry-disabled',
    ...extraArgs,
  ];
  lines.push(`& ${psQuote(process.execPath)} ${args.map(psQuote).join(' ')}`);
  const script = join(dir, `run-${name}.ps1`);
  writeFileSync(script, `${lines.join('\n')}\n`, 'utf8');

  return {
    sandbox,
    dir,
    script,
    sessionFile,
    sessionDir: sandbox.sessionDir,
    agentDir: sandbox.agentDir,
    home: sandbox.home,
    workDir: sandbox.workDir,
    workDir,
    command: `powershell -NoProfile -ExecutionPolicy Bypass -File ${script}`,
    args,
    pluginPath: effectivePlugin,
    mockUrl: mockUrl ?? null,
  };
}

/** Start the local mock. `steps` are consumed per chat-completion request. */
export async function startMock(options = {}) {
  return startMockProvider(options);
}

/** Read all JSONL entries of a session file (the header is filtered out). */
export function sessionEntries(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function userMessages(entries) {
  return entries
    .filter(entry => entry?.type === 'message' && entry.message?.role === 'user')
    .map(entry => entry.message.content.filter(part => part.type === 'text').map(part => part.text).join(''));
}

export function assistantTexts(entries) {
  return entries
    .filter(entry => entry?.type === 'message' && entry.message?.role === 'assistant')
    .flatMap(entry => entry.message.content
      .filter(part => part.type === 'text')
      .map(part => part.text));
}

export function toolResults(entries) {
  return entries
    .filter(entry => entry?.type === 'message' && entry.message?.role === 'toolResult')
    .map(entry => ({
      toolCallId: entry.message.toolCallId,
      toolName: entry.message.toolName,
      isError: entry.message.isError === true,
      text: entry.message.content.filter(part => part.type === 'text').map(part => part.text).join(''),
      nestedCalls: entry.message.nestedCalls ?? null,
    }));
}

export function modelChanges(entries) {
  return entries.filter(entry => entry?.type === 'model_change');
}

export function identityEntries(entries) {
  return entries.filter(entry => entry?.type === 'custom' && entry.customType === 'primary-agent/v1');
}

export function stopStateCount(entries) {
  return entries.filter(entry => entry?.type === 'custom' && entry.customType === 'senpi.hooks.stop-state').length;
}

/** Wait for a new turn-end marker (`senpi.hooks.stop-state`) after `before`. */
export async function waitTurnEnd(file, before, { timeout = 30000 } = {}) {
  await waitFile(file, () => stopStateCount(sessionEntries(file)) > before, {
    timeout,
    label: `turn end in ${file}`,
  });
  return sessionEntries(file);
}

/** Event-driven wait on a file predicate; the timeout is the only clock. */
export function waitFile(file, predicate, { timeout = 30000, label = file } = {}) {
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
      try {
        if (predicate()) finish(null, true);
      } catch (error) {
        finish(error);
      }
    };
    const timer = setTimeout(() => finish(new Error(`timeout waiting for ${label}`)), timeout);
    try {
      watcher = watch(dirname(file), { persistent: false }, (_event, filename) => {
        if (!filename || String(filename).toLowerCase() === file.split(/[\\/]/).at(-1).toLowerCase()) check();
      });
    } catch {
      // The file's directory may not exist yet; the timeout still bounds the wait.
    }
    check();
  });
}

/** Wait until the session file contains an entry matching `predicate`. */
export async function waitSessionEntry(file, predicate, options = {}) {
  await waitFile(file, () => sessionEntries(file).some(predicate), options);
  return sessionEntries(file);
}

/** Wait for a tool result with the given tool name (latest one). */
export async function waitToolResult(file, toolName, options = {}) {
  const entries = await waitSessionEntry(
    file,
    entry => entry?.type === 'message' && entry.message?.role === 'toolResult'
      && entry.message.toolName === toolName,
    options,
  );
  return toolResults(entries).filter(result => result.toolName === toolName).at(-1) ?? null;
}

export function paneText(pane) {
  return readText(pane);
}

export function paneRaw(pane) {
  return herdr(['pane', 'read', pane, '--source', 'visible', '--format', 'ansi']).stdout;
}

export function readRecent(pane, lines = 240) {
  return herdr(['pane', 'read', pane, '--source', 'recent', '--lines', String(lines)]).stdout;
}

export async function waitReady(pane, timeout = 45000) {
  const debug = process.env.PIOMO_QA_DEBUG === '1' ? (message) => console.error(`[qa] ${message}`) : () => {};
  debug(`ready: waiting for footer (${pane})`);
  await waitRegex(pane, '\\(qa-mock\\)|Settings: settings.json', { timeout });
  debug('ready: footer seen');
  await waitRegex(pane, 'Tab 전환 UI를 불러오지 못했어요|▌ ', { timeout: 10000 }).catch(() => null);
  debug('ready: extension session_start paint seen or timed out');
}

/** Quit the CLI and wait for its resume hint, then the shell prompt. */
export async function exitCli(pane) {
  sendText(pane, '/exit');
  sendKeys(pane, 'enter');
  await waitOutput(pane, 'To resume this session', { timeout: 20000 }).catch(() => null);
  await waitOutput(pane, 'PS ', { timeout: 5000 }).catch(() => null);
}

export function editorWarning(text) {
  const line = String(text ?? '').split(/\r?\n/).find(entry => entry.includes('Tab 전환 UI를 불러오지 못했어요'));
  return line ?? null;
}

export function hasLabel(text) {
  return String(text ?? '').includes('▌ ');
}

export function lastModelChange(entries) {
  return [...entries].reverse().find(entry => entry?.type === 'model_change') ?? null;
}

export function systemPromptOf(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const system = messages.find(message => message?.role === 'system');
  if (!system) return '';
  if (typeof system.content === 'string') return system.content;
  if (Array.isArray(system.content)) {
    return system.content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  return '';
}

/** True for the host's auxiliary session-title request. */
export function isTitleRequest(body) {
  return /Generate a concise title|title for this coding-agent session/i.test(systemPromptOf(body));
}

export function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  return '';
}

export function normalizeVolatile(text, replacements = []) {
  let out = String(text ?? '');
  for (const [pattern, value] of replacements) out = out.replace(pattern, value);
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
  out = out.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}(?:\.\d+)?Z?\b/g, '<TIMESTAMP>');
  out = out.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<DATE>');
  out = out.replace(/mock-tool-\d+/g, '<TOOLID>');
  out = out.replace(/st_[0-9a-z]+/gi, '<TASKID>');
  return out;
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function listSessionFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => join(dir, name));
}

export function listSessionFilesDeep(dir) {
  const out = [];
  const visit = (current) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path);
    }
  };
  visit(dir);
  return out;
}

/** Wait until some session file under `dir` contains a matching line. */
export async function waitForSessionContaining(dir, predicate, { timeout = 30000 } = {}) {
  const find = () => listSessionFilesDeep(dir).find(file => sessionEntries(file).some(predicate));
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
      try {
        const hit = find();
        if (hit) finish(null, hit);
      } catch (error) {
        finish(error);
      }
    };
    const timer = setTimeout(() => finish(new Error(`timeout waiting for a session file under ${dir}`)), timeout);
    try {
      watcher = watch(dir, { persistent: false, recursive: true }, check);
    } catch {
      // The timeout still bounds the wait.
    }
    check();
  });
}

export async function waitForNewSessionFiles(dir, before, { timeout = 30000 } = {}) {
  const baseline = new Set(before);
  await waitFile(join(dir, '.watch'), () => listSessionFiles(dir).some(file => !baseline.has(file)), {
    timeout,
    label: `new session file in ${dir}`,
  });
  return listSessionFiles(dir).filter(file => !baseline.has(file));
}

export function writeText(out, name, text) {
  mkdirSync(out, { recursive: true });
  const file = join(out, name);
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return file;
}

export function applyGateAdapter(pluginDir, stateDir) {
  const script = join(ROOT, 'scripts', 'gate-adapter.mjs');
  const target = join(pluginDir, 'extensions', 'omo-task.js');
  const result = spawnSync(process.execPath, [script, 'install', '--target', target, '--state-dir', stateDir], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  if (result.status !== 0) {
    throw new Error(`gate adapter install failed: ${result.stderr || result.stdout}`);
  }
  return { target, stdout: result.stdout, stderr: result.stderr, status: result.status };
}

export function currentPaneLayout(pane) {
  try {
    const parsed = JSON.parse(herdr(['pane', 'layout', '--pane', pane]).stdout);
    const panes = parsed?.result?.layout?.panes ?? [];
    return panes.find(entry => entry.pane_id === pane) ?? null;
  } catch {
    return null;
  }
}

/** Resize the split that owns `pane` to approximately `cols` cells. */
export function resizePaneTo(pane, cols, { directions = ['right', 'left'] } = {}) {
  const area = JSON.parse(herdr(['pane', 'layout', '--pane', pane]).stdout)?.result?.layout?.area;
  if (!area) return null;
  let current = currentPaneLayout(pane);
  if (!current) return null;
  for (const direction of directions) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      current = currentPaneLayout(pane);
      if (!current || Math.abs(current.rect.width - cols) <= 1) return current;
      const delta = cols - current.rect.width;
      const other = direction === 'right' ? 'left' : 'right';
      // `amount` is a ratio delta; convert the wanted cell delta to a ratio.
      const ratio = Math.max(0.01, Math.min(0.2, Math.abs(delta) / area.width));
      const stepDirection = delta > 0 ? other : direction;
      const result = herdr(['pane', 'resize', '--pane', pane, '--direction', stepDirection, '--amount', String(ratio)]);
      if (result.code !== 0) break;
    }
  }
  return currentPaneLayout(pane);
}

/** Create a full-width pane in a new tab (Herdr area width, not 200 in an 86-col split). */
export function createTabPane(cwd, label) {
  const created = herdr(['tab', 'create', '--cwd', cwd, '--label', label]);
  const match = /"pane_id"\s*:\s*"([^"]+)"/.exec(created.stdout);
  if (!match) throw new Error(`tab create returned no pane: ${created.stdout}`);
  return match[1];
}

export function processesFor(marker) {
  const command = [
    'Get-CimInstance Win32_Process',
    `| Where-Object { $_.CommandLine -like '*${String(marker).replaceAll("'", "''")}*' }`,
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

export function cleanupScenario(scenario) {
  const leftovers = processesFor(scenario.sandbox.stateDir);
  for (const entry of leftovers) {
    if (typeof entry.ProcessId === 'number') killTree(entry.ProcessId);
  }
  const stillThere = processesFor(scenario.sandbox.stateDir);
  const cleanup = scenario.sandbox.cleanup();
  return {
    processesBeforeCleanup: leftovers.length,
    processesAfterKill: stillThere.length,
    cleanup,
  };
}

export async function runTuiScenario({
  out,
  name,
  evidenceName,
  scenarioOptions = {},
  mockOptions = {},
  mock: providedMock,
  label,
  requireEditor = false,
  keepSandbox = false,
  body,
}) {
  const mock = providedMock ?? await startMock({ captureBody: true, ...mockOptions });
  const scenario = createTuiScenario({ name, mockUrl: mock.baseUrl, ...scenarioOptions });
  try {
    return await withTuiScenario({
      name,
      out,
      evidenceName: evidenceName ?? `task-11-piomo-primary-agents-${name}`,
      scenario,
      mock,
      label,
      keepSandbox,
      body: async (pane, record) => {
        await waitReady(pane);
        const readyText = readRecent(pane);
        record.checks.readyFrame = readyText;
        const warning = editorWarning(readyText);
        record.checks.editorWarning = warning;
        record.checks.editorInstalled = warning === null && hasLabel(readyText);
        if (requireEditor && record.checks.editorInstalled !== true) {
          throw new Error(`editor_install_failed: ${warning ?? 'no label painted'}`);
        }
        return body(pane, record, scenario);
      },
    });
  } finally {
    if (providedMock === undefined) await mock.close();
  }
}

/** Send a model prompt and wait for the turn-end marker. */
export async function sendPrompt(pane, file, text, sentinel, { timeout = 45000 } = {}) {
  const before = stopStateCount(sessionEntries(file));
  await submitText(pane, text);
  if (sentinel) await waitOutput(pane, sentinel, { timeout }).catch(() => {});
  await waitTurnEnd(file, before, { timeout });
  return sessionEntries(file);
}

/** Type text, wait until the editor shows it, then submit. */
export async function submitText(pane, text, token) {
  const debug = process.env.PIOMO_QA_DEBUG === '1' ? (message) => console.error(`[qa] ${message}`) : () => {};
  debug(`submit: sending ${JSON.stringify(text)}`);
  const marker = token ?? String(text).split(/\r?\n/)[0].slice(0, 60);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    sendText(pane, text);
    if (!marker) break;
    const seen = await waitOutput(pane, marker, { timeout: 5000 }).catch(() => ({ code: 1 }));
    debug(`submit: marker attempt ${attempt + 1} code=${seen.code}`);
    if (seen.code === 0) break;
  }
  // Slash commands open an autocomplete list; Escape closes the list so Enter
  // submits the command instead of accepting the highlighted completion.
  if (String(text).trimStart().startsWith('/')) sendKeys(pane, 'escape');
  sendKeys(pane, 'enter');
  debug('submit: enter sent');
}

/** Standard scenario wrapper: pane, raw frames, result JSON, cleanup. */
export async function withTuiScenario({
  name,
  out,
  evidenceName,
  scenario,
  mock,
  body,
  label,
  closePaneAfter = true,
  keepSandbox = false,
}) {
  const pane = createPane(scenario.workDir, label ?? `PiOMO ${name}`);
  const frames = [];
  const record = {
    scenario: name,
    pane,
    agentDir: scenario.agentDir,
    home: scenario.home,
    stateDir: scenario.sandbox.stateDir,
    sessionFile: scenario.sessionFile,
    command: scenario.command,
    startedAt: new Date().toISOString(),
    checks: {},
    frames,
  };
  let error = null;
  try {
    run(pane, scenario.command);
    record.result = await body(pane, record);
    record.ok = record.result?.ok === true;
    if (!record.ok) throw new Error(record.result?.error ?? record.result?.reason ?? 'scenario body did not report ok');
  } catch (caught) {
    error = caught;
    record.ok = false;
    record.error = String(caught?.stack ?? caught);
    try { frames.push({ name: 'error-frame', text: paneText(pane), raw: paneRaw(pane) }); } catch { /* pane gone */ }
  } finally {
    record.endedAt = new Date().toISOString();
    record.sessionEntries = sessionEntries(scenario.sessionFile);
    try { record.finalFrame = paneText(pane); } catch { record.finalFrame = ''; }
    if (closePaneAfter) {
      try { closePane(pane); } catch { /* already gone */ }
    }
    const leftovers = processesFor(scenario.sandbox.stateDir);
    for (const entry of leftovers) {
      if (typeof entry.ProcessId === 'number') killTree(entry.ProcessId);
    }
    record.processesAfterClose = leftovers;
    record.processesAfterKill = processesFor(scenario.sandbox.stateDir);
    if (keepSandbox) {
      record.cleanup = {
        kept: true,
        stateDir: scenario.sandbox.stateDir,
        processesAfterClose: record.processesAfterClose.length,
        processesAfterKill: record.processesAfterKill.length,
      };
    } else {
      let removed = false;
      try {
        removed = scenario.sandbox.cleanup().removed;
      } catch (cleanupError) {
        record.cleanupError = String(cleanupError?.message ?? cleanupError);
      }
      record.cleanup = {
        stateDir: scenario.sandbox.stateDir,
        removed,
        processesAfterClose: record.processesAfterClose.length,
        processesAfterKill: record.processesAfterKill.length,
      };
    }
    record.mockRequests = mock?.requests?.map(({ body: _body, ...rest }) => rest) ?? [];
    writeEvidence(out, evidenceName, record);
    if (error) throw error;
  }
  return record;
}

/** Write the evidence file (raw, human-readable; one file per scenario). */
export function writeEvidence(out, name, record) {
  mkdirSync(out, { recursive: true });
  const lines = [];
  lines.push(`# ${name}`);
  lines.push('');
  lines.push(`- Result: ${record.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`- Started: ${record.startedAt}`);
  lines.push(`- Ended: ${record.endedAt}`);
  lines.push(`- Pane: ${record.pane ?? 'none'}`);
  lines.push(`- Temp agent dir: ${record.agentDir ?? 'none'}`);
  lines.push(`- Temp home: ${record.home ?? 'none'}`);
  lines.push(`- Session file: ${record.sessionFile ?? 'none'}`);
  lines.push(`- Command: ${record.command ?? 'none'}`);
  if (record.error) {
    lines.push('');
    lines.push('## Error');
    lines.push('');
    lines.push('```');
    lines.push(record.error);
    lines.push('```');
  }
  lines.push('');
  lines.push('## Checks');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(record.checks ?? {}, null, 2));
  lines.push('```');
  if (record.result) {
    lines.push('');
    lines.push('## Result');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(record.result, null, 2));
    lines.push('```');
  }
  lines.push('');
  lines.push('## Pane frames');
  for (const frame of record.frames ?? []) {
    lines.push('');
    lines.push(`### ${frame.name}`);
    lines.push('');
    lines.push('```text');
    lines.push(frame.text);
    lines.push('```');
  }
  lines.push('');
  lines.push('## Session entries');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(record.sessionEntries ?? [], null, 2));
  lines.push('```');
  lines.push('');
  lines.push('## Cleanup');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(record.cleanup ?? {}, null, 2));
  lines.push('```');
  const file = join(out, `${name}.md`);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

export { closePane, createPane, herdr, killTree, pidGone, readText, run, sendKeys, sendText, waitOutput };
