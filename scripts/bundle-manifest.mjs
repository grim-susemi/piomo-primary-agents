import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT_DEFAULTS = {
  senpi: 'C:/Users/USER/.bun/install/global/node_modules/@code-yeongyu/senpi',
  'pi-tui': 'C:/Users/USER/.bun/install/global/node_modules/@earendil-works/pi-tui',
  plugin: 'C:/Users/USER/.omo-stable-500/staging/memory-rollback-5.1.38-r1/package/plugin',
};

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
  },
});

if (!values.out) {
  throw new Error('usage: node scripts/bundle-manifest.mjs --out <evidence dir>');
}
const outDir = resolve(values.out);
mkdirSync(join(outDir, 'bundle-manifests'), { recursive: true });

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function posix(path) {
  return path.split(sep).join('/');
}

async function walk(root) {
  const entries = [];
  const visited = new Set();

  async function visit(directory) {
    const real = realpathSync.native(directory);
    if (visited.has(real)) return;
    visited.add(real);
    const names = readdirSync(directory).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const rel = posix(relative(root, path));
      if (stat.isSymbolicLink()) {
        entries.push({ rel, kind: 'link', sha256: sha256(`link:${readlinkSync(path)}`), bytes: 0 });
      } else if (stat.isDirectory()) {
        await visit(path);
      } else if (stat.isFile()) {
        entries.push({ rel, kind: 'file', sha256: await hashFile(path), bytes: stat.size });
      }
    }
  }

  await visit(root);
  entries.sort((a, b) => a.rel.localeCompare(b.rel));
  return entries;
}

const manifest = {
  v: 1,
  generatedAt: new Date().toISOString(),
  trees: {},
};

for (const [name, fallback] of Object.entries(ROOT_DEFAULTS)) {
  const envKey = `PIOMO_${name.toUpperCase().replace(/-/g, '_')}_ROOT`;
  const root = resolve(process.env[envKey] ?? fallback);
  const entries = await walk(root);
  const lines = entries.map(entry => `${entry.sha256}  ${entry.rel}`).join('\n') + '\n';
  const bytes = lines.length;
  const manifestPath = join(outDir, 'bundle-manifests', `${name}.sha256`);
  writeFileSync(manifestPath, lines, 'utf8');
  manifest.trees[name] = {
    root,
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    manifest: manifestPath,
    manifestBytes: bytes,
    treeSha256: sha256(lines),
  };
  console.log(`${name}: ${entries.length} files, ${manifest.trees[name].treeSha256}`);
}

const summaryPath = join(outDir, 'task-1-piomo-primary-agents-bundles.json');
writeFileSync(summaryPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const textPath = join(outDir, 'task-1-piomo-primary-agents-bundles.txt');
const summaryLines = [
  'piomo-primary-agents bundle manifests',
  `generated: ${manifest.generatedAt}`,
  ...Object.entries(manifest.trees).map(([name, tree]) =>
    `${name}: ${tree.files} files, ${tree.bytes} bytes, tree sha256 ${tree.treeSha256}, ${tree.manifest}`),
  `json: ${summaryPath}`,
];
writeFileSync(textPath, summaryLines.join('\n') + '\n', 'utf8');
console.log(`wrote ${summaryPath}`);
