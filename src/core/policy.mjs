// Tool policy for the restricted agents. Pure decision logic: the only
// filesystem access is `realpath`/existence probing of the nearest existing
// ancestor, used to refuse symlink and junction escapes.
//
// verdict(toolName, input, {agentId, cwdReal, toolSchemas, scaffoldPath})
//   -> { allow: true } | { block: true, reason }
//
// Prometheus may change only `<cwd>/.omo/**/*.md`, run a small read/plan bash
// allowlist, and delegate only to read-only agents. Atlas may change only
// `<cwd>/.omo/**`; its bash stays open (stated residual). Sisyphus and
// Hephaestus are unrestricted.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { AGENT_IDS } from '../../contract/constants.mjs';

export const READ_ONLY_SUBAGENTS = Object.freeze([
  'explore',
  'librarian',
  'oracle',
  'plan-consultant',
  'plan-reviewer',
]);

export const PROMETHEUS_TASK_CATEGORIES = Object.freeze(['architect', 'ultrabrain']);

export const GIT_READONLY_SUBCOMMANDS = Object.freeze([
  'status',
  'log',
  'show',
  'diff',
  'rev-parse',
  'ls-files',
]);

export const BASH_READONLY_COMMANDS = Object.freeze([
  'ls',
  'rg',
  'grep',
  'cat',
  'head',
  'tail',
  'wc',
  'sha256sum',
  'pwd',
]);

export const SCAFFOLD_ALLOWED_FLAGS = Object.freeze([
  '--clear',
  '--unclear',
  '--draft-only',
  '--review-required',
]);

// Rewriting or discarding plan artifacts is never a planner read.
export const SCAFFOLD_BLOCKED_FLAGS = Object.freeze(['--reset', '--force']);

const SCAFFOLD_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const RUNTIME_EVAL_FLAGS = /^(?:-e|-p|--eval|--print|--import|--require)(?:=|$)/;
const MUTATION_NAME = /write|edit|patch|rewrite|move|delete|rename|create/i;
const PATH_KEY = /^(?:path|paths|file|files|filename|file_?name|file_?path|file_?paths|target|target_?path|source|source_?path|destination|destination_?path|dest|dest_?path|to|from|old_?path|new_?path|move_?from|move_?to)$/i;
const PATH_HINT = /path|file|filename|target|destination|source|dest/i;
const AGENT_SET = new Set(AGENT_IDS);
const GIT_SUBCOMMANDS = new Set(GIT_READONLY_SUBCOMMANDS);
const READONLY_COMMANDS = new Set(BASH_READONLY_COMMANDS);
const SCAFFOLD_FLAGS = new Set(SCAFFOLD_ALLOWED_FLAGS);
const TASK_CATEGORIES = new Set(PROMETHEUS_TASK_CATEGORIES);
const READ_ONLY_AGENTS = new Set(READ_ONLY_SUBAGENTS);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPathKey(key) {
  return PATH_KEY.test(key) || PATH_HINT.test(key);
}

