// S6b - Sisyphus behaves like today.
// The main-session Sisyphus provider-request system prompt equals the
// package-removed run after normalizing volatile fields, and a scripted
// 5-tool turn has no blocked call. Both runs use fresh temp agent dirs/homes
// and the same cwd, so first-run state (MCP discovery, onboarding) is equal.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createTuiScenario, expect, isTitleRequest, normalizeVolatile, runTuiScenario, sendKeys,
  sendText, sessionEntries, sha256, startMock, systemPromptOf, textOfMessage, toolResults,
  waitFile, waitOutput,
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

    const packageRun = await runTuiScenario({
      out,
      name: 'S6b',
      evidenceName: 'task-11-piomo-primary-agents-S6b',
      mock,
      scenarioOptions: { sandbox: first.sandbox, workDir: sharedCwd },
      label: 'PiOMO S6b Sisyphus (package)',
      keepSandbox: true,
      body: async (pane, record, scenario) => {
        await waitMcpCache(scenario);
        sendText(pane, 'S6B warmup');
        sendKeys(pane, 'enter');
        await waitOutput(pane, 'S6B warmup done', { timeout: 30000 });
        sendText(pane, 'S6B prompt');
        sendKeys(pane, 'enter');
        await waitOutput(pane, 'S6B done', { timeout: 45000 });
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
    const noPackage = await runTuiScenario({
      out,
      name: 'S6b-nopackage',
      evidenceName: 'task-11-piomo-primary-agents-S6b-nopackage',
      mock,
      scenarioOptions: {
        sandbox: second.sandbox,
        workDir: sharedCwd,
        packages: [],
        pluginPath: first.pluginPath,
        sessionName: 'nopackage',
      },
      label: 'PiOMO S6b Sisyphus (no package)',
      body: async (pane, record, scenario) => {
        await waitMcpCache(scenario);
        sendText(pane, 'S6B warmup');
        sendKeys(pane, 'enter');
        await waitOutput(pane, 'S6B warmup done', { timeout: 30000 });
        sendText(pane, 'S6B prompt');
        sendKeys(pane, 'enter');
        await waitOutput(pane, 'S6B done', { timeout: 30000 });
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
    const { writeEvidence } = await import('./lib.mjs');
    writeEvidence(out, 'task-11-piomo-primary-agents-S6b-crossrun', {
      ok: hashA === hashB,
      scenario: 'S6b cross-run',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      agentDir: first.sandbox.agentDir,
      home: first.sandbox.home,
      sessionFile: first.sessionFile,
      command: first.command,
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
      ok: hashA === hashB,
      error: hashA === hashB ? undefined : `Sisyphus prompts differ: ${hashA} != ${hashB}`,
      checks: { ...packageRun.checks, comparison },
    });
    expect(hashA === hashB, `Sisyphus prompts differ: ${hashA} != ${hashB}`);
    return { ok: true, hashA, hashB, toolResults: 5 };
  } finally {
    await mock.close();
    try { first?.sandbox.cleanup(); } catch { /* removed */ }
    try { second?.sandbox.cleanup(); } catch { /* removed */ }
    if (sharedCwd) {
      try { rmSync(sharedCwd, { recursive: true, force: true, maxRetries: 5 }); } catch { /* locked by a dying child */ }
    }
  }
}

const invokedDirectly = process.argv[1]?.endsWith('s6b.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s6b.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
