// P2 probe: count before_agent_start handler invocations split by the
// event.preview flag. PIOMO_P2_UNSAFE=1 adds a handler registered without
// {previewSafe:true}, which should make the host skip previews entirely.
import { appendFileSync } from 'node:fs';

export default function p2Preview(pi) {
  const out = process.env.PIOMO_P2_LOG;
  if (!out) throw new Error('PIOMO_P2_LOG is required');
  const log = record => appendFileSync(out, `${JSON.stringify(record)}\n`, 'utf8');
  log({ event: 'factory', sessionKind: pi.sessionKind, unsafeExtra: process.env.PIOMO_P2_UNSAFE === '1' });
  pi.on('before_agent_start', (event) => {
    log({
      event: 'handler',
      handler: 'previewSafe',
      preview: event.preview === true,
      trigger: event.trigger,
      prompt: event.prompt.slice(0, 80),
    });
  }, { previewSafe: true });
  if (process.env.PIOMO_P2_UNSAFE === '1') {
    pi.on('before_agent_start', (event) => {
      log({ event: 'handler', handler: 'unsafe', preview: event.preview === true, trigger: event.trigger });
    });
  }

  pi.registerTool({
    name: 'p2_preview',
    label: 'P2 preview',
    description: 'Ask the host for its prompt-cache prefix request, which runs the preview pass.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const before = ctx.getPromptCachePrefixRequest ? 'available' : 'missing';
      const result = ctx.getPromptCachePrefixRequest
        ? await ctx.getPromptCachePrefixRequest()
        : { status: 'unavailable' };
      const status = result?.status ?? null;
      const reason = result?.reason ?? null;
      const systemPrompt = result?.request?.context?.systemPrompt ?? null;
      log({
        event: 'preview_request',
        availability: before,
        status,
        reason,
        hasRequest: Boolean(result?.request),
        systemPromptLength: typeof systemPrompt === 'string' ? systemPrompt.length : null,
        unsafeExtra: process.env.PIOMO_P2_UNSAFE === '1',
      });
      return { content: [{ type: 'text', text: `p2_preview ${JSON.stringify({ status, reason })}` }] };
    },
  });
}
