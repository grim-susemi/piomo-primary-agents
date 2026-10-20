// S5 - tool policy enforcement with mock-provider scripted tool calls.
// Prometheus: edit src/x.ts blocked (Korean reason), write .omo/plans/x.md
// allowed, bash `echo x > a.txt` blocked, `git status` allowed, the ulw-plan
// scaffold allowed. Atlas: write src/x.ts blocked, write .omo/notes/x.txt
// allowed. A nested call (parentToolCallId) is blocked.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  expect, readRecent, runTuiScenario, sendKeys, sendText, sessionEntries, stopStateCount,
  toolResults, waitFile, waitOutput, waitSessionEntry, waitTurnEnd, submitText,
} from './lib.mjs';

const KO_PROMETHEUS = '프로메테우스는 .omo 계획 문서만 수정할 수 있어요';
const KO_ATLAS = '아틀라스는 .omo 폴더 안의 파일만 수정할 수 있어요';

const PROMPTS = {
  'S5-P-EDIT': { tool: 'edit', arguments: { path: 'src/x.ts', oldText: 'a', newText: 'b' } },
  'S5-P-WRITE-PLAN': { tool: 'write', arguments: { path: '.omo/plans/x.md', content: '# plan' } },
  'S5-P-BASH-REDIRECT': { tool: 'eval', arguments: { action: 'run', summary: 'S5 bash redirect', language: 'js', code: "await tool.bash({ command: 'echo x > a.txt' })" } },
  'S5-P-BASH-GIT': { tool: 'eval', arguments: { action: 'run', summary: 'S5 git status', language: 'js', code: "await tool.bash({ command: 'git status' })" } },
  'S5-P-SCAFFOLD': { tool: 'eval', arguments: { code: null } },
  'S5-A-WRITE-SRC': { tool: 'write', arguments: { path: 'src/x.ts', content: 'x' } },
  'S5-A-WRITE-NOTES': { tool: 'write', arguments: { path: '.omo/notes/x.txt', content: 'note' } },
  'S5-P-NESTED': { tool: 'qa_nested_write', arguments: {} },
};

function lastUserText(entries) {
  return entries.filter(entry => entry?.type === 'message' && entry.message?.role === 'user')
    .map(entry => entry.message.content.filter(part => part.type === 'text').map(part => part.text).join(''))
    .at(-1) ?? '';
}

