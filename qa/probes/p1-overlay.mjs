// P1/P2 probe: append a marker block at the end of the system prompt in
// before_agent_start, and capture every provider request's system message.
// PIOMO_P1_UNSAFE=1 additionally registers a before_agent_start handler without
// {previewSafe:true} (the P2 negative / P1 prewarm-skip case).
import { appendFileSync } from 'node:fs';

const MARKER = '\n\n<!-- PIOMO_P1_MARKER_BEGIN -->\nPIOMO P1 persona overlay marker.\n<!-- PIOMO_P1_MARKER_END -->';

function log(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}

function systemText(payload) {
  if (payload === null || typeof payload !== 'object') return { text: '', shape: typeof payload };
  if (Array.isArray(payload.messages)) {
    const system = payload.messages.find(message => message?.role === 'system');
    if (system) {
      return {
        text: typeof system.content === 'string' ? system.content : JSON.stringify(system.content),
        shape: 'messages[role=system].content',
      };
    }
  }
  if (typeof payload.system === 'string') return { text: payload.system, shape: 'system:string' };
  return { text: '', shape: `keys:${Object.keys(payload).join(',')}` };
}

export default function p1Overlay(pi) {
  const out = process.env.PIOMO_P1_LOG;
  if (!out) throw new Error('PIOMO_P1_LOG is required');
  let requestIndex = 0;
  log(out, { event: 'factory', sessionKind: pi.sessionKind, unsafeExtra: process.env.PIOMO_P1_UNSAFE === '1' });

  pi.on('before_agent_start', (event) => {
    log(out, {
      event: 'before_agent_start',
      preview: event.preview === true,
      trigger: event.trigger,
      prompt: event.prompt.slice(0, 120),
      systemPromptLength: event.systemPrompt.length,
    });
    return { systemPrompt: `${event.systemPrompt}${MARKER}` };
  }, { previewSafe: true });

  if (process.env.PIOMO_P1_UNSAFE === '1') {
    pi.on('before_agent_start', (event) => {
      log(out, { event: 'before_agent_start_unsafe', preview: event.preview === true, trigger: event.trigger });
    });
  }

  pi.on('before_provider_request', (event) => {
    requestIndex += 1;
    const system = systemText(event.payload);
    log(out, {
      event: 'provider_request',
      index: requestIndex,
      model: event.model?.id ?? event.payload?.model ?? null,
      systemShape: system.shape,
      systemLength: system.text.length,
      markerPresent: system.text.includes('PIOMO_P1_MARKER_BEGIN'),
      markerLast: /<!-- PIOMO_P1_MARKER_END -->\s*$/.test(system.text),
      systemTail: system.text.slice(-160),
    });
  });

  pi.registerTool({
    name: 'p1_noop',
    label: 'P1 noop',
    description: 'Probe no-op that returns ok.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      log(out, { event: 'tool', name: 'p1_noop' });
      return { content: [{ type: 'text', text: 'p1_noop ok' }] };
    },
  });

  pi.registerTool({
    name: 'p1_preview',
    label: 'P1 preview',
    description: 'Ask the host for the prompt-cache prefix request and record the preview-skip reason.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = ctx.getPromptCachePrefixRequest
        ? await ctx.getPromptCachePrefixRequest()
        : { status: 'unavailable' };
      log(out, {
        event: 'preview_request',
        status: result?.status ?? null,
        reason: result?.reason ?? null,
        unsafeExtra: process.env.PIOMO_P1_UNSAFE === '1',
      });
      return { content: [{ type: 'text', text: `p1_preview ${JSON.stringify({ status: result?.status ?? null, reason: result?.reason ?? null })}` }] };
    },
  });

  pi.registerTool({
    name: 'p1_switch',
    label: 'P1 switch',
    description: 'Probe switch to the target mock model through pi.setSessionModel.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const targetId = process.env.PIOMO_P1_SWITCH_MODEL ?? 'gpt-mock-fast';
      const target = ctx.modelRegistry.find('qa-mock', targetId);
      const before = { provider: ctx.model?.provider ?? null, id: ctx.model?.id ?? null };
      const result = target ? await pi.setSessionModel(target) : null;
      const after = { provider: ctx.model?.provider ?? null, id: ctx.model?.id ?? null };
      const entries = ctx.sessionManager.getEntries().slice(-4);
      log(out, {
        event: 'setSessionModel', targetId, targetFound: Boolean(target), result, before, after,
        entries: entries.map(entry => ({
          type: entry.type,
          source: entry.source,
          actor: entry.actor,
          provider: entry.provider,
          modelId: entry.modelId,
          thinkingLevel: entry.thinkingLevel,
          triggerSource: entry.triggerSource,
        })),
      });
      return { content: [{ type: 'text', text: `p1_switch ${JSON.stringify({ result, before, after })}` }] };
    },
  });
}
