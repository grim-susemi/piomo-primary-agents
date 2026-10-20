// Todo 8 failure scenario: the editor slot is already owned by a fake
// extension. installUi must leave that factory alone, install the label,
// status and title, and emit exactly one warning even when called twice.
import { renderLabel, stripAnsi } from '../src/ui/label.mjs';
import {
  SLOT_TAKEN_WARNING, STATUS_KEY, WIDGET_KEY, installUi,
} from '../src/ui/install.mjs';

const calls = {
  editor: 0,
  warnings: [],
  status: [],
  title: [],
  widget: [],
};
const otherFactory = () => 'fake extension editor';
const ui = {
  getEditorComponent: () => otherFactory,
  setEditorComponent() { calls.editor += 1; },
  setWidget(key, content, options) { calls.widget.push({ key, content, options }); },
  setStatus(key, text) { calls.status.push({ key, text }); },
  setTitle(title) { calls.title.push(title); },
  notify(message, type) {
    if (type === 'warning') calls.warnings.push(message);
  },
};
const state = {
  EditorBase: class {},
  snapshot: () => ({
    agentId: 'sisyphus',
    modelId: 'claude-opus-5-5',
    thinking: 'medium',
    pending: false,
  }),
  isStreaming: () => false,
  isSwitchInFlight: () => false,
  onCycle() { throw new Error('label-only mode must not cycle'); },
  onThinkingIntent() {},
};

const first = installUi({ ui }, state);
const second = installUi({ ui }, state);
const component = calls.widget[0]?.content?.(null, null);
const line = component?.render(80)?.[0] ?? '';

const checks = {
  editorSlotUntouched: calls.editor === 0,
  editorInstalledFalse: first.editorInstalled === false && second.editorInstalled === false,
  labelOnly: first.labelOnly === true && second.labelOnly === true,
  exactlyOneWarning: calls.warnings.length === 1,
  warningText: calls.warnings[0] === SLOT_TAKEN_WARNING,
  widgetKey: calls.widget[0]?.key === WIDGET_KEY && calls.widget[0]?.key === 'primary-agent',
  widgetPlacement: calls.widget[0]?.options?.placement === 'belowEditor',
  status: calls.status.at(-1)?.key === STATUS_KEY && calls.status.at(-1)?.text === 'Sisyphus',
  title: calls.title.at(-1) === 'PiOMO · Sisyphus',
  label: stripAnsi(line).startsWith('▌ Sisyphus  claude-opus-5-5 · medium'),
  labelMatchesRenderer: line === renderLabel({
    agent: 'sisyphus', modelId: 'claude-opus-5-5', thinking: 'medium', pending: false, width: 80,
  }),
};

console.log('task 8 - editor slot already owned by a fake extension');
console.log(`editorSlotBefore: owned`);
console.log(`setEditorComponentCalls: ${calls.editor}`);
console.log(`editorInstalled: ${first.editorInstalled}`);
console.log(`labelOnly: ${first.labelOnly}`);
console.log(`warningCount: ${calls.warnings.length}`);
console.log(`warning: ${calls.warnings[0] ?? '(none)'}`);
console.log(`widgetKey: ${calls.widget[0]?.key}`);
console.log(`widgetPlacement: ${calls.widget[0]?.options?.placement}`);
console.log(`status: ${calls.status.at(-1)?.text}`);
console.log(`title: ${calls.title.at(-1)}`);
console.log(`label80: ${stripAnsi(line)}`);

for (const [name, ok] of Object.entries(checks)) {
  if (!ok) {
    console.error(`FAIL ${name}`);
    process.exitCode = 1;
  }
}
if (process.exitCode !== 1) console.log('PASS label-only with exactly one warning');
