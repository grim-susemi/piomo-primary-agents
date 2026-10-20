// S6 - child sessions are untouched.
// A TUI main-session parent spawns a `task` child through the mock provider.
// The child's provider-request system prompt has no piomo-primary-agent marker
// and, after normalizing volatile fields, hashes the same in the package run
// and the package-removed run (same temp dir and cwd). Positive control: the
// package run's parent prompt carries the marker.
import { parseArgs } from 'node:util';
import {
  createTuiScenario, expect, isTitleRequest, normalizeVolatile, readRecent, runTuiScenario,
  sendKeys, sendText, sessionEntries, sha256, startMock, systemPromptOf, textOfMessage,
  waitOutput,
} from './lib.mjs';
import { SEEDED_MODEL_PROFILES } from '../harness.mjs';

const OMO = {
  model_profiles: SEEDED_MODEL_PROFILES,
  task: { default_execution_mode: 'process', process_runner: 'child-process' },
  categories: {
    quick: {
      description: 'S6 quick child',
      model: 'qa-mock/claude-mock-medium',
      variant: 'medium',
    },
  },
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    }),
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

export async function run({ out }) {
  const state = { run: null, parentPrompt: null, childPrompt: null };
  const childSeen = deferred();

  const route = (body) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    const lastText = textOfMessage(last);
    if (lastText.includes('S6 child marker')) {
      if (isTitleRequest(body)) return { text: 'S6 child title' };
      if (!state.childPrompt) {
        state.childPrompt = systemPromptOf(body);
        childSeen.resolve();
      }
      return { text: 'S6 child done' };
    }
    if (lastText.includes('S6 parent spawn')) {
      if (isTitleRequest(body)) return { text: 'S6 parent title' };
      if (!state.parentPrompt) state.parentPrompt = systemPromptOf(body);
      return {
        tool: 'task',
        arguments: {
          category: 'quick',
          prompt: 'S6 child marker',
          description: 'S6 child probe',
          run_in_background: false,
        },
      };
    }
    if (messages.some(message => message?.role === 'tool')) {
      return { text: 'S6 parent done' };
    }
    return { text: 'S6 idle' };
  };
  const mock = await startMock({ captureBody: true, route });

  try {
    const first = createTuiScenario({
      name: 'S6-package',
      mockUrl: mock.baseUrl,
      modelProfiles: OMO,
      settings: { task: OMO.task },
    });
    const resultA = await runTuiScenario({
      out,
      name: 'S6',
      mock,
      scenarioOptions: { sandbox: first.sandbox, modelProfiles: OMO, settings: { task: OMO.task } },
      label: 'PiOMO S6 child (package)',
      keepSandbox: true,
      body: async (pane, record) => {
        sendText(pane, '/agent hephaestus');
        sendKeys(pane, 'enter');
        await waitOutput(pane, 'gpt-mock-fast', { timeout: 20000 });
        sendText(pane, 'S6 parent spawn');
        sendKeys(pane, 'enter');
        await withTimeout(childSeen.promise, 45000, 'S6 child provider request');
        await waitOutput(pane, 'S6 parent done', { timeout: 30000 });
        record.checks.parentPromptHasMarker = String(state.parentPrompt).includes('piomo-primary-agent:begin');
        record.checks.childPromptHasMarker = String(state.childPrompt).includes('piomo-primary-agent:begin');
        expect(record.checks.parentPromptHasMarker === true,
          'positive control failed: the package parent prompt has no piomo-primary-agent marker');
        expect(record.checks.childPromptHasMarker === false,
          'the child prompt carries a piomo-primary-agent marker');
        return {
          ok: true,
          parentSystemLength: state.parentPrompt.length,
          childSystemLength: state.childPrompt.length,
          childSystemTail: state.childPrompt.slice(-400),
        };
      },
    });

    const childPromptA = state.childPrompt;
    const parentPromptA = state.parentPrompt;
    state.parentPrompt = null;
    state.childPrompt = null;
    const secondSeen = deferred();
    childSeen.resolve = secondSeen.resolve;

    const resultB = await runTuiScenario({
      out,
      name: 'S6-nopackage',
      evidenceName: 'task-11-piomo-primary-agents-S6-nopackage',
      mock,
      scenarioOptions: {
        sandbox: first.sandbox,
        packages: [],
        pluginPath: first.pluginPath,
        extraExtensions: [],
        modelProfiles: OMO,
        settings: { task: OMO.task },
        sessionName: 'nopackage',
      },
      label: 'PiOMO S6 child (no package)',
      body: async (pane, record) => {
        sendText(pane, 'S6 parent spawn');
        sendKeys(pane, 'enter');
        await withTimeout(secondSeen.promise, 45000, 'S6 no-package child provider request');
        await waitOutput(pane, 'S6 parent done', { timeout: 30000 });
        record.checks.parentPromptHasMarker = String(state.parentPrompt).includes('piomo-primary-agent:begin');
        record.checks.childPromptHasMarker = String(state.childPrompt).includes('piomo-primary-agent:begin');
        expect(record.checks.parentPromptHasMarker === false,
          'the package-removed parent prompt still has a marker');
        return { ok: true, childSystemLength: state.childPrompt.length };
      },
    });

    const sandbox = first.sandbox;
    const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const replacements = [
      [new RegExp(escape(sandbox.stateDir), 'g'), '<TMP>'],
      [new RegExp(escape(sandbox.stateDir.replace(/\\/g, '/')), 'g'), '<TMP>'],
      [new RegExp(escape(sandbox.workDir), 'g'), '<CWD>'],
      [new RegExp(escape(sandbox.home), 'g'), '<HOME>'],
      [new RegExp(escape(sandbox.agentDir), 'g'), '<AGENTDIR>'],
      [new RegExp(escape(sandbox.agentDir.replace(/\\/g, '/')), 'g'), '<AGENTDIR>'],
    ];
    const normalizedA = normalizeVolatile(childPromptA, replacements);
    const normalizedB = normalizeVolatile(state.childPrompt, replacements);
    const hashA = sha256(normalizedA);
    const hashB = sha256(normalizedB);

    const evidence = {
      packageRun: resultA,
      noPackageRun: resultB,
      parentPromptMarkerA: String(parentPromptA).includes('piomo-primary-agent:begin'),
      childHashA: hashA,
      childHashB: hashB,
      childHashEqual: hashA === hashB,
      normalizedA,
      normalizedB,
    };
    expect(evidence.childHashEqual === true, `child prompt hashes differ: ${hashA} != ${hashB}`);
    // The per-run evidence file is extended with the cross-run comparison.
    const { writeEvidence } = await import('./lib.mjs');
    writeEvidence(out, 'task-11-piomo-primary-agents-S6-crossrun', {
      ok: true,
      scenario: 'S6 cross-run',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      agentDir: sandbox.agentDir,
      home: sandbox.home,
      sessionFile: first.sessionFile,
      command: first.command,
      checks: evidence,
    });
    return { ok: true, ...evidence };
  } finally {
    await mock.close();
  }
}

const invokedDirectly = process.argv[1]?.endsWith('s6.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s6.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
