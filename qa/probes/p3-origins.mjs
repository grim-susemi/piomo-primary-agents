// P3 probe: record factory/session_start/model_select facts and exercise
// pi.setSessionModel from a tool call. The session transcript is copied by the
// runner, so entry shapes come from the runtime's own JSONL.
import { appendFileSync } from 'node:fs';

function entryShape(entry) {
  return {
    type: entry.type,
    id: entry.id,
    parentId: entry.parentId,
    source: entry.source,
    actor: entry.actor,
    provider: entry.provider,
    modelId: entry.modelId,
    thinkingLevel: entry.thinkingLevel,
    triggerSource: entry.triggerSource,
    triggerActor: entry.triggerActor,
    reason: entry.reason,
    duringTurn: entry.duringTurn,
  };
}

export default function p3Origins(pi) {
  const out = process.env.PIOMO_P3_LOG;
  if (!out) throw new Error('PIOMO_P3_LOG is required');
  const log = record => appendFileSync(out, `${JSON.stringify(record)}\n`, 'utf8');
  log({ event: 'factory', sessionKind: pi.sessionKind, sessionContext: pi.sessionContext });

  pi.on('session_start', (event, ctx) => {
    log({
      event: 'session_start',
      reason: event.reason,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      sessionId: ctx.sessionManager.getSessionId(),
      model: { provider: ctx.model?.provider ?? null, id: ctx.model?.id ?? null },
      thinkingLevel: ctx.thinkingLevel ?? null,
      entries: ctx.sessionManager.getEntries().map(entryShape),
    });
  });

  pi.on('model_select', (event, ctx) => {
    log({
      event: 'model_select',
      source: event.source,
      model: { provider: event.model?.provider ?? null, id: event.model?.id ?? null },
      previous: event.previousModel
        ? { provider: event.previousModel.provider ?? null, id: event.previousModel.id ?? null }
        : null,
      entriesTail: ctx.sessionManager.getEntries().slice(-5).map(entryShape),
    });
  });

  pi.on('thinking_level_select', (event, ctx) => {
    log({
      event: 'thinking_level_select',
      level: event.level,
      entriesTail: ctx.sessionManager.getEntries().slice(-3).map(entryShape),
    });
  });

  pi.registerCommand('probe-dump', {
    description: 'Write the current session entries to the P3 probe log.',
    handler: async (args, ctx) => {
      const label = args.trim();
      log({
        event: 'probe_dump',
        label,
        model: { provider: ctx.model?.provider ?? null, id: ctx.model?.id ?? null },
        thinkingLevel: ctx.thinkingLevel ?? null,
        entries: ctx.sessionManager.getEntries().map(entryShape),
      });
      ctx.ui.notify(`P3DUMP:${label}`, 'info');
    },
  });

  pi.registerTool({
    name: 'p3_switch',
    label: 'P3 switch',
    description: 'Switch the session model through pi.setSessionModel and report the result.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const targetId = process.env.PIOMO_P3_SWITCH_MODEL ?? 'gpt-mock-fast';
      const target = ctx.modelRegistry.find('qa-mock', targetId);
      const before = { provider: ctx.model?.provider ?? null, id: ctx.model?.id ?? null };
      const result = target ? await pi.setSessionModel(target) : null;
      const after = { provider: ctx.model?.provider ?? null, id: ctx.model?.id ?? null };
      log({
        event: 'setSessionModel',
        targetId,
        targetFound: Boolean(target),
        result,
        before,
        after,
        heldSwitch: result === true && after.id !== targetId,
        entriesTail: ctx.sessionManager.getEntries().slice(-5).map(entryShape),
      });
      return { content: [{ type: 'text', text: `p3_switch ${JSON.stringify({ result, before, after })}` }] };
    },
  });
}
