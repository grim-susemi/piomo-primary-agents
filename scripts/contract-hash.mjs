// Write or verify contract/CONTRACT.sha256.
//
// The aggregate is sha256 over the sorted contract file names and bytes
// (name, NUL, bytes, NUL). CONTRACT.sha256 itself is excluded.
//
//   node scripts/contract-hash.mjs           write the manifest
//   node scripts/contract-hash.mjs --check   exit 0 only when it is current
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACT_DIR = join(ROOT, 'contract');
const MANIFEST = join(CONTRACT_DIR, 'CONTRACT.sha256');
const MANIFEST_NAME = 'CONTRACT.sha256';

function contractFiles() {
  return readdirSync(CONTRACT_DIR)
    .filter(name => name !== MANIFEST_NAME && statSync(join(CONTRACT_DIR, name)).isFile())
    .sort();
}

function digest(files) {
  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(name, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(join(CONTRACT_DIR, name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function manifestText(files, aggregate) {
  const lines = [
    '# piomo-primary-agents contract digest v1',
    '# sha256 over sorted files: name NUL bytes NUL, excluding CONTRACT.sha256',
    `contract-sha256 ${aggregate}`,
  ];
  for (const name of files) {
    const fileHash = createHash('sha256').update(readFileSync(join(CONTRACT_DIR, name))).digest('hex');
    lines.push(`${fileHash}  ${name}`);
  }
  return `${lines.join('\n')}\n`;
}

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
const files = contractFiles();
const aggregate = digest(files);

if (values.check) {
  let current;
  try {
    current = readFileSync(MANIFEST, 'utf8');
  } catch (error) {
    console.error(`contract-hash: cannot read ${MANIFEST}: ${error.message}`);
    process.exit(1);
  }
  const match = current.match(/^contract-sha256 ([0-9a-f]{64})$/m);
  if (!match) {
    console.error('contract-hash: CONTRACT.sha256 has no contract-sha256 line');
    process.exit(1);
  }
  if (match[1] !== aggregate) {
    console.error(`contract-hash: stale (manifest ${match[1]}, current ${aggregate})`);
    process.exit(1);
  }
  console.log(`contract-hash: OK ${aggregate} (${files.length} files)`);
} else {
  writeFileSync(MANIFEST, manifestText(files, aggregate), 'utf8');
  console.log(`contract-hash: wrote contract/CONTRACT.sha256 (${files.length} files, ${aggregate})`);
}
