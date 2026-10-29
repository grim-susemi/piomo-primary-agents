import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../scripts/install.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'scripts', 'install.mjs');
const MARKER = '// managed by omo-primary-agents';
const GENERATION = 'generation-000001';
const DIST_FILES = [
  'contract/atomic.mjs', 'extension.js', 'prompts/atlas.md', 'src/core/orchestration.mjs',
];
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function write(base, rel, text) {
  const path = join(base, ...rel.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function sha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'installer-test-'));
  roots.push(root);
  const dist = join(root, 'dist');
  write(dist, 'extension.js', 'export default {};\n');
  write(dist, 'src/core/orchestration.mjs', 'export const x = 1;\n');
  write(dist, 'prompts/atlas.md', '# atlas\n');
  write(dist, 'contract/atomic.mjs', 'export {};\n');
  const agentDir = join(root, 'agent');
  mkdirSync(agentDir, { recursive: true });
  return { root, agentDir, dist };
}

// Stubs replace the real build and the git check so each test controls them.
function options(sb, extra = {}) {
  return {
    agentDir: sb.agentDir,
    dist: sb.dist,
    buildProduct: () => {},
    distStatus: () => '',
    ...extra,
  };
}

// Every file and directory under `dir`, keyed by forward-slash relpath.
function tree(dir) {
  const entries = {};
  if (!existsSync(dir)) return entries;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const key = relative(dir, path).split('\\').join('/');
      if (entry.isDirectory()) {
        entries[`${key}/`] = 'dir';
        walk(path);
      } else {
        entries[key] = sha(path);
      }
    }
  };
  walk(dir);
  return entries;
}

test('refuses the live-shaped agent dir without --live and writes nothing', () => {
  const sb = sandbox();
  const live = join(sb.root, 'home', '.omo', 'agent');
  mkdirSync(live, { recursive: true });
  const before = tree(live);
  assert.throws(
    () => install(options(sb, { agentDir: live, liveAgentDir: live })),
    error => error.code === 'live_agent_dir_refused' && error.exitCode === 2,
  );
  assert.deepEqual(tree(live), before);
});

test('--dry-run on the live-shaped path plans the install and writes nothing', () => {
  const sb = sandbox();
  const live = join(sb.root, 'home', '.omo', 'agent');
  mkdirSync(live, { recursive: true });
  const before = tree(live);
  const plan = install(options(sb, { agentDir: live, liveAgentDir: live, dryRun: true }));
  assert.equal(plan.status, 'dry_run');
  assert.equal(plan.generation, GENERATION);
  assert.deepEqual(tree(live), before);
});

test('refuses a settings.json that carries the repo path, and writes nothing', () => {
  for (const carrier of ['packages', 'extensions']) {
    const sb = sandbox();
    writeFileSync(join(sb.agentDir, 'settings.json'),
      JSON.stringify({ [carrier]: [join(ROOT, 'dist', 'extension.js')] }), 'utf8');
    const before = tree(sb.agentDir);
    assert.throws(
      () => install(options(sb)),
      error => error.code === 'package_carrier_present' && error.exitCode === 1,
    );
    assert.deepEqual(tree(sb.agentDir), before);
  }
});

test('refuses a foreign shim and leaves it and the agent dir unchanged', () => {
  const sb = sandbox();
  write(sb.agentDir, 'extensions/omo-primary-agents.js', '// someone else\nexport default 1;\n');
  const before = tree(sb.agentDir);
  assert.throws(() => install(options(sb)), error => error.code === 'foreign_shim');
  assert.deepEqual(tree(sb.agentDir), before);
});

test('refuses a stale dist after the build, and writes nothing', () => {
  const sb = sandbox();
  const builds = [];
  const before = tree(sb.agentDir);
  assert.throws(
    () => install(options(sb, {
      buildProduct: () => builds.push('build'),
      distStatus: () => ' M dist/extension.js\n',
    })),
    error => error.code === 'dist_stale' && error.exitCode === 1,
  );
  assert.deepEqual(builds, ['build']);
  assert.deepEqual(tree(sb.agentDir), before);
});

