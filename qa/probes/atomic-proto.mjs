// P9 atomic-write prototype (todo 4 adopts this): exclusive temp file in the
// destination directory -> fsync -> close -> rename, with the bounded
// EPERM/EBUSY retry ladder 10/20/40/80/160 ms. Never writes in place and never
// unlinks the destination.
//
//   node atomic-proto.mjs writer --dir <dir> --name hephaestus.json --writer A --iterations 200
//   node atomic-proto.mjs reader --dir <dir> --name hephaestus.json --stop <stopfile>
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const RETRY_DELAYS_MS = [10, 20, 40, 80, 160];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function atomicWriteJson(directory, name, value) {
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, name);
  const temporary = join(directory, `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  const body = `${JSON.stringify(value)}\n`;
  const fd = openSync(temporary, 'wx');
  try {
    writeSync(fd, body, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let retries = 0;
  for (;;) {
    try {
      renameSync(temporary, destination);
      return { retries, bytes: Buffer.byteLength(body), destination };
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || retries >= RETRY_DELAYS_MS.length) {
        throw error;
      }
      sleepSync(RETRY_DELAYS_MS[retries]);
      retries += 1;
    }
  }
}

function writer({ dir, name, writer, iterations }) {
  const startedAt = Date.now();
  let retryTotal = 0;
  let retryMax = 0;
  for (let seq = 1; seq <= iterations; seq += 1) {
    const result = atomicWriteJson(dir, name, {
      writer,
      seq,
      writtenAt: new Date().toISOString(),
      payload: 'x'.repeat(2048),
    });
    retryTotal += result.retries;
    retryMax = Math.max(retryMax, result.retries);
  }
  console.log(JSON.stringify({
    role: 'writer',
    writer,
    iterations,
    retryTotal,
    retryMax,
    elapsedMs: Date.now() - startedAt,
    directory: dir,
    destination: join(dir, name),
  }));
}

function reader({ dir, name, stop }) {
  const destination = join(dir, name);
  const startedAt = Date.now();
  writeFileSync(`${stop}.ready`, 'ready\n', 'utf8');
  let reads = 0;
  let parseErrors = 0;
  const errors = [];
  let lastValid = null;
  const readOnce = () => {
    let text;
    try {
      text = readFileSync(destination, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    reads += 1;
    try {
      lastValid = JSON.parse(text);
    } catch (error) {
      parseErrors += 1;
      if (errors.length < 5) errors.push({ message: error.message, text: text.slice(0, 120) });
    }
  };
  for (;;) {
    readOnce();
    if (existsSync(stop)) {
      // Cover the final rename that completed before the stop file appeared.
      for (let index = 0; index < 10; index += 1) readOnce();
      break;
    }
  }
  console.log(JSON.stringify({
    role: 'reader',
    reads,
    parseErrors,
    errors,
    lastValid,
    elapsedMs: Date.now() - startedAt,
  }));
}

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    role: { type: 'string' },
    dir: { type: 'string' },
    name: { type: 'string', default: 'hephaestus.json' },
    writer: { type: 'string', default: 'A' },
    iterations: { type: 'string', default: '200' },
    stop: { type: 'string' },
  },
});
const role = values.role ?? process.argv[2];
if (role === 'writer') {
  writer({
    dir: values.dir,
    name: values.name,
    writer: values.writer,
    iterations: Number(values.iterations),
  });
} else if (role === 'reader') {
  reader({ dir: values.dir, name: values.name, stop: values.stop });
} else {
  console.error('usage: node atomic-proto.mjs writer|reader --dir <dir> ...');
  process.exit(2);
}
