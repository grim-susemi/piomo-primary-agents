import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build.mjs');
const BUILD_TIMEOUT_MS = 120000;
const GIT_TIMEOUT_MS = 30000;
const ENTRY = 'extension.js';
const MARKER = '// managed by omo-primary-agents';
export const LIVE_AGENT_DIR = 'C:/Users/USER/.omo-stable-500/home/.omo/agent';

function fail(code, message, exitCode = 1) {
  return Object.assign(new Error(message), { code, exitCode });
}

function pathKey(path) {
  const normalized = resolve(path).replaceAll('\\', '/');
  return (normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized).toLowerCase();
}

function realPathKey(path) {
  const missing = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return pathKey(join(realpathSync.native(existing), ...missing));
}

export function isLiveAgentDir(agentDir, liveAgentDir = LIVE_AGENT_DIR) {
  return pathKey(agentDir) === pathKey(liveAgentDir)
    || realPathKey(agentDir) === realPathKey(liveAgentDir);
}

// settings.json is read only for this check: a `packages` or `extensions` entry
// under the repo path would load the whole package a second time.
function packageCarrierPresent(agentDir) {
  const settingsPath = join(agentDir, 'settings.json');
  if (!existsSync(settingsPath)) return false;
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const repo = ROOT.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return [...(settings.packages ?? []), ...(settings.extensions ?? [])].some((entry) => {
    const key = String(entry).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
    return key === repo || key.startsWith(`${repo}/`);
  });
}

function filesUnder(directory, root = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path, root));
    else if (entry.isFile()) files.push(relative(root, path).replaceAll(sep, '/'));
  }
  return files.sort();
}

function fileHashes(directory, files) {
  const hashes = {};
  for (const file of files) {
    hashes[file] = createHash('sha256').update(readFileSync(join(directory, file))).digest('hex');
  }
  return hashes;
}

function verifyHashes(directory, expected) {
  const actual = fileHashes(directory, Object.keys(expected));
  for (const [file, hash] of Object.entries(expected)) {
    if (actual[file] !== hash) throw fail('copy_mismatch', `${file} in ${directory} does not match its hash.`);
  }
}

function replaceWrite(path, text) {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function foreignShim(shimPath) {
  return existsSync(shimPath) && readFileSync(shimPath, 'utf8').split(/\r?\n/, 1)[0] !== MARKER;
}

function nextGeneration(integration) {
  const numbers = existsSync(integration) ? readdirSync(integration)
    .map(name => /^generation-(\d{6})$/.exec(name))
    .filter(Boolean)
    .map(match => Number(match[1])) : [];
  return `generation-${String(Math.max(0, ...numbers) + 1).padStart(6, '0')}`;
}

const runBuild = () => execFileSync(process.execPath, [BUILD_SCRIPT], {
  cwd: ROOT, stdio: 'pipe', timeout: BUILD_TIMEOUT_MS, windowsHide: true,
});

const readDistStatus = () => execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', 'dist'], {
  encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true,
});

export function install({
  agentDir,
  uninstall = false,
  live = false,
  dryRun = false,
  liveAgentDir = LIVE_AGENT_DIR,
  dist = join(ROOT, 'dist'),
  buildProduct = runBuild,
  distStatus = readDistStatus,
} = {}) {
  if (!agentDir) throw fail('agent_dir_required', 'Use --agent-dir <directory>.');
  const agent = resolve(agentDir);
  if (existsSync(agent) && !statSync(agent).isDirectory()) {
    throw fail('agent_dir_not_directory', `${agent} is not a directory.`);
  }
  if (!dryRun && !live && isLiveAgentDir(agent, liveAgentDir)) {
    throw fail('live_agent_dir_refused',
      `Refusing to write into the live agent directory ${agent}; pass --live only after owner approval.`, 2);
  }
  const shimPath = join(agent, 'extensions', 'omo-primary-agents.js');
  const currentPath = join(agent, 'primary-agents', 'integration', 'current.json');
  if (foreignShim(shimPath)) throw fail('foreign_shim', 'Refusing a non-managed omo-primary-agents.js; nothing changed.');

  if (uninstall) {
    const removed = [shimPath, currentPath].filter(path => existsSync(path));
    if (!dryRun) for (const path of removed) unlinkSync(path);
    return {
      status: dryRun ? 'dry_run' : 'uninstalled', agent_dir: agent, removed, kept: ['generations'],
    };
  }

  if (packageCarrierPresent(agent)) {
    throw fail('package_carrier_present',
      'settings.json already loads this repo as a package; remove that entry before installing the shim.');
  }
  buildProduct();
  if (distStatus().trim() !== '') {
    throw fail('dist_stale', 'dist/ differs from a fresh build; commit the rebuilt dist before installing.');
  }
  if (!existsSync(join(dist, ENTRY))) throw fail('dist_missing', 'dist/extension.js is missing; run npm run build.');

  const files = filesUnder(dist);
  const sha256 = fileHashes(dist, files);
  const integration = join(agent, 'primary-agents', 'integration');
  const generation = nextGeneration(integration);
  const generationPath = join(integration, generation);
  const shimText = `${MARKER}\nexport { default } from '../primary-agents/integration/${generation}/${ENTRY}';\n`;

  if (dryRun) {
    return {
      status: 'dry_run',
      generation,
      generation_path: generationPath,
      shim_path: shimPath,
      shim_text: shimText,
      current_path: currentPath,
      targets: [...files.map(file => join(generationPath, file)), currentPath, shimPath],
      sha256,
    };
  }

  for (const file of files) {
    const target = join(generationPath, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(dist, file), target);
  }
  verifyHashes(generationPath, sha256);
  replaceWrite(currentPath, `${JSON.stringify({
    generation, installed_at: new Date().toISOString(), entry: ENTRY, sha256,
  }, null, 2)}\n`);
  mkdirSync(dirname(shimPath), { recursive: true });
  replaceWrite(shimPath, shimText);

  verifyHashes(generationPath, sha256);
  const recorded = JSON.parse(readFileSync(currentPath, 'utf8'));
  if (recorded.generation !== generation || readFileSync(shimPath, 'utf8') !== shimText) {
    throw fail('verify_failed', 'Installed files do not match the plan; the shim may be inconsistent.');
  }
  return {
    status: 'installed', generation, generation_path: generationPath, agent_dir: agent,
    shim_path: shimPath, current_path: currentPath, entry: ENTRY, sha256,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'agent-dir': { type: 'string' },
      live: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      uninstall: { type: 'boolean' },
    } });
    if (!values['agent-dir']) throw fail('agent_dir_required', 'Use --agent-dir <directory>.');
    console.log(JSON.stringify(install({
      agentDir: values['agent-dir'],
      uninstall: !!values.uninstall,
      live: !!values.live,
      dryRun: !!values['dry-run'],
    }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ status: 'error', code: error.code ?? 'unexpected', message: error.message }));
    process.exitCode = error.exitCode ?? 1;
  }
}
