// P1 negative: rerun the overlay probe with a deliberately non-preview-safe
// before_agent_start handler and ask the host for its prompt-cache prefix. The
// host must skip the preview pass before any handler runs (runner.js:1748-1757)
// and say which handler blocked it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PROBE_DIR, runHeadlessProbe, summarizeRun } from './lib.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) {
  console.error('usage: node qa/probes/run-p1-negative.mjs --out <evidence dir>');
  process.exit(2);
}
const OUT = values.out;
const log = join(OUT, 'probe-raw', 'p1-negative.log');
writeFileSync(log, '', 'utf8');
const run = await runHeadlessProbe({
  prompt: 'P1 negative probe',
  extensions: [join(PROBE_DIR, 'p1-overlay.mjs')],
  extraEnv: { PIOMO_P1_LOG: log, PIOMO_P1_UNSAFE: '1' },
  includePlugin: false,
  steps: [{ tool: 'p1_preview', arguments: {} }, { text: 'P1 negative final' }],
});
const summary = summarizeRun(run.run);
const lines = (await import('node:fs')).readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
const records = lines.map(line => JSON.parse(line));
const previewRequest = records.find(record => record.event === 'preview_request') ?? null;
const previewCalls = records.filter(record => record.event === 'before_agent_start' && record.preview === true).length;
const unsafeCalls = records.filter(record => record.event === 'before_agent_start_unsafe').length;
const skipped = previewRequest?.status === 'skipped' &&
  /before_agent_start handlers not registered previewSafe/.test(previewRequest?.reason ?? '') &&
  previewCalls === 0 && unsafeCalls > 0;
const text = [
  'P1 negative run: a deliberately non-preview-safe before_agent_start handler',
  `temp agent dir: ${run.sandbox.agentDir} (removed after the run)`,
  `exit=${summary.exitCode} timedOut=${summary.timedOut} pidGone=${summary.pidGone}`,
  `preview calls=${previewCalls} unsafe handler real calls=${unsafeCalls}`,
  `preview_request status=${previewRequest?.status} reason=${previewRequest?.reason}`,
  'runner.js:1748-1757 getPreviewUnsafeBeforeAgentStartPaths -> buildPromptCachePrefixRequest skips the preview pass',
  `verdict=${skipped ? 'PASS' : 'FAIL'}`,
  '',
  'raw log:',
  ...lines,
  '',
  `raw evidence: ${log}`,
].join('\n');
writeFileSync(join(OUT, 'task-2-piomo-primary-agents-p1-negative.txt'), `${text}\n`, 'utf8');
console.log(text);
if (!skipped) process.exitCode = 1;
