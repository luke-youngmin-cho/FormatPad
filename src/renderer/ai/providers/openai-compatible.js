function cleanEndpoint(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return 'https://api.openai.com/v1/chat/completions';
  if (raw.endsWith('/chat/completions')) return raw;
  return raw.replace(/\/+$/, '') + '/chat/completions';
}

async function readError(res) {
  let body = '';
  try { body = await res.text(); } catch {}
  const suffix = body ? `: ${body.slice(0, 500)}` : '';
  throw new Error(`Provider request failed (${res.status} ${res.statusText})${suffix}`);
}

async function* streamOpenAIResponse(res) {
  if (!res.ok) await readError(res);
  if (!res.body) throw new Error('Provider did not return a stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = new Map();

  function captureToolCalls(deltas) {
    for (const delta of deltas || []) {
      const index = delta.index || 0;
      const current = toolCalls.get(index) || { id: '', name: '', arguments: '' };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.name = delta.function.name;
      if (delta.function?.arguments) current.arguments += delta.function.arguments;
      toolCalls.set(index, current);
    }
  }

  function pendingToolCalls() {
    return Array.from(toolCalls.values()).filter(call => call.name);
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || '';
    for (const chunk of chunks) {
      const data = chunk
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') {
        for (const call of pendingToolCalls()) yield { type: 'tool_call', ...call };
        yield { type: 'done' };
        return;
      }
      try {
        const json = JSON.parse(data);
        const choice = json.choices?.[0] || {};
        const delta = choice.delta?.content || '';
        if (delta) yield { type: 'text', delta };
        captureToolCalls(choice.delta?.tool_calls);
        if (json.usage) yield { type: 'usage', usage: json.usage };
      } catch {
        // Ignore keep-alive or provider-specific events we do not understand yet.
      }
    }
  }
  for (const call of pendingToolCalls()) yield { type: 'tool_call', ...call };
  yield { type: 'done' };
}

export async function* streamOpenAICompatible({ endpoint, apiKey, messages, model, abortSignal, extraHeaders = {}, tools = [] }) {
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    model,
    messages,
    stream: true,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(cleanEndpoint(endpoint), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: abortSignal,
  });
  yield* streamOpenAIResponse(res);
}

export default {
  id: 'openai-compatible',
  displayName: 'OpenAI-compatible',
  models: ['gpt-4o-mini', 'llama3.1', 'qwen2.5-coder'],
  defaultModel: 'gpt-4o-mini',
  needsKey: false,
  configurableEndpoint: true,
  defaultEndpoint: 'https://api.openai.com/v1',
  costs: { input: 0.15, output: 0.60 },
  async *chat(args) {
    yield* streamOpenAICompatible(args);
  },
};
