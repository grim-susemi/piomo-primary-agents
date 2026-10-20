import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MOCK_API_KEY, MOCK_MODELS, PROVIDER_ID } from './mock-extension.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SENPI_CLI = process.env.PIOMO_SENPI_CLI
  ?? 'C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js';
export const PLUGIN = process.env.PIOMO_PLUGIN
  ?? 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.38-r1/package/plugin';
export const HARNESS_DEADLINE_MS = 60000;
export const SELF_CHECK_SENTINEL = 'PIOMO_QA_SELF_CHECK_OK';

export const LIVE_ROOTS = [
  'C:/Users/USER/.omo-stable-500/home/.omo',
  'C:/Users/USER/.omo',
  'C:/Users/USER/.omo-original',
  'C:/Users/USER/.somo',
];

export const AGENT_IDS = ['sisyphus', 'hephaestus', 'prometheus', 'atlas'];
export const AGENT_LANES = {
  sisyphus: 'daily-normal',
  hephaestus: 'geeky-normal',
  prometheus: 'daily-heavy',
  atlas: 'daily-normal',
};

// The 5.1.38 lane shape: a lane names an ordered list of models, and each
// model is either a string or an object with model/variant/reasoning fields.
// P8 records the final override shape; until then this is the switcher-derived
// lane list expressed the way the installed plugin parses it.
export const SEEDED_MODEL_PROFILES = {
  'daily-normal': {
    display_name: 'QA daily normal',
    family: 'daily',
    tier: 'normal',
    models: [
      { model: 'qa-mock/claude-mock-medium', variant: 'medium' },
      { model: 'qa-mock/claude-mock-max', variant: 'max' },
    ],
  },
  'daily-heavy': {
    display_name: 'QA daily heavy',
    family: 'daily',
    tier: 'heavy',
    models: [
      { model: 'qa-mock/claude-mock-xhigh', variant: 'xhigh' },
    ],
  },
  'geeky-normal': {
    display_name: 'QA geeky normal',
    family: 'geeky',
    tier: 'normal',
    models: [
      { model: 'qa-mock/gpt-mock-fast', variant: 'medium' },
      { model: 'qa-mock/gpt-mock-sol', variant: 'medium' },
    ],
  },
  'geeky-heavy': {
    display_name: 'QA geeky heavy',
    family: 'geeky',
    tier: 'heavy',
    models: [
      { model: 'qa-mock/gpt-mock-astra', variant: 'high' },
    ],
  },
};

export class IsolatedPathRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'IsolatedPathRefused';
    this.code = 'ISOLATED_PATH_REFUSED';
  }
}

