// P9-style Windows contention check against the shipped contract/atomic.mjs.
//
//   node qa/probes/atomic-contract-proto.mjs
//
// Spawns one reader and two writer processes that hammer
// <temp>/memory/hephaestus.json through atomicWriteJson (200 iterations each).
// The reader must observe zero unparsable files. The temp dir is removed at the
// end; the process tree exits on its own.
import { spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { atomicWriteJson } from '../../contract/atomic.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const role = process.argv[2];

function takeOptions() {
  return parseArgs({
    args: process.argv.slice(3),
    options: {
      dir: { type: 'string' },
      name: { type: 'string', default: 'hephaestus.json' },
      writer: { type: 'string', default: 'A' },
      iterations: { type: 'string', default: '200' },
      stop: { type: 'string' },
    },
  }).values;
}

function writerRole() {
  const values = takeOptions();
  const iterations = Number(values.iterations);
  const startedAt = Date.now();
  let retryTotal = 0;
  let retryMax = 0;
  for (let sequence = 1; sequence <= iterations; sequence += 1) {
    try {
      const result = atomicWriteJson(join(values.dir, values.name), {
        writer: values.writer,
        sequence,
        writtenAt: new Date().toISOString(),
        payload: 'x'.repeat(2048),
      });
      retryTotal += result.retries;
      retryMax = Math.max(retryMax, result.retries);
    } catch (error) {
      console.log(JSON.stringify({
        role: 'writer',
        writer: values.writer,
        iterations,
        completed: sequence - 1,
        failedAt: sequence,
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? String(error),
        retryTotal,
        retryMax,
        elapsedMs: Date.now() - startedAt,
      }));
      process.exitCode = 1;
      return;
    }
  }
  console.log(JSON.stringify({
    role: 'writer',
    writer: values.writer,
    iterations,
    retryTotal,
    retryMax,
    elapsedMs: Date.now() - startedAt,
  }));
}

function readerRole() {
  const values = takeOptions();
  const destination = join(values.dir, values.name);
  const startedAt = Date.now();
  writeFileSync(`${values.stop}.ready`, 'ready\n', 'utf8');
  let reads = 0;
  let parseErrors = 0;
  const errors = [];
  const readErrors = [];
  const readOnce = () => {
    let text;
    try {
      text = readFileSync(destination, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (readErrors.length < 5) readErrors.push({ code: error?.code, message: error.message });
      return;
    }
    reads += 1;
    try {
      JSON.parse(text);
    } catch (error) {
      parseErrors += 1;
      if (errors.length < 5) errors.push({ message: error.message, text: text.slice(0, 120) });
    }
  };
  for (;;) {
    readOnce();
    if (existsSync(values.stop)) {
      // Cover a final rename that completed just before the stop file appeared.
      for (let index = 0; index < 10; index += 1) readOnce();
      break;
    }
  }
  console.log(JSON.stringify({
    role: 'reader',
    reads,
    parseErrors,
    readErrors,
    errors,
    elapsedMs: Date.now() - startedAt,
  }));
}

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { windowsHide: true });
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

function parseLastLine(stdout) {
  try {
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  } catch {
    return null;
  }
}

async function runnerRole() {
  const root = mkdtempSync(join(tmpdir(), 'piomo-t4-contention-'));
  const dir = join(root, 'memory');
  const stop = join(root, 'stop');
  const name = 'hephaestus.json';
  const iterations = 200;
  let result;
  let removed = false;
  try {
    const readerPromise = runChild(['reader', '--dir', dir, '--name', name, '--stop', stop]);
    await waitForFile(`${stop}.ready`);

    const writers = await Promise.all([
      runChild(['writer', '--dir', dir, '--name', name, '--writer', 'A', '--iterations', String(iterations)]),
      runChild(['writer', '--dir', dir, '--name', name, '--writer', 'B', '--iterations', String(iterations)]),
    ]);
    writeFileSync(stop, 'stop\n', 'utf8');
    const reader = await readerPromise;

    const writerResults = writers.map(writer => ({
      exitCode: writer.code,
      ...parseLastLine(writer.stdout),
      stderr: writer.stderr.trim().split(/\r?\n/).slice(0, 3).join(' | '),
    }));
    const readerResult = { exitCode: reader.code, ...parseLastLine(reader.stdout) };
    if (readerResult.reads === undefined) readerResult.stderr = reader.stderr.trim().split(/\r?\n/).slice(0, 3).join(' | ');
    const finalValue = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const tmpLeftovers = readdirSync(dir).filter(entry => entry.endsWith('.tmp'));

    const writersOk = writerResults.every(writer => writer.exitCode === 0
      && writer.iterations === iterations
      && writer.role === 'writer');
    const verdict = writersOk
      && readerResult.exitCode === 0
      && readerResult.parseErrors === 0
      && (readerResult.readErrors?.length ?? 0) === 0
      && readerResult.reads > 0
      && tmpLeftovers.length === 0
      ? 'PASS'
      : 'FAIL';

    result = {
      verdict,
      implementation: 'contract/atomic.mjs atomicWriteJson',
      iterationsPerWriter: iterations,
      readers: readerResult,
      writers: writerResults,
      retryTotal: writerResults.reduce((sum, writer) => sum + (writer.retryTotal ?? 0), 0),
      retryMax: Math.max(...writerResults.map(writer => writer.retryMax ?? 0)),
      tmpLeftovers,
      finalValue,
    };
  } finally {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Reported below; the run still exits with its verdict.
    }
    removed = !existsSync(root);
  }
  if (!result) throw new Error('contention run produced no result');
  console.log(`task-4 contention: ${result.verdict}`);
  console.log(`reads=${result.readers.reads} parseErrors=${result.readers.parseErrors} `
    + `readErrors=${result.readers.readErrors?.length ?? 0} retries=${result.retryTotal} `
    + `retryMax=${result.retryMax} tmpLeftovers=${result.tmpLeftovers.length}`);
  console.log(`writers=${JSON.stringify(result.writers.map(writer => ({
    writer: writer.writer, exitCode: writer.exitCode, iterations: writer.iterations,
  })))}`);
  console.log(`finalValue=${JSON.stringify(result.finalValue).slice(0, 160)}`);
  console.log(`cleanup: temp dir removed=${removed}`);
  console.log(JSON.stringify(result));
  process.exitCode = result.verdict === 'PASS' && removed ? 0 : 1;
}

if (role === 'writer') writerRole();
else if (role === 'reader') readerRole();
else await runnerRole();
