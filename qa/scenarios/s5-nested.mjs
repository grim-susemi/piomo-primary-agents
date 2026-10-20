// S5-only probe tool: a nested write issued through `ctx.executeTool()`,
// which carries `parentToolCallId` exactly like a call made from the eval tool.
export default function s5NestedTool(pi) {
  pi.registerTool({
    name: 'qa_nested_write',
    label: 'S5 nested write probe',
    description: 'Calls the write tool through ctx.executeTool() to prove nested calls are checked.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const outcome = await ctx.executeTool('write', {
        path: 'src/x.ts',
        content: 'nested write must be blocked',
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            nestedIsError: outcome?.isError === true,
            nestedContent: outcome?.content ?? null,
          }),
        }],
        details: { nestedIsError: outcome?.isError === true },
        isError: false,
      };
    },
  });
}
