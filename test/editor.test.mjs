import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUSY_NOTICE, createPrimaryAgentEditor, isPathOrCommandToken, tokenBeforeCursor,
} from '../src/ui/editor.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';
const KEYBINDINGS = {
  matches(data, action) {
    if (action === 'tui.input.tab') return data === TAB;
    if (action === 'app.thinking.cycle') return data === SHIFT_TAB;
    return false;
  },
};

class FakeBase {
  constructor(tui, theme, keybindings) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.text = '';
    this.cursor = { line: 0, col: 0 };
    this.autocomplete = false;
    this.superCalls = [];
    this.events = [];
    this.borderColor = '#ABC123';
  }

  handleInput(data) {
    this.superCalls.push(data);
    this.events.push(`super:${data}`);
  }

  isShowingAutocomplete() {
    return this.autocomplete;
  }

  getText() {
    return this.text;
  }

  getLines() {
    return this.text.split('\n');
  }

  getCursor() {
    return { ...this.cursor };
  }
}

function editorFor(overrides = {}) {
  const calls = { cycles: 0, intents: 0, notices: [] };
  const Editor = createPrimaryAgentEditor(overrides.Base ?? FakeBase);
  const editor = new Editor(null, null, KEYBINDINGS, {
    keybindings: KEYBINDINGS,
    isStreaming: () => overrides.streaming === true,
    isSwitchInFlight: () => overrides.switching === true,
    onCycle: () => { calls.cycles += 1; },
    onThinkingIntent: () => {
      calls.intents += 1;
      editor.events.push('intent');
    },
    notify: (message, type) => calls.notices.push([message, type]),
  });
  editor.text = overrides.text ?? '';
  editor.cursor = overrides.cursor ?? { line: 0, col: editor.text.split('\n')[0].length };
  editor.autocomplete = overrides.autocomplete === true;
  return { editor, calls };
}

test('editor: createPrimaryAgentEditor returns a Base subclass', () => {
  const Editor = createPrimaryAgentEditor(FakeBase);
  assert.equal(Object.getPrototypeOf(Editor.prototype), FakeBase.prototype);
  assert.throws(() => createPrimaryAgentEditor(undefined), /requires the host editor base class/);
});

test('editor: the subclass never replaces the host borderColor', () => {
  const { editor } = editorFor();
  assert.equal(editor.borderColor, '#ABC123');
  editor.handleInput(TAB);
  assert.equal(editor.borderColor, '#ABC123');
});

test('editor: Tab routing table', () => {
  const cases = [
    { name: 'autocomplete open', text: '', autocomplete: true, action: 'super' },
    { name: 'empty editor', text: '', action: 'cycle' },
    { name: 'hello', text: 'hello', action: 'cycle' },
    { name: 'hello.', text: 'hello.', action: 'cycle' },
    { name: '10:30', text: '10:30', action: 'cycle' },
    { name: '완료.', text: '완료.', action: 'cycle' },
    { name: './', text: './', action: 'super' },
    { name: '/sk', text: '/sk', action: 'super' },
    { name: 'C:\\x', text: 'C:\\x', action: 'super' },
    { name: '~', text: '~', action: 'super' },
    { name: '@f', text: '@f', action: 'super' },
    { name: 'streaming', text: 'hello', streaming: true, action: 'busy' },
    { name: 'switch in flight', text: 'hello', switching: true, action: 'busy' },
    { name: 'path while streaming', text: './', streaming: true, action: 'super' },
    { name: 'autocomplete while streaming', text: 'hello', autocomplete: true, streaming: true, action: 'super' },
  ];

  for (const entry of cases) {
    const { editor, calls } = editorFor(entry);
    editor.handleInput(TAB);
    if (entry.action === 'cycle') {
      assert.equal(calls.cycles, 1, `${entry.name}: expected cycle`);
      assert.equal(editor.superCalls.length, 0, `${entry.name}: expected no super`);
      assert.equal(calls.notices.length, 0, `${entry.name}: expected no notice`);
    } else if (entry.action === 'super') {
      assert.equal(calls.cycles, 0, `${entry.name}: expected no cycle`);
      assert.deepEqual(editor.superCalls, [TAB], `${entry.name}: expected super`);
      assert.equal(calls.notices.length, 0, `${entry.name}: expected no notice`);
    } else {
      assert.equal(calls.cycles, 0, `${entry.name}: expected no cycle`);
      assert.equal(editor.superCalls.length, 0, `${entry.name}: expected consumed`);
      assert.deepEqual(calls.notices, [[BUSY_NOTICE, 'info']], `${entry.name}: notice`);
    }
  }
});

