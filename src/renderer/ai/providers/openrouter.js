import { streamOpenAICompatible } from './openai-compatible.js';

export default {
  id: 'openrouter',
  displayName: 'OpenRouter',
  models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'meta-llama/llama-3.1-8b-instruct'],
  defaultModel: 'openai/gpt-4o-mini',
  needsKey: true,
  defaultEndpoint: 'https://openrouter.ai/api/v1',
  costs: { input: 0.15, output: 0.60 },
  async *chat({ apiKey, messages, model, abortSignal, tools }) {
    if (!apiKey) throw new Error('OpenRouter API key is not set.');
    yield* streamOpenAICompatible({
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey,
      messages,
      model,
      abortSignal,
      tools,
      extraHeaders: {
        'HTTP-Referer': 'https://orpad.local',
        'X-Title': 'OrPAD',
      },
    });
  },
};
