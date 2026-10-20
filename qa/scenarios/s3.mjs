// S3 - below-input label and footer status at pane widths 80, 200 and 50.
import { parseArgs } from 'node:util';
import {
  expect, currentPaneLayout, readText, resizePaneTo, runTuiScenario, waitOutput,
} from './lib.mjs';

function labelLines(text) {
  return text.split(/\r?\n/).filter(line => line.includes('▌'));
}

function footerLine(text) {
  return text.split(/\r?\n/).filter(line => line.includes('0/200K') || line.includes('(qa-mock)')).at(-1) ?? '';
}

export async function run({ out }) {
  return runTuiScenario({
    out,
    name: 'S3',
    requireEditor: true,
    label: 'PiOMO S3 label',
    body: async (pane, record) => {
      const widths = [];
      for (const target of [80, 200, 50]) {
        const layout = resizePaneTo(pane, target);
        const width = layout?.rect?.width ?? null;
        await waitOutput(pane, '▌ Sisyphus', { timeout: 15000 });
        const frame = readText(pane);
        const labels = labelLines(frame);
        widths.push({
          requested: target,
          width,
          labelCount: labels.length,
          label: labels.at(-1) ?? '',
          footer: footerLine(frame),
          frame,
        });
      }
      record.checks.widths = widths;

      const wide80 = widths.find(entry => entry.requested === 80);
      const wide200 = widths.find(entry => entry.requested === 200);
      const narrow = widths.find(entry => entry.requested === 50);
      expect(wide80.labelCount === 1, 'width 80 painted more than one label line');
      expect(wide80.label.includes('Tab 전환'), 'width 80 dropped the Tab hint');
      expect(wide80.label.includes('Sisyphus') && wide80.label.includes('claude-mock-medium') && wide80.label.includes('medium'),
        'width 80 label is missing the name, model or thinking');
      expect(wide80.footer.includes('Sisyphus'), 'footer status does not name the agent');
      expect(wide200.labelCount === 1, 'width 200 painted more than one label line');
      expect(wide200.label.includes('Tab 전환'), 'width 200 dropped the Tab hint');
      expect(narrow.labelCount === 1, 'width 50 painted more than one label line');
      expect(narrow.label.endsWith('\x1b[0m') || narrow.label.length > 0, 'width 50 label is empty');
      expect(!narrow.label.includes('Tab 전환'), 'width 50 kept the Tab hint');

      return {
        ok: true,
        widths: widths.map(entry => ({ requested: entry.requested, width: entry.width, label: entry.label })),
      };
    },
  });
}

const invokedDirectly = process.argv[1]?.endsWith('s3.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s3.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
