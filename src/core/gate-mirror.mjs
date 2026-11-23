// Mirror of the installed omo-task gate, keyed by session id.
//
// The gate locks plan review after an ulw-execute run. The extension may only
// reopen it through the owner's own interactive submission; extension-originated
// input is ignored by the gate (probe P5b), so it is never recorded here either.
//
// Pure: no clocks, no I/O, no SDK. Sequences are monotonic counters, so
// "newer" is a comparison and never a timestamp.
//
//   ulw-execute <- interactive `/skill:ulw-execute` or `/ulw-execute`
//               <- a read tool_result whose path ends skills/ulw-execute/SKILL.md
//
// A process start begins with an empty mirror (the module holds no state of its
// own). Atlas/Prometheus routing no longer consumes a plan counter here; the
// installed gate owns that bookkeeping.

export const INTERACTIVE_SOURCE = 'interactive';

function commandText(text, command) {
  if (typeof text !== 'string') return false;
  if (!text.startsWith(command)) return false;
  const rest = text.slice(command.length);
  return rest.length === 0 || rest.startsWith(' ');
}

/** `/skill:ulw-execute` or `/ulw-execute`, followed by a space or the end. */
export function isUlwExecute(text) {
  return commandText(text, '/skill:ulw-execute') || commandText(text, '/ulw-execute');
}

function normalized(path) {
  return typeof path === 'string' ? path.replace(/\\/g, '/') : '';
}

/** True for a read path that loads the ulw-execute skill itself. */
export function isUlwExecuteSkillPath(path) {
  return normalized(path).endsWith('skills/ulw-execute/SKILL.md');
}

export function createGateMirror() {
  let sequence = 0;
  const sessions = new Map();

  function stateFor(sessionId) {
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'default';
    let state = sessions.get(key);
    if (!state) {
      state = { execute: 0 };
      sessions.set(key, state);
    }
    return state;
  }

  return {
    /** Record an interactive submission; anything else is ignored. */
    observeInput(sessionId, text, source = INTERACTIVE_SOURCE) {
      if (source !== INTERACTIVE_SOURCE) return { execute: false };
      const state = stateFor(sessionId);
      const execute = isUlwExecute(text);
      if (execute) {
        sequence += 1;
        state.execute = sequence;
      }
      return { execute };
    },

    ulwExecute(sessionId) {
      sequence += 1;
      stateFor(sessionId).execute = sequence;
      return sequence;
    },

    hasUlwExecute(sessionId) {
      return stateFor(sessionId).execute > 0;
    },

    /** A tool result has no source field: callers only record from a TUI main. */
    observeToolResult(sessionId, toolName, path) {
      if (toolName !== 'read' || !isUlwExecuteSkillPath(path)) return false;
      sequence += 1;
      stateFor(sessionId).execute = sequence;
      return true;
    },

    forget(sessionId) {
      const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'default';
      sessions.delete(key);
    },

    snapshot(sessionId) {
      return { execute: stateFor(sessionId).execute };
    },
  };
}
