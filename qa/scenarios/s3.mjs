// S3 - below-input label and footer status at pane widths 80, 200 and the
// Tab-hint boundary.
import { parseArgs } from 'node:util';
import {
  expect, currentPaneLayout, readText, resizePaneTo, runTuiScenario, waitOutput,
} from './lib.mjs';
import { displayWidth, HINT } from '../../src/ui/label.mjs';

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
      const observe = async (target) => {
        const layout = resizePaneTo(pane, target);
        const width = layout?.rect?.width ?? null;
        await waitOutput(pane, '▌ Sisyphus', { timeout: 15000 });
        const frame = readText(pane);
        const labels = labelLines(frame);
        return {
          requested: target,
          width,
          labelCount: labels.length,
          label: labels.at(-1) ?? '',
          footer: footerOf(frame),
          frame,
        };
      };
      const widths = [await observe(80), await observe(WIDE)];
      // src/ui/label.mjs drops the hint when the bar, name, model and thinking,
      // plus two spaces and the hint, do not fit. Measure that line from the
      // observed label, then check the rule on both sides of the boundary.
      const wide80 = widths[0];
      // The widget gets fewer cells than the pane (3 at widths 80 and 155); the
      // hint-shown line is padded to the widget width, so the offset is measured.
      const offset = wide80.width - displayWidth(wide80.label);
      const bodyWidth = displayWidth(wide80.label.replace(HINT, '').trimEnd());
      const needed = bodyWidth + 2 + displayWidth(HINT) + offset;
      const atBoundary = await observe(needed);
      // resizePaneTo accepts a result within one cell of the request, so a probe
      // one cell below the threshold can come back at the threshold. Probe three
      // cells below, which that tolerance cannot absorb.
      const dropProbe = needed - 3;
      const dropSide = await observe(dropProbe);
      widths.push(atBoundary, dropSide);
      record.checks.widths = widths;
      record.checks.hintThreshold = needed;
      record.checks.dropProbeRequested = dropProbe;
      record.checks.dropSideWidth = dropSide.width;

      const wide = widths.find(entry => entry.requested === WIDE);
      // The Herdr pane's widest reachable column is 155 cells (the split's
      // minimum sibling width caps it); a literal 200-cell pane does not exist.
      const widestAvailable = wide?.width ?? null;
      record.checks.wideRequest = WIDE;
      record.checks.widestAvailable = widestAvailable;
      record.checks.wideUnreachable = widestAvailable !== null && widestAvailable < WIDE;
      record.checks.wideNote = record.checks.wideUnreachable
        ? `A ${WIDE}-cell width is unreachable in this Herdr pane; the widest achieved is ${widestAvailable} cells, so the wide case ran at ${widestAvailable}.`
        : `A ${WIDE}-cell width was reachable at ${widestAvailable}; the 200-unreachable note is stale.`;

      // A fresh session keeps the host start thinking level (Q4), shown as `off`.
      expect(wide80.labelCount === 1, 'width 80 painted more than one label line');
      expect(wide80.label.includes('Tab 전환'), 'width 80 dropped the Tab hint');
      expect(wide80.label.includes('Sisyphus') && wide80.label.includes('claude-mock-medium') && wide80.label.includes('· off'),
        'width 80 label is missing the name, model or thinking');
      expect(wide80.footer.includes('Sisyphus'), 'footer status does not name the agent');
      expect(wide.width !== null && wide.width < WIDE,
        `width ${WIDE} was actually reachable at ${wide.width}; do not claim it is unreachable`);
      expect(wide.width >= 150, `the widest available width fell to ${wide.width}`);
      expect(wide.labelCount === 1, `width ${wide.width} painted more than one label line`);
      expect(wide.label.includes('Tab 전환'), `width ${wide.width} dropped the Tab hint`);
      expect(wide.label.includes('Sisyphus') && wide.label.includes('claude-mock-medium') && wide.label.includes('· off'),
        `width ${wide.width} label is missing the name, model or thinking`);
      expect(wide.footer.includes('Sisyphus'), `footer status does not name the agent at width ${wide.width}`);
      // The rule at the achieved widths: the hint is shown iff the line fits.
      expect(atBoundary.width !== null && atBoundary.width >= needed && atBoundary.labelCount === 1 && atBoundary.label.includes('Tab 전환'),
        `width ${atBoundary.width} (line fits in ${needed}) is below the threshold or dropped the Tab hint`);
      // The drop side must sit below the threshold by more than the one-cell
      // tolerance, or the absent-hint assertion proves nothing.
      expect(dropSide.width !== null && dropSide.width <= needed - 2,
        `drop-side probe (requested ${dropProbe}) reached width ${dropSide.width}, not at least two cells below threshold ${needed}; the hint-dropped side was not exercised`);
      // A hint that does not fit can be clipped mid-word, so any fragment of it
      // counts as shown.
      const hintFragment = /Tab|전환/;
      expect(dropSide.labelCount === 1 && !hintFragment.test(dropSide.label),
        `width ${dropSide.width} (line does not fit in ${needed}) still shows part of the Tab hint`);
      record.checks.dropSideHintShown = hintFragment.test(dropSide.label);

      return {
        ok: true,
        wideNote: record.checks.wideNote,
        hintThreshold: needed,
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
