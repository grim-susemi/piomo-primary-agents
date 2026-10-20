// Static runtime probes P8, P10 and P11. All reads are read-only; no live file
// is written and no real omo-task.js is edited.
// Usage: node qa/probes/static-probes.mjs --out <evidence dir>
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PROBE_DIR, runHeadlessProbe, summarizeRun, writeJson } from './lib.mjs';
import { PLUGIN } from '../harness.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) {
  console.error('usage: node qa/probes/static-probes.mjs --out <evidence dir>');
  process.exit(2);
}
const OUT = values.out;
const RAW = join(OUT, 'probe-raw');
mkdirSync(RAW, { recursive: true });

const LIVEHOME = 'C:/Users/USER/.omo-stable-500/home/.omo';
const GLOBAL_TASK = 'C:/Users/USER/.bun/install/global/node_modules/omo-ai/plugin/extensions/omo-task.js';
const PLUGIN_TASK = join(PLUGIN, 'extensions', 'omo-task.js');
const HERDR_EXTENSION = 'C:/Users/USER/orca/projects/herdr-agent-sidebar-diagnosis/repair/herdr-senpi.mjs';
const results = {};

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeRaw(name, text) {
  const path = join(RAW, name);
  writeFileSync(path, text, 'utf8');
  return path;
}

// ---------------------------------------------------------------- P8
function p8() {
  const omo = readFileSync(join(PLUGIN, 'extensions', 'omo.js'), 'utf8').replaceAll("\r\n", "\n");
  const snippets = [];
  for (const needle of ['Bc=ed(ll(),qc)', 'Wc=ed(ll(),Uc)', 'var Ld=', 'var zc=']) {
    const index = omo.indexOf(needle);
    if (index < 0) continue;
    snippets.push(`/* ${needle} @${index} */\n${omo.slice(Math.max(0, index - 500), index + 1400)}\n`);
  }
  const raw = writeRaw('p8-schema.txt', snippets.join('\n'));
  results.P8 = {
    verdict: snippets.length === 4 ? 'PASS' : 'FAIL',
    decision: 'todo 4 emits [native].model_profiles lane overrides as { <laneId>: { display_name?, family?: "daily"|"geeky", tier?: "normal"|"heavy", models?: Array<string | {model, variant?, reasoning?, temperature?, top_p?, max_tokens?, provider_options?, reasoningEffort?, thinking?, textVerbosity?, maxTokens?, providerOptions?}> } }; the parser accepts a partial lane at [native].model_profiles and a full lane at root model_profiles',
    raw,
    schema: {
      root: 'Bc = record(laneId -> full lane zc)',
      nativeOverride: 'Wc = record(laneId -> partial lane zc.partial())',
      lane: {
        display_name: 'string?',
        family: '"daily" | "geeky"?',
        tier: '"normal" | "heavy"?',
        models: 'Array<string | rung>?',
      },
      rung: {
        model: 'string (required)',
        reasoning: 'optional',
        temperature: 'number 0..2?',
        top_p: 'number 0..1?',
        max_tokens: 'positive int?',
        provider_options: 'record<string, unknown>?',
        variant: 'string?',
        reasoningEffort: 'optional',
        thinking: 'optional',
        textVerbosity: '"low" | "medium" | "high"?',
        maxTokens: 'number?',
        providerOptions: 'record<string, unknown>?',
      },
      note: 'The native schema (Wc) is the partial-lane override form; a root model_profiles entry (Bc) is a complete lane.',
    },
  };
}

async function p8NativeAcceptance() {
  const probe = join(PROBE_DIR, 'p2-preview.mjs');
  const log = join(RAW, 'p8-native.log');
  writeFileSync(log, '', 'utf8');
  const run = await runHeadlessProbe({
    prompt: 'P8 native lane override probe',
    extensions: [probe],
    extraEnv: { PIOMO_P2_LOG: log },
    omoConfig: {
      '[native]': {
        model_profiles: {
          'daily-normal': {
            display_name: 'P8 native override',
            models: [{ model: 'qa-mock/gpt-mock-sol', variant: 'medium' }],
          },
        },
      },
    },
    steps: [{ text: 'P8 answer' }],
  });
  const summary = summarizeRun(run.run);
  const validationNoise = /model_profiles[^\n]*(invalid|error|expected|unrecognized)|invalid configuration/i.test(
    `${summary.stdout}\n${summary.stderr}`,
  );
  results.P8.nativeAcceptance = {
    exitCode: summary.exitCode,
    timedOut: summary.timedOut,
    pidGone: summary.pidGone,
    validationNoise,
    stderrTail: summary.stderr.slice(-1200),
    temp: { agentDir: run.sandbox.agentDir, home: run.sandbox.home, stateDir: run.sandbox.stateDir },
    verdict: summary.exitCode === 0 && !summary.timedOut && !validationNoise ? 'accepted' : 'rejected',
  };
}

// ---------------------------------------------------------------- P10
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/i.test(entry.name)) out.push(path);
  }
  return out;
}

function packageExtensions(packageDir) {
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) return [];
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const entries = manifest?.pi?.extensions;
    if (Array.isArray(entries) && entries.length > 0) {
      return entries.map(entry => resolve(packageDir, entry));
    }
  } catch {
    return [];
  }
  return [];
}

