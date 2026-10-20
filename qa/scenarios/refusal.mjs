// Refusal: the harness and the scenario driver refuse a live agent dir before
// starting any process. Raw output is written to the todo's refusal file.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { writeText } from './lib.mjs';
import { ROOT, createSandbox } from '../harness.mjs';

export const LIVE_AGENT_DIR = 'C:/Users/USER/.omo-stable-500/home/.omo/agent';

export function run({ out }) {
  const harness = spawnSync(process.execPath, [
    join(ROOT, 'qa', 'harness.mjs'),
    '--self-check',
    '--agent-dir', LIVE_AGENT_DIR,
  ], { encoding: 'utf8', timeout: 60000, windowsHide: true });

  let driver = { status: null, error: null };
  try {
    createSandbox({ agentDir: LIVE_AGENT_DIR });
    driver = { status: 'NOT_REFUSED', error: null };
  } catch (error) {
    driver = { status: 'refused', error: String(error?.message ?? error), code: error?.code ?? null };
  }

  const raw = [
    'piomo-primary-agents todo 11 - live agent dir refusal',
    `live agent dir: ${LIVE_AGENT_DIR}`,
    '',
    '## harness self-check',
    `exit: ${harness.status}`,
    `signal: ${harness.signal ?? 'none'}`,
    '--- stdout ---',
    harness.stdout ?? '',
    '--- stderr ---',
    harness.stderr ?? '',
    '',
    '## scenario driver createSandbox',
    `result: ${driver.status}`,
    `error: ${driver.error ?? ''}`,
    `code: ${driver.code ?? ''}`,
    '',
  ].join('\n');
  const file = writeText(out, 'task-11-piomo-primary-agents-refusal.txt', raw);
  const ok = harness.status !== 0
    && /live agent dir refused/.test(`${harness.stdout ?? ''}${harness.stderr ?? ''}`)
    && driver.status === 'refused'
    && /live agent dir refused/.test(driver.error ?? '');
  if (!ok) throw new Error(`live agent dir was not refused: harness=${harness.status}, driver=${driver.status}`);
  return { ok, file, harnessStatus: harness.status, driver };
}

const invokedDirectly = process.argv[1]?.endsWith('refusal.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/refusal.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    try {
      run({ out: values.out });
    } catch (error) {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    }
  }
}
