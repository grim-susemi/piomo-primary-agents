// Who is allowed to act: exactly the interactive TUI main session.
//
// P4 (todo 2, `task-2-piomo-primary-agents-probes.md`) measured the real
// signals: the parent main session reports `sessionKind: "interactive"`,
// `ctx.mode: "print"`, `ctx.hasUI: false`; a `task` child opened as an RPC
// session reports `sessionKind: "interactive"`, `ctx.mode: "rpc"`,
// `ctx.hasUI: true`. Neither `sessionKind` nor `hasUI` alone separates them;
// `ctx.mode === "tui"` does. This module is pure so every handler can call it
// before touching state.

export const PRIMARY_SESSION_KIND = 'interactive';
export const PRIMARY_MODE = 'tui';

/**
 * P4 decision: an interactive TUI session with a UI is the primary main
 * session. Print/json/rpc runs and worker sessions are never primary main.
 *
 * @param {{sessionKind?: string, mode?: string, hasUI?: boolean}} signals
 * @returns {boolean}
 */
export function isPrimaryMain(signals = {}) {
  const { sessionKind, mode, hasUI } = signals ?? {};
  return sessionKind === PRIMARY_SESSION_KIND && mode === PRIMARY_MODE && hasUI === true;
}

/**
 * Convenience adapter for handlers that hold the live `pi` and `ctx`.
 *
 * @param {{sessionKind?: string}} pi
 * @param {{mode?: string, hasUI?: boolean}} ctx
 * @returns {boolean}
 */
export function isPrimaryMainSession(pi, ctx) {
  return isPrimaryMain({
    sessionKind: pi?.sessionKind,
    mode: ctx?.mode,
    hasUI: ctx?.hasUI,
  });
}
