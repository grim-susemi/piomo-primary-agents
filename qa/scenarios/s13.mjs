// S13 - plain-language gate entry (temp PLUGIN copy).
// On Prometheus `플랜 짜줘 데모` is rewritten to `/skill:ulw-plan ...`; the
// scripted turn reads .omo/plans/demo.md and spawns plan-consultant (admitted).
// Restart the CLI on the same session and type again -> rewritten and admitted.
// Positive control: the same text on Sisyphus is refused.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createTuiScenario, expect, readRecent, run as runCommand, runTuiScenario, sendKeys,
  sendText, sessionEntries, submitText, textOfMessage, toolResults, userMessages,
  waitOutput, waitReady, waitSessionEntry,
} from './lib.mjs';
import { SEEDED_MODEL_PROFILES, ROOT } from '../harness.mjs';

const OMO = {
  model_profiles: SEEDED_MODEL_PROFILES,
  task: { default_execution_mode: 'process', process_runner: 'child-process' },
  agents: {
    'plan-consultant': { model: 'qa-mock/claude-mock-medium', variant: 'medium' },
  },
  categories: {
    quick: { description: 'S13 quick', model: 'qa-mock/claude-mock-medium', variant: 'medium' },
  },
};

function refused(result) {
  return /plan-gated|explicitly requests the ulw-plan workflow|plan review/i.test(result?.text ?? '');
}

function admitted(result) {
  return result !== null && refused(result) === false;
}

export async function run({ out }) {
  const route = (body) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    const text = textOfMessage(last);
    if (last?.role === 'user' && (text.includes('플랜 짜줘') || text.includes('ulw-plan'))) {
      return { tool: 'read', arguments: { path: '.omo/plans/demo.md' } };
    }
    const toolMessages = messages.filter(message => message?.role === 'tool');
    const readResult = toolMessages.find(message => /demo\.md/.test(textOfMessage(message)));
    const taskResult = toolMessages.find(message => /plan-consultant|plan-gated|No available model/i.test(textOfMessage(message)));
    if (readResult && !taskResult) {
      return {
        tool: 'task',
        arguments: {
          subagent_type: 'plan-consultant',
          prompt: 'S13 plan request',
          description: 'S13 plan consultant',
          run_in_background: false,
        },
      };
    }
    return { text: 'S13 done' };
  };

  return runTuiScenario({
    out,
    name: 'S13',
    label: 'PiOMO S13 gate',
    scenarioOptions: { pluginCopy: true, modelProfiles: OMO },
    mockOptions: { route },
    body: async (pane, record, scenario) => {
      mkdirSync(join(scenario.workDir, '.omo', 'plans'), { recursive: true });
      writeFileSync(join(scenario.workDir, '.omo', 'plans', 'demo.md'), '# demo plan\n', 'utf8');
      const editor = record.checks.editorInstalled === true;

      sendText(pane, '/agent prometheus');
      sendKeys(pane, 'enter');
      await waitSessionEntry(scenario.sessionFile, entry => entry?.type === 'custom'
        && entry.customType === 'primary-agent/v1' && entry.data?.agentId === 'prometheus',
      { timeout: 25000, label: 'prometheus identity' });

      await submitText(pane, '플랜 짜줘 데모');
      await waitOutput(pane, 'S13 done', { timeout: 45000 }).catch(() => {});
      const firstEntries = sessionEntries(scenario.sessionFile);
      const firstUsers = userMessages(firstEntries);
      const firstTask = toolResults(firstEntries).filter(result => result.toolName === 'task').at(-1) ?? null;
      record.checks.first = {
        userMessages: firstUsers,
        rewritten: firstUsers.some(message => message.startsWith('/skill:ulw-plan 플랜 짜줘 데모')),
        taskResult: firstTask,
        admitted: admitted(firstTask),
      };

      // Restart on the same session and type again on Prometheus.
      sendText(pane, '/exit');
      sendKeys(pane, 'enter');
      await waitOutput(pane, 'To resume this session', { timeout: 20000 }).catch(() => null);
      await waitOutput(pane, 'PS ', { timeout: 5000 }).catch(() => null);
      const sessionId = sessionEntries(scenario.sessionFile)[0]?.id;
      const restarted = createTuiScenario({
        name: 'S13-restart',
        sandbox: scenario.sandbox,
        mockUrl: scenario.mockUrl,
        packages: [ROOT],
        pluginPath: scenario.pluginPath,
        modelProfiles: OMO,
        sessionName: 'owned',
        sessionArg: sessionId,
      });
      runCommand(pane, restarted.command);
      await waitReady(pane);
      sendText(pane, '/agent prometheus');
      sendKeys(pane, 'enter');
      await waitSessionEntry(scenario.sessionFile, entry => entry?.type === 'custom'
        && entry.customType === 'primary-agent/v1' && entry.data?.agentId === 'prometheus',
      { timeout: 25000, label: 'prometheus identity after restart' });
      await submitText(pane, '플랜 짜줘 데모');
      await waitOutput(pane, 'S13 done', { timeout: 45000 }).catch(() => {});
      const secondEntries = sessionEntries(scenario.sessionFile);
      const secondUsers = userMessages(secondEntries);
      const secondTask = toolResults(secondEntries).filter(result => result.toolName === 'task').at(-1) ?? null;
      record.checks.afterRestart = {
        userMessages: secondUsers,
        rewritten: secondUsers.filter(message => message.startsWith('/skill:ulw-plan 플랜 짜줘 데모')).length >= 2,
        taskResult: secondTask,
        admitted: admitted(secondTask),
        sessionId: secondEntries[0]?.id ?? null,
      };

      // Positive control: the same text on Sisyphus is refused.
      await submitText(pane, '/agent sisyphus');
      await waitSessionEntry(scenario.sessionFile, entry => entry?.type === 'custom'
        && entry.customType === 'primary-agent/v1' && entry.data?.agentId === 'sisyphus',
      { timeout: 25000, label: 'sisyphus identity' });
      await submitText(pane, '플랜 짜줘 데모');
      await waitOutput(pane, 'S13 done', { timeout: 45000 }).catch(() => {});
      const controlEntries = sessionEntries(scenario.sessionFile);
      const controlTask = toolResults(controlEntries).filter(result => result.toolName === 'task').at(-1) ?? null;
      record.checks.positiveControl = {
        taskResult: controlTask,
        refused: refused(controlTask),
      };
      record.checks.lastFrame = readRecent(pane);

      const ok = editor
        && record.checks.first.rewritten
        && record.checks.first.admitted
        && record.checks.afterRestart.rewritten
        && record.checks.afterRestart.admitted
        && record.checks.positiveControl.refused;
      return {
        ok,
        reason: ok ? null : (editor ? 'a gate assertion failed; see checks'
          : 'editor_install_failed: the plain-language rewrite lives in the onSubmit wrap'),
        checks: record.checks,
      };
    },
  });
}

const invokedDirectly = process.argv[1]?.endsWith('s13.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s13.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
