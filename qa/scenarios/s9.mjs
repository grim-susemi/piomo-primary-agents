// S9 - Prometheus plain-language entry.
// `계획 잡아줘 데모` is sent as `/skill:ulw-plan 계획 잡아줘 데모`; the next
// Prometheus message is unchanged; a /model command is never rewritten.
import { parseArgs } from 'node:util';
import {
  expect, readRecent, runTuiScenario, sendKeys, sendText, sessionEntries,
  submitText, userMessages, waitOutput, waitSessionEntry,
} from './lib.mjs';

export async function run({ out }) {
  return runTuiScenario({
    out,
    name: 'S9',
    label: 'PiOMO S9 plain language',
    mockOptions: { route },
    body: async (pane, record, scenario) => {
      const editor = record.checks.editorInstalled === true;
      sendText(pane, '/agent prometheus');
      sendKeys(pane, 'enter');
      await waitSessionEntry(scenario.sessionFile, entry => entry?.type === 'custom'
        && entry.customType === 'primary-agent/v1' && entry.data?.agentId === 'prometheus',
      { timeout: 25000, label: 'prometheus identity' });

      await submitText(pane, '계획 잡아줘 데모');
      await waitOutput(pane, 'S9 first done', { timeout: 30000 }).catch(() => {});
      const firstEntries = sessionEntries(scenario.sessionFile);
      record.checks.firstUserMessages = userMessages(firstEntries).map(message => message.slice(0, 400));

      await submitText(pane, '두 번째 메시지');
      await waitOutput(pane, 'S9 second done', { timeout: 30000 }).catch(() => {});
      const secondEntries = sessionEntries(scenario.sessionFile);
      record.checks.secondUserMessages = userMessages(secondEntries).map(message => message.slice(0, 400));

      await submitText(pane, '/model claude-mock-max');
      await waitSessionEntry(scenario.sessionFile, entry => entry?.type === 'model_change'
        && entry.modelId === 'claude-mock-max', { timeout: 25000, label: 'model command' }).catch(() => null);
      record.checks.modelCommandUserMessages = userMessages(sessionEntries(scenario.sessionFile))
        .map(message => message.slice(0, 400));

      const rewritten = record.checks.firstUserMessages.some(message => message.startsWith('/skill:ulw-plan 계획 잡아줘 데모'));
      const secondUnchanged = record.checks.secondUserMessages.some(message => message === '두 번째 메시지');
      const modelNotRewritten = !record.checks.modelCommandUserMessages.some(message => message.includes('/skill:ulw-plan /model'));
      record.checks.rewritten = rewritten;
      record.checks.secondUnchanged = secondUnchanged;
      record.checks.modelNotRewritten = modelNotRewritten;

      const ok = editor && rewritten && secondUnchanged && modelNotRewritten;
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