function normalizePath(value) {
  let current = resolve(value);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  try {
    current = realpathSync.native(current);
  } catch {
    // Keep the resolved spelling when realpath is unavailable.
  }
  const real = suffix.length > 0 ? join(current, ...suffix) : current;
  return real.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isUnder(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function assertIsolatedDir(directory, label) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new IsolatedPathRefused(`invalid ${label}`);
  }
  const normalized = normalizePath(directory);
  for (const root of LIVE_ROOTS) {
    if (isUnder(normalized, normalizePath(root))) {
      throw new IsolatedPathRefused(`live ${label} refused: ${directory} resolves under ${root}`);
    }
  }
  const tempRoot = normalizePath(tmpdir());
  if (!isUnder(normalized, tempRoot)) {
    throw new IsolatedPathRefused(`${label} refused: ${directory} is not under ${tmpdir()}`);
  }
  return normalized;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function createSandbox({ agentDir, home } = {}) {
  const explicitHome = home ? resolve(home) : null;
  const explicitAgent = agentDir ? resolve(agentDir) : null;
  if (explicitHome) assertIsolatedDir(explicitHome, 'home');
  if (explicitAgent) assertIsolatedDir(explicitAgent, 'agent dir');

  const stateDir = mkdtempSync(join(tmpdir(), 'piomo-primary-agents-qa-'));
  const homeDir = explicitHome ?? join(stateDir, 'home');
  const agentPath = explicitAgent ?? join(homeDir, '.omo', 'agent');
  assertIsolatedDir(homeDir, 'home');
  assertIsolatedDir(agentPath, 'agent dir');

  const omoDir = join(homeDir, '.omo');
  const workDir = join(stateDir, 'work');
  const sessionDir = join(stateDir, 'sessions');
  mkdirSync(omoDir, { recursive: true });
  mkdirSync(agentPath, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  writeJson(join(omoDir, 'omo.jsonc'), {
    model_profiles: SEEDED_MODEL_PROFILES,
  });
  writeJson(join(agentPath, 'settings.json'), {
    quietStartup: true,
    packages: [],
    extensions: [],
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, modelFallback: false, provider: { maxRetries: 0 } },
  });

  return {
    stateDir,
    home: homeDir,
    agentDir: agentPath,
    workDir,
    sessionDir,
    sessionFile: join(sessionDir, 'owned.jsonl'),
    cleanup() {
      let removed = false;
      if (existsSync(stateDir)) {
        rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      removed = !existsSync(stateDir);
      if (!removed) throw new Error(`cleanup_failed: ${stateDir}`);
      return { stateDir, removed, agentDir: agentPath, home: homeDir };
    },
  };
}

function splitModel(value) {
  if (typeof value !== 'string') return [null, null];
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return [null, null];
  return [value.slice(0, slash), value.slice(slash + 1)];
}

export function validateLanes() {
  const resolved = [];
  for (const [laneId, lane] of Object.entries(SEEDED_MODEL_PROFILES)) {
    if (!Array.isArray(lane.models) || lane.models.length === 0) {
      throw new Error(`lane ${laneId} has no models`);
    }
    for (const rung of lane.models) {
      const [provider, modelId] = splitModel(rung.model);
      if (provider !== PROVIDER_ID) throw new Error(`lane ${laneId} is not pointed at ${PROVIDER_ID}`);
      const model = MOCK_MODELS.find(candidate => candidate.id === modelId);
      if (!model) throw new Error(`lane ${laneId} names unregistered mock model ${modelId}`);
      if (model.reasoning !== true) throw new Error(`mock model ${modelId} is not reasoning=true`);
      resolved.push({
        laneId,
        provider,
        modelId,
        thinking: rung.variant ?? 'off',
        reasoning: model.reasoning,
        auth: MOCK_API_KEY.length > 0,
      });
    }
  }
  const gptIds = resolved.filter(entry => entry.modelId.startsWith('gpt-'));
  if (gptIds.length < 2) throw new Error('seeded lanes need at least two gpt-* model ids');
  return resolved;
}

export function resolveAgentModel(agentId) {
  const laneId = AGENT_LANES[agentId];
  if (!laneId) throw new Error(`unknown agent ${agentId}`);
  const lane = SEEDED_MODEL_PROFILES[laneId];
  if (!lane) throw new Error(`unknown lane ${laneId}`);
  const rung = lane.models[0];
  const [provider, modelId] = splitModel(rung.model);
  const model = MOCK_MODELS.find(candidate => candidate.id === modelId);
  if (!model) throw new Error(`lane ${laneId} names unregistered mock model ${modelId}`);
  return {
    agentId,
    laneId,
    provider,
    modelId,
    thinking: rung.variant ?? 'off',
    reasoning: model.reasoning === true,
    auth: MOCK_API_KEY.length > 0,
  };
}

function shellSafeEnvironment(sandbox, extra) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^(PI_SESSION_|PI_GOAL_|OMO_AGENT_TOOLKIT_|OMO_DAG_|OMO_HERDR_|SENPI_HOST_|PI_HOST_)/.test(key) ||
        (key.startsWith('OMO_STABLE_') && key !== 'OMO_STABLE_NODE') ||
        ['OMO_BIN', 'SENPI_BIN', 'OMO_PACKAGE_DIR', 'SENPI_PACKAGE_DIR', 'PI_PACKAGE_DIR'].includes(key)) {
      delete environment[key];
    }
  }
  Object.assign(environment, {
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    XDG_CONFIG_HOME: join(sandbox.home, 'config'),
    XDG_DATA_HOME: join(sandbox.home, 'data'),
    XDG_STATE_HOME: join(sandbox.home, 'state'),
    XDG_CACHE_HOME: join(sandbox.home, 'cache'),
    OMO_CODING_AGENT_DIR: sandbox.agentDir,
    SENPI_CODING_AGENT_DIR: sandbox.agentDir,
    PI_CODING_AGENT_DIR: sandbox.agentDir,
    OMO_CODING_AGENT_SESSION_DIR: sandbox.sessionDir,
    SENPI_CODING_AGENT_SESSION_DIR: sandbox.sessionDir,
    PI_CODING_AGENT_SESSION_DIR: sandbox.sessionDir,
    OMO_RUNTIME: 'node',
    SENPI_RUNTIME: 'node',
    OMO_NATIVE: '1',
    SENPI_BRAND: JSON.stringify({ name: 'OmO', command: 'omo', configDir: '.omo', envPrefix: 'OMO' }),
    PI_OFFLINE: '1',
    PI_TELEMETRY: '0',
    OMO_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    ...extra,
  });
  return environment;
}

