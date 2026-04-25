import openai from './openai.js';
import anthropic from './anthropic.js';
import ollama from './ollama.js';
import openrouter from './openrouter.js';
import openaiCompatible from './openai-compatible.js';

export const providers = [openai, anthropic, ollama, openrouter, openaiCompatible];

export function getProvider(id) {
  return providers.find(provider => provider.id === id) || providers[0];
}

export function providerOptions() {
  return providers.map(provider => ({
    id: provider.id,
    displayName: provider.displayName,
    defaultModel: provider.defaultModel,
    models: provider.models,
    needsKey: provider.needsKey,
    configurableEndpoint: provider.configurableEndpoint,
  }));
}

export function estimateCostUsd(provider, inputTokens, outputTokens = 1200) {
  const costs = provider?.costs || { input: 0, output: 0 };
  return ((inputTokens / 1_000_000) * costs.input) + ((outputTokens / 1_000_000) * costs.output);
}