test('takes the next generation number and never overwrites an existing one', () => {
  const sb = sandbox();
  write(sb.agentDir, 'primary-agents/integration/generation-000003/extension.js', 'OLD');
  const result = install(options(sb));
  assert.equal(result.generation, 'generation-000004');
  assert.equal(readFileSync(join(sb.agentDir, 'primary-agents/integration/generation-000003/extension.js'), 'utf8'), 'OLD');
  const current = JSON.parse(readFileSync(join(sb.agentDir, 'primary-agents/integration/current.json'), 'utf8'));
  assert.equal(current.generation, 'generation-000004');
});

test('writes the exact shim text, a current.json with per-file sha256, and the prompts layout', () => {
  const sb = sandbox();
  install(options(sb));
  const shim = readFileSync(join(sb.agentDir, 'extensions/omo-primary-agents.js'), 'utf8');
  assert.equal(shim,
    `${MARKER}\nexport { default } from '../primary-agents/integration/${GENERATION}/extension.js';\n`);
  const currentPath = join(sb.agentDir, 'primary-agents/integration/current.json');
  const current = JSON.parse(readFileSync(currentPath, 'utf8'));
  assert.deepEqual(Object.keys(current).sort(), ['entry', 'generation', 'installed_at', 'sha256']);
  assert.equal(current.generation, GENERATION);
  assert.equal(current.entry, 'extension.js');
  assert.equal(Number.isNaN(Date.parse(current.installed_at)), false);
  const generationDir = join(sb.agentDir, 'primary-agents/integration', GENERATION);
  const expected = Object.fromEntries(DIST_FILES.map(file => [file, sha(join(sb.dist, ...file.split('/')))]));
  assert.deepEqual(current.sha256, expected);
  for (const file of Object.keys(current.sha256)) {
    assert.equal(file.includes('\\'), false);
    assert.equal(sha(join(generationDir, ...file.split('/'))), current.sha256[file]);
  }
  assert.equal(existsSync(join(generationDir, 'prompts', 'atlas.md')), true);
});

test('--uninstall removes only the shim and current.json and keeps the generations', () => {
  const sb = sandbox();
  const userFiles = {
    'primary-agents/roster.json': '{"roster":true}\n',
    'primary-agents/apply-journal.json': '[]\n',
    'primary-agents/memory/notes.md': 'remember\n',
    'settings.json': JSON.stringify({ packages: ['C:/elsewhere/other-pkg'] }),
  };
  for (const [rel, text] of Object.entries(userFiles)) write(sb.agentDir, rel, text);
  const omoPath = join(sb.root, 'omo.jsonc');
  writeFileSync(omoPath, '{"model_profiles":{}}\n', 'utf8');
  const userBefore = Object.fromEntries(Object.keys(userFiles).map(rel => [rel, sha(join(sb.agentDir, rel))]));
  const omoBefore = sha(omoPath);

  const installed = install(options(sb));
  assert.equal(installed.status, 'installed');
  const afterInstall = tree(sb.agentDir);

  const removed = install({ agentDir: sb.agentDir, uninstall: true });
  assert.equal(removed.status, 'uninstalled');
  const afterUninstall = tree(sb.agentDir);
  const gone = ['extensions/omo-primary-agents.js', 'primary-agents/integration/current.json'];
  assert.deepEqual(
    Object.keys(afterUninstall).sort(),
    Object.keys(afterInstall).filter(key => !gone.includes(key)).sort(),
  );
  for (const rel of Object.keys(userFiles)) {
    assert.equal(sha(join(sb.agentDir, rel)), userBefore[rel]);
  }
  assert.equal(sha(omoPath), omoBefore);
});

test('the CLI rejects an unknown flag, a missing --agent-dir and a file as agent dir', () => {
  const sb = sandbox();
  const filePath = join(sb.root, 'not-a-dir.txt');
  writeFileSync(filePath, 'x', 'utf8');
  const cases = [
    [['--bogus'], 'ERR_PARSE_ARGS_UNKNOWN_OPTION'],
    [[], 'agent_dir_required'],
    [['--agent-dir', filePath], 'agent_dir_not_directory'],
  ];
  for (const [args, code] of cases) {
    const child = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(child.status, 1, child.stderr);
    assert.equal(JSON.parse(child.stderr).code, code);
  }
});
