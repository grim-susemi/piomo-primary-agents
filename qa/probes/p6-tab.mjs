// P6 probe: a CustomEditor subclass that logs tui.input.tab matches, the
// autocomplete state and the token before the cursor for each case. It never
// consumes Tab; super.handleInput is always called so path/slash completion can
// still open.
import { appendFileSync } from 'node:fs';
import { CustomEditor } from '@earendil-works/pi-coding-agent';

const PATH_LIKE = /[/\\\.~@:]/;

export default function p6Tab(pi) {
  const out = process.env.PIOMO_P6_LOG;
  if (!out) throw new Error('PIOMO_P6_LOG is required');
  const log = record => appendFileSync(out, `${JSON.stringify(record)}\n`, 'utf8');
  let currentCase = '';
  let factoryCalls = 0;
  let installs = 0;
  let caseIndex = -1;
  const CASES = [
    ['empty', ''],
    ['hello', 'hello'],
    ['hello-dot', 'hello.'],
    ['time', '10:30'],
    ['korean', '완료.'],
    ['dot-slash', './'],
    ['slash-sk', '/sk'],
    ['cdrive', 'C:\\'],
    ['list-open', './'],
  ];

  log({ event: 'factory', sessionKind: pi.sessionKind });

  function installEditor(ctx) {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      factoryCalls += 1;
      const editor = new ProbeEditor(tui, theme, keybindings, {
        log,
        keybindings,
        notify: (message, level) => ctx.ui.notify(message, level),
        currentCase: () => currentCase,
        factoryCall: factoryCalls,
      });
      return editor;
    });
    installs += 1;
    log({ event: 'editor_installed', install: installs, factoryCalls });
    ctx.ui.notify(`P6INSTALL:ok:${installs}`, 'info');
  }

  pi.registerCommand('probe-case', {
    description: 'Set the editor text for one P6 case: /probe-case <name>|<text>',
    requiresArguments: true,
    handler: async (args, ctx) => {
      const [name, ...rest] = args.split('|');
      currentCase = name.trim();
      const text = rest.join('|');
      ctx.ui.setEditorText(text);
      log({ event: 'case_set', case: currentCase, text, mode: ctx.mode, hasUI: ctx.hasUI });
      ctx.ui.notify(`P6CASE:${currentCase}`, 'info');
    },
  });

  pi.registerCommand('probe-install', {
    description: 'Install the P6 Tab editor after the TUI is fully up.',
    handler: async (args, ctx) => installEditor(ctx),
  });

  // A shortcut dispatches before editor input, so it sets each case's text
  // regardless of the editor's previous value.
  pi.registerShortcut('ctrl+shift+y', {
    description: 'P6 probe: load the next Tab case.',
    handler: (ctx) => {
      caseIndex += 1;
      const entry = CASES[caseIndex];
      if (!entry) {
        log({ event: 'cases_done', index: caseIndex });
        return;
      }
      const [name, text] = entry;
      currentCase = name;
      ctx.ui.setEditorText(text);
      log({ event: 'case_set', case: name, text, mode: ctx.mode, hasUI: ctx.hasUI, index: caseIndex });
      ctx.ui.notify(`P6CASE:${name}`, 'info');
    },
  });

  pi.on('session_start', (event, ctx) => {
    if (ctx.mode !== 'tui' || !ctx.hasUI) return;
    installEditor(ctx);
  });
}

class ProbeEditor extends CustomEditor {
  constructor(tui, theme, keybindings, options) {
    super(tui, theme, keybindings);
    this.options = options;
    this.lastTab = null;
    this.renderWatch = 0;
    this.watchToken = '';
    this.watchCase = '';
  }

  render(width) {
    const lines = super.render(width);
    if (this.renderWatch > 0) {
      this.renderWatch -= 1;
      const open = this.isShowingAutocomplete();
      this.options.log({
        event: 'tab_render',
        case: this.watchCase,
        tokenBefore: this.watchToken,
        autocompleteAfterRender: open,
        remaining: this.renderWatch,
      });
      if (open) {
        this.options.notify(`P6RENDER:${this.watchCase}:open`, 'info');
        this.renderWatch = 0;
      }
    }
    return lines;
  }

  tokenBeforeCursor() {
    const cursor = this.getCursor();
    const lines = this.getText().split('\n');
    const line = lines[cursor.line] ?? '';
    const before = line.slice(0, cursor.col);
    const match = /[^\s]*$/u.exec(before);
    return { token: match ? match[0] : '', cursor, before };
  }

  handleInput(data) {
    const isTab = this.options.keybindings.matches(data, 'tui.input.tab');
    const { token, cursor } = this.tokenBeforeCursor();
    const autocompleteBefore = this.isShowingAutocomplete();
    const caseName = this.options.currentCase();
    if (isTab || this.lastTab !== null) {
      this.options.log({
        event: isTab ? 'tab' : 'next_input',
        case: caseName,
        data,
        tokenBefore: token,
        pathLike: PATH_LIKE.test(token),
        autocompleteBefore,
        previousTabAutocomplete: this.lastTab,
        textLength: this.getText().length,
        cursor,
      });
      if (isTab) {
        this.options.notify(`P6TAB:${caseName}:${token}:${autocompleteBefore ? 'open' : 'closed'}`, 'info');
      } else {
        this.options.notify(`P6NEXT:${caseName}:${autocompleteBefore ? 'open' : 'closed'}`, 'info');
        this.lastTab = null;
      }
    }
    super.handleInput(data);
    if (isTab) {
      this.lastTab = { case: caseName, token, autocompleteAfterSuper: this.isShowingAutocomplete() };
      this.watchToken = token;
      this.watchCase = caseName;
      this.renderWatch = 20;
      this.options.log({
        event: 'tab_after_super',
        case: caseName,
        tokenBefore: token,
        autocompleteAfterSuper: this.isShowingAutocomplete(),
        textAfter: this.getText(),
      });
    }
  }
}
