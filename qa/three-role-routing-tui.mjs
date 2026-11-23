// Three-role routing candidate proof: load the candidate extension beside the
// Native extensions in an isolated Herdr TUI, observe the /ulw-execute routing,
// then exercise the plan-handoff gate: full read -> first delegation, Boulder
// selection, and a plan swap after the read (must block the delegation).
//
// The candidate bytes are intentionally identical to the installed 5.1.81
// package, so this is a load/routing proof, not a version-difference comparison.
//
// Usage:
//   node qa/three-role-routing-tui.mjs --native-task <omo-task.js> \
//     --native-skills <plugin/skills> --candidate dist/extension.js \
//     --case all --out <evidence dir>
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PLUGIN, SEEDED_MODEL_PROFILES } from './harness.mjs';
import { createTuiSandbox, MOCK_EXTENSION } from './probes/tui-lib.mjs';
import {
  expect, readText, sendKeys, sendText, sessionEntries, startMock, waitOutput,
  waitRestartReady, withTuiScenario,
} from './scenarios/lib.mjs';

const CASES = ['route', 'invalid', 'delegate', 'boulder', 'read-dominance'];
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function planText({ lead, rationale = '저장 복구 집중 검증' }) {
  return [
    '# three-role routing fixture',
    '',
    '## TL;DR',
    '- candidate load/routing proof only.',
    `Execution lead: ${lead}`,
    `Execution rationale: ${rationale}`,
    '',
    '## Background',
    '- Isolated QA fixture; no production plan bytes are used.',
    '',
  ].join('\n');
}

