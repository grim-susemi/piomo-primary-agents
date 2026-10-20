// Todo 8 visual QA extension. It wires the real host CustomEditor through
// installUi with a four-agent in-memory state; no model call is made. The
// driver reads the pane screen and this file's JSONL log.
import { appendFileSync } from 'node:fs';
import { installUi } from '../src/ui/install.mjs';
import { EditorBase } from '../src/host/editor-host.mjs';

const AGENTS = [
  { agentId: 'sisyphus', modelId: 'claude-mock-medium', thinking: 'medium' },
  { agentId: 'hephaestus', modelId: 'gpt-mock-fast', thinking: 'medium' },
  { agentId: 'prometheus', modelId: 'claude-mock-xhigh', thinking: 'xhigh' },
  { agentId: 'atlas', modelId: 'claude-mock-max', thinking: 'max' },
];

const LOG = process.env.PIOMO_T8_LOG;
if (!LOG) throw new Error('PIOMO_T8_LOG is required');

let index = 0;
let streaming = false;
let handle = null;
let uiContext = null;

function current() {
  return AGENTS[index];
}

function log(record) {
  appendFileSync(LOG, `${JSON.stringify(record)}\n`, 'utf8');
}

function snapshot() {
  return {
    ...current(),
    pending: false,
  };
}

function notify(message, type = 'info') {
  log({ event: 'notice', message, type });
  uiContext?.ui.notify(message, type);
}

function install(ctx, reason) {
  uiContext = ctx;
  handle = installUi(ctx, {
    EditorBase,
    snapshot,
    isStreaming: () => streaming,
    isSwitchInFlight: () => false,
    onCycle: () => {
      index = (index + 1) % AGENTS.length;
      log({ event: 'cycle', agentId: current().agentId });
      notify(`T8CYCLE:${current().agentId}`);
      handle?.refresh();
    },
    onThinkingIntent: () => {
      log({ event: 'thinking_intent', agentId: current().agentId });
      notify('T8THINK:intent');
    },
    notify: (message, type) => notify(message, type),
  });
  log({
    event: 'install',
    reason,
    editorInstalled: handle.editorInstalled,
    labelOnly: handle.labelOnly,
    warning: handle.warning,
  });
  ctx.ui.notify(`T8${reason === 'session_start' ? 'INSTALL' : 'REINSTALL'}:${handle.editorInstalled ? 'editor' : 'label-only'}`, 'info');
}

export default function task8Tui(pi) {
  log({ event: 'factory', sessionKind: pi.sessionKind });

  pi.registerCommand('t8-stream', {
    description: 'Todo 8 QA: toggle the streaming flag for Tab routing.',
    handler: async (args, ctx) => {
      streaming = args.trim() === 'on';
      log({ event: 'stream', streaming });
      ctx.ui.notify(`T8STREAM:${streaming ? 'on' : 'off'}`, 'info');
    },
  });

  pi.registerCommand('t8-set', {
    description: 'Todo 8 QA: set the editor text.',
    requiresArguments: true,
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(args);
      log({ event: 'set_text', text: args });
      ctx.ui.notify(`T8SET:${args}`, 'info');
    },
  });

  pi.registerCommand('t8-reinstall', {
    description: 'Todo 8 QA: install the editor after the host finished starting.',
    handler: async (_args, ctx) => install(ctx, 'command'),
  });

  pi.registerShortcut('ctrl+shift+y', {
    description: 'Todo 8 QA: reinstall the editor after startup.',
    handler: ctx => install(ctx, 'shortcut'),
  });

  pi.registerShortcut('ctrl+shift+u', {
    description: 'Todo 8 QA: put a path token in the editor.',
    handler: ctx => {
      ctx.ui.setEditorText('./');
      log({ event: 'set_text', text: './' });
      ctx.ui.notify('T8SET:./', 'info');
    },
  });

  pi.registerShortcut('ctrl+shift+i', {
    description: 'Todo 8 QA: clear the editor.',
    handler: ctx => {
      ctx.ui.setEditorText('');
      log({ event: 'set_text', text: '' });
      ctx.ui.notify('T8CLEAR', 'info');
    },
  });

  pi.registerShortcut('ctrl+shift+o', {
    description: 'Todo 8 QA: toggle the streaming flag.',
    handler: ctx => {
      streaming = !streaming;
      log({ event: 'stream', streaming });
      ctx.ui.notify(`T8STREAM:${streaming ? 'on' : 'off'}`, 'info');
    },
  });

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    install(ctx, 'session_start');
  });
}
