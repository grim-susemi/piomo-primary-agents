// S11 - uninstall restores stock behaviour.
// Positive control: the label is visible with the package installed. Then the
// package is removed from the temp settings.json and the CLI is restarted in
// the same temp agent dir: Tab completes paths on plain text and no label is
// shown.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  closePane, createPane, createTuiScenario, exitCli, expect, hasLabel, readText,
  run as runCommand, runTuiScenario, sendKeys, sendText, waitOutput, waitReady,
} from './lib.mjs';

export async function run({ out }) {
  return runTuiScenario({
    out,
    name: 'S11',
    requireEditor: true,
    label: 'PiOMO S11 uninstall',
    body: async (pane, record, scenario) => {
      const firstFrame = readText(pane);
      expect(hasLabel(firstFrame), 'positive control: no label with the package installed');
      record.checks.installedLabel = firstFrame.split(/\r?\n/).filter(line => line.includes('▌')).at(-1) ?? '';

      // Leave the running session, then remove the package from the same temp
      // settings. The restart gets its own pane so the first CLI's label cannot
      // survive in the reused terminal's scrollback.
      await exitCli(pane);
      const settingsPath = join(scenario.agentDir, 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      settings.packages = [];
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

      const second = createTuiScenario({
        name: 'S11-restart',
        sandbox: scenario.sandbox,
        mockUrl: scenario.mockUrl,
        packages: [],
        pluginPath: scenario.pluginPath,
        sessionName: 'uninstalled',
        settings: { packages: [] },
      });
      writeFileSync(join(scenario.workDir, 'alpha.txt'), 'a\n', 'utf8');
      const fresh = createPane(scenario.workDir, 'PiOMO S11 uninstall');
      try {
        runCommand(fresh, second.command);
        await waitReady(fresh);
        const restarted = readText(fresh);
        expect(!hasLabel(restarted), 'the label is still shown after uninstall');

        sendText(fresh, './');
        sendKeys(fresh, 'tab');
        const completion = await waitOutput(fresh, 'alpha.txt', { timeout: 20000 });
        expect(completion.code === 0, 'path completion did not open after uninstall');
        record.checks.uninstalledFrame = readText(fresh);
        record.checks.settingsAfter = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } finally {
        closePane(fresh);
      }

      return { ok: true, labelBefore: record.checks.installedLabel };
    },
  });
}

const invokedDirectly = process.argv[1]?.endsWith('s11.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s11.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
