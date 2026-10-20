// S6b - Sisyphus behaves like today.
// The main-session Sisyphus provider-request system prompt equals the
// package-removed run after normalizing volatile fields, and a scripted
// 5-tool turn has no blocked call. Both runs use fresh temp agent dirs/homes
// and the same cwd, so first-run state (MCP discovery, onboarding) is equal.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createPane, createTuiScenario, expect, isTitleRequest, normalizeVolatile, run as runCommand,
  runTuiScenario, sendKeys, sendText, sessionEntries, sha256, startMock, systemPromptOf, textOfMessage,
  toolResults, waitFile, waitOutput,
} from './lib.mjs';

const TOOLS = [
  { tool: 'read', arguments: { path: 'seed.txt' } },
  { tool: 'write', arguments: { path: 'out.txt', content: 'x' } },
  { tool: 'edit', arguments: { path: 'out.txt', oldText: 'x', newText: 'y' } },
  { tool: 'eval', arguments: { action: 'run', summary: 'S6B bash', language: 'js', code: "await tool.bash({ command: 'echo ok' })" } },
  { tool: 'read', arguments: { path: 'out.txt' } },
];

const BLOCK_MARKERS = [
  '프로메테우스는 .omo',
  '아틀라스는 .omo',
  '이 도구는 이 에이전트에게 막혀 있어요',
];

