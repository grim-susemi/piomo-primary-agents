// S3 - below-input label and footer status at pane widths 80, 200 and 50.
import { parseArgs } from 'node:util';
import {
  expect, currentPaneLayout, readText, resizePaneTo, runTuiScenario, waitOutput,
} from './lib.mjs';

function labelLines(text) {
  return text.split(/\r?\n/).filter(line => line.includes('▌'));
}

// The status is painted on the line after the path/context footer, so include
// the footer block rather than only the line that carries the token count.
function footerOf(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const index = lines.findIndex(line => line.includes('0/200K') || line.includes('(qa-mock)'));
  return index === -1 ? '' : lines.slice(index).join('\n');
}

export async function run({ out }) {
  const WIDE = 200;
  return runTuiScenario({
    out,
    name: 'S3',
    requireEditor: true,
    label: 'PiOMO S3 label',
    body: async (pane, record) => {
      const widths = [];
      for (const target of [80, WIDE, 50]) {
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
          footer: footerOf(frame),
          frame,
        });
      }
      record.checks.widths = widths;

      const wide80 = widths.find(entry => entry.requested === 80);
      const wide = widths.find(entry => entry.requested === WIDE);
      const narrow = widths.find(entry => entry.requested === 50);
      // The Herdr pane's widest reachable column is 155 cells (the split's
      // minimum sibling width caps it); a literal 200-cell pane does not exist.
      const widestAvailable = wide?.width ?? null;
      record.checks.wideRequest = WIDE;
      record.checks.widestAvailable = widestAvailable;
      record.checks.wideUnreachable = widestAvailable !== null && widestAvailable < WIDE;
      record.checks.wideNote = record.checks.wideUnreachable
        ? `A ${WIDE}-cell width is unreachable in this Herdr pane; the widest achieved is ${widestAvailable} cells, so the wide case ran at ${widestAvailable}.`
        : `A ${WIDE}-cell width was reachable at ${widestAvailable}; the 200-unreachable note is stale.`;

      expect(wide80.labelCount === 1, 'width 80 painted more than one label line');
      expect(wide80.label.includes('Tab 전환'), 'width 80 dropped the Tab hint');
      expect(wide80.label.includes('Sisyphus') && wide80.label.includes('claude-mock-medium') && wide80.label.includes('medium'),
        'width 80 label is missing the name, model or thinking');
      expect(wide80.footer.includes('Sisyphus'), 'footer status does not name the agent');
      expect(wide.width !== null && wide.width < WIDE,
        `width ${WIDE} was actually reachable at ${wide.width}; do not claim it is unreachable`);
      expect(wide.width >= 150, `the widest available width fell to ${wide.width}`);
      expect(wide.labelCount === 1, `width ${wide.width} painted more than one label line`);
      expect(wide.label.includes('Tab 전환'), `width ${wide.width} dropped the Tab hint`);
      expect(wide.label.includes('Sisyphus') && wide.label.includes('claude-mock-medium') && wide.label.includes('medium'),
        `width ${wide.width} label is missing the name, model or thinking`);
      expect(wide.footer.includes('Sisyphus'), `footer status does not name the agent at width ${wide.width}`);
      expect(narrow.labelCount === 1, 'width 50 painted more than one label line');
      expect(narrow.label.endsWith('\x1b[0m') || narrow.label.length > 0, 'width 50 label is empty');
      expect(!narrow.label.includes('Tab 전환'), 'width 50 kept the Tab hint');

      return {
        ok: true,
        wideNote: record.checks.wideNote,
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