function pathKey(value) {
  const normalized = String(value).replace(/\//g, '\\').replace(/\\+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(child, parent) {
  const childKey = pathKey(child);
  const parentKey = pathKey(parent);
  return childKey === parentKey || childKey.startsWith(`${parentKey}\\`);
}

function reject(reason) {
  return { ok: false, reason };
}

/**
 * Realpath of the nearest ancestor that exists, with the missing tail appended.
 * Returns null when the filesystem refuses to answer (ENOTDIR, EACCES, ...):
 * a policy check that cannot resolve the parent must not allow the write.
 */
export function realpathNearestAncestor(target) {
  let current = resolve(target);
  const missing = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length > 0 ? join(real, ...missing.slice().reverse()) : real;
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Canonicalize a write target and prove it stays inside `<cwdReal>/.omo`.
 * Refuses device paths, UNC paths, drive-relative paths, alternate data
 * streams, sibling prefixes (`.omo-x`) and link escapes.
 *
 * @param {string} target
 * @param {{cwdReal: string, root?: string}} options
 * @returns {{ok: true, path: string, lexical: string} | {ok: false, reason: string}}
 */
export function canonicalizeTarget(target, options = {}) {
  const { cwdReal, root } = options;
  if (typeof target !== 'string' || target.trim().length === 0) {
    return reject('write target is not a non-empty string');
  }
  if (target.includes('\0')) return reject('write target contains a NUL byte');
  if (typeof cwdReal !== 'string' || cwdReal.length === 0) return reject('cwdReal is required');

  const windows = target.replace(/\//g, '\\');
  if (/^\\\\[?.]\\/.test(windows)) return reject(`device path refused: ${target}`);
  if (/^\\\\/.test(windows)) return reject(`UNC path refused: ${target}`);
  if (/^[a-zA-Z]:(?:[^\\]|$)/.test(windows)) return reject(`drive-relative path refused: ${target}`);
  const afterDrive = windows.replace(/^[a-zA-Z]:/, '');
  if (afterDrive.includes(':')) return reject(`alternate data stream refused: ${target}`);

  const rootDir = resolve(root ?? join(cwdReal, '.omo'));
  const lexical = resolve(cwdReal, target);
  if (!isInside(lexical, rootDir)) {
    return reject(`write target is outside ${rootDir}: ${target}`);
  }

  const realTarget = realpathNearestAncestor(lexical);
  const realRoot = realpathNearestAncestor(rootDir);
  if (realTarget === null || realRoot === null) {
    return reject(`cannot resolve the nearest existing ancestor of ${target}`);
  }
  if (!isInside(realTarget, realRoot)) {
    return reject(`write target escapes ${rootDir} through a link: ${target}`);
  }
  return { ok: true, path: realTarget, lexical };
}

function propertiesFrom(info) {
  if (!isPlainObject(info)) return {};
  const candidates = [info.parameters, info.inputSchema, info.schema, info];
  for (const candidate of candidates) {
    if (isPlainObject(candidate?.properties)) return candidate.properties;
  }
  return {};
}

function schemaFor(toolName, toolSchemas) {
  if (!toolSchemas) return null;
  if (toolSchemas instanceof Map) return toolSchemas.get(toolName) ?? null;
  if (Array.isArray(toolSchemas)) {
    return toolSchemas.find(entry => entry?.name === toolName) ?? null;
  }
  if (isPlainObject(toolSchemas)) {
    if (isPlainObject(toolSchemas.properties)) return toolSchemas;
    return toolSchemas[toolName] ?? null;
  }
  return null;
}

function collectValues(value, out) {
  if (typeof value === 'string' && value.length > 0) {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0) out.push(item);
      else if (isPlainObject(item)) {
        for (const [key, nested] of Object.entries(item)) {
          if (isPathKey(key)) collectValues(nested, out);
        }
      }
    }
  } else if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (isPathKey(key)) collectValues(nested, out);
    }
  }
}

function collectInputPaths(input, keys) {
  const out = [];
  if (!isPlainObject(input)) return out;
  const selected = keys ?? Object.keys(input).filter(isPathKey);
  for (const key of selected) {
    if (Object.prototype.hasOwnProperty.call(input, key)) collectValues(input[key], out);
  }
  return [...new Set(out)];
}

function patchText(input) {
  for (const key of ['patch', 'input', 'text']) {
    if (typeof input?.[key] === 'string') return input[key];
  }
  return null;
}

/**
 * Every path a patch can touch. A patch that does not parse cleanly is
 * reported as malformed and is always blocked.
 *
 * @param {string} patch
 * @returns {{ok: true, paths: string[]} | {ok: false, reason: string}}
 */
export function parsePatchTargets(patch) {
  if (typeof patch !== 'string' || patch.trim().length === 0) {
    return { ok: false, reason: 'apply_patch input is empty' };
  }
  const lines = patch.split(/\r?\n/);
  let begun = false;
  let ended = false;
  let inUpdate = false;
  const paths = [];
  for (const raw of lines) {
    if (ended) {
      if (raw.trim().length > 0) return { ok: false, reason: 'apply_patch has content after "*** End Patch"' };
      continue;
    }
    const line = raw.trimEnd();
    if (!line.startsWith('***')) continue;
    if (line === '*** Begin Patch') {
      if (begun) return { ok: false, reason: 'apply_patch has more than one "*** Begin Patch"' };
      begun = true;
      continue;
    }
    if (line === '*** End Patch') {
      if (!begun) return { ok: false, reason: 'apply_patch ends before it begins' };
      ended = true;
      continue;
    }
    if (!begun) return { ok: false, reason: 'apply_patch does not start with "*** Begin Patch"' };
    if (line === '*** End of File') continue;
    const match = /^\*\*\* (Add File|Update File|Delete File|Move to): (.*)$/.exec(line);
    if (!match) return { ok: false, reason: `apply_patch has an unknown directive: ${line}` };
    const [, directive, rawPath] = match;
    const path = rawPath.trim();
    if (path.length === 0) return { ok: false, reason: `apply_patch ${directive} has an empty path` };
    if (directive === 'Move to') {
      if (!inUpdate) return { ok: false, reason: 'apply_patch "*** Move to" is not inside an Update File' };
    } else {
      inUpdate = directive === 'Update File';
    }
    paths.push(path);
  }
  if (!begun) return { ok: false, reason: 'apply_patch does not start with "*** Begin Patch"' };
  if (!ended) return { ok: false, reason: 'apply_patch does not end with "*** End Patch"' };
  if (paths.length === 0) return { ok: false, reason: 'apply_patch names no file' };
  return { ok: true, paths: [...new Set(paths)] };
}