/** Close the mock with a hard bound; a leaked keep-alive socket must not wedge the runner. */
async function closeMockBounded(mock, ms = 5000) {
  let timer;
  try {
    await Promise.race([
      mock.close().catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Remove a tree, retrying while a dying daemon releases its handle. */
async function removeTree(path, { timeout = 10000 } = {}) {
  const started = Date.now();
  let lastError = null;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (caught) {
      lastError = caught;
    }
    if (!existsSync(path)) return { removed: true, error: null };
    if (Date.now() - started >= timeout) {
      return { removed: false, error: String(lastError?.message ?? lastError ?? 'path still exists') };
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/**
 * Delete the package sandbox in a child process while the no-package run
 * starts. The package tree is ~9,500 runtime files; deleting it synchronously
 * after the second run would push the whole runner past the 60s bound.
 */
function startTreeRemoval(path, { timeout = 20000 } = {}) {
  const script = [
    "const fs = require('node:fs');",
    `const p = ${JSON.stringify(path)};`,
    `const end = Date.now() + ${timeout};`,
    'function go() {',
    '  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }); } catch {}',
    '  if (!fs.existsSync(p)) process.exit(0);',
    '  if (Date.now() > end) process.exit(1);',
    '  setTimeout(go, 250);',
    '}',
    'go();',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: 'ignore' });
  return new Promise((resolve) => {
    child.once('error', () => resolve({ removed: !existsSync(path), exitCode: null }));
    child.once('exit', code => resolve({ removed: !existsSync(path), exitCode: code }));
  });
}

/** Remove both sandboxes and the shared cwd; report whether each tree is actually gone. */
async function cleanupTrees({ first, second, sharedCwd, packageRemoval }) {
  const results = [];
  const targets = [
    { label: 'package sandbox', path: first?.sandbox.stateDir, preRemoval: packageRemoval },
    { label: 'nopackage sandbox', path: second?.sandbox.stateDir },
    { label: 'shared cwd', path: sharedCwd },
  ];
  for (const target of targets) {
    if (!target.path) continue;
    let removal = target.preRemoval;
    if (!removal?.removed) removal = await removeTree(target.path);
    results.push({
      label: target.label,
      path: target.path,
      removed: removal.removed === true || !existsSync(target.path),
      error: removal.removed === true || !existsSync(target.path) ? null
        : String(removal.error ?? `removal child exit ${removal.exitCode}`),
    });
  }
  return results;
}

// The plugin registers context7 as a lazy MCP server. Its instructions land only
// after the catalog cache exists; waiting on that event keeps the package and
// package-removed runs at the same MCP state instead of racing the first turn.
async function waitMcpCache(scenario) {
  const cacheDir = join(scenario.agentDir, 'cache');
  const cacheFile = join(cacheDir, 'mcp-cache.json');
  mkdirSync(cacheDir, { recursive: true });
  await waitFile(cacheFile,
    () => existsSync(cacheFile) && readFileSync(cacheFile, 'utf8').includes('context7'),
    { timeout: 30000, label: 'context7 MCP cache' });
}

export async function run({ out }) {
  const runStartedAt = Date.now();
  const state = { packagePrompt: null, noPackagePrompt: null, run: 'package', prompts: [] };
  const recordPrompt = (label, body) => {
    const prompt = systemPromptOf(body);
    state.prompts.push({
      run: state.run,
      label,
      length: prompt.length,
      hasMcp: prompt.includes('mcp_instructions'),
      tail: prompt.slice(-700),
    });
  };
  const route = (body) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    const lastText = textOfMessage(last);
    if (lastText.includes('S6B warmup')) {
      if (!isTitleRequest(body)) recordPrompt('warmup', body);
      return { text: 'S6B warmup done' };
    }
    if (lastText.includes('S6B prompt')) {
      if (isTitleRequest(body)) return { text: 'S6B title' };
      recordPrompt('prompt', body);
      const key = state.run === 'nopackage' ? 'noPackagePrompt' : 'packagePrompt';
      if (!state[key]) state[key] = systemPromptOf(body);
      return { tool: TOOLS[0].tool, arguments: TOOLS[0].arguments };
    }
    const results = messages.filter(message => message?.role === 'tool');
    if (results.length > 0 && results.length < TOOLS.length) {
      const next = TOOLS[results.length];
      return { tool: next.tool, arguments: next.arguments };
    }
    if (results.length >= TOOLS.length) return { text: 'S6B done' };
    return { text: 'S6B idle' };
  };
  const mock = await startMock({ captureBody: true, route });
  let sharedCwd;
  let first;
  let second;
  let packageRemoval = null;
  try {
    sharedCwd = mkdtempSync(join(tmpdir(), 'piomo-s6b-cwd-'));
    first = createTuiScenario({
      name: 'S6b-package',
      mockUrl: mock.baseUrl,
      workDir: sharedCwd,
    });
    second = createTuiScenario({
      name: 'S6b-nopackage',
      mockUrl: mock.baseUrl,
      packages: [],
      pluginPath: first.pluginPath,
      workDir: sharedCwd,
      sessionName: 'nopackage',
    });
    writeFileSync(join(sharedCwd, 'seed.txt'), 'seed\n', 'utf8');

    // Start both CLIs before either body so the two ~25s TUI startups overlap.
    // The scripted tool turns still run sequentially against the shared cwd.
    const packagePane = createPane(first.workDir, 'PiOMO S6b Sisyphus (package)');
    const noPackagePane = createPane(sharedCwd, 'PiOMO S6b Sisyphus (no package)');
    runCommand(packagePane, first.command);
    runCommand(noPackagePane, second.command);

    const packageRun = await runTuiScenario({
      out,
      name: 'S6b',
      evidenceName: 'task-11-piomo-primary-agents-S6b',
      mock,
      scenario: first,
      pane: packagePane,
      start: false,
      label: 'PiOMO S6b Sisyphus (package)',
      keepSandbox: true,
      body: async (pane, record, scenario) => {
        const mark = (label) => {
          record.checks.timings = { ...(record.checks.timings ?? {}), [label]: Date.now() - Date.parse(record.startedAt) };
        };
        mark('bodyStart');
        await waitMcpCache(scenario);
        mark('mcpCache');
        sendText(pane, 'S6B warmup');
        sendKeys(pane, 'enter');
        await waitOutput(pane, 'S6B warmup done', { timeout: 30000 });
        mark('warmupDone');
        sendText(pane, 'S6B prompt');
        sendKeys(pane, 'enter');
        await waitOutput(pane, 'S6B done', { timeout: 45000 });
        mark('done');
        const results = toolResults(sessionEntries(scenario.sessionFile));
        record.checks.toolResults = results;
        record.checks.blocked = results.filter(result =>
          BLOCK_MARKERS.some(marker => result.text.includes(marker)));
        expect(results.length === TOOLS.length, `expected 5 tool results, got ${results.length}`);
        expect(record.checks.blocked.length === 0,
          `a Sisyphus tool call was blocked: ${JSON.stringify(record.checks.blocked)}`);
        expect(results.every(result => result.isError === false),
          `a Sisyphus tool call errored: ${JSON.stringify(results.filter(result => result.isError))}`);
        record.checks.promptHasMarker = String(state.packagePrompt).includes('piomo-primary-agent:begin');
        record.checks.promptTurns = state.prompts.filter(entry => entry.run === 'package');
        expect(record.checks.promptHasMarker === false,
          'the Sisyphus package prompt carries a piomo-primary-agent block');
        return { ok: true, toolResults: results.length };
      },
    });

    state.run = 'nopackage';
    // The package sandbox is not used by the no-package run; delete it in a
    // child process while that run starts so its ~9.5k runtime files do not
    // add their removal time to the runner's wall clock.
    packageRemoval = startTreeRemoval(first.sandbox.stateDir);
    const noPackage = await runTuiScenario({
      out,
      name: 'S6b-nopackage',
      evidenceName: 'task-11-piomo-primary-agents-S6b-nopackage',
      mock,
      scenario: second,
      pane: noPackagePane,
      start: false,
      label: 'PiOMO S6b Sisyphus (no package)',
      body: async (pane, record, scenario) => {
        const mark = (label) => {
          record.checks.timings = { ...(record.checks.timings ?? {}), [label]: Date.now() - Date.parse(record.startedAt) };
        };
        mark('bodyStart');
        await waitMcpCache(scenario);
        mark('mcpCache');
        sendText(pane, 'S6B warmup');
        sendKeys(pane, 'enter');
        await waitOutput(pane, 'S6B warmup done', { timeout: 30000 });
        mark('warmupDone');
        sendText(pane, 'S6B prompt');
        sendKeys(pane, 'enter');
        await waitOutput(pane, 'S6B done', { timeout: 30000 });
        mark('done');
        return { ok: true };
      },
    });

    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const replacements = [
      [new RegExp(escape(first.sandbox.stateDir), 'g'), '<TMP>'],
      [new RegExp(escape(first.sandbox.stateDir.replace(/\\/g, '/')), 'g'), '<TMP>'],
      [new RegExp(escape(second.sandbox.stateDir), 'g'), '<TMP>'],
      [new RegExp(escape(second.sandbox.stateDir.replace(/\\/g, '/')), 'g'), '<TMP>'],
      [new RegExp(escape(sharedCwd), 'g'), '<CWD>'],
      [new RegExp(escape(sharedCwd.replace(/\\/g, '/')), 'g'), '<CWD>'],
      [new RegExp(escape(first.sandbox.home), 'g'), '<HOME>'],
      [new RegExp(escape(second.sandbox.home), 'g'), '<HOME>'],
      [new RegExp(escape(first.sandbox.agentDir), 'g'), '<AGENTDIR>'],
      [new RegExp(escape(first.sandbox.agentDir.replace(/\\/g, '/')), 'g'), '<AGENTDIR>'],
      [new RegExp(escape(second.sandbox.agentDir), 'g'), '<AGENTDIR>'],
      [new RegExp(escape(second.sandbox.agentDir.replace(/\\/g, '/')), 'g'), '<AGENTDIR>'],
    ];
    const normalizedA = normalizeVolatile(state.packagePrompt, replacements);
    const normalizedB = normalizeVolatile(state.noPackagePrompt, replacements);
    const hashA = sha256(normalizedA);
    const hashB = sha256(normalizedB);
    let firstDiff = -1;
    for (let index = 0; index < Math.max(normalizedA.length, normalizedB.length); index += 1) {
      if (normalizedA[index] !== normalizedB[index]) { firstDiff = index; break; }
    }
    // Clean both sandboxes and the shared cwd BEFORE writing the final evidence
    // so the evidence carries the removal proof and no process handle can keep
    // the 9k-file tree alive after the claim.
    const cleanup = await cleanupTrees({ first, second, sharedCwd, packageRemoval });
    const allRemoved = cleanup.every(entry => entry.removed === true);
    const { writeEvidence } = await import('./lib.mjs');
    writeEvidence(out, 'task-11-piomo-primary-agents-S6b-crossrun', {
      ok: allRemoved && hashA === hashB,
      scenario: 'S6b cross-run',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      agentDir: first.sandbox.agentDir,
      home: first.sandbox.home,
      sessionFile: first.sessionFile,
      command: first.command,
      cleanup,
      checks: {
        packageRun,
        noPackageRun: noPackage,
        promptTurns: state.prompts,
        hashA,
        hashB,
        equal: hashA === hashB,
        firstDiff,
        diffContextA: firstDiff === -1 ? '' : normalizedA.slice(Math.max(0, firstDiff - 300), firstDiff + 600),
        diffContextB: firstDiff === -1 ? '' : normalizedB.slice(Math.max(0, firstDiff - 300), firstDiff + 600),
        normalizedA,
        normalizedB,
      },
    });
    const comparison = {
      hashA,
      hashB,
      equal: hashA === hashB,
      firstDiff,
      diffContextA: firstDiff === -1 ? '' : normalizedA.slice(Math.max(0, firstDiff - 300), firstDiff + 600),
      diffContextB: firstDiff === -1 ? '' : normalizedB.slice(Math.max(0, firstDiff - 300), firstDiff + 600),
    };
    writeEvidence(out, 'task-11-piomo-primary-agents-S6b', {
      ...packageRun,
      ok: allRemoved && hashA === hashB,
      error: hashA === hashB ? (allRemoved ? undefined : 'cleanup left a temp tree') : `Sisyphus prompts differ: ${hashA} != ${hashB}`,
      checks: { ...packageRun.checks, comparison, cleanup },
      cleanup: { runs: cleanup, allRemoved },
      timing: {
        totalMs: Date.now() - runStartedAt,
        packageRun: packageRun.checks?.timings ?? null,
        noPackageRun: noPackage?.checks?.timings ?? null,
      },
    });
    expect(allRemoved, `cleanup left a temp tree: ${JSON.stringify(cleanup)}`);
    expect(hashA === hashB, `Sisyphus prompts differ: ${hashA} != ${hashB}`);
    return { ok: true, hashA, hashB, toolResults: 5, cleanup, totalMs: Date.now() - runStartedAt };
  } finally {
    // Idempotent safety net for the failure path; the success path already ran
    // this before writing the evidence.
    await cleanupTrees({ first, second, sharedCwd, packageRemoval });
    await closeMockBounded(mock);
  }
}

const invokedDirectly = process.argv[1]?.endsWith('s6b.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s6b.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    const startedAt = Date.now();
    run({ out: values.out }).then((result) => {
      console.log(JSON.stringify({ result, elapsedMs: Date.now() - startedAt }));
      process.exit(0);
    }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exit(1);
    });
  }
}
