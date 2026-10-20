// S1 - Tab cycle in a Herdr TUI pane.
// Empty editor: Tab x4 -> Sisyphus -> Hephaestus -> Prometheus -> Atlas ->
// Sisyphus. `/agent atlas` -> Atlas. `/agent` alone opens the selector.
import { parseArgs } from 'node:util';
import {
  expect, readText, runTuiScenario, sendKeys, sessionEntries, submitText, switchAgent,
  waitOutput,
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

      for (const [index, agent] of ['Hephaestus', 'Prometheus', 'Atlas', 'Sisyphus'].entries()) {
        sendKeys(pane, 'tab');
        const painted = await waitOutput(pane, `▌ ${agent}`, { timeout: 20000 });
        expect(painted.code === 0, `Tab ${index + 1} did not paint ${agent}`);
        labels.push({ step: `tab-${index + 1}`, label: labelLine() });
      }
      record.checks.labels = labels;

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
