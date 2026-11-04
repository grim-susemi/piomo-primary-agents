// S1 - Tab cycle in a Herdr TUI pane.
// Empty editor: Tab alternates Sisyphus and Hephaestus. Plan/execute commands
// enter the specialists, whose Tab returns to the previous main agent.
// `/agent atlas` -> Atlas. `/agent` alone opens the selector.
import { parseArgs } from 'node:util';
import {
  expect, readText, runTuiScenario, sendKeys, sendPrompt, submitText, switchAgent,
  waitOutput, agentIdentityCount, waitAgentIdentity,
} from './lib.mjs';

export async function run({ out }) {
  return runTuiScenario({
    out,
    name: 'S1',
    requireEditor: true,
    label: 'PiOMO S1 Tab cycle',
    body: async (pane, record) => {
      const labels = [];
      const labelLine = () => readText(pane).split(/\r?\n/).filter(line => line.includes('▌')).at(-1) ?? '';
      labels.push({ step: 'initial', label: labelLine() });
      expect(labels[0].label.includes('Sisyphus'), `initial label: ${JSON.stringify(labels[0].label)}`);

      for (const [index, agent] of ['Hephaestus', 'Sisyphus', 'Hephaestus', 'Sisyphus'].entries()) {
        sendKeys(pane, 'tab');
        const painted = await waitOutput(pane, `▌ ${agent}`, { timeout: 20000 });
        expect(painted.code === 0, `Tab ${index + 1} did not paint ${agent}`);
        labels.push({ step: `tab-${index + 1}`, label: labelLine() });
      }
      record.checks.labels = labels;

      for (const main of ['sisyphus', 'hephaestus']) {
        if (main === 'hephaestus') await switchAgent(pane, record.sessionFile, main);
        for (const [command, specialist, display] of [
          ['/skill:ulw-plan S1 plan', 'prometheus', 'Prometheus'],
          ['/ulw-execute S1 plan', 'atlas', 'Atlas'],
        ]) {
          await sendPrompt(pane, record.sessionFile, command);
          expect((await waitOutput(pane, `▌ ${display}`, { timeout: 20000 })).code === 0,
            `${command} did not enter ${display}`);
          const before = agentIdentityCount(record.sessionFile, main);
          sendKeys(pane, 'tab');
          await waitAgentIdentity(pane, record.sessionFile, main, { before });
          record.checks[`${specialist}-return-${main}`] = labelLine();
        }
      }

      const entries = await switchAgent(pane, record.sessionFile, 'atlas');
      const atlasPainted = await waitOutput(pane, '▌ Atlas', { timeout: 20000 });
      expect(atlasPainted.code === 0, '/agent atlas did not paint Atlas');
      record.checks.agentCommand = {
        identity: entries.filter(entry => entry?.type === 'custom' && entry.customType === 'primary-agent/v1').at(-1),
        label: labelLine(),
      };

      await submitText(pane, '/agent');
      const selector = await waitOutput(pane, '에이전트 선택', { timeout: 20000 });
      expect(selector.code === 0, '/agent alone did not open the selector');
      record.checks.selectorFrame = readText(pane);
      sendKeys(pane, 'escape');

      return { ok: true, labels: labels.map(entry => entry.label) };
    },
  });
}

const invokedDirectly = process.argv[1]?.endsWith('s1.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s1.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
