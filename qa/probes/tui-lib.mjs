// Herdr-pane helpers for the TUI probes. Follows the
// herdr-pane-live-tui-verification skill: owned no-focus pane, real key input,
// frame reads, and the pane is closed only when this driver created it.
import { execFile, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROBE_DIR } from './lib.mjs';
import {
  MOCK_API_KEY, MOCK_MODELS,
} from '../mock-extension.mjs';
import {
  SENPI_CLI, PLUGIN, ROOT, createSandbox, probeEnvironment, startMockProvider,
} from '../harness.mjs';

export const HERDR = 'C:/Users/USER/.omo-stable-500/home/.herdr/packages/standalone/releases/0.9.3-x86_64-pc-windows-msvc/herdr.exe';
export const MOCK_EXTENSION = join(ROOT, 'qa', 'mock-extension.mjs');

export function herdr(args, { timeout = 30000 } = {}) {
  const result = spawnSync(HERDR, args, { encoding: 'utf8', timeout, windowsHide: true });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function herdrAsync(args, { timeout = 40000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(HERDR, args, { encoding: 'utf8', timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) resolve({ code: null, stdout: stdout ?? '', stderr: `${stderr ?? ''}\nTIMEOUT` });
        else reject(error);
        return;
      }
      resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

export function ownerPane() {
  const id = process.env.HERDR_PANE_ID;
  if (!id) throw new Error('HERDR_PANE_ID is required to create an owned pane');
  return id;
}

export function createPane(cwd, label) {
  const split = herdr([
    'pane', 'split', '--pane', ownerPane(), '--direction', 'down', '--ratio', '0.5', '--cwd', cwd, '--no-focus',
  ]);
  if (split.code !== 0) throw new Error(`pane split failed: ${split.stderr || split.stdout}`);
  const match = /"pane_id"\s*:\s*"([^"]+)"/.exec(split.stdout);
  if (!match) throw new Error(`pane split returned no pane id: ${split.stdout}`);
  const paneId = match[1];
  herdr(['pane', 'rename', paneId, label]);
  return paneId;
}

export function closePane(paneId) {
  return herdr(['pane', 'close', paneId]);
}

export function run(paneId, command) {
  return herdr(['pane', 'run', paneId, command]);
}

export function sendText(paneId, text) {
  return herdr(['pane', 'send-text', paneId, text]);
}

export function sendKeys(paneId, ...keys) {
  return herdr(['pane', 'send-keys', paneId, ...keys]);
}

export function readRaw(paneId) {
  const result = herdr(['pane', 'read', paneId, '--source', 'visible', '--format', 'ansi']);
  return result.stdout;
}

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

export function readText(paneId) {
  return stripAnsi(readRaw(paneId));
}

export function waitOutput(paneId, match, { timeout = 30000, source = 'recent', lines } = {}) {
  const args = ['pane', 'wait-output', '--match', match, '--source', source, '--timeout', String(timeout)];
  if (lines) args.push('--lines', String(lines));
  args.push(paneId);
  return herdrAsync(args, { timeout: timeout + 5000 });
}

export function waitRegex(paneId, pattern, { timeout = 30000, source = 'recent' } = {}) {
  return herdrAsync([
    'pane', 'wait-output', '--regex', pattern, '--source', source, '--timeout', String(timeout), paneId,
  ], { timeout: timeout + 5000 });
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Create a temp agent dir/home, write the probe settings and a space-free .ps1
 * launcher, and return everything the driver needs.
 */
export function createTuiSandbox({
  name,
  extensions,
  omoConfig,
  settings,
  model = 'claude-mock-medium',
  thinking = 'off',
  mockUrl,
  prompt,
  extraEnv = {},
  pluginPath = PLUGIN,
  pluginCopy = false,
  omoFlags = true,
}) {
  const sandbox = createSandbox();
  const dir = join(sandbox.stateDir, 'tui');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(sandbox.agentDir, 'settings.json'), `${JSON.stringify({
    quietStartup: true,
    packages: [],
    extensions: [],
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, modelFallback: false, provider: { maxRetries: 0 } },
    defaultProjectTrust: 'always',
    theme: 'dark',
    ...settings,
  }, null, 2)}\n`, 'utf8');
  if (omoConfig) {
    writeFileSync(join(sandbox.home, '.omo', 'omo.jsonc'), `${JSON.stringify(omoConfig, null, 2)}\n`, 'utf8');
  }
  // The interactive CLI resolves --provider/--model before extensions register
  // providers, so the mock provider is declared in the agent's models.json.
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
  lines.push(`Set-Location ${psQuote(sandbox.workDir)}`);

  let effectivePlugin = pluginPath;
  if (effectivePlugin && pluginCopy) {
    const copy = join(dir, 'plugin');
    cpSync(effectivePlugin, copy, { recursive: true });
    effectivePlugin = copy;
  }
  const args = [
    SENPI_CLI,
    '--offline',
    '--no-extensions',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-themes',
    '--no-approve',
    ...(effectivePlugin ? ['--extension', effectivePlugin] : []),
    ...extensions.flatMap(extension => ['--extension', extension]),
    '--provider', 'qa-mock',
    '--model', model,
    '--thinking', thinking,
    '--session-dir', sandbox.sessionDir,
    '--session', sandbox.sessionFile,
    ...(omoFlags ? [
      '--omo-senpi-memory-disabled',
      '--omo-senpi-builtin-mcps-disabled',
      '--omo-senpi-config-watch-disabled',
      '--omo-senpi-model-profile-disabled',
      '--omo-senpi-ulw-loop-disabled',
      '--omo-senpi-telemetry-disabled',
    ] : []),
  ];
  if (prompt) args.push('--', prompt);
  lines.push(`& ${psQuote(process.execPath)} ${args.map(psQuote).join(' ')}`);
  const script = join(dir, `run-${name}.ps1`);
  writeFileSync(script, `${lines.join('\n')}\n`, 'utf8');

  return { sandbox, dir, script, command: `powershell -NoProfile -ExecutionPolicy Bypass -File ${script}` };
}

export async function startMock(options) {
  return startMockProvider(options);
}

export function killTree(pid) {
  if (!pid) return true;
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
  return true;
}

export function pidGone(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

export { PLUGIN, SENPI_CLI, PROBE_DIR };
