import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeTarget,
  parsePatchTargets,
  verdict,
} from '../src/core/policy.mjs';

let root;
let scaffold;
let otherScript;
let junctionTarget;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'piomo-policy-'));
  mkdirSync(join(root, '.omo', 'plans'), { recursive: true });
  mkdirSync(join(root, '.omo', 'drafts'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  scaffold = join(root, 'tools', 'scaffold-plan.mjs');
  otherScript = join(root, 'tools', 'other.mjs');
  writeFileSync(scaffold, '// scaffold\n', 'utf8');
  writeFileSync(otherScript, '// other\n', 'utf8');
  junctionTarget = join(root, '.omo', 'link');
  symlinkSync(join(root, 'src'), junctionTarget, 'junction');
});

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function context(agentId, extra = {}) {
  return {
    agentId,
    cwdReal: root,
    scaffoldPath: scaffold,
    toolSchemas: {},
    ...extra,
  };
}

function allowed(toolName, input, agentId, extra) {
  const result = verdict(toolName, input, context(agentId, extra));
  assert.equal(result.block, undefined, `${toolName} should be allowed: ${result.reason ?? ''}`);
  assert.equal(result.allow, true);
}

function blocked(toolName, input, agentId, extra) {
  const result = verdict(toolName, input, context(agentId, extra));
  assert.equal(result.allow, undefined, `${toolName} should be blocked`);
  assert.equal(result.block, true);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
}

test('policy: sisyphus and hephaestus allow every tool', () => {
  for (const agentId of ['sisyphus', 'hephaestus']) {
    allowed('write', { path: join(root, 'src', 'app.js') }, agentId);
    allowed('bash', { command: 'rm -rf src && echo x > out' }, agentId);
    allowed('task', { category: 'quick', subagent_type: 'general' }, agentId);
    allowed('workflow', { name: 'anything' }, agentId);
  }
});

test('policy: prometheus write allows .omo markdown', () => {
  allowed('write', { path: join(root, '.omo', 'plans', 'plan.md') }, 'prometheus');
  allowed('write', { path: '.omo/plans/relative.md' }, 'prometheus');
  allowed('write', { path: join(root, '.omo', 'drafts', 'draft.MD') }, 'prometheus');
});

test('policy: prometheus write blocks non-markdown and non-.omo targets', () => {
  blocked('write', { path: join(root, '.omo', 'plans', 'plan.txt') }, 'prometheus');
  blocked('write', { path: join(root, 'src', 'app.md') }, 'prometheus');
  blocked('write', { path: 'src/app.js' }, 'prometheus');
  blocked('write', { path: '' }, 'prometheus');
});

test('policy: atlas write allows any .omo target and blocks the rest', () => {
  allowed('write', { path: join(root, '.omo', 'notes', 'data.json') }, 'atlas');
  blocked('write', { path: join(root, 'src', 'data.json') }, 'atlas');
});

test('policy: prometheus edit is checked like write', () => {
  allowed('edit', {
    path: join(root, '.omo', 'plans', 'plan.md'),
    edits: [{ oldText: 'a', newText: 'b' }],
  }, 'prometheus');
  blocked('edit', {
    path: join(root, 'src', 'app.js'),
    edits: [{ oldText: 'a', newText: 'b' }],
  }, 'prometheus');
});

test('policy: device paths are refused', () => {
  blocked('write', { path: '\\\\?\\C:\\tmp\\.omo\\x.md' }, 'prometheus');
  blocked('write', { path: '\\\\.\\pipe\\x.md' }, 'prometheus');
});

test('policy: UNC paths are refused', () => {
  blocked('write', { path: '\\\\server\\share\\.omo\\x.md' }, 'prometheus');
  blocked('write', { path: '//server/share/.omo/x.md' }, 'prometheus');
});

test('policy: drive-relative paths are refused', () => {
  blocked('write', { path: 'C:foo.md' }, 'prometheus');
  blocked('write', { path: 'C:' }, 'prometheus');
});

test('policy: alternate data streams are refused', () => {
  blocked('write', { path: `${join(root, '.omo', 'x.md')}:stream` }, 'prometheus');
});

test('policy: sibling prefixes are refused', () => {
  blocked('write', { path: join(root, '.omo-x', 'x.md') }, 'prometheus');
  blocked('write', { path: join(root, '.omo2', 'x.md') }, 'prometheus');
});

test('policy: traversal out of .omo is refused', () => {
  blocked('write', { path: join(root, '.omo', '..', 'src', 'x.md') }, 'prometheus');
  blocked('write', { path: '.omo/../../escape.md' }, 'prometheus');
});

test('policy: a real junction escape is refused', () => {
  blocked('write', { path: join(junctionTarget, 'escape.md') }, 'prometheus');
  blocked('write', { path: join(junctionTarget, 'escape.txt') }, 'atlas');
});