export async function run({ out }) {
  let scaffoldPath = null;
  const route = (body) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    if (last?.role === 'tool') return { text: 'S5 tool result acknowledged' };
    const content = typeof last?.content === 'string'
      ? last.content
      : Array.isArray(last?.content) ? last.content.map(part => part?.text ?? '').join('') : '';
    const key = Object.keys(PROMPTS).find(candidate => content.includes(candidate));
    if (!key) return { text: 'S5 idle' };
    const spec = PROMPTS[key];
    const args = spec.tool === 'eval' && key === 'S5-P-SCAFFOLD'
      ? { action: 'run', summary: 'S5 scaffold', language: 'js', code: `await tool.bash({ command: ${JSON.stringify(`node "${scaffoldPath}" demo --clear --draft-only --review-required`)} })` }
      : spec.arguments;
    return { tool: spec.tool, arguments: args };
  };

  return runTuiScenario({
    out,
    name: 'S5',
    label: 'PiOMO S5 policy',
    scenarioOptions: {
      pluginCopy: true,
      extraExtensions: [join(import.meta.dirname, 's5-nested.mjs')],
    },
    mockOptions: { route },
    body: async (pane, record, scenario) => {
      scaffoldPath = join(scenario.pluginPath, 'skills', 'ulw-plan', 'scripts', 'scaffold-plan.mjs');
      mkdirSync(join(scenario.workDir, '.omo', 'plans'), { recursive: true });
      mkdirSync(join(scenario.workDir, '.omo', 'notes'), { recursive: true });
      mkdirSync(join(scenario.workDir, 'src'), { recursive: true });
      record.checks.scaffoldPath = scaffoldPath;

      const runTurn = async (prompt, expectedTool) => {
        const before = toolResults(sessionEntries(scenario.sessionFile))
          .filter(result => result.toolName === expectedTool).length;
        const turnsBefore = stopStateCount(sessionEntries(scenario.sessionFile));
        await submitText(pane, prompt);
        await waitFile(scenario.sessionFile, () => toolResults(sessionEntries(scenario.sessionFile))
          .filter(result => result.toolName === expectedTool).length > before, {
          timeout: 30000,
          label: `${prompt} tool result`,
        });
        const results = toolResults(sessionEntries(scenario.sessionFile));
        expect(results.filter(result => result.toolName === expectedTool).length > before,
          `${prompt} produced no tool result`);
        await waitTurnEnd(scenario.sessionFile, turnsBefore, { timeout: 30000 });
        await waitOutput(pane, 'S5 tool result acknowledged', { timeout: 20000 }).catch(() => {});
        return results.at(-1);
      };

      sendText(pane, '/agent prometheus');
      sendKeys(pane, 'enter');
      await waitSessionEntry(scenario.sessionFile, entry => entry?.type === 'custom'
        && entry.customType === 'primary-agent/v1' && entry.data?.agentId === 'prometheus',
      { timeout: 25000, label: 'prometheus identity' });

      record.checks.prometheus = {};
      record.checks.prometheus.edit = await runTurn('S5-P-EDIT', 'edit');
      expect(record.checks.prometheus.edit.isError === true
        && record.checks.prometheus.edit.text.includes(KO_PROMETHEUS),
      `Prometheus edit was not blocked: ${JSON.stringify(record.checks.prometheus.edit)}`);

      record.checks.prometheus.writePlan = await runTurn('S5-P-WRITE-PLAN', 'write');
      expect(record.checks.prometheus.writePlan.isError === false,
        `Prometheus plan write failed: ${JSON.stringify(record.checks.prometheus.writePlan)}`);

      record.checks.prometheus.bashRedirect = await runTurn('S5-P-BASH-REDIRECT', 'eval');
      expect(JSON.stringify(record.checks.prometheus.bashRedirect).includes(KO_PROMETHEUS),
        `Prometheus redirection was not blocked: ${JSON.stringify(record.checks.prometheus.bashRedirect)}`);

      record.checks.prometheus.bashGit = await runTurn('S5-P-BASH-GIT', 'eval');
      expect(!JSON.stringify(record.checks.prometheus.bashGit).includes(KO_PROMETHEUS),
        `Prometheus git status was blocked: ${JSON.stringify(record.checks.prometheus.bashGit)}`);

      record.checks.prometheus.scaffold = await runTurn('S5-P-SCAFFOLD', 'eval');
      expect(!JSON.stringify(record.checks.prometheus.scaffold).includes(KO_PROMETHEUS),
        `Prometheus scaffold was blocked: ${JSON.stringify(record.checks.prometheus.scaffold)}`);

      sendText(pane, '/agent atlas');
      sendKeys(pane, 'enter');
      await waitSessionEntry(scenario.sessionFile, entry => entry?.type === 'custom'
        && entry.customType === 'primary-agent/v1' && entry.data?.agentId === 'atlas',
      { timeout: 25000, label: 'atlas identity' });

      record.checks.atlas = {};
      record.checks.atlas.writeSrc = await runTurn('S5-A-WRITE-SRC', 'write');
      expect(record.checks.atlas.writeSrc.isError === true
        && record.checks.atlas.writeSrc.text.includes(KO_ATLAS),
      `Atlas source write was not blocked: ${JSON.stringify(record.checks.atlas.writeSrc)}`);
      record.checks.atlas.writeNotes = await runTurn('S5-A-WRITE-NOTES', 'write');
      expect(record.checks.atlas.writeNotes.isError === false,
        `Atlas .omo write failed: ${JSON.stringify(record.checks.atlas.writeNotes)}`);

      sendText(pane, '/agent prometheus');
      sendKeys(pane, 'enter');
      await waitSessionEntry(scenario.sessionFile, entry => entry?.type === 'custom'
        && entry.customType === 'primary-agent/v1' && entry.data?.agentId === 'prometheus',
      { timeout: 25000, label: 'prometheus identity again' });
      record.checks.prometheus.nested = await runTurn('S5-P-NESTED', 'qa_nested_write');
      const nestedCalls = record.checks.prometheus.nested.nestedCalls?.calls ?? [];
      record.checks.prometheus.nestedBlocked = nestedCalls.some(call => call.status === 'error'
        && String(call.error ?? '').includes(KO_PROMETHEUS));
      expect(record.checks.prometheus.nestedBlocked === true,
        `nested write was not blocked: ${JSON.stringify(record.checks.prometheus.nested)}`);

      record.checks.lastFrame = readRecent(pane);
      return { ok: true, checks: record.checks };
    },
  });
}

const invokedDirectly = process.argv[1]?.endsWith('s5.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s5.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
