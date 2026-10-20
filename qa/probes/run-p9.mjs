// P9 runner: one reader and two writers contending on memory/hephaestus.json.
// The reader must never see an unparsable file; writer retry counts are
// recorded. Everything lives under a temp dir that is deleted at the end.
import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PROBE_DIR, writeJson } from './lib.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) {
  console.error('usage: node qa/probes/run-p9.mjs --out <evidence dir>');
  process.exit(2);
}
const OUT = values.out;
const script = join(PROBE_DIR, 'atomic-proto.mjs');

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, pid: child.pid }));
  });
}

async function waitForFile(path, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${path}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const root = mkdtempSync(join(tmpdir(), 'piomo-p9-'));
const dir = join(root, 'memory');
const stop = join(root, 'stop');
const name = 'hephaestus.json';
const iterations = 200;
let result;
try {
  const readerPromise = runChild(['reader', '--dir', dir, '--name', name, '--stop', stop]);
  await waitForFile(`${stop}.ready`);
  const writersPromise = Promise.all([
    runChild(['writer', '--dir', dir, '--name', name, '--writer', 'A', '--iterations', String(iterations)]),
    runChild(['writer', '--dir', dir, '--name', name, '--writer', 'B', '--iterations', String(iterations)]),
  ]);
  const writers = await writersPromise;
  writeFileSync(stop, 'stop\n', 'utf8');
  const reader = await readerPromise;
  const finalText = readFileSync(join(dir, name), 'utf8');
  const finalValue = JSON.parse(finalText);
  const parse = line => {
    try { return JSON.parse(line.trim().split(/\r?\n/).at(-1)); } catch { return null; }
  };
  const writerResults = writers.map(writer => ({ exitCode: writer.code, ...parse(writer.stdout) }));
  const readerResult = { exitCode: reader.code, ...parse(reader.stdout) };
  const retryTotal = writerResults.reduce((sum, writer) => sum + (writer.retryTotal ?? 0), 0);
  result = {
    verdict: readerResult.exitCode === 0 && readerResult.parseErrors === 0 &&
      readerResult.reads > 0 && writerResults.every(writer => writer.exitCode === 0 && writer.iterations === iterations) &&
      writerResults.reduce((sum, writer) => sum + (writer.iterations ?? 0), 0) === iterations * 2
      ? 'PASS'
      : 'FAIL',
    decision: 'todo 4 adopts this writer: exclusive same-directory temp file, fsync, close, rename with 10/20/40/80/160 ms EPERM/EBUSY retries; the reader observed zero unparsable files',
    directory: dir,
    name,
    iterationsPerWriter: iterations,
    retryDelaysMs: [10, 20, 40, 80, 160],
    retryTotal,
    writerResults,
    readerResult,
    finalValue,
    raw: {
      writers: writerResults,
      reader: readerResult,
    },
  };
  writeJson(join(OUT, 'probe-raw', 'p9-result.json'), result);
  writeFileSync(join(OUT, 'probe-raw', 'p9-writers.txt'),
    `${writerResults.map(writer => JSON.stringify(writer)).join('\n')}\n`, 'utf8');
  console.log(`P9: ${result.verdict} - ${result.decision}`);
  console.log(`reads=${readerResult.reads} parseErrors=${readerResult.parseErrors} retries=${retryTotal} final=${JSON.stringify(finalValue).slice(0, 120)}`);
} finally {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
  const removed = !existsSync(root);
  if (result) {
    result.cleanup = { root, removed };
    writeJson(join(OUT, 'probe-raw', 'p9-result.json'), result);
  }
}