test('policy: canonicalizeTarget reports the containment decision', () => {
  const inside = canonicalizeTarget(join(root, '.omo', 'plans', 'a.md'), { cwdReal: root });
  assert.equal(inside.ok, true);
  const outside = canonicalizeTarget(join(root, 'src', 'a.md'), { cwdReal: root });
  assert.equal(outside.ok, false);
});

test('policy: apply_patch checks every target in a multi-file patch', () => {
  const good = [
    '*** Begin Patch',
    '*** Add File: .omo/plans/a.md',
    '+a',
    '*** Update File: .omo/drafts/b.md',
    '@@',
    '-old',
    '+new',
    '*** Move to: .omo/drafts/c.md',
    '*** Delete File: .omo/drafts/d.md',
    '*** End Patch',
  ].join('\n');
  allowed('apply_patch', { input: good }, 'prometheus');

  const oneBadPath = [
    '*** Begin Patch',
    '*** Add File: .omo/plans/a.md',
    '+a',
    '*** Add File: src/evil.md',
    '+b',
    '*** End Patch',
  ].join('\n');
  blocked('apply_patch', { input: oneBadPath }, 'prometheus');

  const traversal = [
    '*** Begin Patch',
    '*** Update File: .omo/../src/evil.md',
    '@@',
    '-a',
    '+b',
    '*** End Patch',
  ].join('\n');
  blocked('apply_patch', { input: traversal }, 'prometheus');
});

test('policy: malformed apply_patch is blocked', () => {
  const cases = [
    '*** Begin Patch\n*** Add File: .omo/plans/a.md\n+a\n',
    '*** Begin Patch\n*** Add File: \n+a\n*** End Patch',
    '*** Begin Patch\n*** Rename File: .omo/a.md\n*** End Patch',
    '*** Begin Patch\n*** Move to: .omo/a.md\n*** End Patch',
    '*** Add File: .omo/a.md\n+a\n*** End Patch',
    '*** Begin Patch\n*** End Patch',
    '',
  ];
  for (const patch of cases) {
    blocked('apply_patch', { input: patch }, 'prometheus');
  }
  assert.equal(parsePatchTargets(cases[0]).ok, false);
});

test('policy: ast_grep rewrite is a mutation, plain search is not', () => {
  allowed('ast_grep', {
    pattern: 'x', paths: ['.omo/plans/a.md'], rewrite: 'y',
  }, 'prometheus');
  blocked('ast_grep', {
    pattern: 'x', paths: ['src/a.ts'], rewrite: 'y',
  }, 'prometheus');
  allowed('ast_grep', {
    pattern: 'x', paths: ['src/a.ts'],
  }, 'prometheus');
});

test('policy: a mutation-named tool with a path schema is checked', () => {
  const toolSchemas = new Map([
    ['create_thing', {
      name: 'create_thing',
      parameters: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' } } },
    }],
    ['move_thing', {
      name: 'move_thing',
      parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
    }],
    ['search_thing', {
      name: 'search_thing',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    }],
  ]);
  allowed('create_thing', { path: '.omo/plans/a.md', name: 'a' }, 'prometheus', { toolSchemas });
  blocked('create_thing', { path: 'src/a.md', name: 'a' }, 'prometheus', { toolSchemas });
  blocked('move_thing', { from: '.omo/plans/a.md', to: 'src/a.md' }, 'prometheus', { toolSchemas });
  allowed('search_thing', { query: 'src/a.md' }, 'prometheus', { toolSchemas });
  allowed('create_goal', { objective: 'do the thing' }, 'prometheus', { toolSchemas: [] });
});

test('policy: a mutation-named tool with a path input is checked without a schema', () => {
  blocked('write_file', { file_path: 'src/app.js' }, 'prometheus');
  allowed('write_file', { file_path: '.omo/plans/a.md' }, 'prometheus');
});

test('policy: nested calls are checked exactly like top-level calls', () => {
  blocked('write', {
    path: join(root, 'src', 'nested.js'),
    parentToolCallId: 'call-1',
  }, 'prometheus');
  blocked('edit', {
    path: join(root, 'src', 'nested.js'),
    parentToolCallId: 'call-1/0',
  }, 'prometheus');
  blocked('write', { path: join(root, 'src', 'nested.js') }, 'prometheus', {
    parentToolCallId: 'call-1',
  });
  allowed('write', {
    path: join(root, '.omo', 'plans', 'nested.md'),
    parentToolCallId: 'call-1',
  }, 'prometheus');
});

