// S4 - per-agent model memory on Hephaestus.
// Pick a second GPT model with /model, Tab around twice, come back to
// Hephaestus, restart, and check the memory file; a non-GPT pick runs but is
// not remembered and shows one notice.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createTuiScenario, exitCli, expect, readRecent, readText, run as runCommand, runTuiScenario,
  sendKeys, sendText, submitText, waitOutput, waitReady, waitSessionEntry,
} from './lib.mjs';
import { memoryPath } from '../../contract/schema.mjs';
import { ROOT } from '../harness.mjs';

function hashFile(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'MISSING';
}

function footerOf(text) {
  return String(text ?? '').split(/\r?\n/).filter(line => line.includes('(qa-mock)')).at(-1) ?? '';
}

async function command(pane, text, file, predicate, label) {
  await submitText(pane, text);
  return waitSessionEntry(file, predicate, { timeout: 25000, label });
}

function identity(agentId) {
  return entry => entry?.type === 'custom' && entry.customType === 'primary-agent/v1'
    && entry.data?.agentId === agentId;
}

function modelChange(modelId, source) {
  return entry => entry?.type === 'model_change' && entry.modelId === modelId
    && (source === undefined || entry.source === source);
}

export async function run({ out }) {
  return runTuiScenario({
    out,
    name: 'S4',
    label: 'PiOMO S4 model memory',
    body: async (pane, record, scenario) => {
      const hephMemory = memoryPath(scenario.agentDir, 'hephaestus');
      const others = ['sisyphus', 'prometheus', 'atlas'].map(id => ({
        id,
        path: memoryPath(scenario.agentDir, id),
        before: hashFile(memoryPath(scenario.agentDir, id)),
      }));
      const editor = record.checks.editorInstalled === true;
      record.checks.editorInstalled = editor;
      record.checks.tabRequiredByScenario = true;

      await command(pane, '/agent hephaestus', scenario.sessionFile, identity('hephaestus'), 'hephaestus identity');
      await waitOutput(pane, 'gpt-mock-fast', { timeout: 20000 });
      record.checks.afterAgentSwitch = footerOf(readRecent(pane));

      await command(pane, '/model gpt-mock-sol', scenario.sessionFile,
        modelChange('gpt-mock-sol', 'command'), 'gpt-mock-sol model change');

      if (editor) {
        // Hephaestus -> Prometheus -> Atlas -> Sisyphus -> Hephaestus
        for (const agent of ['Prometheus', 'Atlas', 'Sisyphus', 'Hephaestus']) {
          sendKeys(pane, 'tab');
          const painted = await waitOutput(pane, `▌ ${agent}`, { timeout: 20000 });
          expect(painted.code === 0, `Tab did not paint ${agent}`);
        }
        await waitOutput(pane, 'gpt-mock-sol', { timeout: 20000 });
        record.checks.tabRoundTrip = true;
      } else {
        for (const id of ['prometheus', 'atlas', 'sisyphus', 'hephaestus']) {
          await command(pane, `/agent ${id}`, scenario.sessionFile, identity(id), `${id} identity`);
        }
        await waitOutput(pane, 'gpt-mock-sol', { timeout: 20000 });
        record.checks.tabRoundTrip = false;
      }

      record.checks.restoredFooter = footerOf(readRecent(pane));
      record.checks.memoryAfterRoundTrip = existsSync(hephMemory)
        ? JSON.parse(readFileSync(hephMemory, 'utf8')) : null;
      expect(record.checks.memoryAfterRoundTrip?.model?.modelId === 'gpt-mock-sol',
        `memory was not written: ${JSON.stringify(record.checks.memoryAfterRoundTrip)}`);

      const beforeNonGpt = hashFile(hephMemory);
      await command(pane, '/model claude-mock-max', scenario.sessionFile,
        modelChange('claude-mock-max', 'command'), 'non-gpt model change');
      await command(pane, '/agent sisyphus', scenario.sessionFile, identity('sisyphus'), 'sisyphus identity');
      record.checks.nonGptNotice = readRecent(pane).split(/\r?\n/)
        .filter(line => line.includes('Hephaestus는 GPT 모델만 기억해요')).at(0) ?? null;
      record.checks.memoryAfterNonGpt = hashFile(hephMemory);
      record.checks.memoryUnchangedAfterNonGpt = beforeNonGpt === record.checks.memoryAfterNonGpt;

      // Restart = a new CLI process and a new session against the same temp agent dir.
      const second = createTuiScenario({
        name: 'S4-restart',
        sandbox: scenario.sandbox,
        mockUrl: scenario.mockUrl,
        packages: [ROOT],
        pluginPath: scenario.pluginPath,
        sessionName: 'restarted',
      });
      await exitCli(pane);
      runCommand(pane, second.command);
      await waitReady(pane);
      await command(pane, '/agent hephaestus', second.sessionFile,
        modelChange('gpt-mock-sol', 'extension'), 'memory restored on restart');
      record.checks.restartFooter = footerOf(readRecent(pane));
      record.checks.othersUnchanged = others.map(entry => ({
        id: entry.id,
        before: entry.before,
        after: hashFile(entry.path),
      }));

      return {
        ok: editor && record.checks.tabRoundTrip === true,
        reason: editor
          ? null
          : 'editor_install_failed: S4 requires Tab and a visible label, but the package could not load its editor',
        checks: record.checks,
      };
    },
  });
}

const invokedDirectly = process.argv[1]?.endsWith('s4.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s4.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
