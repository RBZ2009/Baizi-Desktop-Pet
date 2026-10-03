/**
 * Responsibility: Coordinate durable turns and automatic memory work.
 * Implementation: 1. Serialize foreground generations. 2. Build budgeted context. 3. Persist completion or interruption before emitting terminal events.
 */
const { ContextManager, tokenBound } = require('./context-manager');
const { chatCompletion } = require('./provider');
const { definitions: toolDefinitions, executeTool } = require('./tools/tool-registry');

// Keep tool JSON valid even when a result is larger than the remaining context budget.
function boundedToolResult(output, byteLimit) {
  const json = JSON.stringify(output);
  if (Buffer.byteLength(json) <= byteLimit) return json;
  let excerpt = json;
  while (Buffer.byteLength(JSON.stringify({ truncated: true, excerpt })) > byteLimit && excerpt.length) {
    excerpt = excerpt.slice(0, Math.floor(excerpt.length * 0.7));
  }
  return JSON.stringify({ truncated: true, excerpt });
}

class ChatService {
  constructor(storage, persona, memoryService, toolOptions = {}) {
    this.storage = storage;
    this.context = new ContextManager(storage, persona);
    this.memory = memoryService;
    this.toolOptions = toolOptions;
    this.tail = null;
  }

  // Wait for an aborted predecessor to persist its final state before assembling a new context.
  async run(prompt, settings, signal, send) {
    const previous = this.tail;
    const task = (async () => {
      await previous?.catch(() => {});
      if (signal.aborted) throw Object.assign(new Error('请求已取消。'), { name: 'AbortError' });
      const session = this.storage.currentSession();
      const turn = this.storage.beginTurn(session.id, prompt);
      let text = '';
      try {
        const inputBudget = settings.contextWindow - settings.maxOutputTokens - 1024;
        let tools = settings.toolsEnabled === false ? [] : toolDefinitions.filter(tool => settings.commandToolsEnabled || tool.function.name !== 'run_command');
        const schemaBytes = tools.length ? Buffer.byteLength(JSON.stringify(tools)) + 128 : 0;
        // Reserve room for tool definitions and results without crowding out the persona/current prompt.
        if (schemaBytes + 2048 + Buffer.byteLength(this.context.persona + prompt) > inputBudget) tools = [];
        const capabilities = tools.length ? `本轮可用工具：${tools.map(tool => tool.function.name).join('、')}。未列出的工具不可用；不能声称未开启的联网、诊断或动作已执行。` : '本轮没有工具权限（关闭或上下文空间不足）。不要声称已联网查询、运行命令或发出动作请求。';
        const fixedBytes = tokenBound([{ role: 'system', content: this.context.persona + capabilities }, { role: 'user', content: prompt }]) + 256;
        const toolReserve = tools.length ? schemaBytes + Math.max(0, Math.min(4096, Math.floor(inputBudget * 0.2), inputBudget - fixedBytes - schemaBytes - 512)) : 0;
        const context = await this.context.build(session.id, prompt, settings, signal, toolReserve, capabilities);
        send({ type: 'context', ...context.stats });
        const messages = [...context.messages];
        let result;
        let executedCalls = 0;
        let actionUsed = false;
        const onDelta = delta => { text += delta; send({ type: 'chunk', text: delta }); };
        for (let round = 0; round < 4; round += 1) {
          // The last model pass must finish in text, rather than launch another tool cycle.
          const activeTools = round < 3 && executedCalls < 6 ? tools : [];
          const wantsTools = activeTools.length > 0;
          if (tokenBound(messages) + (wantsTools ? schemaBytes : 0) > inputBudget) throw new Error('本轮工具结果超过上下文预算，请缩短问题或开启新会话。');
          try {
            result = await chatCompletion(settings, messages, { signal, onDelta, tools: activeTools, toolChoice: 'auto' });
          } catch (error) {
            // Retry plain text only before any tool result exists, preserving older compatible providers.
            if (round === 0 && wantsTools && [400, 404, 422].includes(error.status)) {
              tools = [];
              send({ type: 'tool', name: 'tools', status: 'unavailable', error: '当前模型接口不接受工具调用，本轮使用文字回复。' });
              result = await chatCompletion(settings, [...context.messages, { role: 'system', content: '当前 API 不支持工具，本轮没有联网或命令能力。请据此回答，不声称已查询信息或执行动作。' }], { signal, onDelta });
            } else throw error;
          }
          if (!result.toolCalls?.length) break;
          if (!wantsTools || result.finishReason === 'length') throw new Error('模型工具请求未完整结束或超出本轮调用次数。');
          messages.push({ role: 'assistant', content: result.text || null, tool_calls: result.toolCalls });
          const remaining = inputBudget - tokenBound(messages) - schemaBytes - 256;
          const resultLimit = Math.min(3000, Math.floor(remaining / result.toolCalls.length) - 256);
          if (resultLimit < 256) throw new Error('工具参数超过剩余上下文预算，未执行这批工具。');
          for (const call of result.toolCalls) {
            if (signal.aborted) throw Object.assign(new Error('请求已取消。'), { name: 'AbortError' });
            send({ type: 'tool', name: call.function.name, status: 'running' });
            let output;
            try {
              if (!activeTools.some(tool => tool.function.name === call.function.name)) throw new Error('这个工具当前未开启。');
              if (executedCalls >= 6) throw new Error('本轮工具次数已用完，请使用已有结果回答。');
              if (call.function.name === 'set_pet_action' && actionUsed) throw new Error('一次回复只允许一个动作。');
              executedCalls += 1;
              output = await executeTool(call.function.name, call.function.arguments, { ...this.toolOptions, signal, timeZone: settings.timeZone });
              if (signal.aborted) throw Object.assign(new Error('请求已取消。'), { name: 'AbortError' });
              if (call.function.name === 'set_pet_action') actionUsed = true;
              send({ type: 'tool', name: call.function.name, status: 'complete', ...(call.function.name === 'set_pet_action' ? { result: output } : {}) });
            } catch (error) {
              if (signal.aborted) throw error;
              output = { error: error.message };
              send({ type: 'tool', name: call.function.name, status: 'error', error: error.message });
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: boundedToolResult(output, resultLimit) });
          }
        }
        if (result?.toolCalls?.length) throw new Error('工具调用次数超过上限，暂时无法完成这次请求。');
        if (signal.aborted) throw Object.assign(new Error('请求已取消。'), { name: 'AbortError' });
        this.storage.finishTurn(turn, text, result.finishReason === 'length' ? 'truncated' : 'complete');
        let memoryError = '';
        if (settings.autoMemory && result.finishReason !== 'length') {
          try { this.storage.enqueueMemory(turn.userId); this.memory.kick(); }
          catch (error) { memoryError = error.message; }
        }
        send({ type: 'done', text, usage: result.usage, truncated: result.finishReason === 'length', memoryError });
      } catch (error) {
        this.storage.finishTurn(turn, text, signal.aborted ? 'interrupted' : 'failed', error.message);
        throw error;
      }
    })();
    this.tail = task;
    try { return await task; } finally { if (this.tail === task) this.tail = null; }
  }

  // Management actions can wait for all foreground writes to settle before switching sessions.
  async settle() { await this.tail?.catch(() => {}); }
}
module.exports = { ChatService };
