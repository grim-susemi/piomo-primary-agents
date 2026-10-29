// S17 - the installer's managed shim loads the package in a real TUI session.
// The package is installed into the sandbox agent dir as a shim (no `packages`
// entry). The pane launch omits the candidate, so the only route to the
// primary-agents extension is the shim. `/agent atlas` must then record the
// primary-agent/v1 identity entry. The negative run deletes the shim after
// install: no identity entry may be recorded.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createSandbox } from '../harness.mjs';
import { install } from '../../scripts/install.mjs';
import {
  expect, identityEntries, runTuiScenario, sessionEntries, submitText, switchAgent, waitFile, writeText,
} from './lib.mjs';

const SHIM = join('extensions', 'omo-primary-agents.js');
const NEGATIVE_TIMEOUT = 10000;
const SUMMARY = 'task-11-piomo-primary-agents-S17.md';
const NEGATIVE_SUMMARY = 's17-negative.txt';

function atlasEntries(file) {
  return identityEntries(sessionEntries(file)).filter(entry => entry.data?.agentId === 'atlas');
}

async function atlasRecordedWithin(file, timeout) {
  try {
    await waitFile(file, () => atlasEntries(file).length > 0, { timeout, label: 'atlas identity' });
    return true;
  } catch {
    return false;
  }
}

async function runCase({ out, name, removeShim }) {
  const sandbox = createSandbox();
  try {
    const installed = install({ agentDir: sandbox.agentDir });
    if (removeShim) rmSync(join(sandbox.agentDir, SHIM));
    return await runTuiScenario({
      out,
      name,
      evidenceName: `task-11-piomo-primary-agents-${name}`,
      scenarioOptions: { sandbox, packages: [] },
      label: `PiOMO ${name}`,
      body: async (pane, record, scenario) => {
        const launchesCandidate = scenario.args.some(arg => String(arg).replaceAll('\\', '/').endsWith('dist/extension.js'));
        expect(!launchesCandidate, 'launch args must not name dist/extension.js');
        record.checks.install = { generation: installed.generation, shim: installed.shim_path };
        if (removeShim) {
          await submitText(pane, '/agent atlas');
          const recorded = await atlasRecordedWithin(scenario.sessionFile, NEGATIVE_TIMEOUT);
          expect(!recorded, 'atlas identity was recorded although the shim was removed');
          record.checks.atlasIdentity = 'absent';
          return { ok: true, atlasIdentity: 'absent' };
        }
        await switchAgent(pane, scenario.sessionFile, 'atlas', { timeout: 25000 });
        const atlas = atlasEntries(scenario.sessionFile).at(-1);
        expect(atlas !== undefined, 'no primary-agent/v1 atlas entry after /agent atlas');
        record.checks.atlasIdentity = atlas.data;
        return { ok: true, identity: atlas };
      },
    });
  } finally {
    sandbox.cleanup();
  }
}

export async function run({ out, negative = false }) {
  if (negative) {
    const result = await runCase({ out, name: 'S17-negative', removeShim: true });
    writeText(out, NEGATIVE_SUMMARY, [
      'S17 negative: shim deleted after install; /agent atlas records no primary-agent/v1 entry.',
      `Result: ${JSON.stringify(result)}`,
    ].join('\n'));
    return result;
  }
  const result = await runCase({ out, name: 'S17', removeShim: false });
  writeText(out, SUMMARY, [
    '# S17 - the installer shim loads the primary agents',
    '',
    'Installed with scripts/install.mjs into the sandbox agent dir, no `packages` entry.',
    'Launched without the candidate in the args; `/agent atlas` recorded primary-agent/v1.',
    `Result: ${JSON.stringify(result)}`,
  ].join('\n'));
  return result;
}

const invokedDirectly = process.argv[1]?.endsWith('s17.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, negative: { type: 'boolean' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s17.mjs --out <evidence dir> [--negative]');
    process.exitCode = 2;
  } else {
    run({ out: values.out, negative: !!values.negative }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
