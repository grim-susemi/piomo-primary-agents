// S9 - Prometheus plain-language entry.
// `계획 잡아줘 데모` is sent as `/skill:ulw-plan 계획 잡아줘 데모`; the next
// Prometheus message is unchanged; a /model command is never rewritten.
import { parseArgs } from 'node:util';
import {
  expect, runTuiScenario, sessionEntries, stopStateCount, submitText, switchAgent,
  userMessages, waitSessionEntry, waitTurnEnd,
} from './lib.mjs';

export async function run({ out }) {
  return runTuiScenario({
    out,
    name: 'S9',
    label: 'PiOMO S9 plain language',
    mockOptions: { route },
    body: async (pane, record, scenario) => {
      const editor = record.checks.editorInstalled === true;
      const runTurn = async (text) => {
        const before = stopStateCount(sessionEntries(scenario.sessionFile));
        await submitText(pane, text);
        await waitTurnEnd(scenario.sessionFile, before, { timeout: 30000 }).catch(() => null);
      };
      await switchAgent(pane, scenario.sessionFile, 'prometheus');

      await runTurn('계획 잡아줘 데모');
      const firstEntries = sessionEntries(scenario.sessionFile);
      const firstUsers = userMessages(firstEntries);
      record.checks.firstUserMessages = firstUsers.map(message => message.slice(0, 400));

      await runTurn('두 번째 메시지');
      const secondEntries = sessionEntries(scenario.sessionFile);
      const secondUsers = userMessages(secondEntries);
      record.checks.secondUserMessages = secondUsers.map(message => message.slice(0, 400));

      // Positive observation of the /model path: the command must leave its own
      // model_change entry. A timeout here FAILS the scenario instead of being
      // swallowed as "nothing was rewritten".
      const beforeModelUsers = [...secondUsers];
      await submitText(pane, '/model claude-mock-max');
      const modelEntries = await waitSessionEntry(scenario.sessionFile, entry =>
        entry?.type === 'model_change' && entry.modelId === 'claude-mock-max'
        && entry.source === 'command', { timeout: 25000, label: 'model command model_change' });
      const modelChangeEntry = [...modelEntries].reverse().find(entry =>
        entry?.type === 'model_change' && entry.modelId === 'claude-mock-max'
        && entry.source === 'command') ?? null;
      record.checks.modelCommandAcknowledged = modelChangeEntry !== null;
      record.checks.modelChange = modelChangeEntry;
      expect(modelChangeEntry !== null, 'the /model command recorded no model_change');

      const afterModelUsers = userMessages(modelEntries);
      const addedUsers = afterModelUsers.slice(beforeModelUsers.length);
      record.checks.modelCommandUserMessages = afterModelUsers.map(message => message.slice(0, 400));
      record.checks.modelCommandAddedUserMessages = addedUsers.map(message => message.slice(0, 400));
      const modelNotRewritten = addedUsers.every(message => message === '/model claude-mock-max');
      record.checks.modelNotRewritten = modelNotRewritten;
      expect(modelNotRewritten,
        `the /model command was rewritten into a user message: ${JSON.stringify(addedUsers)}`);

      const rewritten = firstUsers.some(message =>
        message.includes('The user explicitly invoked the "ulw-plan" skill')
        && message.includes('계획 잡아줘 데모'));
      const secondUnchanged = secondUsers.some(message => message === '두 번째 메시지');
      record.checks.rewritten = rewritten;
      record.checks.secondUnchanged = secondUnchanged;

      const ok = editor && rewritten && secondUnchanged && modelNotRewritten
        && record.checks.modelCommandAcknowledged === true;
      return {
        ok,
        reason: ok ? null : (editor ? 'the sent user message was not rewritten; see checks'
          : 'editor_install_failed: the Prometheus rewrite lives in the onSubmit wrap'),
        checks: record.checks,
      };
    },
  });
}

// A route that answers each prompt with a distinguishable sentinel.
export function route(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = messages.at(-1)?.content;
  const joined = typeof text === 'string' ? text
    : Array.isArray(text) ? text.map(part => part?.text ?? '').join('') : '';
  if (joined.includes('계획 잡아줘')) return { text: 'S9 first done' };
  if (joined.includes('두 번째 메시지')) return { text: 'S9 second done' };
  return { text: 'S9 done' };
}

const invokedDirectly = process.argv[1]?.endsWith('s9.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s9.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
