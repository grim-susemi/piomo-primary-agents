// Tab routing for the primary-agent editor.
//
// This module is SDK-free: the host binds CustomEditor and calls
// `createPrimaryAgentEditor(CustomEditor)` from src/host/editor-host.mjs.
//
// Decision table (probe P6 + AD9):
//   not Tab / Shift+Tab -> super (Shift+Tab first reports the thinking intent)
//   Tab, autocomplete open -> super (accept the completion)
//   Tab, path/slash-like token before the cursor -> super (completion)
//   Tab, streaming or switch in flight -> consume + one transient notice
//   Tab, anything else -> onCycle()
//
// The path/slash rule is intentionally literal: the token starts with / . ~ @,
// contains / or \, or starts with a drive prefix. A trailing dot or a time such
// as 10:30 is plain text and cycles.

export const TAB_ACTION = 'tui.input.tab';
export const THINKING_ACTION = 'app.thinking.cycle';
export const BUSY_NOTICE = '응답 중에는 에이전트를 바꿀 수 없어요';

/** True when the token before the cursor is a path or slash command. */
export function isPathOrCommandToken(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  return token.startsWith('/')
    || token.startsWith('.')
    || token.startsWith('~')
    || token.startsWith('@')
    || token.includes('/')
    || token.includes('\\')
    || /^[A-Za-z]:/.test(token);
}

/** The text after the last whitespace on the cursor's line, up to the cursor. */
export function tokenBeforeCursor(editor) {
  const cursor = typeof editor?.getCursor === 'function' ? editor.getCursor() : { line: 0, col: 0 };
  const lineIndex = Number.isInteger(cursor?.line) && cursor.line >= 0 ? cursor.line : 0;
  const lines = typeof editor?.getLines === 'function'
    ? editor.getLines()
    : String(typeof editor?.getText === 'function' ? editor.getText() : '').split('\n');
  const line = Array.isArray(lines) ? (lines[lineIndex] ?? '') : '';
  const rawCol = Number(cursor?.col);
  const col = Number.isFinite(rawCol) ? Math.max(0, Math.min(Math.floor(rawCol), line.length)) : 0;
  const before = line.slice(0, col);
  const match = /[^\s]*$/u.exec(before);
  return match ? match[0] : '';
}

/**
 * @param {new (...args: any[]) => any} Base
 * @returns {new (...args: any[]) => any}
 */
export function createPrimaryAgentEditor(Base) {
  if (typeof Base !== 'function') {
    throw new TypeError('createPrimaryAgentEditor requires the host editor base class');
  }

  return class PrimaryAgentEditor extends Base {
    constructor(tui, theme, keybindings, options = {}) {
      super(tui, theme, keybindings);
      this.primaryAgentOptions = options ?? {};
      this.primaryAgentKeybindings = options?.keybindings ?? keybindings;
    }

    handleInput(data) {
      const options = this.primaryAgentOptions;
      const keybindings = this.primaryAgentKeybindings;
      const matches = typeof keybindings?.matches === 'function'
        ? action => keybindings.matches(data, action)
        : () => false;

      if (!matches(TAB_ACTION)) {
        if (matches(THINKING_ACTION)) options.onThinkingIntent?.();
        super.handleInput(data);
        return;
      }

      if (this.isShowingAutocomplete()) {
        super.handleInput(data);
        return;
      }

      if (isPathOrCommandToken(tokenBeforeCursor(this))) {
        super.handleInput(data);
        return;
      }

      if (options.isStreaming?.() === true || options.isSwitchInFlight?.() === true) {
        options.notify?.(BUSY_NOTICE, 'info');
        return;
      }

      options.onCycle?.();
    }
  };
}
