// S10-only probe: records the loaded extension paths and the slash commands
// the host sees after every configured extension has loaded.
import { appendFileSync } from 'node:fs';

export default function s10Probe(pi) {
  const log = process.env.PIOMO_S10_LOG;
  if (!log) throw new Error('PIOMO_S10_LOG is required');
  pi.on('session_start', (_event, ctx) => {
    appendFileSync(log, `${JSON.stringify({
      event: 'session_start',
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      loadedExtensionPaths: ctx.loadedExtensionPaths ?? [],
      commands: typeof pi.getCommands === 'function'
        ? pi.getCommands().map(command => command.name)
        : null,
    })}\n`, 'utf8');
  });
}
