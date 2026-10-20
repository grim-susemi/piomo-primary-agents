// P7 probe: install a custom editor, then wrap the onSubmit the host assigns at
// interactive-mode.js:3395-3397. Logs whether /ulw-execute reaches the wrapper
// and the ordering with the extension `input` event.
import { appendFileSync } from 'node:fs';
import { CustomEditor } from '@earendil-works/pi-coding-agent';

export default function p7Submit(pi) {
  const out = process.env.PIOMO_P7_LOG;
  if (!out) throw new Error('PIOMO_P7_LOG is required');
  const log = record => appendFileSync(out, `${JSON.stringify(record)}\n`, 'utf8');
  let sequence = 0;
  let factoryCalls = 0;
  let installs = 0;
  let lastEditor = null;
  let lastWrapper = null;

  log({ event: 'factory', sessionKind: pi.sessionKind });

  function installEditor(ctx) {
    let current;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      factoryCalls += 1;
      current = new CustomEditor(tui, theme, keybindings);
      lastEditor = current;
      log({ event: 'factory_call', call: factoryCalls });
      return current;
    });
    const hostSubmit = current?.onSubmit;
    const wrapper = (text) => {
      sequence += 1;
      log({ event: 'submit_wrap', text, idle: ctx.isIdle(), sequence });
      hostSubmit?.(text);
    };
    if (current) current.onSubmit = wrapper;
    lastWrapper = wrapper;
    installs += 1;
    log({
      event: 'editor_installed',
      install: installs,
      hostSubmitAssigned: typeof hostSubmit === 'function',
      liveOnSubmitIsWrapper: Boolean(current && current.onSubmit === wrapper),
    });
    ctx.ui.notify(`P7INSTALL:${current && current.onSubmit === wrapper ? 'ok' : 'failed'}`, 'info');
  }

  pi.on('session_start', (event, ctx) => {
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    installEditor(ctx);
  });

  pi.registerCommand('probe-install', {
    description: 'Install the submit-wrap editor after the TUI is fully up.',
    handler: async (args, ctx) => installEditor(ctx),
  });

  pi.on('input', (event) => {
    sequence += 1;
    log({
      event: 'input_event',
      text: event.text,
      source: event.source,
      sequence,
      factoryCalls,
      installs,
      liveOnSubmitIsWrapper: Boolean(lastEditor && lastEditor.onSubmit === lastWrapper),
    });
  });

  pi.on('agent_start', () => log({ event: 'agent_start' }));
  pi.on('agent_end', () => log({ event: 'agent_end' }));

  pi.on('tool_call', (event) => {
    log({ event: 'tool_call', toolName: event.toolName, input: JSON.stringify(event.input ?? null).slice(0, 400) });
  });
}