/**
 * Mutation targets for a tool call, or null when the call does not mutate.
 * `malformed` marks a call that claims to mutate but names no verifiable path.
 */
function mutationTargets(toolName, input, toolSchemas) {
  const name = String(toolName ?? '');
  if (name === 'apply_patch') {
    const parsed = parsePatchTargets(patchText(input));
    return parsed.ok ? { paths: parsed.paths } : { paths: [], malformed: parsed.reason };
  }
  if (name === 'ast_grep') {
    const hasRewrite = ['rewrite', 'apply', 'replacement'].some(key => {
      const value = input?.[key];
      return value !== undefined && value !== null && value !== false && value !== '';
    });
    if (!hasRewrite) return null;
    return { paths: collectInputPaths(input) };
  }

  const schema = schemaFor(name, toolSchemas);
  const properties = propertiesFrom(schema);
  const schemaPathKeys = Object.keys(properties).filter(isPathKey);
  const inputPathKeys = isPlainObject(input) ? Object.keys(input).filter(isPathKey) : [];
  const explicit = name === 'edit' || name === 'write';
  // A mutation-named tool with a path-like schema property mutates. When the
  // schema is unavailable, a path-like input key is the same signal, so a
  // missing tool list cannot turn a write into an allow.
  if (!explicit && !(MUTATION_NAME.test(name) && (schemaPathKeys.length > 0 || inputPathKeys.length > 0))) {
    return null;
  }

  const keys = schemaPathKeys.length > 0
    ? schemaPathKeys
    : (inputPathKeys.length > 0 ? inputPathKeys : ['path', 'file_path', 'paths', 'files']);
  return { paths: collectInputPaths(input, keys) };
}

function checkMutationTargets(agentId, paths, context) {
  if (paths.length === 0) {
    return { block: true, reason: `${agentId} mutation has no verifiable path target` };
  }
  for (const target of paths) {
    const canonical = canonicalizeTarget(target, {
      cwdReal: context.cwdReal,
      root: context.root,
    });
    if (!canonical.ok) return { block: true, reason: canonical.reason };
    if (agentId === 'prometheus' && !/\.md$/i.test(canonical.path)) {
      return { block: true, reason: `prometheus may only write .md files: ${target}` };
    }
  }
  return { allow: true };
}

function tokenizeShell(command) {
  const tokens = [];
  let word = '';
  let hasWord = false;
  let quote = null;
  const pushWord = () => {
    if (!hasWord) return;
    tokens.push({ type: 'word', value: word });
    word = '';
    hasWord = false;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      hasWord = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasWord = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      pushWord();
      continue;
    }
    if (char === '&') {
      pushWord();
      if (command[index + 1] === '&') {
        tokens.push({ type: 'operator', value: '&&' });
        index += 1;
      } else {
        tokens.push({ type: 'operator', value: '&' });
      }
      continue;
    }
    if (char === '|') {
      pushWord();
      if (command[index + 1] === '|') {
        tokens.push({ type: 'operator', value: '||' });
        index += 1;
      } else {
        tokens.push({ type: 'operator', value: '|' });
      }
      continue;
    }
    if (char === ';') {
      pushWord();
      tokens.push({ type: 'operator', value: ';' });
      continue;
    }
    if (char === '>') {
      pushWord();
      if (command[index + 1] === '>') {
        tokens.push({ type: 'operator', value: '>>' });
        index += 1;
      } else {
        tokens.push({ type: 'operator', value: '>' });
      }
      continue;
    }
    word += char;
    hasWord = true;
  }
  if (quote) return { error: 'unbalanced quote' };
  pushWord();
  if (tokens.length === 0) return { error: 'empty command' };

  const segments = [[]];
  for (const token of tokens) {
    if (token.type === 'word') {
      segments[segments.length - 1].push(token.value);
      continue;
    }
    if (token.value === '&' || token.value === '>' || token.value === '>>') {
      return { error: `shell operator "${token.value}" is not allowed` };
    }
    segments.push([]);
  }
  return { segments };
}

