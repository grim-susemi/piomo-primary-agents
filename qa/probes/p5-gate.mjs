// P5 probe: an editor whose onSubmit wrap rewrites the owner's "probe request"
// to "/skill:ulw-plan probe request", plus a command that sends the same text
// through pi.sendUserMessage (source: extension). Logs the task tool outcome so
// the gate's admitted/refused verdict is observed, and cancels any admitted
// child immediately.
import { appendFileSync } from 'node:fs';
import { CustomEditor } from '@earendil-works/pi-coding-agent';

export default function p5Gate(pi) {
  const out = process.env.PIOMO_P5_LOG;
  if (!out) throw new Error('PIOMO_P5_LOG is required');
  const log = record => appendFileSync(out, `${JSON.stringify(record)}\n`, 'utf8');

  log({ event: 'factory', sessionKind: pi.sessionKind });
  let factoryCalls = 0;
  let installs = 0;
  let lastEditor = null;
  let lastWrapper = null;

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
      const forwarded = text === 'probe request' ? '/skill:ulw-plan probe request' : text;
      log({ event: 'submit_wrap', ownerText: text, forwarded, rewritten: forwarded !== text });
      ctx.ui.notify(forwarded === text ? 'P5WRAP:unchanged' : 'P5WRAP:rewritten', 'info');
      hostSubmit?.(forwarded);
    };
    if (current) current.onSubmit = wrapper;
    lastWrapper = wrapper;
    installs += 1;
    log({
      event: 'editor_installed',
      install: installs,
      hostSubmitAssigned: typeof hostSubmit === 'function',
      liveOnSubmitIsWrapper: current?.onSubmit === wrapper,
    });
    ctx.ui.notify(`P5INSTALL:${current?.onSubmit === wrapper ? 'ok' : 'failed'}`, 'info');
  }

  pi.on('session_start', (event, ctx) => {
    log({ event: 'session_start', reason: event.reason, mode: ctx.mode, hasUI: ctx.hasUI });
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    installEditor(ctx);
  });

  pi.registerCommand('probe-install', {
    description: 'Install the gate editor after the TUI is fully up.',
    handler: async (args, ctx) => installEditor(ctx),
  });

  pi.registerCommand('probe-send', {
    description: 'Send "probe request" through pi.sendUserMessage (extension source).',
    handler: async () => {
      log({ event: 'send_user_message', text: 'probe request', source: 'extension' });
      pi.sendUserMessage('probe request');
    },
  });

  pi.on('input', (event) => {
    log({
      event: 'input_event',
      text: event.text.slice(0, 120),
      source: event.source,
      factoryCalls,
      installs,
      liveOnSubmitIsWrapper: Boolean(lastEditor && lastEditor.onSubmit === lastWrapper),
    });
  });

  pi.on('tool_call', (event) => {
    if (!['task', 'read'].includes(event.toolName)) return;
    log({ event: 'tool_call', toolName: event.toolName, input: JSON.stringify(event.input ?? null).slice(0, 800) });
  });

  pi.on('tool_result', async (event, ctx) => {
    if (!['task', 'read'].includes(event.toolName)) return;
    const serialized = JSON.stringify({
      content: event.content ?? null,
      details: event.details ?? null,
      structuredContent: event.structuredContent ?? null,
      isError: event.isError === true,
    });
    log({
      event: 'tool_result',
      toolName: event.toolName,
      isError: event.isError === true,
      result: serialized.slice(0, 3000),
    });
    if (event.toolName !== 'task') return;
    const denied = /"status"\s*:\s*"denied"|policy_denied|is plan-gated/.test(serialized);
    log({ event: 'task_verdict', verdict: denied ? 'refused' : 'admitted', isError: event.isError === true });
    ctx.ui.notify(`P5TASK:${denied ? 'refused' : 'admitted'}`, 'info');
    if (denied) return;
    const match = /"task_id"\s*:\s*"([^"]+)"/.exec(serialized);
    if (!match) {
      log({ event: 'task_cancel', cancelled: false, reason: 'no task_id in result' });
      return;
    }
    try {
      const outcome = await pi.executeTool('task_cancel', { task_id: match[1] });
      log({
        event: 'task_cancel',
        taskId: match[1],
        cancelled: true,
        outcome: JSON.stringify(outcome ?? null).slice(0, 800),
      });
    } catch (error) {
      log({ event: 'task_cancel', taskId: match[1], cancelled: false, error: String(error?.message ?? error) });
    }
  });
}