function findReceipt(skills) {
  const candidates = [
    join(skills, '.rebuilt-receipt.json'),
    join(skills, '..', '.rebuilt-receipt.json'),
    join(skills, '..', '..', '.rebuilt-receipt.json'),
    join(skills, '..', '..', '..', '.rebuilt-receipt.json'),
    join(skills, '..', '..', '..', '..', '.rebuilt-receipt.json'),
    join(skills, '..', '..', '..', '..', '..', '.rebuilt-receipt.json'),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

function labelLine(pane) {
  return readText(pane).split(/\r?\n/).filter((line) => line.includes('▌')).at(-1) ?? '';
}

// One submission only. The scenario submitText retry path is intentionally not
// used: it sends the command again after the extension clears the editor, and
// the second submit hits SUBMIT_LOCKED_NOTICE. The caller waits for the
// restart-ready/startup-settled gate before this function.
const SCRIPT_LINES = readFileSync(new URL(import.meta.url), 'utf8').split(/\r?\n/);
const scriptLine = (needle) => SCRIPT_LINES.findIndex((line) => line.includes(needle)) + 1;

async function submitOnce(pane, text) {
  const echoed = waitOutput(pane, text, { timeout: 5000, source: 'visible' })
    .catch(() => ({ code: 1 }));
  sendText(pane, text);
  await echoed;
  if (String(text).trimStart().startsWith('/')) sendKeys(pane, 'escape');
  sendKeys(pane, 'enter');
}

function identities(entries) {
  return entries.filter((entry) => entry?.type === 'custom'
    && entry.customType === 'primary-agent/v1');
}

function hasToolCall(entry, name) {
  const message = entry?.type === 'message' ? entry.message : null;
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.content.some((part) => part?.type === 'toolCall'
    && (part.toolName === name || part.name === name));
}

function hasToolResult(entry, name) {
  const message = entry?.type === 'message' ? entry.message : null;
  return Boolean(message && message.role === 'toolResult' && message.toolName === name);
}

function toolCallPart(entry, name) {
  const message = entry?.type === 'message' ? entry.message : null;
  if (!message || !Array.isArray(message.content)) return null;
  return message.content.find((part) => part?.type === 'toolCall'
    && (part.toolName === name || part.name === name)) ?? null;
}

function toolResultMessage(entry, name) {
  const message = entry?.type === 'message' ? entry.message : null;
  return message && message.role === 'toolResult' && message.toolName === name ? message : null;
}

function resultText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

// Event-driven wait on the session JSONL; no fixed sleep or polling delay.
function waitForSession(file, predicate, timeout = 120000) {
  return new Promise((resolveEntry, reject) => {
    let settled = false;
    let watcher;
    const finish = (error, entry) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
      error ? reject(error) : resolveEntry(entry);
    };
    const inspect = () => {
      try {
        const hit = sessionEntries(file).find(predicate);
        if (hit) finish(null, hit);
      } catch (error) {
        finish(error);
      }
    };
    const timer = setTimeout(() => finish(new Error(`timeout waiting for session event: ${file}`)), timeout);
    try { watcher = watch(dirname(file), inspect); } catch { /* file may not exist yet */ }
    inspect();
  });
}

function writeLoadedNative({
  out, name, record, scenario, candidate, nativeTask, nativeSkills, planPath,
  readEntry, taskCall, taskResult, boulder, extra = {},
}) {
  const loaded = {
    schema: 'piomo.three-role.loaded-native.v1',
    case: name,
    pane: record.pane,
    sessionFile: scenario.sessionFile,
    command: scenario.command,
    candidate: { path: candidate, sha256: sha(candidate) },
    nativeTask: { path: nativeTask, sha256: sha(nativeTask) },
    plugin: { path: PLUGIN },
    extensions: [MOCK_EXTENSION, nativeTask, candidate],
    skills: {
      ulwPlan: {
        loadedPath: join(scenario.agentDir, 'skills', 'ulw-plan', 'SKILL.md'),
        sourcePath: join(nativeSkills, 'ulw-plan', 'SKILL.md'),
        sha256: sha(join(nativeSkills, 'ulw-plan', 'SKILL.md')),
      },
      ulwExecute: {
        loadedPath: join(scenario.agentDir, 'skills', 'ulw-execute', 'SKILL.md'),
        sourcePath: join(nativeSkills, 'ulw-execute', 'SKILL.md'),
        sha256: sha(join(nativeSkills, 'ulw-execute', 'SKILL.md')),
      },
    },
    plan: { path: planPath, sha256: sha(planPath) },
    read: readEntry ? {
      toolCallId: readEntry.message?.toolCallId ?? null,
      textLength: resultText(readEntry.message).length,
      isError: readEntry.message?.isError === true,
    } : null,
    task: taskCall ? {
      toolCallId: taskCall.toolCallId ?? taskCall.id ?? null,
      toolName: taskCall.toolName ?? taskCall.name ?? null,
      input: taskCall.input ?? taskCall.arguments ?? null,
      resultText: taskResult ? resultText(taskResult.message) : null,
      isError: taskResult ? taskResult.message?.isError === true : null,
    } : null,
    boulder: boulder ?? null,
    ...extra,
  };
  writeJson(join(out, `loaded-native-${name}.json`), loaded);
  if (name === 'delegate') writeJson(join(out, 'loaded-native.json'), loaded);
  return join(out, `loaded-native-${name}.json`);
}

async function runCase({ name, out, nativeTask, nativeSkills, candidate }) {
  const state = {
    planPath: null,
    planBody: null,
    changed: false,
  };
  const mock = await startMock({
    route: (body, count) => {
      if (name === 'route' || name === 'invalid') {
        return { text: 'QA mock response.' };
      }
      if (count === 1) {
        return {
          tool: 'read',
          arguments: { path: state.planPath, offset: 1, limit: 2000 },
        };
      }
      if (count === 2) {
        const step = {
          tool: 'task',
          arguments: {
            category: 'deep-low',
            prompt: 'QA first delegation: reply with one short line.',
            description: 'QA first delegation',
          },
        };
        if (name === 'read-dominance') {
          step.onStart = () => {
            state.changed = true;
            writeFileSync(state.planPath, `${state.planBody}\nchanged by QA after read\n`, 'utf8');
          };
        }
        return step;
      }
      return { text: 'QA child done.' };
    },
  });
  const tui = createTuiSandbox({
    name: `three-role-${name}`,
    pluginPath: PLUGIN,
    extensions: [MOCK_EXTENSION, nativeTask, candidate],
    omoConfig: {
      model_profiles: SEEDED_MODEL_PROFILES,
      categories: { 'deep-low': { model: 'qa-mock/gpt-mock-fast' } },
    },
    settings: { quietStartup: false },
    model: 'claude-mock-medium',
    thinking: 'off',
    mockUrl: mock.baseUrl,
    omoFlags: true,
  });
  cpSync(nativeSkills, join(tui.sandbox.agentDir, 'skills'), { recursive: true, force: true });
  mkdirSync(join(tui.sandbox.workDir, '.omo', 'plans'), { recursive: true });
  const slug = name === 'invalid' ? 'lead-invalid' : 'lead-hephaestus';
  const planPath = join(tui.sandbox.workDir, '.omo', 'plans', `${slug}.md`);
  const planBody = planText({ lead: name === 'invalid' ? 'atlas' : 'hephaestus' });
  writeFileSync(planPath, planBody, 'utf8');
  state.planPath = planPath;
  state.planBody = planBody;
  const scenario = {
    ...tui,
    workDir: tui.sandbox.workDir,
    agentDir: tui.sandbox.agentDir,
    home: tui.sandbox.home,
    stateDir: tui.sandbox.stateDir,
    sessionFile: tui.sandbox.sessionFile,
    sandbox: tui.sandbox,
  };
  let record;
  try {
    record = await withTuiScenario({
      name: `three-role-${name}`,
      out,
      evidenceName: `three-role-${name}`,
      scenario,
      mock,
      label: `PiOMO three-role ${name}`,
      body: async (pane, result) => {
        // Startup gate: wait for the host's own startup scan and repainted
        // footer before typing. This is the finite settle wait; no retry path.
        await waitRestartReady(pane, scenario.sessionFile, { timeout: 60000 });
        const ready = await waitOutput(pane, '▌ Sisyphus', { timeout: 60000 });
        expect(ready.code === 0, 'Sisyphus label did not paint');
        result.checks.initial = labelLine(pane);

        let boulder = null;
        if (name === 'boulder') {
          const session = sessionEntries(scenario.sessionFile).find((entry) => entry?.type === 'session');
          expect(session?.id, 'session id missing for Boulder fixture');
          boulder = { workId: 'qa-boulder', planName: slug, sessionId: session.id };
          writeJson(join(scenario.workDir, '.omo', 'boulder.json'), {
            works: {
              [boulder.workId]: {
                status: 'active',
                plan_name: slug,
                session_ids: [`senpi:${session.id}`],
              },
            },
          });
        }

        const command = name === 'boulder' ? '/ulw-execute' : `/ulw-execute ${slug}`;
        await submitOnce(pane, command);

        if (name === 'invalid') {
          const notice = await waitOutput(pane, '실행 책임자 선언이 무효', { timeout: 30000 });
          expect(notice.code === 0, 'invalid-lead notice did not paint');
          const label = labelLine(pane);
          const entries = sessionEntries(scenario.sessionFile);
          const heph = identities(entries).filter((entry) => entry.data?.agentId === 'hephaestus');
          expect(label.includes('Sisyphus'), `invalid lead changed the role: ${label}`);
          expect(heph.length === 0, 'invalid lead created a hephaestus identity');
          result.checks.invalid = { label, hephaestusIdentities: 0 };
          return { ok: true, case: name, label, hephaestusIdentities: 0 };
        }

        const painted = await waitOutput(pane, '▌ Hephaestus', { timeout: 45000 });
        expect(painted.code === 0, 'Hephaestus label did not paint');
        const label = labelLine(pane);
        expect(label.includes('Hephaestus'), `Hephaestus label: ${label}`);
        expect(label.includes('gpt-mock-fast'), `candidate model not applied: ${label}`);
        const entries = sessionEntries(scenario.sessionFile);
        const heph = identities(entries).filter((entry) => entry.data?.agentId === 'hephaestus');
        expect(heph.length > 0, 'no hephaestus identity entry');
        result.checks.route = { label, identity: heph.at(-1) };

        if (name === 'route') {
          return { ok: true, case: name, label, identity: heph.at(-1) };
        }

        let observedRead = null;
        let observedTaskCall = null;
        let observedTaskResult = null;
        try {
        const readEntry = await waitForSession(
          scenario.sessionFile,
          (entry) => hasToolResult(entry, 'read'),
          30000,
        );
        expect(readEntry, 'read result not observed');
        observedRead = readEntry;
        result.checks.read = {
          toolCallId: readEntry.message?.toolCallId ?? null,
          isError: readEntry.message?.isError === true,
          textLength: resultText(readEntry.message).length,
        };

        if (name === 'read-dominance') {
          const notice = await waitOutput(pane, '바뀌었어요', { timeout: 30000 });
          expect(notice.code === 0, 'plan-changed notice did not paint');
          const taskResults = sessionEntries(scenario.sessionFile)
            .map((entry) => toolResultMessage(entry, 'task'))
            .filter(Boolean);
          const successfulTask = taskResults.find((message) => message.isError !== true);
          expect(!successfulTask, 'a changed plan still produced a successful task result');
          result.checks.readDominance = {
            notice: readText(pane).split(/\r?\n/).filter((line) => line.includes('바뀌었어요')).at(-1) ?? '',
            changedSha256: sha(planPath),
            successfulTask: false,
          };
          writeLoadedNative({
            out, name, record: result, scenario, candidate, nativeTask, nativeSkills, planPath,
            readEntry, taskCall: null, taskResult: null, boulder,
            extra: { scope: 'plan-changed block after a verified full read' },
          });
          return { ok: true, case: name, read: result.checks.read, readDominance: result.checks.readDominance };
        }

        const taskCallEntry = await waitForSession(
          scenario.sessionFile,
          (entry) => hasToolCall(entry, 'task'),
          30000,
        );
        const taskCall = toolCallPart(taskCallEntry, 'task');
        expect(taskCall, 'task tool call not observed');
        observedTaskCall = taskCall;
        result.checks.taskCall = taskCall;
        const taskResultEntry = await waitForSession(
          scenario.sessionFile,
          (entry) => hasToolResult(entry, 'task'),
          120000,
        );
        const taskMessage = toolResultMessage(taskResultEntry, 'task');
        expect(taskMessage, 'task tool result not observed');
        observedTaskResult = { message: taskMessage };
        result.checks.taskResult = {
          toolCallId: taskMessage.toolCallId ?? null,
          isError: taskMessage.isError === true,
          text: resultText(taskMessage).slice(0, 2000),
        };
        expect(taskMessage.isError !== true,
          `first delegation failed: ${resultText(taskMessage).slice(0, 500)}`);

        const loadedNative = writeLoadedNative({
          out, name, record: result, scenario, candidate, nativeTask, nativeSkills, planPath,
          readEntry, taskCall, taskResult: { message: taskMessage }, boulder,
          extra: {
            scope: 'full read -> first task delegation; candidate load/routing, not version-diff',
            boulderSelection: boulder ? 'active plan selected without explicit name' : null,
          },
        });
        result.checks.loadedNative = loadedNative;
        return {
          ok: true,
          case: name,
          label,
          identity: heph.at(-1),
          read: result.checks.read,
          task: result.checks.taskResult,
          boulder,
          loadedNative,
        };
        } catch (error) {
          const submitLocked = readText(pane).includes('같은 세션의 실행 요청을 처리 중이에요');
          const failure = writeLoadedNative({
            out, name, record: result, scenario, candidate, nativeTask, nativeSkills, planPath,
            readEntry: observedRead, taskCall: observedTaskCall, taskResult: observedTaskResult, boulder,
            extra: {
              error: String(error?.message ?? error),
              submitLocked,
              submitLine: scriptLine('await submitOnce(pane, command)'),
              readWaitLine: scriptLine("(entry) => hasToolResult(entry, 'read')"),
              agentLabel: labelLine(pane),
              note: submitLocked
                ? 'SUBMIT_LOCKED_NOTICE after the role switch; the forwarded Native command never reached a read/task tool call'
                : 'read/task handoff did not complete',
            },
          });
          result.checks.failureEvidence = failure;
          result.checks.submitLocked = submitLocked;
          throw error;
        }
      },
    });
    return record;
  } finally {
    await mock.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'native-task': { type: 'string' },
      'native-skills': { type: 'string' },
      candidate: { type: 'string' },
      case: { type: 'string', default: 'all' },
      out: { type: 'string' },
    },
  });
  for (const key of ['native-task', 'native-skills', 'candidate', 'out']) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  const nativeTask = resolve(values['native-task']);
  const nativeSkills = resolve(values['native-skills']);
  const candidate = resolve(values.candidate);
  const out = resolve(values.out);
  for (const [label, file] of [['native-task', nativeTask], ['candidate', candidate]]) {
    if (!existsSync(file)) throw new Error(`${label} is missing: ${file}`);
  }
  if (!existsSync(join(nativeSkills, 'ulw-plan', 'SKILL.md'))
    || !existsSync(join(nativeSkills, 'ulw-execute', 'SKILL.md'))) {
    throw new Error(`native skills are incomplete: ${nativeSkills}`);
  }
  const selected = values.case === 'all' ? CASES : values.case.split(',').map((s) => s.trim());
  for (const name of selected) if (!CASES.includes(name)) throw new Error(`unknown case: ${name}`);
  mkdirSync(out, { recursive: true });

  const results = [];
  for (const name of selected) {
    console.log(`[three-role] case ${name}`);
    try {
      const record = await runCase({ name, out, nativeTask, nativeSkills, candidate });
      results.push({
        name,
        ok: record.ok === true,
        evidence: `three-role-${name}.md`,
        loadedNative: record.result?.loadedNative ?? null,
        error: null,
      });
    } catch (error) {
      results.push({
        name,
        ok: false,
        evidence: `three-role-${name}.md`,
        loadedNative: null,
        error: String(error?.stack ?? error),
      });
    }
  }
  const summary = {
    schema: 'piomo.three-role.candidate-routing.v1',
    at: new Date().toISOString(),
    scope: 'candidate load/routing behavior; candidate bytes equal installed 5.1.81; not a version-difference verification',
    candidate: { path: candidate, sha256: sha(candidate) },
    nativeSkills: {
      path: nativeSkills,
      ulwPlanSha256: sha(join(nativeSkills, 'ulw-plan', 'SKILL.md')),
      ulwExecuteSha256: sha(join(nativeSkills, 'ulw-execute', 'SKILL.md')),
      rebuiltReceipt: findReceipt(nativeSkills),
    },
    nativeTask: { path: nativeTask, sha256: sha(nativeTask) },
    plugin: { path: PLUGIN },
    cases: results,
    ok: results.length > 0 && results.every((result) => result.ok),
    liveWrites: 0,
  };
  writeJson(join(out, 'three-role-summary.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
