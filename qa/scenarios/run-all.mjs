// Run every todo-11 scenario in its own process and record the suite summary.
// Each scenario writes its own raw evidence file; this runner only aggregates.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { writeText } from './lib.mjs';

const SCENARIOS = [
  's1', 's2', 's3', 's4', 's4a', 's5', 's6', 's6b', 's7', 's8', 's9',
  's10', 's11', 's13', 's14', 's15', 'refusal',
];

const EVIDENCE = {
  s1: 'task-11-piomo-primary-agents-S1.md',
  s2: 'task-11-piomo-primary-agents-S2.md',
  s3: 'task-11-piomo-primary-agents-S3.md',
  s4: 'task-11-piomo-primary-agents-S4.md',
  s4a: 'task-11-piomo-primary-agents-S4a.md',
  s5: 'task-11-piomo-primary-agents-S5.md',
  s6: 'task-11-piomo-primary-agents-S6.md',
  s6b: 'task-11-piomo-primary-agents-S6b.md',
  s7: 'task-11-piomo-primary-agents-S7.md',
  s8: 'task-11-piomo-primary-agents-S8.md',
  s9: 'task-11-piomo-primary-agents-S9.md',
  s10: 'task-11-piomo-primary-agents-S10.json',
  s11: 'task-11-piomo-primary-agents-S11.md',
  s13: 'task-11-piomo-primary-agents-S13.md',
  s14: 'task-11-piomo-primary-agents-S14.md',
  s15: 'task-11-piomo-primary-agents-S15.md',
  refusal: 'task-11-piomo-primary-agents-refusal.txt',
};

export function run({ out }) {
  writeText(out, 'task-11-piomo-primary-agents-S12.md', [
    '# S12 - real-model smoke',
    '',
    'Not run in todo 11 by design: no credential copies and no metered API keys.',
    'The real-model smoke runs after the todo-16 (a) install, pinned to a subscription provider.',
  ].join('\n'));
  const results = [];
  for (const name of SCENARIOS) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const child = spawnSync(process.execPath, [join(import.meta.dirname, `${name}.mjs`), '--out', out], {
      encoding: 'utf8',
      timeout: 240000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    const file = join(out, EVIDENCE[name]);
    if (!existsSync(file)) {
      writeText(out, EVIDENCE[name], [
        `# ${name} - no evidence file produced`,
        '',
        `The scenario exited ${child.status} without writing its evidence file.`,
        '',
        '--- stdout ---',
        child.stdout ?? '',
        '--- stderr ---',
        child.stderr ?? '',
      ].join('\n'));
    }
    results.push({
      name,
      startedAt,
      elapsedMs: Date.now() - started,
      status: child.status,
      signal: child.signal,
      timedOut: child.error?.code === 'ETIMEDOUT',
      evidence: file,
      stdoutTail: String(child.stdout ?? '').slice(-2000),
      stderrTail: String(child.stderr ?? '').slice(-2000),
    });
  }
  const ok = results.every(result => result.status === 0 && result.timedOut !== true);
  const summary = `${JSON.stringify({
    ok,
    generatedAt: new Date().toISOString(),
    scenarios: results,
  }, null, 2)}\n`;
  writeText(out, 'task-11-piomo-primary-agents-suite.json', summary);
  console.log(summary);
  return { ok, results };
}

const invokedDirectly = process.argv[1]?.endsWith('run-all.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/run-all.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    const result = run({ out: values.out });
    process.exitCode = result.ok ? 0 : 1;
  }
}
