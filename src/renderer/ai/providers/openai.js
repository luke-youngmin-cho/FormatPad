import { streamOpenAICompatible } from './openai-compatible.js';

export default {
  id: 'openai',
  displayName: 'OpenAI',
  models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  defaultModel: 'gpt-4o-mini',
  needsKey: true,
  defaultEndpoint: 'https://api.openai.com/v1',
  costs: { input: 0.15, output: 0.60 },
  async *chat({ apiKey, messages, model, abortSignal, tools }) {
    if (!apiKey) throw new Error('OpenAI API key is not set.');
    yield* streamOpenAICompatible({
      endpoint: 'https://api.openai.com/v1',
      apiKey,
      messages,
      model,
      abortSignal,
      tools,
    });
  },
};