// The installed engine reads the agent dir from OMO_CODING_AGENT_DIR. The
// harness exposes --agent-dir as the isolated entry point and maps it here;
// it never passes a live path to the CLI.
export function headlessArgs(sandbox, {
  plugin = PLUGIN,
  mockExtension = join(ROOT, 'qa', 'mock-extension.mjs'),
  candidate = join(ROOT, 'dist', 'extension.js'),
  modelId = 'claude-mock-medium',
  thinking = 'off',
  prompt = 'PIOMO QA self-check',
  mockUrl,
  omoFlags = true,
  extraEnv = {},
} = {}) {
  if (!MOCK_MODELS.some(model => model.id === modelId)) {
    throw new Error(`unknown mock model ${modelId}`);
  }
  const omoArgs = omoFlags ? [
    '--omo-senpi-memory-disabled',
    '--omo-senpi-builtin-mcps-disabled',
    '--omo-senpi-config-watch-disabled',
    '--omo-senpi-model-profile-disabled',
    '--omo-senpi-ulw-loop-disabled',
    '--omo-senpi-telemetry-disabled',
  ] : [];
  return {
    command: process.execPath,
    args: [
      SENPI_CLI,
      '-p',
      '--mode', 'text',
      '--offline',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-themes',
      '--no-approve',
      '--no-builtin-tools',
      '--extension', plugin,
      '--extension', mockExtension,
      '--extension', candidate,
      '--provider', PROVIDER_ID,
      '--model', modelId,
      '--thinking', thinking,
      '--session-dir', sandbox.sessionDir,
      '--session', sandbox.sessionFile,
      ...omoArgs,
      '--',
      prompt,
    ],
    env: shellSafeEnvironment(sandbox, {
      ...(mockUrl ? { PIOMO_QA_MOCK_URL: mockUrl } : {}),
      ...extraEnv,
    }),
  };
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

function killOwnedTree(pid) {
  if (!pid || pidGone(pid)) return true;
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
  return pidGone(pid);
}

export async function runHeadless(sandbox, options = {}) {
  const { timeoutMs = HARNESS_DEADLINE_MS } = options;
  const invocation = headlessArgs(sandbox, options);
  const startedAt = Date.now();
  const child = spawn(invocation.command, invocation.args, {
    cwd: sandbox.workDir,
    env: invocation.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (child.stdin) child.stdin.end();

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killOwnedTree(child.pid);
  }, timeoutMs);
  timer.unref?.();

  const result = await new Promise(resolveExit => {
    child.once('error', error => resolveExit({ exitCode: null, signal: null, error: error.message }));
    child.once('close', (code, signal) => resolveExit({ exitCode: code, signal, error: null }));
  });
  clearTimeout(timer);
  if (!result.error && !pidGone(child.pid)) {
    killOwnedTree(child.pid);
  }

  return {
    ...result,
    pid: child.pid ?? null,
    pidGone: pidGone(child.pid),
    timedOut,
    stdout,
    stderr,
    elapsedMs: Date.now() - startedAt,
    argv: [invocation.command, ...invocation.args],
  };
}

export async function startMockProvider({ steps = [] } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        data: MOCK_MODELS.map(model => ({ id: model.id, object: 'model' })),
      }));
      return;
    }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : '{}');
    requests.push({ url: request.url, model: body.model, messages: body.messages?.length ?? 0 });
    const step = steps.shift() ?? { text: 'QA mock response.' };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const writeChunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
      id: `mock-${requests.length}`,
      object: 'chat.completion.chunk',
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    writeChunk({ role: 'assistant', content: '' });
    if (step.tool) {
      writeChunk({
        tool_calls: [{
          index: 0,
          id: `mock-tool-${requests.length}`,
          type: 'function',
          function: { name: step.tool, arguments: JSON.stringify(step.arguments ?? {}) },
        }],
      });
      writeChunk({}, 'tool_calls');
    } else {
      writeChunk({ content: step.text ?? 'QA mock response.' });
      writeChunk({}, 'stop');
    }
    response.write('data: [DONE]\n\n');
    response.end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections?.();
      await closed;
    },
  };
}

