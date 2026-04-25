async function* streamOllamaLines(res) {
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    throw new Error(`Ollama request failed (${res.status} ${res.statusText})${body ? `: ${body.slice(0, 500)}` : ''}`);
  }
  if (!res.body) throw new Error('Ollama did not return a stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        const delta = json.message?.content || json.response || '';
        if (delta) yield { type: 'text', delta };
        if (json.done) yield { type: 'done', usage: json };
      } catch {
        // Ignore malformed keep-alive lines.
      }
    }
  }
  yield { type: 'done' };
}

export default {
  id: 'ollama',
  displayName: 'Ollama',
  models: ['llama3.1', 'qwen2.5-coder', 'mistral'],
  defaultModel: 'llama3.1',
  needsKey: false,
  defaultEndpoint: 'http://localhost:11434',
  costs: { input: 0, output: 0 },
  async *chat({ messages, model, abortSignal, endpoint }) {
    const base = String(endpoint || 'http://localhost:11434').replace(/\/+$/, '');
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: abortSignal,
    });
    yield* streamOllamaLines(res);
  },
};
