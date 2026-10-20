// S10 - headless coexistence.
// The temp agent dir loads copies of everything in the P10 run-time list:
// the plugin, the briefing generation named by current.json (with its own
// state dir under the temp agent dir), every live extensions/packages entry and
// agent/extensions/** file, plus this package. No load errors; their commands
// are still listed. Any board server it started is stopped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  MOCK_EXTENSION, expect, killTree, processesFor, startMock, writeText,
} from './lib.mjs';
import { PLUGIN, ROOT, createSandbox, runHeadless } from '../harness.mjs';

export const LIVE_AGENT = 'C:/Users/USER/.omo-stable-500/home/.omo/agent';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export async function run({ out }) {
  const liveSettings = readJson(join(LIVE_AGENT, 'settings.json'));
  const current = readJson(join(LIVE_AGENT, 'briefing', 'current.json'));
  const generation = current.generation;
  const sandbox = createSandbox();
  const log = join(sandbox.stateDir, 's10-probe.log');
  writeFileSync(log, '', 'utf8');
  const mock = await startMock({ steps: [{ text: 'S10 done' }] });
  try {
    // Copy the live extension surface into the temp agent dir.
    const { cpSync } = await import('node:fs');
    const copy = (from, to) => {
      if (!existsSync(from)) return false;
      cpSync(from, to, { recursive: true });
      return true;
    };
    const pluginCopy = join(sandbox.stateDir, 'plugin');
    copy(PLUGIN, pluginCopy);
    copy(join(LIVE_AGENT, 'extensions'), join(sandbox.agentDir, 'extensions'));
    copy(join(LIVE_AGENT, 'packages'), join(sandbox.agentDir, 'packages'));
    copy(join(LIVE_AGENT, 'task-no-fallback-pkg'), join(sandbox.agentDir, 'task-no-fallback-pkg'));
    copy(join(LIVE_AGENT, 'briefing', 'integration', generation),
      join(sandbox.agentDir, 'briefing', 'integration', generation));
    copy(join(LIVE_AGENT, 'briefing', 'current.json'), join(sandbox.agentDir, 'briefing', 'current.json'));
    mkdirSync(join(sandbox.agentDir, 'briefing', 'state'), { recursive: true });
    // The other managed shims point at their own integration generations; copy
    // the code with an empty state dir so no live board state travels along.
    for (const name of ['herdr-dashboard', 'oracle-advisor', 'herdr-dag', 'herdr-todo']) {
      copy(join(LIVE_AGENT, name, 'integration'), join(sandbox.agentDir, name, 'integration'));
      copy(join(LIVE_AGENT, name, 'current.json'), join(sandbox.agentDir, name, 'current.json'));
      mkdirSync(join(sandbox.agentDir, name, 'state'), { recursive: true });
    }
    copy(join(LIVE_AGENT, 'oracle-advisor', 'oracle-policy-generation-000001.json'),
      join(sandbox.agentDir, 'oracle-advisor', 'oracle-policy-generation-000001.json'));
    copy(join(LIVE_AGENT, 'settings-guard'), join(sandbox.agentDir, 'settings-guard'));
    copy(join(LIVE_AGENT, 'task-record-publish-retry'), join(sandbox.agentDir, 'task-record-publish-retry'));
    // The live extension shim points at the generation; keep it working.
    const shim = join(sandbox.agentDir, 'extensions', 'omo-briefing.js');
    const herdrRepair = liveSettings.extensions?.find(entry => /herdr-senpi\.mjs$/i.test(entry));
    if (herdrRepair) {
      copy(herdrRepair, join(sandbox.agentDir, 'extensions', 'herdr-senpi.mjs'));
    }

    const packages = [
      join(sandbox.agentDir, 'task-no-fallback-pkg'),
      join(sandbox.agentDir, 'packages', 'piomo-agent-coordination-mod'),
      pluginCopy,
      ROOT,
    ];
    writeFileSync(join(sandbox.agentDir, 'settings.json'), `${JSON.stringify({
      quietStartup: true,
      packages,
      extensions: herdrRepair ? [join(sandbox.agentDir, 'extensions', 'herdr-senpi.mjs')] : [],
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0, modelFallback: false, provider: { maxRetries: 0 } },
      defaultProjectTrust: 'always',
      theme: 'dark',
    }, null, 2)}\n`, 'utf8');

    const probe = join(import.meta.dirname, 's10-probe.mjs');
    const run = await runHeadless(sandbox, {
      plugin: null,
      candidate: probe,
      mockExtension: MOCK_EXTENSION,
      mockUrl: mock.baseUrl,
      prompt: 'S10 coexistence',
      noExtensions: false,
      omoFlags: false,
      extraEnv: { PIOMO_S10_LOG: log },
    });

    const records = existsSync(log)
      ? readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
      : [];
    const session = records.find(record => record.event === 'session_start') ?? null;
    const stderr = String(run.stderr ?? '');
    const loadErrorLines = stderr.split(/\r?\n/).filter(line =>
      /error.*extension|extension.*error|cannot find package|failed to load/i.test(line));

    const loaded = session?.loadedExtensionPaths ?? [];
    const basenames = new Set(loaded.map(path => path.replace(/\\/g, '/').split('/').pop()));
    const expectedBasenames = [
      'omo.js', 'omo-briefing.js', 'early-compaction.js', 'omo-settings-guard.js',
      'extension.js', 'omo-task-no-fallback.js', 'herdr-senpi.mjs',
    ];
    const missing = expectedBasenames.filter(name => !basenames.has(name));
    const commands = session?.commands ?? [];
    const expectedCommands = ['agent', 'doctor', 'tasks'];
    const missingCommands = expectedCommands.filter(name => !commands.includes(name));

    const boardState = join(sandbox.agentDir, 'briefing', 'state', 'server.json');
    let boardServer = null;
    if (existsSync(boardState)) {
      try {
        boardServer = JSON.parse(readFileSync(boardState, 'utf8'));
      } catch {
        boardServer = { unparsable: true };
      }
    }
    const leftovers = processesFor(sandbox.stateDir);
    const killed = [];
    const killPid = (pid) => {
      if (typeof pid !== 'number') return;
      killTree(pid);
      killed.push(pid);
    };
    for (const entry of leftovers) killPid(entry.ProcessId);
    if (boardServer?.pid) killPid(Number(boardServer.pid));

    const checks = {
      tempAgentDir: sandbox.agentDir,
      generation,
      copiedShim: existsSync(shim),
      packages,
      loadedCount: loaded.length,
      loaded,
      missing,
      commands,
      missingCommands,
      loadErrorLines,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      boardServer,
      boardProcesses: leftovers.length,
      killed,
      stdoutTail: String(run.stdout ?? '').slice(-800),
      stderrTail: stderr.slice(-1200),
    };
    const ok = run.exitCode === 0
      && run.timedOut !== true
      && loadErrorLines.length === 0
      && missing.length === 0
      && missingCommands.length === 0;
    writeText(out, 'task-11-piomo-primary-agents-S10.json', JSON.stringify({ ok, ...checks }, null, 2));
    expect(ok, `S10 coexistence failed: missing=${missing.join(',')} commands=${missingCommands.join(',')} errors=${loadErrorLines.join(' | ')}`);
    return { ok: true, ...checks };
  } finally {
    await mock.close();
    const leftovers = processesFor(sandbox.stateDir);
    for (const entry of leftovers) {
      if (typeof entry.ProcessId === 'number') killTree(entry.ProcessId);
    }
    sandbox.cleanup();
  }
}

const invokedDirectly = process.argv[1]?.endsWith('s10.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s10.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
