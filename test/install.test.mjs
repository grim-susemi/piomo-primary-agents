import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderLabel } from '../src/ui/label.mjs';
import {
  SLOT_TAKEN_WARNING, STATUS_KEY, WIDGET_KEY, installUi,
} from '../src/ui/install.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAB = '\t';

class FakeBase {
  constructor(tui, theme, keybindings) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.text = '';
    this.cursor = { line: 0, col: 0 };
    this.autocomplete = false;
    this.borderColor = '#ABC123';
    this.superCalls = [];
  }

  handleInput(data) {
    this.superCalls.push(data);
  }

  isShowingAutocomplete() {
    return this.autocomplete;
  }

  getText() {
    return this.text;
  }

  getLines() {
    return [this.text];
  }

  getCursor() {
    return { ...this.cursor };
  }
}

function fakeUi(existingFactory = undefined) {
  const calls = { editor: 0, notify: [], status: [], title: [], widget: [] };
  let factory = existingFactory;
  const ui = {
    getEditorComponent() {
      return factory;
    },
    setEditorComponent(next) {
      calls.editor += 1;
      factory = next;
    },
    setWidget(key, content, options) {
      calls.widget.push({ key, content, options });
    },
    setStatus(key, text) {
      calls.status.push({ key, text });
    },
    setTitle(title) {
      calls.title.push(title);
    },
    notify(message, type) {
      calls.notify.push({ message, type });
    },
  };
  return {
    ui,
    calls,
    factory: () => factory,
    resetFactory() { factory = undefined; },
  };
}

function fakeState(initial = {}) {
  let snapshot = {
    agentId: 'sisyphus',
    modelId: 'claude-opus-5-5',
    thinking: 'medium',
    pending: false,
    ...initial,
  };
  const calls = { cycles: 0, intents: 0, notices: [] };
  const state = {
    EditorBase: FakeBase,
    snapshot: () => ({ ...snapshot }),
    isStreaming: () => false,
    isSwitchInFlight: () => false,
    onCycle: () => { calls.cycles += 1; },
    onThinkingIntent: () => { calls.intents += 1; },
    notify: (message, type) => calls.notices.push([message, type]),
  };
  return {
    state,
    calls,
    set(next) { snapshot = { ...snapshot, ...next }; },
    get: () => ({ ...snapshot }),
  };
}

test('install: free slot installs the editor, below-editor label, status and title', () => {
  const { ui, calls, factory } = fakeUi();
  const { state, calls: stateCalls } = fakeState();
  const handle = installUi({ ui }, state);

  assert.equal(handle.editorInstalled, true);
  assert.equal(handle.labelOnly, false);
  assert.equal(handle.warning, null);
  assert.equal(calls.editor, 1);
  assert.deepEqual(calls.notify, []);
  assert.equal(calls.widget.length, 1);
  assert.equal(calls.widget[0].key, WIDGET_KEY);
  assert.equal(calls.widget[0].key, 'primary-agent');
  assert.deepEqual(calls.widget[0].options, { placement: 'belowEditor' });
  assert.deepEqual(calls.status.at(-1), { key: STATUS_KEY, text: 'Sisyphus' });
  assert.equal(calls.title.at(-1), 'PiOMO · Sisyphus');

  const component = calls.widget[0].content(null, null);
  const line = component.render(80);
  assert.deepEqual(line, [renderLabel({
    agent: 'sisyphus',
    modelId: 'claude-opus-5-5',
    thinking: 'medium',
    pending: false,
    width: 80,
  })]);

  const editor = factory()(null, null, {
    matches(data, action) {
      return action === 'tui.input.tab' && data === TAB;
    },
  });
  assert.ok(editor instanceof FakeBase);
  assert.equal(editor.borderColor, '#ABC123');
  editor.handleInput(TAB);
  assert.equal(stateCalls.cycles, 1);
  assert.equal(editor.superCalls.length, 0);
});

