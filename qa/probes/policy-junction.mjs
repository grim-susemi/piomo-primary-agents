// Failure scenario for todo 5: a real NTFS junction inside `.omo` must not
// become a write escape. Creates <tmp>/.omo/link -> <tmp>/src, then asks the
// policy for a Prometheus write through the link. Expected: blocked.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verdict } from '../../src/core/policy.mjs';

const root = mkdtempSync(join(tmpdir(), 'piomo-t5-junction-'));
const omo = join(root, '.omo');
const src = join(root, 'src');
const link = join(omo, 'link');
const notes = join(omo, 'notes');
const scaffold = join(root, 'scaffold-plan.mjs');
let failed = false;

function check(name, condition, detail) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failed = true;
  console.log(`[${status}] ${name}: ${detail}`);
}

try {
  mkdirSync(notes, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(scaffold, '// scaffold\n', 'utf8');
  symlinkSync(src, link, 'junction');

  const context = {
    agentId: 'prometheus',
    cwdReal: root,
    scaffoldPath: scaffold,
    toolSchemas: {},
  };

  const throughLink = verdict('write', { path: join(link, 'escape.md') }, context);
  check(
    'prometheus write through a junction inside .omo is blocked',
    throughLink.block === true && typeof throughLink.reason === 'string',
    JSON.stringify(throughLink),
  );

  const throughLinkTxt = verdict('write', { path: join(link, 'escape.txt') }, { ...context, agentId: 'atlas' });
  check(
    'atlas write through the same junction is blocked',
    throughLinkTxt.block === true,
    JSON.stringify(throughLinkTxt),
  );

  const control = verdict('write', { path: join(notes, 'ok.md') }, context);
  check(
    'positive control: a normal .omo markdown write is allowed',
    control.allow === true,
    JSON.stringify(control),
  );

  const lexical = verdict('write', { path: join(omo, '..', 'src', 'escape.md') }, context);
  check(
    'positive control: lexical traversal is blocked',
    lexical.block === true,
    JSON.stringify(lexical),
  );

  console.log(`temp root: ${root}`);
  console.log(`verdict: ${failed ? 'FAIL' : 'PASS'}`);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  console.log(`cleanup: temp dir removed=${!existsSync(root)}`);
}

process.exitCode = failed ? 1 : 0;
