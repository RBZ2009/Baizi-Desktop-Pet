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
      if (buffer.length > 1024 * 1024) throw new Error('响应分片超过长度限制。');
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
async function chatCompletion(settings, messages, { signal, onDelta, model, json = false, maxTokens, tools = [], toolChoice = 'auto' } = {}) {
  if (!settings.apiKey) throw new Error('请先在对话与记忆设置中填写 API Key。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, settings.requestTimeoutMs);
  try {
    // Stream visible text while assembling function arguments separately from text deltas.
    const stream = !!onDelta;
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || settings.model, messages, temperature: json ? 0.2 : settings.temperature,
        max_tokens: maxTokens || settings.maxOutputTokens, stream, ...(tools.length ? { tools, tool_choice: toolChoice } : {}) })
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`模型 API 返回 HTTP ${response.status}，请检查地址、模型、额度及凭据。`);
      error.status = response.status;
      throw error;
    }
    let text = '';
    let usage = null;
    let finishReason = null;
    let toolCalls = [];
    const streamedCalls = new Map();
    let streamCompleted = false;
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      if (!response.body) throw new Error('模型没有返回响应流。');
      for await (const data of readSse(response.body)) {
        if (data.trim() === '[DONE]') { streamCompleted = true; break; }
        let event;
        try { event = JSON.parse(data); } catch { throw new Error('模型返回了无法解析的流式数据。'); }
        if (event.error) throw new Error('模型返回了错误事件。');
        usage = event.usage || usage;
        finishReason = event.choices?.[0]?.finish_reason || finishReason;
        if (finishReason) streamCompleted = true;
        const delta = textContent(event.choices?.[0]?.delta?.content);
        for (const part of event.choices?.[0]?.delta?.tool_calls || []) {
          const index = Number(part.index);
          if (!Number.isInteger(index) || index < 0 || index >= 8) throw new Error('模型返回的工具调用数量超过上限。');
          const call = streamedCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          call.id += part.id || '';
          call.function.name += part.function?.name || '';
          call.function.arguments += part.function?.arguments || '';
          if (call.id.length > 200 || call.function.name.length > 100 || call.function.arguments.length > 4096) throw new Error('模型工具参数超过长度限制。');
          streamedCalls.set(index, call);
        }
        text += delta;
        if (text.length > 200000) throw new Error('模型回复超过长度限制。');
        if (delta) onDelta?.(delta);
      }
      if (!streamCompleted) throw new Error('模型响应流意外结束，未保存为完整回复。');
      toolCalls = [...streamedCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    } else {
      const event = await response.json();
      if (event.error) throw new Error('模型返回了错误事件。');
      const message = event.choices?.[0]?.message || {};
      text = textContent(message.content);
      toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call, index) => ({
        id: String(call.id || `tool_call_${index}`),
        type: 'function',
        function: { name: String(call.function?.name || ''), arguments: String(call.function?.arguments || '{}') }
      })).filter(call => call.function.name) : [];
      finishReason = event.choices?.[0]?.finish_reason;
      usage = event.usage;
      if (text) onDelta?.(text);
    }
    if (toolCalls.length > 8 || toolCalls.some(call => !call.id || !call.function.name || call.id.length > 200 || call.function.name.length > 100 || call.function.arguments.length > 4096)) {
      throw new Error('模型返回了无效或过长的工具请求。');
    }
    if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) throw new Error('模型返回了重复的工具请求编号。');
    if (text.length > 200000) throw new Error('模型回复超过长度限制。');
    if (!text.trim() && !toolCalls.length) throw new Error('模型未返回可读回复。');
    return { text, usage, finishReason, toolCalls };
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
