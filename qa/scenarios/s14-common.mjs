// Shared S14/S15 body: re-plan in the same session with and without the
// todo-17 gate adapter.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentIdentityCount, applyGateAdapter, expect, isTitleRequest, readRecent, runTuiScenario, sendKeys,
  sessionEntries, stopStateCount, submitText, switchAgent, textOfMessage, toolResults,
  waitAgentIdentity, waitOutput, waitTurnEnd,
} from './lib.mjs';
import { SEEDED_MODEL_PROFILES } from '../harness.mjs';

const OMO = {
  model_profiles: SEEDED_MODEL_PROFILES,
  task: { default_execution_mode: 'process', process_runner: 'child-process' },
  agents: {
    'plan-consultant': { model: 'qa-mock/claude-mock-medium', variant: 'medium' },
  },
  categories: {
    quick: { description: 'S14 quick', model: 'qa-mock/claude-mock-medium', variant: 'medium' },
  },
};

function refused(result) {
  return /plan-gated|explicitly requests the ulw-plan workflow|plan review/i.test(result?.text ?? '');
}

function planTaskResults(file) {
  return toolResults(sessionEntries(file)).filter(result => result.toolName === 'task');
}

export async function runReplan({ out, name, adapter }) {
  const route = (body) => {
    if (isTitleRequest(body)) return { text: 'S14 title' };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUserIndex = messages.findLastIndex(message => message?.role === 'user');
    if (lastUserIndex === -1) return { text: 'S14 done' };
    const turnText = textOfMessage(messages[lastUserIndex]);
    const turnTools = messages.slice(lastUserIndex + 1).filter(message => message?.role === 'tool');
    const taskSeen = turnTools.some(message =>
      /task_id: st_|plan-consultant|plan-gated|No available model|S14 background/i.test(textOfMessage(message)));
    if (turnText.includes('S14 background work marker')) {
      return { text: 'S14 background done' };
    }
    if (turnText.includes('S14 spawn background child')) {
      if (taskSeen) return { text: 'S14 done' };
      return {
        tool: 'task',
        arguments: {
          subagent_type: 'explore',
          prompt: 'S14 background work marker',
          description: 'S14 background child',
          run_in_background: true,
        },
      };
    }
    if (turnText.includes('방향 다시 잡자')) {
      if (taskSeen) return { text: 'S14 done' };
      if (turnTools.length === 0) {
        return { tool: 'write', arguments: { path: '.omo/plans/demo.md', content: '# demo plan\n' } };
      }
      return {
        tool: 'task',
        arguments: {
          subagent_type: 'plan-consultant',
          prompt: 'S14 re-plan',
          description: 'S14 re-plan',
          run_in_background: false,
        },
      };
    }
    if (turnText.includes('ulw-execute')) {
      if (taskSeen) return { text: 'S14 done' };
      return {
        tool: 'task',
        arguments: {
          subagent_type: 'plan-consultant',
          prompt: 'S14 execute-time plan',
          description: 'S14 execute-time plan',
          run_in_background: false,
        },
      };
    }
    return { text: 'S14 done' };
  };

  return runTuiScenario({
    out,
    name,
    evidenceName: `task-11-piomo-primary-agents-${name}`,
    label: `PiOMO ${name}`,
    scenarioOptions: {
      pluginCopy: true,
      modelProfiles: OMO,
      patchPlugin: adapter
        ? (copy) => applyGateAdapter(copy, join(copy, '..', 'adapter-state'))
        : undefined,
    },
    mockOptions: { route },
    body: async (pane, record, scenario) => {
      mkdirSync(join(scenario.workDir, '.omo', 'plans'), { recursive: true });
      writeFileSync(join(scenario.workDir, '.omo', 'plans', 'demo.md'), '# demo plan\n', 'utf8');
      const editor = record.checks.editorInstalled === true;

      await switchAgent(pane, scenario.sessionFile, 'prometheus');

      const runTurn = async (text, { expectPlanTask = false } = {}) => {
        const turnBefore = stopStateCount(sessionEntries(scenario.sessionFile));
        const planBefore = planTaskResults(scenario.sessionFile).length;
        await submitText(pane, text);
        await waitTurnEnd(scenario.sessionFile, turnBefore, { timeout: 45000 }).catch(() => null);
        if (!expectPlanTask) return null;
        const results = planTaskResults(scenario.sessionFile);
        return results.length > planBefore ? results.at(-1) : null;
      };

      // 1. /ulw-execute -> switches to Atlas (when the editor exists) and the
      //    plan-consultant spawn is refused because the gate is locked.
      const executeTask = await runTurn('/ulw-execute demo', { expectPlanTask: true });
      record.checks.afterExecute = { taskResult: executeTask, refused: refused(executeTask) };
      record.checks.afterExecuteAgent = sessionEntries(scenario.sessionFile)
        .filter(entry => entry?.type === 'custom' && entry.customType === 'primary-agent/v1').at(-1) ?? null;

      // 2. A background task child started before the re-plan.
      await runTurn('S14 spawn background child');
      record.checks.background = {
        entries: sessionEntries(scenario.sessionFile).filter(entry =>
          /S14 background|senpi-task|taskResult/i.test(JSON.stringify(entry))).slice(-8),
      };

      // 3. Re-plan in the same session: Tab back to Prometheus when the editor
      //    exists, otherwise /agent as a recorded fallback.
      if (editor) {
        const prometheusBefore = agentIdentityCount(scenario.sessionFile, 'prometheus');
        await waitOutput(pane, '▌ Atlas', { timeout: 20000 });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          sendKeys(pane, 'tab');
        }
        const prometheus = await waitOutput(pane, '▌ Prometheus', { timeout: 25000 });
        expect(prometheus.code === 0, 'Tab did not return to Prometheus');
        await waitAgentIdentity(pane, scenario.sessionFile, 'prometheus', { before: prometheusBefore });
      } else {
        await switchAgent(pane, scenario.sessionFile, 'prometheus', { expectLabel: false });
      }
      const replanTask = await runTurn('방향 다시 잡자', { expectPlanTask: true });
      record.checks.replan = {
        taskResult: replanTask,
        refused: refused(replanTask),
        admitted: replanTask !== null && refused(replanTask) === false,
        notice: readRecent(pane).split(/\r?\n/)
          .filter(line => line.includes('게이트 어댑터 미설치')).at(0) ?? null,
      };

      // 4. /ulw-execute again -> refused again.
      const againTask = await runTurn('/ulw-execute demo', { expectPlanTask: true });
      record.checks.afterExecuteAgain = { taskResult: againTask, refused: refused(againTask) };
      record.checks.lastFrame = readRecent(pane);

      const ok = editor
        && record.checks.afterExecute.refused === true
        && record.checks.replan.admitted === (adapter === true)
        && record.checks.afterExecuteAgain.refused === true
        && (adapter === true || record.checks.replan.notice !== null);
      return {
        ok,
        reason: ok ? null : (editor ? 'a re-plan assertion failed; see checks'
          : 'editor_install_failed: the re-plan rewrite lives in the onSubmit wrap'),
        checks: record.checks,
      };
    },
  });
}
