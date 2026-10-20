// S2 - completion stays untouched.
// `./` + Tab and `/sk` + Tab open the completion list and keep the agent;
// with the list open Tab accepts an item.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import {
  expect, readText, runTuiScenario, sendKeys, sendText, waitOutput,
} from './lib.mjs';

export async function run({ out }) {
  return runTuiScenario({
    out,
    name: 'S2',
    requireEditor: true,
    label: 'PiOMO S2 completion',
    body: async (pane, record, scenario) => {
      writeFileSync(join(scenario.workDir, 'alpha.txt'), 'a\n', 'utf8');
      mkdirSync(join(scenario.workDir, 'folder'), { recursive: true });
      writeFileSync(join(scenario.workDir, 'folder', 'beta.txt'), 'b\n', 'utf8');

      const labelLine = () => readText(pane).split(/\r?\n/).filter(line => line.includes('▌')).at(-1) ?? '';
      const initial = labelLine();
      expect(initial.includes('Sisyphus'), `initial label: ${JSON.stringify(initial)}`);

      sendText(pane, './');
      sendKeys(pane, 'tab');
      const pathList = await waitOutput(pane, 'alpha.txt', { timeout: 20000 });
      expect(pathList.code === 0, 'path Tab did not open completion');
      const pathFrame = readText(pane);
      record.checks.pathCompletion = { frame: pathFrame, label: labelLine() };
      expect(labelLine().includes('Sisyphus'), 'path Tab changed the agent');

      // With the list open, Tab accepts the highlighted item.
      sendKeys(pane, 'tab');
      const accepted = await waitOutput(pane, 'alpha.txt', { timeout: 10000 });
      expect(accepted.code === 0, 'Tab did not accept the path completion');
      record.checks.pathAcceptedFrame = readText(pane);

      sendKeys(pane, 'ctrl+u');
      sendText(pane, '/sk');
      sendKeys(pane, 'tab');
      const slashList = await waitOutput(pane, '/skill', { timeout: 20000 });
      expect(slashList.code === 0, 'slash Tab did not open completion');
      record.checks.slashCompletion = { frame: readText(pane), label: labelLine() };
      expect(labelLine().includes('Sisyphus'), 'slash Tab changed the agent');

      sendKeys(pane, 'tab');
      record.checks.slashAcceptedFrame = readText(pane);

      return {
        ok: true,
        pathLabel: record.checks.pathCompletion.label,
        slashLabel: record.checks.slashCompletion.label,
      };
    },
  });
}

const invokedDirectly = process.argv[1]?.endsWith('s2.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s2.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
