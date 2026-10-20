// Local QA fixture. It registers one OpenAI-compatible provider whose models
// are served by qa/harness.mjs. It is never loaded outside a disposable run.
export const PROVIDER_ID = 'qa-mock';
export const MOCK_API_KEY = 'local-fixture-not-a-credential';

export const MOCK_MODEL_IDS = [
  'claude-mock-medium',
  'claude-mock-max',
  'claude-mock-xhigh',
  'gpt-mock-fast',
  'gpt-mock-sol',
  'gpt-mock-astra',
];

export const MOCK_MODELS = MOCK_MODEL_IDS.map(id => ({
  id,
  name: `QA ${id}`,
  reasoning: true,
  input: ['text'],
  contextWindow: 200000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStore: false, supportsDeveloperRole: false },
}));

export default function mockProvider(pi) {
  const baseUrl = process.env.PIOMO_QA_MOCK_URL;
  if (!baseUrl) return;
  pi.registerProvider(PROVIDER_ID, {
    name: 'PiOMO local QA mock',
    baseUrl,
    api: 'openai-completions',
    apiKey: MOCK_API_KEY,
    models: MOCK_MODELS,
  });
}