test('install: refresh follows the live snapshot for status, title and label', () => {
  const { ui, calls } = fakeUi();
  const fixture = fakeState();
  const handle = installUi({ ui }, fixture.state);
  const component = calls.widget[0].content(null, null);

  fixture.set({ agentId: 'atlas', modelId: 'glm-5.3', thinking: 'max', pending: true });
  handle.refresh();

  assert.deepEqual(calls.status.at(-1), { key: STATUS_KEY, text: 'Atlas' });
  assert.equal(calls.title.at(-1), 'PiOMO · Atlas');
  assert.ok(component.render(100)[0].includes('Atlas'));
  assert.ok(component.render(100)[0].includes('(대기)'));
});

test('install: an owned editor slot warns exactly once and runs label-only', () => {
  const other = () => 'other extension editor';
  const { ui, calls, factory } = fakeUi(other);
  const { state } = fakeState();

  const first = installUi({ ui }, state);
  assert.equal(first.editorInstalled, false);
  assert.equal(first.labelOnly, true);
  assert.equal(first.warning, SLOT_TAKEN_WARNING);
  assert.equal(calls.editor, 0);
  assert.equal(factory(), other);
  assert.equal(calls.notify.length, 1);
  assert.deepEqual(calls.notify[0], { message: SLOT_TAKEN_WARNING, type: 'warning' });
  assert.equal(calls.widget.length, 1);
  assert.deepEqual(calls.status.at(-1), { key: STATUS_KEY, text: 'Sisyphus' });
  assert.equal(calls.title.at(-1), 'PiOMO · Sisyphus');

  const second = installUi({ ui }, state);
  assert.equal(second.labelOnly, true);
  assert.equal(calls.editor, 0);
  assert.equal(calls.notify.length, 1, 'the warning must not repeat');
});

test('install: repeating on our own factory does not warn or duplicate the editor', () => {
  const { ui, calls } = fakeUi();
  const { state } = fakeState();
  installUi({ ui }, state);
  const second = installUi({ ui }, state);
  assert.equal(second.editorInstalled, true);
  assert.equal(calls.editor, 1);
  assert.equal(calls.notify.length, 0);
});

test('install: a host reset reinstalls the editor without warning', () => {
  const { ui, calls, resetFactory } = fakeUi();
  const { state } = fakeState();
  installUi({ ui }, state);
  resetFactory();
  const second = installUi({ ui }, state);
  assert.equal(second.editorInstalled, true);
  assert.equal(calls.editor, 2);
  assert.equal(calls.notify.length, 0);
});

test('install: hosts without getEditorComponent get the editor', () => {
  const calls = { editor: 0, widget: [], status: [], title: [], notify: [] };
  const ui = {
    setEditorComponent() { calls.editor += 1; },
    setWidget(key, content, options) { calls.widget.push({ key, content, options }); },
    setStatus(key, text) { calls.status.push({ key, text }); },
    setTitle(title) { calls.title.push(title); },
    notify(message, type) { calls.notify.push({ message, type }); },
  };
  const { state } = fakeState();
  const handle = installUi({ ui }, state);
  assert.equal(handle.editorInstalled, true);
  assert.equal(calls.editor, 1);
});

test('install: programmer errors are loud', () => {
  const { ui } = fakeUi();
  assert.throws(() => installUi({ ui }, {}), /state\.snapshot\(\)/);
  const state = { snapshot: () => ({ agentId: 'sisyphus' }) };
  assert.throws(() => installUi({ ui }, state), /state\.EditorBase/);
  const noUi = installUi({}, { snapshot: () => ({}) });
  assert.equal(noUi.editorInstalled, false);
  assert.equal(noUi.labelOnly, true);
  assert.equal(noUi.warning, null);
  assert.equal(typeof noUi.refresh, 'function');
  assert.equal(noUi.widgetKey, WIDGET_KEY);
  assert.equal(noUi.statusKey, STATUS_KEY);
});

test('install: source has no shortcut registration, borderColor write or timer', () => {
  const source = readFileSync(join(ROOT, 'src', 'ui', 'install.mjs'), 'utf8');
  assert.equal(source.includes('registerShortcut'), false);
  assert.equal(source.includes('borderColor'), true, 'the comment documents that it is untouched');
  assert.equal(/\.borderColor\s*=/.test(source), false);
  assert.equal(/setTimeout|setInterval|setImmediate/.test(source), false);
});
