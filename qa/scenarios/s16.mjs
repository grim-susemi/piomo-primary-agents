// S16 - session start follows a Sisyphus pin only (fresh-session rule).
// The host starts on claude-mock-xhigh (a daily-heavy rung), so a switch cannot be
// confused with the default rung claude-mock-medium.
// (a) no roster -> no extension model_change after start: only the host's own
//     start entry is present.
// (b) roster pins sisyphus to qa-mock/claude-mock-max, thinking low -> exactly one
//     extension model_change to claude-mock-max plus its thinking entry.
import { parseArgs } from 'node:util';
import { createSandbox } from '../harness.mjs';
import { writeRoster } from '../../contract/atomic.mjs';
import { defaultRoster, setAgentPin } from '../../contract/schema.mjs';
import {
  expect, modelChanges, runTuiScenario, sessionEntries, waitRestartReady, waitSessionEntry,
  writeText,
} from './lib.mjs';

const START_MODEL = 'claude-mock-xhigh';
const PIN = { provider: 'qa-mock', modelId: 'claude-mock-max', thinking: 'low' };
const SUMMARY = 'task-11-piomo-primary-agents-S16.md';

async function runCase({ out, name, pinned }) {
  const sandbox = createSandbox();
  try {
    if (pinned) {
      writeRoster(sandbox.agentDir, setAgentPin(defaultRoster(), 'sisyphus', PIN), 0);
    }
    return await runTuiScenario({
      out,
      name,
      scenarioOptions: { sandbox, model: START_MODEL, thinking: 'off' },
      label: `PiOMO ${name}`,
      body: async (pane, record, scenario) => {
        // Start gate: the CLI's startup scan entry, then the painted editor.
        await waitRestartReady(pane, scenario.sessionFile, { timeout: 25000 });
        if (pinned) {
          await waitSessionEntry(scenario.sessionFile,
            entry => entry?.type === 'model_change' && entry.modelId === PIN.modelId,
            { timeout: 25000, label: `${name} sisyphus pin model_change` });
          await waitSessionEntry(scenario.sessionFile,
            entry => entry?.type === 'thinking_level_change' && entry.thinkingLevel === PIN.thinking,
            { timeout: 25000, label: `${name} sisyphus pin thinking entry` });
        }
        const entries = sessionEntries(scenario.sessionFile);
        const switches = modelChanges(entries);
        const thinking = entries.filter(entry => entry?.type === 'thinking_level_change');
        record.checks.modelChanges = switches.map(entry => ({ modelId: entry.modelId, provider: entry.provider }));
        record.checks.thinkingLevels = thinking.map(entry => entry.thinkingLevel);
        if (pinned) {
          expect(switches.length === 2, `expected start + one extension model_change, got ${switches.length}`);
          expect(switches[1].modelId === PIN.modelId, `extension model_change went to ${switches[1].modelId}`);
          expect(thinking.some(entry => entry.thinkingLevel === PIN.thinking), 'pin thinking entry missing');
        } else {
          expect(switches.length === 1, `expected only the host start model_change, got ${switches.length}`);
          expect(switches[0].modelId === START_MODEL, `start model is ${switches[0].modelId}`);
        }
        return { ok: true, modelChanges: record.checks.modelChanges, thinkingLevels: record.checks.thinkingLevels };
      },
    });
  } finally {
    sandbox.cleanup();
  }
}

export async function run({ out }) {
  const noRoster = await runCase({ out, name: 'S16a', pinned: false });
  const pinned = await runCase({ out, name: 'S16b', pinned: true });
  writeText(out, SUMMARY, [
    '# S16 - session start follows a Sisyphus pin only',
    '',
    `(a) no roster: ${JSON.stringify(noRoster)}`,
    `(b) sisyphus pinned to ${PIN.modelId}/${PIN.thinking}: ${JSON.stringify(pinned)}`,
  ].join('\n'));
  return { noRoster, pinned };
}

const invokedDirectly = process.argv[1]?.endsWith('s16.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s16.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
