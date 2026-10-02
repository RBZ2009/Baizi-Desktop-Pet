/**
 * Responsibility: Adapt compatible chat-completion APIs to text deltas.
 * Implementation: 1. Parse framed SSE and JSON. 2. Share cancellation and deadlines. 3. Surface bounded errors without credentials.
 */

// Decode SSE frames across arbitrary UTF-8 chunk boundaries, including multiline data.
async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line) {
          if (data.length) yield data.join('\n');
          data = [];
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (done) break;
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim());
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Join only user-visible text content; reasoning and tool arguments stay internal.
function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(part => part.type === 'text').map(part => part.text || '').join('');
  return '';
}

// Keep one deadline active until the entire provider response has been consumed.
async function chatCompletion(settings, messages, { signal, onDelta, model, json = false, maxTokens } = {}) {
  if (!settings.apiKey) throw new Error('请先在对话与记忆设置中填写 API Key。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, settings.requestTimeoutMs);
  try {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || settings.model, messages, temperature: json ? 0.2 : settings.temperature,
        max_tokens: maxTokens || settings.maxOutputTokens, stream: !!onDelta })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`模型 API 返回 HTTP ${response.status}，请检查地址、模型、额度及凭据。`);
    }
    let text = '';
    let usage = null;
    let finishReason = null;
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      if (!response.body) throw new Error('模型没有返回响应流。');
      for await (const data of readSse(response.body)) {
        if (data.trim() === '[DONE]') break;
        let event;
        try { event = JSON.parse(data); } catch { throw new Error('模型返回了无法解析的流式数据。'); }
        if (event.error) throw new Error('模型返回了错误事件。');
        usage = event.usage || usage;
        finishReason = event.choices?.[0]?.finish_reason || finishReason;
        const delta = textContent(event.choices?.[0]?.delta?.content);
        text += delta;
        if (text.length > 200000) throw new Error('模型回复超过长度限制。');
        if (delta) onDelta?.(delta);
      }
    } else {
      const event = await response.json();
      if (event.error) throw new Error('模型返回了错误事件。');
      text = textContent(event.choices?.[0]?.message?.content);
      finishReason = event.choices?.[0]?.finish_reason;
      usage = event.usage;
      if (text) onDelta?.(text);
    }
    if (!text.trim()) throw new Error('模型未返回可读回复。');
    return { text, usage, finishReason };
  } catch (error) {
    if (expired) throw new Error('模型请求超时，请稍后重试。');
    if (signal?.aborted) throw Object.assign(new Error('请求已取消。'), { name: 'AbortError' });
    if (error instanceof TypeError) throw new Error('无法连接模型 API，请检查网络和 API 地址。');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
module.exports = { readSse, chatCompletion };
