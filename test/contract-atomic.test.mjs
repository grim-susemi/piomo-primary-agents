import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, renameSync as realRename,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteJson, writeRoster } from '../contract/atomic.mjs';
import { defaultRoster, rosterPath, setAgentLane } from '../contract/schema.mjs';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'piomo-atomic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function tmpFiles(dir) {
  return readdirSync(dir).filter(name => name.endsWith('.tmp'));
}

function retryingFs(failures, code = 'EPERM') {
  let attempts = 0;
  return {
    fs: {
      ...nodeFs,
      renameSync(from, to) {
        attempts += 1;
        if (attempts <= failures) {
          const error = new Error(`injected ${code}`);
          error.code = code;
          throw error;
        }
        return realRename(from, to);
      },
    },
    attempts: () => attempts,
  };
}

test('atomicWriteJson retries EPERM then succeeds and replaces the destination', t => {
  const dir = tempDir(t);
  const file = join(dir, 'state.json');
  writeFileSync(file, '{"old":true}\n', 'utf8');
  const injected = retryingFs(2, 'EPERM');

  const result = atomicWriteJson(file, { next: true }, { fs: injected.fs });

  assert.equal(result.retries, 2);
  assert.equal(injected.attempts(), 3);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { next: true });
  assert.deepEqual(tmpFiles(dir), []);
});

test('atomicWriteJson retries EBUSY and succeeds', t => {
  const dir = tempDir(t);
  const file = join(dir, 'state.json');
  const injected = retryingFs(1, 'EBUSY');

  const result = atomicWriteJson(file, { next: true }, { fs: injected.fs });

  assert.equal(result.retries, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { next: true });
  assert.deepEqual(tmpFiles(dir), []);
});

test('exhaustion keeps the destination bytes, removes the tmp and throws ATOMIC_EXHAUSTED', t => {
  const dir = tempDir(t);
  const file = join(dir, 'state.json');
  const original = '{"old":true}\n';
  writeFileSync(file, original, 'utf8');
  let attempts = 0;
  const injected = {
    ...nodeFs,
    renameSync() {
      attempts += 1;
      const error = new Error('always busy');
      error.code = 'EPERM';
      throw error;
    },
  };

  assert.throws(
    () => atomicWriteJson(file, { next: true }, { fs: injected }),
    error => error.code === 'ATOMIC_EXHAUSTED',
  );
  assert.equal(attempts, 6);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(tmpFiles(dir), []);
});

test('a non-retryable rename error propagates and still removes the tmp', t => {
  const dir = tempDir(t);
  const file = join(dir, 'state.json');
  writeFileSync(file, '{"old":true}\n', 'utf8');
  const injected = {
    ...nodeFs,
    renameSync() {
      const error = new Error('cross-device');
      error.code = 'EXDEV';
      throw error;
    },
  };

  assert.throws(() => atomicWriteJson(file, { next: true }, { fs: injected }), error => error.code === 'EXDEV');
  assert.equal(readFileSync(file, 'utf8'), '{"old":true}\n');
  assert.deepEqual(tmpFiles(dir), []);
});

test('writeRoster starts a fresh roster at revision 1 and persists it', t => {
  const dir = tempDir(t);
  const written = writeRoster(dir, defaultRoster(), 0);
  assert.equal(written.revision, 1);
  assert.deepEqual(JSON.parse(readFileSync(rosterPath(dir), 'utf8')), written);
});

test('writeRoster throws CONFLICT on a stale expectedRevision and keeps the bytes', t => {
  const dir = tempDir(t);
  writeRoster(dir, defaultRoster(), 0);
  const bytes = readFileSync(rosterPath(dir));

  assert.throws(
    () => writeRoster(dir, defaultRoster(), 0),
    error => error.code === 'CONFLICT',
  );

  assert.ok(readFileSync(rosterPath(dir)).equals(bytes));
  assert.equal(existsSync(join(dir, 'primary-agents', 'backups')), false);
});

test('writeRoster validates before writing and creates no destination on rejection', t => {
  const dir = tempDir(t);
  const invalid = defaultRoster();
  invalid.agents.sisyphus.lane = 'weekly';

  assert.throws(
    () => writeRoster(dir, invalid, 0),
    error => error.code === 'INVALID_ROSTER',
  );

  assert.equal(existsSync(rosterPath(dir)), false);
  assert.equal(existsSync(join(dir, 'primary-agents', 'backups')), false);
});

test('writeRoster backs up the previous bytes before replacing the roster', t => {
  const dir = tempDir(t);
  writeRoster(dir, defaultRoster(), 0);
  const before = readFileSync(rosterPath(dir));
  writeRoster(dir, defaultRoster(), 1);

  const backups = readdirSync(join(dir, 'primary-agents', 'backups'))
    .filter(name => /^roster-\d{8}-\d{6}-\d{3}\.json$/.test(name));
  assert.equal(backups.length, 1);
  assert.ok(readFileSync(join(dir, 'primary-agents', 'backups', backups[0])).equals(before));
});

test('writeRoster prunes backups to the newest 20', t => {
  const dir = tempDir(t);
  let roster = defaultRoster();
  writeRoster(dir, roster, 0);
  for (let revision = 1; revision <= 24; revision += 1) {
    roster = setAgentLane(roster, 'sisyphus', revision % 2 === 0 ? 'daily-normal' : 'daily-heavy');
    writeRoster(dir, roster, revision);
  }

  const backups = readdirSync(join(dir, 'primary-agents', 'backups'))
    .filter(name => /^roster-\d{8}-\d{6}-\d{3}\.json$/.test(name))
    .sort();
  assert.equal(backups.length, 20);

  const revisions = backups.map(name => JSON.parse(
    readFileSync(join(dir, 'primary-agents', 'backups', name), 'utf8'),
  ).revision);
  assert.deepEqual(revisions, Array.from({ length: 20 }, (_, index) => index + 5));
});