function p10() {
  const settingsPath = join(LIVEHOME, 'agent', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const files = new Set();
  for (const extension of settings.extensions ?? []) {
    files.add(resolve(extension));
  }
  for (const packageDir of settings.packages ?? []) {
    const resolved = resolve(packageDir);
    const entries = packageExtensions(resolved);
    if (entries.length > 0) entries.forEach(entry => files.add(entry));
    else walk(join(resolved, 'extensions')).forEach(entry => files.add(entry));
  }
  walk(join(LIVEHOME, 'agent', 'extensions')).forEach(entry => files.add(entry));
  for (const entry of readdirSync(join(PLUGIN, 'extensions'))) {
    if (entry.endsWith('.js')) files.add(join(PLUGIN, 'extensions', entry));
  }
  files.add(HERDR_EXTENSION);

  const tokens = ['setTitle', 'setEditorComponent', 'belowEditor', 'setWidget'];
  const rows = [];
  for (const file of [...files].sort()) {
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const text = readFileSync(file, 'utf8');
    const counts = Object.fromEntries(tokens.map(token => [
      token,
      text.split(token).length - 1,
    ]));
    rows.push({ file: file.replaceAll('\\', '/'), bytes: text.length, counts });
  }
  const owners = Object.fromEntries(tokens.map(token => [
    token,
    rows.filter(row => row.counts[token] > 0).map(row => row.file),
  ]));
  const listPath = join(OUT, 'task-2-piomo-primary-agents-p10-loaded-extensions.json');
  writeJson(listPath, {
    generatedAt: new Date().toISOString(),
    liveSettings: settingsPath,
    extensionCount: rows.length,
    owners,
    files: rows,
  });
  writeRaw('p10-grep.txt', rows.map(row =>
    `${row.file}\n  setTitle=${row.counts.setTitle} setEditorComponent=${row.counts.setEditorComponent} `
    + `belowEditor=${row.counts.belowEditor} setWidget=${row.counts.setWidget}`).join('\n') + '\n');
  results.P10 = {
    verdict: rows.length > 0 ? 'PASS' : 'FAIL',
    decision: owners.setTitle.length === 0
      ? 'todo 8 may call setTitle: no other loaded extension calls it'
      : `todo 8 must not call setTitle: already used by ${owners.setTitle.join(', ')}`,
    listPath,
    extensionCount: rows.length,
    owners,
  };
}

// ---------------------------------------------------------------- P11
function p11() {
  const anchorSource = 'if\\((\\w+)\\.startsWith\\("\\/skill:"\\)\\)\\{let (\\w+)=\\1\\.indexOf\\(" "\\),(\\w+)=\\(-1===\\2\\?\\1\\.slice\\(7\\):\\1\\.slice\\(7,\\2\\)\\)\\.trim\\(\\);return (\\w+)\\((\\w+),(\\w+),\\3\\),void \\4\\((\\w+),\\6,\\3\\)\\}';
  const anchor = new RegExp(anchorSource, 'g');
  const files = [PLUGIN_TASK, GLOBAL_TASK].map(path => {
    const text = readFileSync(path, 'utf8');
    const matches = [...text.matchAll(new RegExp(anchorSource, 'g'))];
    return {
      path: path.replaceAll('\\', '/'),
      sha256: sha256(path),
      bytes: Buffer.byteLength(text),
      matchCount: matches.length,
      captures: matches[0] ? {
        textVar: matches[0][1],
        indexVar: matches[0][2],
        skillVar: matches[0][3],
        markFn: matches[0][4],
        invokedMap: matches[0][5],
        sessionVar: matches[0][6],
        requestedMap: matches[0][7],
      } : null,
      startsWithCoordPrefix: text.startsWith('var __coordNative'),
      startsWithCoordPrefixAfterWhitespace: text.trimStart().startsWith('var __coordNative'),
      firstLine: text.split(/\r?\n/).find(line => line.trim().length > 0)?.slice(0, 80) ?? null,
    };
  });
  // The stable-500 profile loads the plugin directory handed to the Senpi CLI.
  const launcher = readFileSync('C:/Users/USER/.omo-stable-500/omo.cmd', 'utf8');
  const pluginLine = /set "OMO_STABLE_PLUGIN=([^"]+)"/.exec(launcher)?.[1] ?? null;
  const extensionLine = /--extension "%OMO_STABLE_PLUGIN%"/.test(launcher);
  const nativeSettingsPath = join(LIVEHOME, 'agent', 'settings.json');
  const nativeSettings = JSON.parse(readFileSync(nativeSettingsPath, 'utf8'));
  const evidence = {
    anchorSource,
    files,
    stable500: {
      launcher: 'C:/Users/USER/.omo-stable-500/omo.cmd',
      pluginVariable: pluginLine,
      passesPluginToExtension: extensionLine,
      loadedFile: PLUGIN_TASK.replaceAll('\\', '/'),
      settingsPackages: nativeSettings.packages ?? [],
      settingsExtensions: nativeSettings.extensions ?? [],
    },
  };
  writeRaw('p11.json', `${JSON.stringify(evidence, null, 2)}\n`);
  results.P11 = {
    verdict: files.every(file => file.matchCount === 1) ? 'PASS' : 'FAIL',
    decision: files.every(file => file.matchCount === 1)
      ? 'anchor regex for todo 17 matches exactly once per file; the stable-500 profile loads the PLUGIN copy'
      : 'anchor regex is not exactly one match per file; todo 17 must not guess',
    ...evidence,
  };
}

try {
  p8();
  await p8NativeAcceptance();
  writeJson(join(RAW, 'p8-result.json'), results.P8);
  p10();
  p11();
  writeJson(join(RAW, 'static-results.json'), results);
  for (const [name, result] of Object.entries(results)) {
    console.log(`${name}: ${result.verdict} - ${result.decision}`);
  }
} catch (error) {
  writeJson(join(RAW, 'static-results.json'), { ...results, error: String(error?.stack ?? error) });
  throw error;
}
