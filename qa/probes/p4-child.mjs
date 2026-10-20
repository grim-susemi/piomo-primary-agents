// P4 probe: record the session signal in the parent and in a spawned task
// child: pi.sessionKind at factory time and ctx.mode/ctx.hasUI/session file at
// session_start.
import { appendFileSync } from 'node:fs';

export default function p4Child(pi) {
  const out = process.env.PIOMO_P4_LOG;
  if (!out) throw new Error('PIOMO_P4_LOG is required');
  const log = record => appendFileSync(out, `${JSON.stringify(record)}\n`, 'utf8');
  log({
    event: 'factory',
    pid: process.pid,
    sessionKind: pi.sessionKind,
    sessionContext: pi.sessionContext,
    cwd: pi.cwd,
  });

  pi.on('session_start', (event, ctx) => {
    log({
      event: 'session_start',
      pid: process.pid,
      reason: event.reason,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      sessionKindAtFactory: pi.sessionKind,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      entries: ctx.sessionManager.getEntries().slice(0, 3).map(entry => entry.type),
    });
  });

  pi.on('tool_call', (event) => {
    if (event.toolName !== 'task') return;
    log({ event: 'tool_call', pid: process.pid, input: JSON.stringify(event.input ?? null).slice(0, 1200) });
  });

  pi.on('tool_result', (event) => {
    if (event.toolName !== 'task') return;
    log({
      event: 'task_result',
      pid: process.pid,
      isError: event.isError === true,
      content: JSON.stringify(event.content ?? null).slice(0, 3000),
      details: JSON.stringify(event.details ?? null).slice(0, 3000),
      structuredContent: JSON.stringify(event.structuredContent ?? null).slice(0, 1000),
    });
  });
}
