// Wiring for the primary-agent editor, label, footer status and title.
//
// The only caller is the extension's TUI main-session start (todo 9). The state
// object is deliberately small:
//
//   snapshot()            -> {agentId, modelId, thinking, pending?}
//   isStreaming()         -> boolean
//   isSwitchInFlight()    -> boolean
//   onCycle()             -> switch to the next agent
//   onThinkingIntent()    -> report a Shift+Tab thinking change
//   EditorBase            -> host CustomEditor (src/host/editor-host.mjs)
//   notify?               -> optional override for ctx.ui.notify
//
// `installUi` never touches borderColor and never registers a shortcut. The
// host copies the thinking-coloured border onto the custom editor itself
// (SENPI/dist/modes/interactive/interactive-mode.js:3407-3409).
import { renderLabel, resolveAgent } from './label.mjs';
import { createPrimaryAgentEditor } from './editor.mjs';

export const WIDGET_KEY = 'primary-agent';
export const STATUS_KEY = 'primary-agent';
export const SLOT_TAKEN_WARNING = '다른 확장이 입력창을 이미 사용 중이라 Tab 전환을 켤 수 없어요. 라벨만 표시할게요.';

// Probe P10 scanned every loaded extension: none calls setTitle, so this
// extension may own the terminal title.
export const TITLE_OWNER_FREE = true;

const OWN_FACTORY = Symbol('piomo-primary-agent-editor');
const warnedUis = new WeakSet();

function agentFor(snapshot) {
  return resolveAgent(snapshot?.agentId ?? snapshot?.agent);
}

function assertState(state) {
  if (typeof state?.snapshot !== 'function') {
    throw new TypeError('installUi requires state.snapshot()');
  }
}

/**
 * Install the editor (only into a free slot), the below-editor label, the
 * footer status and the title. Repeating the call refreshes the label data
 * instead of warning again, and reinstalls the editor if the host dropped it.
 *
 * @param {{ui: object}} ctx
 * @param {object} state
 * @returns {{editorInstalled: boolean, labelOnly: boolean, warning: string|null, refresh: () => void, widgetKey: string, statusKey: string}}
 */
export function installUi(ctx, state) {
  const ui = ctx?.ui;
  if (!ui) {
    return {
      editorInstalled: false,
      labelOnly: true,
      warning: null,
      refresh() {},
      widgetKey: WIDGET_KEY,
      statusKey: STATUS_KEY,
    };
  }
  assertState(state);
  state.snapshot();

  let editorInstalled = false;
  let warning = null;

  const existing = typeof ui.getEditorComponent === 'function' ? ui.getEditorComponent() : undefined;
  if (existing === undefined || existing === null) {
    if (typeof state.EditorBase !== 'function') {
      throw new TypeError('installUi requires state.EditorBase (src/host/editor-host.mjs)');
    }
    const factory = (tui, theme, keybindings) => {
      const Editor = createPrimaryAgentEditor(state.EditorBase);
      return new Editor(tui, theme, keybindings, {
        keybindings,
        isStreaming: () => state.isStreaming?.() === true,
        isSwitchInFlight: () => state.isSwitchInFlight?.() === true,
        onCycle: () => state.onCycle?.(),
        onThinkingIntent: () => state.onThinkingIntent?.(),
        notify: (message, type) => {
          if (typeof state.notify === 'function') state.notify(message, type);
          else ui.notify?.(message, type);
        },
      });
    };
    factory[OWN_FACTORY] = true;
    ui.setEditorComponent(factory);
    editorInstalled = true;
  } else if (existing[OWN_FACTORY] === true) {
    editorInstalled = true;
  } else {
    warning = SLOT_TAKEN_WARNING;
    if (!warnedUis.has(ui)) {
      warnedUis.add(ui);
      ui.notify?.(SLOT_TAKEN_WARNING, 'warning');
    }
  }

  const refresh = () => {
    const agent = agentFor(state.snapshot());
    ui.setStatus(STATUS_KEY, agent.name);
    if (TITLE_OWNER_FREE) ui.setTitle(`PiOMO · ${agent.name}`);
  };

  const component = {
    render(width) {
      const snapshot = state.snapshot();
      return [renderLabel({
        agent: snapshot?.agentId ?? snapshot?.agent,
        modelId: snapshot?.modelId,
        thinking: snapshot?.thinking,
        pending: snapshot?.pending === true,
        width,
      })];
    },
    invalidate() {},
    dispose() {},
  };

  ui.setWidget(WIDGET_KEY, () => component, { placement: 'belowEditor' });
  refresh();

  return {
    editorInstalled,
    labelOnly: !editorInstalled,
    warning,
    refresh,
    widgetKey: WIDGET_KEY,
    statusKey: STATUS_KEY,
  };
}