test('editor: Shift+Tab reports the thinking intent before super', () => {
  const { editor, calls } = editorFor({ text: 'hello' });
  editor.handleInput(SHIFT_TAB);
  assert.equal(calls.intents, 1);
  assert.deepEqual(editor.events, ['intent', `super:${SHIFT_TAB}`]);
  assert.equal(calls.cycles, 0);
});

test('editor: other keys only reach super', () => {
  const { editor, calls } = editorFor({ text: 'hello' });
  editor.handleInput('a');
  assert.deepEqual(editor.superCalls, ['a']);
  assert.equal(calls.intents, 0);
  assert.equal(calls.cycles, 0);
});

test('editor: only the cursor line and text before the cursor decide the token', () => {
  const multiline = editorFor({ text: 'C:\\x\nhello', cursor: { line: 1, col: 5 } });
  multiline.editor.handleInput(TAB);
  assert.equal(multiline.calls.cycles, 1);
  assert.equal(multiline.editor.superCalls.length, 0);

  const beforeCursor = editorFor({ text: './x', cursor: { line: 0, col: 0 } });
  beforeCursor.editor.handleInput(TAB);
  assert.equal(beforeCursor.calls.cycles, 1);

  const afterWhitespace = editorFor({ text: 'hello ./', cursor: { line: 0, col: 8 } });
  afterWhitespace.editor.handleInput(TAB);
  assert.equal(afterWhitespace.calls.cycles, 0);
  assert.deepEqual(afterWhitespace.editor.superCalls, [TAB]);
});

test('editor: token helpers implement the literal path rule', () => {
  assert.equal(isPathOrCommandToken(''), false);
  assert.equal(isPathOrCommandToken('hello'), false);
  assert.equal(isPathOrCommandToken('hello.'), false);
  assert.equal(isPathOrCommandToken('10:30'), false);
  assert.equal(isPathOrCommandToken('완료.'), false);
  for (const token of ['/', '.', '~', '@', './', '/sk', 'C:\\x', 'dir/file', 'dir\\file', 'D:']) {
    assert.equal(isPathOrCommandToken(token), true, token);
  }

  const cursorEditor = {
    getText: () => 'first line\nhello ./tail',
    getLines: () => ['first line', 'hello ./tail'],
    getCursor: () => ({ line: 1, col: 8 }),
  };
  assert.equal(tokenBeforeCursor(cursorEditor), './');
});

test('editor: ui modules are SDK-free and contain no timers', () => {
  for (const file of ['label.mjs', 'editor.mjs', 'install.mjs']) {
    const source = readFileSync(join(ROOT, 'src', 'ui', file), 'utf8');
    assert.equal(source.includes('@earendil-works/pi-coding-agent'), false, `${file} imports the SDK`);
    assert.equal(source.includes('@code-yeongyu/senpi'), false, `${file} imports senpi`);
    assert.equal(/setTimeout|setInterval|setImmediate/.test(source), false, `${file} has a timer`);
  }

  const host = readFileSync(join(ROOT, 'src', 'host', 'editor-host.mjs'), 'utf8');
  assert.match(host, /from '@earendil-works\/pi-coding-agent'/);
  assert.match(host, /export const EditorBase = CustomEditor/);
});
