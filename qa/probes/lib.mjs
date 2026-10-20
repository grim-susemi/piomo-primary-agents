// Shared helpers for the todo-2 runtime probes. Every probe runs against a
// temporary agent dir/home created by qa/harness.mjs; nothing here touches a
// live agent dir.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ROOT, SEEDED_MODEL_PROFILES, createSandbox, runHeadless, startMockProvider,
} from '../harness.mjs';

export const PROBE_DIR = join(ROOT, 'qa', 'probes');

export function evidencePath(outDir, name) {
  const path = join(outDir, name);
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function logLine(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function extractSystemPrompt(payload) {
  if (payload === null || typeof payload !== 'object') return { text: '', shape: typeof payload };
  if (Array.isArray(payload.messages)) {
    const system = payload.messages.find(message => message?.role === 'system');
    if (system) {
      return {
        text: typeof system.content === 'string' ? system.content : JSON.stringify(system.content),
        shape: 'messages[role=system].content',
      };
    }
  }
  if (typeof payload.system === 'string') return { text: payload.system, shape: 'system:string' };
  if (Array.isArray(payload.system)) return { text: JSON.stringify(payload.system), shape: 'system:array' };
  return { text: '', shape: `unknown keys: ${Object.keys(payload).join(',')}` };
}

export function toolText(text) {
  return { content: [{ type: 'text', text }] };
}

/**
 * Run one headless probe: temp agent dir + temp home, local mock provider,
 * candidate no-op extension plus the probe extensions, and cleanup in finally.
 */
export async function runHeadlessProbe({
  prompt = 'PIOMO probe',
  extensions = [],
  steps = [],
  route,
  captureBody = false,
  timeoutMs = 55000,
  extraEnv = {},
  modelId = 'claude-mock-medium',
  thinking = 'off',
  settings,
  omoConfig,
  collectSession = false,
  includePlugin = true,
} = {}) {
  const sandbox = createSandbox();
  if (settings) {
    writeJson(join(sandbox.agentDir, 'settings.json'), settings);
  }
  if (omoConfig) {
    writeJson(join(sandbox.home, '.omo', 'omo.jsonc'), {
      model_profiles: SEEDED_MODEL_PROFILES,
      ...omoConfig,
    });
  }
  let mock;
  try {
    mock = await startMockProvider({ steps, route, captureBody });
    const run = await runHeadless(sandbox, {
      prompt,
      mockUrl: mock.baseUrl,
      extraExtensions: extensions,
      extraEnv,
      modelId,
      thinking,
      timeoutMs,
      ...(includePlugin ? {} : { plugin: null, omoFlags: false }),
    });
    const sessionText = collectSession && existsSync(sandbox.sessionFile)
      ? readFileSync(sandbox.sessionFile, 'utf8')
      : null;
    return {
      sandbox,
      run,
      requests: mock.requests,
      mockUrl: mock.baseUrl,
      sessionText,
    };
  } finally {
    if (mock) await mock.close();
    sandbox.cleanup();
  }
}

export function summarizeRun(run) {
  return {
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    pidGone: run.pidGone,
    elapsedMs: run.elapsedMs,
    stdout: run.stdout.slice(-4000),
    stderr: run.stderr.slice(-4000),
  };
}
