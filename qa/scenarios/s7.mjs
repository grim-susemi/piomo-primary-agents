// S7 - resume, reload and new session.
// Switch to Atlas, exit, resume the same session -> Atlas with the branch's
// own model; /reload -> still Atlas; /new -> Sisyphus on the host start model (no roster pin, so no lane seeding).
import { parseArgs } from 'node:util';
import {
  createTuiScenario, exitCli, expect, isTitleRequest, listSessionFiles, readRecent,
  run as runCommand, runTuiScenario, sendKeys, sendPrompt, sendText, sessionEntries,
  submitText, systemPromptOf, textOfMessage, waitForSessionContaining, waitOutput,
  waitReady, waitSessionEntry, waitTurnEnd,
} from './lib.mjs';
import { ROOT } from '../harness.mjs';

function footerOf(text) {
  return String(text ?? '').split(/\r?\n/).filter(line => line.includes('(qa-mock)')).at(-1) ?? '';
}

function modelChanges(entries) {
  return entries.filter(entry => entry?.type === 'model_change');
}

const debug = process.env.PIOMO_QA_DEBUG === '1'
  ? message => console.error(`[S7] ${message}`)
  : () => {};

export async function run({ out }) {
  const state = { prompts: {}, tails: {} };
  const route = (body) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    const text = textOfMessage(last);
    for (const key of ['resume', 'reload', 'new']) {
      if (text.includes(`S7 ${key} turn`)) {
        if (isTitleRequest(body)) return { text: `S7 title ${key}` };
        state.prompts[key] = systemPromptOf(body);
        state.tails[key] = state.prompts[key].slice(-900);
        debug(`captured ${key} system prompt (${state.prompts[key].length} chars)`);
        return { text: `S7 done ${key}` };
      }
    }
    return { text: 'S7 idle' };
  };

  const record = await runTuiScenario({
    out,
    name: 'S7',
    label: 'PiOMO S7 resume',
    mockOptions: { route },
    body: async (pane, current, created) => {
      const submitNewTurn = async () => {
        await submitText(pane, 'S7 new turn');
        const newFile = await waitForSessionContaining(created.sandbox.stateDir,
          entry => entry?.type === 'message' && entry.message?.role === 'user'
            && JSON.stringify(entry.message.content).includes('S7 new turn'),
          { timeout: 30000 });
        expect(newFile !== undefined, '/new did not create a session file');
        current.checks.newSessionFile = newFile;
        await waitTurnEnd(newFile, 0, { timeout: 30000 });
      };

      debug('first session: /agent atlas');
      sendText(pane, '/agent atlas');
      sendKeys(pane, 'enter');
      await waitSessionEntry(created.sessionFile, entry => entry?.type === 'custom'
        && entry.customType === 'primary-agent/v1' && entry.data?.agentId === 'atlas',
      { timeout: 25000, label: 'atlas identity' });
      await waitOutput(pane, 'claude-mock-medium', { timeout: 20000 });
      const beforeExit = sessionEntries(created.sessionFile);
      const extensionModelsBefore = modelChanges(beforeExit).filter(entry => entry.source === 'extension');
      current.checks.beforeExit = {
        footer: footerOf(readRecent(pane)),
        identity: beforeExit.filter(entry => entry?.type === 'custom' && entry.customType === 'primary-agent/v1').at(-1),
        lastModel: modelChanges(beforeExit).at(-1),
        extensionModelCount: extensionModelsBefore.length,
      };

      debug('exiting');
      await exitCli(pane);

      const sessionId = sessionEntries(created.sessionFile)[0]?.id;
      expect(typeof sessionId === 'string' && sessionId.length > 0, 'session id missing');
      const resumed = createTuiScenario({
        name: 'S7-resume',
        sandbox: created.sandbox,
        mockUrl: created.mockUrl,
        packages: [ROOT],
        pluginPath: created.pluginPath,
        sessionName: 'owned',
        sessionArg: sessionId,
      });
      debug(`resuming ${sessionId}`);
      runCommand(pane, resumed.command);
      await waitReady(pane);
      debug('resume ready');
      const resumedEntries = sessionEntries(created.sessionFile);
      current.checks.resumeIdentity = resumedEntries.filter(entry => entry?.type === 'custom'
        && entry.customType === 'primary-agent/v1').at(-1) ?? null;
      await sendPrompt(pane, created.sessionFile, 'S7 resume turn', 'S7 done resume');
      debug('resume turn done');
      current.checks.resume = {
        systemPromptHasAtlas: String(state.prompts.resume).includes('piomo-primary-agent:begin id=atlas'),
        systemPromptTail: state.tails.resume ?? null,
        extensionModelCount: modelChanges(sessionEntries(created.sessionFile))
          .filter(entry => entry.source === 'extension').length,
        footer: footerOf(readRecent(pane)),
      };
      expect(current.checks.resume.systemPromptHasAtlas === true, 'resume did not restore Atlas');
      expect(current.checks.resume.extensionModelCount === extensionModelsBefore.length,
        'resume called setSessionModel instead of keeping the branch model');

      debug('sending /reload');
      sendText(pane, '/reload');
      sendKeys(pane, 'enter');
      await waitOutput(pane, 'Reloading keybindings', { timeout: 30000 });
      debug('reload box seen');
      await waitReady(pane);
      debug('reload ready');
      await sendPrompt(pane, created.sessionFile, 'S7 reload turn', 'S7 done reload');
      debug('reload turn done');
      current.checks.reload = {
        systemPromptHasAtlas: String(state.prompts.reload).includes('piomo-primary-agent:begin id=atlas'),
        systemPromptTail: state.tails.reload ?? null,
        footer: footerOf(readRecent(pane)),
      };
      expect(current.checks.reload.systemPromptHasAtlas === true, '/reload did not keep Atlas');

      debug('sending /new');
      sendText(pane, '/new');
      sendKeys(pane, 'enter');
      const newStarted = await waitOutput(pane, 'New session started', { timeout: 30000 });
      expect(newStarted.code === 0, '/new did not start a new session');
      await waitReady(pane);
      await submitNewTurn();
      debug('new session turn done');
      current.checks.newSession = {
        systemPromptHasAtlas: String(state.prompts.new).includes('piomo-primary-agent:begin id=atlas'),
        systemPromptHasAnyMarker: String(state.prompts.new).includes('piomo-primary-agent:begin'),
        systemPromptTail: state.tails.new ?? null,
        modelChanges: modelChanges(sessionEntries(current.checks.newSessionFile)),
        footer: footerOf(readRecent(pane)),
      };
      expect(current.checks.newSession.systemPromptHasAtlas === false, '/new kept Atlas');
      expect(current.checks.newSession.systemPromptHasAnyMarker === false, '/new kept an overlay');
      // Q4: a fresh session with no roster pin keeps the host start model, so the
      // extension never calls setSessionModel for it.
      expect(!current.checks.newSession.modelChanges.some(entry => entry.source === 'extension'),
        '/new called setSessionModel without a Sisyphus pin');

      return { ok: true, checks: current.checks };
    },
  });
  return record;
}

const invokedDirectly = process.argv[1]?.endsWith('s7.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s7.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