function sameRealPath(left, right) {
  const leftReal = realpathNearestAncestor(left);
  const rightReal = realpathNearestAncestor(right);
  if (!leftReal || !rightReal) return false;
  return pathKey(leftReal) === pathKey(rightReal);
}

function scaffoldSegmentAllowed(argv, context) {
  if (argv.length < 2) return 'node/bun needs a script path';
  const script = argv[1];
  if (RUNTIME_EVAL_FLAGS.test(script)) return 'runtime flags before the scaffold script are blocked';
  if (!context.scaffoldPath) return 'scaffold script path is not resolved for this session';
  if (!sameRealPath(resolve(context.cwdReal, script), context.scaffoldPath)) {
    return `only the ulw-plan scaffold script may run: ${script}`;
  }
  const slug = argv[2];
  if (typeof slug !== 'string' || !SCAFFOLD_SLUG.test(slug)) {
    return 'scaffold needs exactly one slug';
  }
  for (const flag of argv.slice(3)) {
    if (!SCAFFOLD_FLAGS.has(flag)) return `scaffold flag is not allowed: ${flag}`;
  }
  return null;
}

function segmentAllowed(argv, context) {
  const head = argv[0];
  if (!head) return 'empty command segment';
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    return 'leading VAR=value assignments are not allowed';
  }
  if (head === 'git') {
    const subcommand = argv[1];
    if (!GIT_SUBCOMMANDS.has(subcommand)) return `git subcommand is not read-only: ${subcommand ?? '(none)'}`;
    if (argv.some(argument => argument === '--output' || argument.startsWith('--output='))) {
      return 'git --output is not allowed';
    }
    return null;
  }
  if (head === 'rg') {
    if (argv.some(argument => argument === '--pre' || argument.startsWith('--pre='))) {
      return 'rg --pre is not allowed';
    }
    return null;
  }
  if (READONLY_COMMANDS.has(head)) return null;
  if (head === 'node' || head === 'bun') return scaffoldSegmentAllowed(argv, context);
  return `command is not on the read/plan allowlist: ${head}`;
}

function bashVerdict(input, context) {
  const command = input?.command;
  if (typeof command !== 'string' || command.length === 0) {
    return { block: true, reason: 'bash command is not a non-empty string' };
  }
  if (/[\r\n]/.test(command)) return { block: true, reason: 'newlines are not allowed in a planner command' };
  if (command.includes('$(')) return { block: true, reason: 'command substitution "$(" is not allowed' };
  if (command.includes('`')) return { block: true, reason: 'backtick substitution is not allowed' };
  if (command.includes('<(') || command.includes('>(')) {
    return { block: true, reason: 'process substitution is not allowed' };
  }
  const parsed = tokenizeShell(command);
  if (parsed.error) return { block: true, reason: parsed.error };
  for (const argv of parsed.segments) {
    const reason = segmentAllowed(argv, context);
    if (reason) return { block: true, reason };
  }
  return { allow: true };
}

function taskVerdict(input) {
  if (!isPlainObject(input)) return { block: true, reason: 'task input must be an object' };
  if (Object.prototype.hasOwnProperty.call(input, 'category')) {
    if (!TASK_CATEGORIES.has(input.category)) {
      return { block: true, reason: `prometheus may only delegate to the ulw-plan advisory lanes` };
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'subagent_type')) {
    if (!READ_ONLY_AGENTS.has(input.subagent_type)) {
      return { block: true, reason: `prometheus may only delegate to read-only agents` };
    }
  }
  return { allow: true };
}

/**
 * @param {string} toolName
 * @param {unknown} input
 * @param {{agentId: string, cwdReal: string, toolSchemas?: unknown, scaffoldPath?: string|null, root?: string, parentToolCallId?: string}} context
 * @returns {{allow: true} | {block: true, reason: string}}
 */
export function verdict(toolName, input, context = {}) {
  const { agentId } = context;
  if (!AGENT_SET.has(agentId)) {
    return { block: true, reason: `unknown agent id "${String(agentId)}"` };
  }
  // Nested calls (parentToolCallId) are not exempt: they run this same check.
  if (agentId === 'sisyphus' || agentId === 'hephaestus') return { allow: true };

  const name = String(toolName ?? '');
  if (agentId === 'prometheus') {
    if (name === 'workflow') return { block: true, reason: 'prometheus may not start a workflow' };
    if (name === 'task') return taskVerdict(input);
    if (name === 'bash') return bashVerdict(input, context);
  }
  if (agentId === 'atlas' && name === 'bash') return { allow: true };

  const mutation = mutationTargets(name, input, context.toolSchemas);
  if (mutation) return checkMutationTargets(agentId, mutation.paths, context);
  return { allow: true };
}
