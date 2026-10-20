import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIRS = ['src', 'contract', 'prompts'];
// The entry is the one module the senpi loader compiles first, so its static
// imports are the only place the alias for @earendil-works/pi-coding-agent
// reaches the host editor. A dynamic import deeper in the graph stays native.
const EXTENSION_STUB = [
  'import { EditorBase } from "./src/host/editor-host.mjs";',
  'import { createPrimaryAgentsExtension } from "./src/index.mjs";',
  '',
  'export default createPrimaryAgentsExtension({ EditorBase });',
  '',
].join('\n');

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
  },
});

const outDir = values.out ? resolve(values.out) : join(ROOT, 'dist');

if (outDir === ROOT) throw new Error('Refusing to build into the package root.');
for (const name of SOURCE_DIRS) {
  const source = join(ROOT, name);
  if (outDir === source || outDir.startsWith(source + sep)) {
    throw new Error(`Refusing to build into the source directory ${name}/.`);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const name of SOURCE_DIRS) {
  cpSync(join(ROOT, name), join(outDir, name), { recursive: true });
}
writeFileSync(join(outDir, 'extension.js'), EXTENSION_STUB, 'utf8');

const count = directory => readdirSync(directory, { withFileTypes: true })
  .reduce((total, entry) => total + (entry.isDirectory()
    ? count(join(directory, entry.name))
    : 1), 0);

const shown = relative(ROOT, outDir) || '.';
console.log(`built ${shown} (${count(outDir)} files)`);
