// Shared S14/S15 body: re-plan in the same session with and without the
// todo-17 gate adapter.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentIdentityCount, applyGateAdapter, expect, isTitleRequest, readRecent, runTuiScenario, sendKeys,
  sessionEntries, stopStateCount, submitText, switchAgent, textOfMessage, toolResults,
  waitAgentIdentity, waitFile, waitOutput, waitRestartReady, waitTurnEnd,
} from './lib.mjs';
import { SEEDED_MODEL_PROFILES } from '../harness.mjs';

const OMO = {
  model_profiles: SEEDED_MODEL_PROFILES,
  // The background child must run inside this CLI: the process runner cannot
  // start under the temp plugin copy, while the in-process runner can.
  task: { default_execution_mode: 'in-process' },
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
    // Stop only after a task tool result (not after the plan-file write); a
    // failed runner must also stop the scripted call instead of looping.
    const taskSeen = turnTools.some(message =>
      /task_id: st_|plan-consultant|plan-gated|No available model|Task runner failed to start|S14 background/i.test(textOfMessage(message)));
    if (turnText.includes('S14 background work marker')) {
      return { text: 'S14 background done' };
    }
    if (turnText.includes('S14 spawn background child')) {
      if (taskSeen) return { text: 'S14 done' };
      return {
        tool: 'task',
        arguments: {
          category: 'quick',
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
      pluginPath: process.env.PIOMO_QA_GATE_PLUGIN,
      pluginCopy: true,
      modelProfiles: OMO,
      patchPlugin: adapter
        ? (copy) => applyGateAdapter(copy, join(copy, '..', 'adapter-state'))
        : undefined,
    },
    mockOptions: { route },
    body: async (pane, record, scenario) => {
      await waitRestartReady(pane, scenario.sessionFile);
      const installed = await waitOutput(pane, '▌ Sisyphus', { timeout: 25000 });
      expect(installed.code === 0, 'the startup Sisyphus label did not paint');
      record.checks.editorInstalled = true;
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

      // 2. A background task child started before the re-plan. Its completion
      //    must land in THIS session; wait for the child's own result text.
      await runTurn('S14 spawn background child');
      let backgroundEntry = null;
      let backgroundWaitError = null;
      try {
        const entries = await waitFile(scenario.sessionFile,
          () => sessionEntries(scenario.sessionFile).some(entry =>
            JSON.stringify(entry).includes('S14 background done')),
          { timeout: 30000, label: 'S14 background child result' })
          .then(() => sessionEntries(scenario.sessionFile));
        backgroundEntry = entries.find(entry =>
          JSON.stringify(entry).includes('S14 background done')) ?? null;
      } catch (error) {
        backgroundWaitError = String(error?.message ?? error);
      }
      record.checks.background = {
        done: backgroundEntry !== null,
        result: backgroundEntry,
        error: backgroundWaitError,
        entries: sessionEntries(scenario.sessionFile).filter(entry =>
          /S14 background|senpi-task|taskResult/i.test(JSON.stringify(entry))).slice(-8),
      };
      expect(backgroundEntry !== null,
        `the background task child did not report to this session: ${backgroundWaitError ?? 'no result entry'}`);

      // 3. Leave the workflow with one Tab, then explicitly enter planning.
      //    Re-planning still exercises the original submit rewrite and gate.
      if (editor) {
        const sisyphusBefore = agentIdentityCount(scenario.sessionFile, 'sisyphus');
        await waitOutput(pane, '▌ Atlas', { timeout: 20000 });
        sendKeys(pane, 'tab');
        await waitAgentIdentity(pane, scenario.sessionFile, 'sisyphus', { before: sisyphusBefore });
        record.checks.tabWorkflowExit = true;
      }
      await switchAgent(pane, scenario.sessionFile, 'prometheus', { expectLabel: editor });
      const replanTask = await runTurn('방향 다시 잡자', { expectPlanTask: true });
      record.checks.replan = {
        taskResult: replanTask,
        refused: refused(replanTask),
        admitted: replanTask !== null && refused(replanTask) === false,
        notice: readRecent(pane).split(/\r?\n/)
          .filter(line => line.includes('실행 뒤 계획 검토')).at(0) ?? null,
      };

      // 4. /ulw-execute again -> refused again.
      const againTask = await runTurn('/ulw-execute demo', { expectPlanTask: true });
      record.checks.afterExecuteAgain = { taskResult: againTask, refused: refused(againTask) };
      record.checks.lastFrame = readRecent(pane);

      const ok = editor
        && record.checks.afterExecute.refused === true
        && record.checks.background.done === true
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
