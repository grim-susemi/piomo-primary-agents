// S4a - first-run lane seeding.
// No memory files: an agent switched to starts on its lane's first available rung.
// A fresh session with no roster pin (startup and `/new`) keeps the host start
// model (HOST_MODEL) instead; the temp settings defaultModel is that model.
import { parseArgs } from 'node:util';
import {
  expect, listSessionFilesDeep, readRecent, runTuiScenario, sendKeys, sendText,
  sessionEntries, waitFooterModel, waitForSessionContaining, waitOutput, waitSessionEntry,
} from './lib.mjs';

const HOST_MODEL = 'claude-mock-max';

// Sisyphus is not seeded at startup (Q4): a fresh session keeps HOST_MODEL.
const LANE_MODELS = {
  hephaestus: { modelId: 'gpt-mock-fast', thinking: 'medium' },
  prometheus: { modelId: 'claude-mock-xhigh', thinking: 'xhigh' },
  atlas: { modelId: 'claude-mock-medium', thinking: 'medium' },
};

function footerOf(text) {
  return String(text ?? '').split(/\r?\n/).filter(line => line.includes('0/200K')).at(-1) ?? '';
}

function lastModel(entries) {
  return [...entries].reverse().find(entry => entry?.type === 'model_change') ?? null;
}

export async function run({ out }) {
  return runTuiScenario({
    out,
    name: 'S4a',
    label: 'PiOMO S4a seeding',
    scenarioOptions: {
      model: HOST_MODEL,
      settings: { defaultProvider: 'qa-mock', defaultModel: `qa-mock/${HOST_MODEL}` },
    },
    body: async (pane, record, scenario) => {
      await waitFooterModel(pane, HOST_MODEL);
      const startupEntries = sessionEntries(scenario.sessionFile);
      record.checks.startup = {
        footer: footerOf(readRecent(pane)),
        lastModel: lastModel(startupEntries),
        modelChanges: startupEntries.filter(entry => entry?.type === 'model_change'),
      };
      expect(!record.checks.startup.modelChanges.some(entry => entry.source === 'extension'),
        `startup called setSessionModel without a Sisyphus pin: ${JSON.stringify(record.checks.startup.modelChanges)}`);

      record.checks.agents = [];
      for (const [agentId, expected] of Object.entries(LANE_MODELS)) {
        sendText(pane, `/agent ${agentId}`);
        sendKeys(pane, 'enter');
        await waitSessionEntry(scenario.sessionFile, entry => entry?.type === 'custom'
          && entry.customType === 'primary-agent/v1' && entry.data?.agentId === agentId,
        { timeout: 25000, label: `${agentId} identity` });
        await waitFooterModel(pane, expected.modelId);
        const entries = sessionEntries(scenario.sessionFile);
        const model = lastModel(entries);
        const footer = footerOf(readRecent(pane));
        record.checks.agents.push({ agentId, expected, model, footer });
        expect(model?.modelId === expected.modelId,
          `${agentId} did not start on ${expected.modelId}: ${JSON.stringify(model)}`);
        expect(String(footer).includes(expected.modelId), `${agentId} footer misses ${expected.modelId}: ${footer}`);
      }

      // `/new` starts on the host start model (settings default); with no roster pin
      // the fresh session gets no Sisyphus lane seeding.
      const before = new Set(listSessionFilesDeep(scenario.sandbox.stateDir));
      sendText(pane, '/new');
      sendKeys(pane, 'enter');
      const started = await waitOutput(pane, 'New session started', { timeout: 30000 });
      expect(started.code === 0, '/new did not start a new session');
      sendText(pane, 'S4A new session turn');
      sendKeys(pane, 'enter');
      const newFile = await waitForSessionContaining(scenario.sandbox.stateDir,
        entry => entry?.type === 'message' && entry.message?.role === 'user'
          && JSON.stringify(entry.message.content).includes('S4A new session turn'),
        { timeout: 30000 });
      record.checks.newSessionFiles = listSessionFilesDeep(scenario.sandbox.stateDir)
        .filter(file => !before.has(file));
      record.checks.newSessionFile = newFile;
      expect(newFile !== undefined, '/new did not create a new session file');
      await waitSessionEntry(newFile, entry => entry?.type === 'model_change' && entry.modelId === HOST_MODEL,
        { timeout: 30000, label: 'new session host model' });
      const newEntries = sessionEntries(newFile);
      record.checks.newSession = {
        footer: footerOf(readRecent(pane)),
        lastModel: lastModel(newEntries),
        modelChanges: newEntries.filter(entry => entry?.type === 'model_change'),
      };
      expect(!record.checks.newSession.modelChanges.some(entry => entry.source === 'extension'),
        `/new called setSessionModel without a Sisyphus pin: ${JSON.stringify(record.checks.newSession.modelChanges)}`);

      return { ok: true, checks: record.checks };
    },
  });
}

const invokedDirectly = process.argv[1]?.endsWith('s4a.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s4a.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