test('policy: prometheus bash allows the read/plan table', async t => {
  const commands = [
    'git status',
    'git log --oneline -5',
    'git show HEAD',
    'git diff --stat',
    'git rev-parse HEAD',
    'git ls-files .omo',
    'ls .omo/plans',
    'rg --line-number foo .omo',
    'grep -n foo .omo/plans/a.md',
    'cat .omo/plans/a.md',
    'head -20 .omo/plans/a.md',
    'tail -5 .omo/plans/a.md',
    'wc -l .omo/plans/a.md',
    'sha256sum .omo/plans/a.md',
    'pwd',
    'cat a.md | wc -l',
    'git status && ls .omo',
    'rg "a|b" .omo',
  ];
  for (const command of commands) {
    await t.test(`allows ${command}`, () => allowed('bash', { command }, 'prometheus'));
  }
});

test('policy: prometheus bash blocks every escape form', async t => {
  const cases = [
    ['command substitution $(...)', 'echo $(pwd)'],
    ['backtick substitution', 'echo `pwd`'],
    ['process substitution <(...)', 'cat <(ls)'],
    ['process substitution >(...)', 'cat >(tee out)'],
    ['embedded newline', 'cat a\ncat b'],
    ['lone ampersand', 'cat a & cat b'],
    ['lone ampersand after &&', 'cat a && cat b & cat c'],
    ['leading VAR=x assignment', 'VAR=x cat a'],
    ['rg --pre', 'rg --pre cat foo'],
    ['rg --pre=...', 'rg --pre=cat foo'],
    ['git -c before the subcommand', 'git -c x=y status'],
    ['git --output=...', 'git diff --output=out'],
    ['git --output ...', 'git diff --output out'],
    ['node -e before the scaffold', 'node -e "console.log(1)" scaffold-plan.mjs demo'],
    ['node -p before the scaffold', 'node -p 1 scaffold-plan.mjs demo'],
    ['output redirection >', 'cat a > out'],
    ['output redirection >>', 'cat a >> out'],
    ['command outside the allowlist', 'rm -rf src'],
    ['git write subcommand', 'git push'],
    ['unlisted read command', 'echo hi'],
    ['chained write command', 'ls; rm -rf src'],
    ['chained git push', 'ls && git push'],
  ];
  for (const [name, command] of cases) {
    await t.test(`blocks ${name}`, () => blocked('bash', { command }, 'prometheus'));
  }
});

test('policy: prometheus bash allows the exact ulw-plan scaffold invocations', () => {
  allowed('bash', {
    command: `node "${scaffold}" demo --clear --draft-only --review-required`,
  }, 'prometheus');
  allowed('bash', {
    command: `node "${scaffold}" demo --unclear --review-required`,
  }, 'prometheus');
  allowed('bash', {
    command: `bun "${scaffold}" demo --clear --draft-only`,
  }, 'prometheus');
  blocked('bash', {
    command: `node "${scaffold}" demo --reset --force`,
  }, 'prometheus');
  blocked('bash', {
    command: `node "${scaffold}" demo --force`,
  }, 'prometheus');
  blocked('bash', {
    command: `node "${otherScript}" demo --clear`,
  }, 'prometheus');
  blocked('bash', {
    command: `node "${scaffold}"`,
  }, 'prometheus');
  blocked('bash', {
    command: `node "${scaffold}" demo extra`,
  }, 'prometheus');
});

test('policy: prometheus task delegates only to advisory lanes and read-only agents', () => {
  allowed('task', { category: 'architect', prompt: 'review' }, 'prometheus');
  allowed('task', { category: 'ultrabrain', prompt: 'review' }, 'prometheus');
  blocked('task', { category: 'quick', prompt: 'review' }, 'prometheus');
  blocked('task', { category: 'deep', prompt: 'review' }, 'prometheus');
  allowed('task', { subagent_type: 'explore', prompt: 'read' }, 'prometheus');
  allowed('task', { subagent_type: 'plan-consultant', prompt: 'read' }, 'prometheus');
  blocked('task', { subagent_type: 'general', prompt: 'write' }, 'prometheus');
  blocked('task', { subagent_type: 'hephaestus', prompt: 'write' }, 'prometheus');
  allowed('task', { prompt: 'no routing fields' }, 'prometheus');
});

test('policy: prometheus workflow is blocked', () => {
  blocked('workflow', { name: 'mass-ulw' }, 'prometheus');
});

test('policy: atlas keeps bash and delegation open', () => {
  allowed('bash', { command: 'rm -rf src && echo hi > out' }, 'atlas');
  allowed('task', { subagent_type: 'hephaestus', category: 'quick' }, 'atlas');
  allowed('workflow', { name: 'mass-ulw' }, 'atlas');
});

test('policy: unknown agents are blocked', () => {
  blocked('read', { path: 'a.md' }, 'nobody');
  blocked('bash', { command: 'ls' }, undefined);
});
