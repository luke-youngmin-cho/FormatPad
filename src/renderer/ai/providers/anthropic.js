async function readError(res) {
  let body = '';
  try { body = await res.text(); } catch {}
  throw new Error(`Anthropic request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 500)}` : ''}`);
}

function splitSystem(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const rest = [];
  for (const msg of messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))) {
    const prev = rest[rest.length - 1];
    if (prev?.role === msg.role) prev.content += `\n\n${msg.content}`;
    else rest.push(msg);
  }
  return { system, messages: rest };
}

function toAnthropicTools(tools = []) {
  return tools.map(tool => ({
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
    input_schema: tool.function?.parameters || tool.input_schema || { type: 'object', properties: {} },
  })).filter(tool => tool.name);
}

async function* streamAnthropic(res) {
  if (!res.ok) await readError(res);
  if (!res.body) throw new Error('Anthropic did not return a stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = new Map();

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
      try {
        const json = JSON.parse(data);
        if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
          toolCalls.set(json.index || 0, {
            id: json.content_block.id || '',
            name: json.content_block.name || '',
            arguments: '',
          });
        }
        if (json.type === 'content_block_delta' && json.delta?.text) {
          yield { type: 'text', delta: json.delta.text };
        }
        if (json.type === 'content_block_delta' && json.delta?.type === 'input_json_delta') {
          const current = toolCalls.get(json.index || 0) || { id: '', name: '', arguments: '' };
          current.arguments += json.delta.partial_json || '';
          toolCalls.set(json.index || 0, current);
        }
        if (json.type === 'message_delta' && json.usage) {
          yield { type: 'usage', usage: json.usage };
        }
        if (json.type === 'message_stop') {
          for (const call of toolCalls.values()) {
            if (call.name) yield { type: 'tool_call', ...call };
          }
          yield { type: 'done' };
          return;
        }
      } catch {
        // Ignore provider events we do not understand yet.
      }
    }
  }
  yield { type: 'done' };
}

export default {
  id: 'anthropic',
  displayName: 'Anthropic',
  models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest', 'claude-3-opus-latest'],
  defaultModel: 'claude-3-5-haiku-latest',
  needsKey: true,
  defaultEndpoint: 'https://api.anthropic.com/v1/messages',
  costs: { input: 0.80, output: 4.00 },
  async *chat({ apiKey, messages, model, abortSignal, tools = [] }) {
    if (!apiKey) throw new Error('Anthropic API key is not set.');
    const converted = splitSystem(messages);
    const anthropicTools = toAnthropicTools(tools);
    const body = {
      model,
      system: converted.system || undefined,
      messages: converted.messages,
      max_tokens: 4096,
      stream: true,
    };
    if (anthropicTools.length) body.tools = anthropicTools;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    yield* streamAnthropic(res);
  },
};
