import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function snapshot(directory) {
  const files = new Map();
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        files.set(relative(directory, path).split(sep).join('/'), readFileSync(path));
      }
    }
  };
  visit(directory);
  return files;
}

test('package shape matches the pi package contract', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'piomo-primary-agents');
  assert.equal(pkg.version, '0.0.0');
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=24');
  assert.equal(pkg.peerDependencies['@code-yeongyu/senpi'], '*');
  assert.deepEqual(pkg.pi.extensions, ['./dist/extension.js']);
  assert.equal(pkg.scripts.test, 'node --test --test-isolation=none test/*.test.mjs');
  assert.equal(pkg.scripts.build, 'node scripts/build.mjs');
  assert.equal(pkg.scripts.check, 'npm test && npm run build');
});

test('src/index.mjs exports a no-op extension', async () => {
  const module = await import('../src/index.mjs');
  assert.equal(typeof module.default, 'function');
  assert.equal(module.default({}), undefined);
});

test('dist/extension.js is the committed package entry stub', () => {
  assert.equal(read('dist/extension.js'), 'export { default } from "./src/index.mjs";\n');
});

test('dist/ equals a fresh build of src/, contract/ and prompts/', () => {
  const out = mkdtempSync(join(tmpdir(), 'piomo-primary-agents-build-'));
  try {
    const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--out', out], {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);
    const fresh = snapshot(out);
    const committed = snapshot(join(ROOT, 'dist'));
    assert.deepEqual([...fresh.keys()], [...committed.keys()]);
    for (const [path, bytes] of fresh) {
      assert.ok(committed.get(path).equals(bytes), `${path} differs from a fresh build`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('git attributes keep contract and fixture bytes exact', () => {
  const attributes = read('.gitattributes').split(/\r?\n/);
  assert.ok(attributes.includes('contract/** -text'));
  assert.ok(attributes.includes('test/fixtures/** -text'));
});

test('LICENSES/SUL-1.0.md is the byte-exact OMO5 license', () => {
  const bytes = readFileSync(join(ROOT, 'LICENSES', 'SUL-1.0.md'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    'b61ac928f152d13517328263e6bee9175b928f9ab696a2d2ca2b6cfd961ddc32');
});
