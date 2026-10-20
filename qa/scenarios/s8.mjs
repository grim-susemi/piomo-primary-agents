// S8 - /ulw-execute while idle switches to Atlas and runs once; while
// streaming the text stays in the editor and the notice appears.
import { parseArgs } from 'node:util';
import {
  expect, readRecent, runTuiScenario, sendKeys, sendText, sessionEntries,
  submitText, textOfMessage, userMessages, waitOutput, waitSessionEntry,
} from './lib.mjs';

export async function run({ out }) {
  const route = (body) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages.at(-1);
    const text = textOfMessage(last);
    if (text.includes('S8 stream')) {
      return { chunks: ['S8 streaming ', 'response'], delayMs: 900 };
    }
    return { text: 'S8 done' };
  };

  return runTuiScenario({
    out,
    name: 'S8',
    label: 'PiOMO S8 execute',
    mockOptions: { route },
    body: async (pane, record, scenario) => {
      const editor = record.checks.editorInstalled === true;
      await submitText(pane, '/ulw-execute demo');
      await waitOutput(pane, 'S8 done', { timeout: 30000 });
      const afterIdle = sessionEntries(scenario.sessionFile);
      record.checks.idle = {
        identity: afterIdle.filter(entry => entry?.type === 'custom'
          && entry.customType === 'primary-agent/v1').at(-1) ?? null,
        userMessages: userMessages(afterIdle).map(message => message.slice(0, 300)),
      };
      record.checks.idleSwitchedToAtlas = record.checks.idle.identity?.data?.agentId === 'atlas';
      record.checks.idleRunsOnce = userMessages(afterIdle).filter(message => message.includes('ulw-execute')).length === 1;

      // Streaming: a slow response is in flight when /ulw-execute is submitted.
      sendText(pane, 'S8 stream');
      sendKeys(pane, 'enter');
      await waitOutput(pane, 'S8 streaming', { timeout: 20000 });
      await submitText(pane, '/ulw-execute demo');
      await waitOutput(pane, '응답이 끝난 뒤 Enter를 다시 누르면 아틀라스로 실행돼요', { timeout: 15000 }).catch(() => {});
      const streamingFrame = readRecent(pane);
      await waitOutput(pane, 'S8 streaming response', { timeout: 30000 }).catch(() => {});
      await waitOutput(pane, 'S8 done', { timeout: 30000 }).catch(() => {});
      const finalEntries = sessionEntries(scenario.sessionFile);
      record.checks.streaming = {
        notice: streamingFrame.split(/\r?\n/)
          .filter(line => line.includes('응답이 끝난 뒤 Enter를 다시 누르면')).at(0) ?? null,
        textKept: streamingFrame.includes('/ulw-execute demo'),
        userMessages: userMessages(finalEntries).map(message => message.slice(0, 300)),
        ulwExecuteMessages: userMessages(finalEntries).filter(message => message.includes('ulw-execute')).length,
      };

      const ok = editor === true
        && record.checks.idleSwitchedToAtlas === true
        && record.checks.idleRunsOnce === true
        && record.checks.streaming.notice !== null
        && record.checks.streaming.textKept === true
        && record.checks.streaming.ulwExecuteMessages === 1;
      return {
        ok,
        reason: ok ? null : (editor ? 'a submit-wrap assertion failed; see checks'
          : 'editor_install_failed: /ulw-execute needs the onSubmit wrap, which is installed with the editor'),
        checks: record.checks,
      };
    },
  });
}

const invokedDirectly = process.argv[1]?.endsWith('s8.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s8.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