export async function selfCheck({ agentDir, home } = {}) {
  const sandbox = createSandbox({ agentDir, home });
  let mock;
  try {
    const lanes = validateLanes();
    const agents = AGENT_IDS.map(resolveAgentModel);

    console.log('piomo-primary-agents QA self-check');
    console.log(`temp agent dir: ${sandbox.agentDir}`);
    console.log(`temp home: ${sandbox.home}`);
    for (const lane of lanes) {
      console.log(`lane ${lane.laneId} -> ${lane.provider}/${lane.modelId} (thinking=${lane.thinking}, reasoning=${lane.reasoning})`);
    }
    for (const agent of agents) {
      console.log(`${agent.agentId} ${agent.laneId} -> ${agent.provider}/${agent.modelId} `
        + `(thinking=${agent.thinking}, reasoning=${agent.reasoning}, auth=${agent.auth})`);
    }
    console.log(`mock provider ${PROVIDER_ID}: ${MOCK_MODELS.length} models registered with an api key`);

    mock = await startMockProvider({ steps: [{ text: SELF_CHECK_SENTINEL }] });
    const run = await runHeadless(sandbox, {
      mockUrl: mock.baseUrl,
      prompt: 'PIOMO QA self-check',
    });
    const mockRequests = mock.requests.filter(entry => entry.url === '/v1/chat/completions').length;
    const ok = !run.timedOut &&
      run.exitCode === 0 &&
      run.stdout.includes(SELF_CHECK_SENTINEL) &&
      mockRequests > 0 &&
      agents.every(agent => agent.reasoning === true && agent.auth === true);
    console.log(`headless launch: ${ok ? 'ok' : 'FAILED'} `
      + `(exit=${run.exitCode}, mock_requests=${mockRequests}, elapsed_ms=${run.elapsedMs}, pid_gone=${run.pidGone})`);
    if (!ok) {
      console.error('--- headless stdout ---');
      console.error(run.stdout);
      console.error('--- headless stderr ---');
      console.error(run.stderr);
      throw new Error('headless self-check failed');
    }
    console.log('self-check: ok');
    return { ok, run, agents, lanes, sandbox };
  } finally {
    if (mock) await mock.close();
    const cleanup = sandbox.cleanup();
    console.log(`temp cleanup: removed=${cleanup.removed}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'self-check': { type: 'boolean', default: false },
      'agent-dir': { type: 'string' },
      home: { type: 'string' },
    },
  });
  if (!values['self-check']) {
    console.error('usage: node qa/harness.mjs --self-check [--agent-dir <dir>] [--home <dir>]');
    process.exitCode = 2;
    return;
  }
  await selfCheck({ agentDir: values['agent-dir'], home: values.home });
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
