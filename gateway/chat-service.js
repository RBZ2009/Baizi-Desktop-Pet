/**
 * Responsibility: Coordinate durable turns and automatic memory work.
 * Implementation: 1. Serialize foreground generations. 2. Build budgeted context. 3. Persist completion or interruption before emitting terminal events.
 */
const { ContextManager } = require('./context-manager');
const { chatCompletion } = require('./provider');
const { definitions: toolDefinitions, executeTool, clip: clipToolOutput } = require('./tools/tool-registry');

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
        const context = await this.context.build(session.id, prompt, settings, signal);
        send({ type: 'context', ...context.stats });
        const messages = [...context.messages];
        const tools = settings.toolsEnabled === false ? [] : toolDefinitions;
        let result;
        for (let round = 0; round < 4; round += 1) {
          const wantsTools = tools.length > 0;
          result = await chatCompletion(settings, messages, { signal, tools: wantsTools ? tools : [], toolChoice: 'auto' });
          if (!result.toolCalls?.length) {
            if (result.text) { text += result.text; send({ type: 'chunk', text: result.text }); }
            break;
          }
          messages.push({ role: 'assistant', content: result.text || null, tool_calls: result.toolCalls });
          for (const call of result.toolCalls) {
            send({ type: 'tool', name: call.function.name, status: 'running', arguments: call.function.arguments });
            let output;
            try {
              output = await executeTool(call.function.name, call.function.arguments, { ...this.toolOptions, signal, timeZone: settings.timeZone });
              send({ type: 'tool', name: call.function.name, status: 'complete', result: output });
            } catch (error) {
              output = { error: error.message };
              send({ type: 'tool', name: call.function.name, status: 'error', error: error.message });
            }
            messages.push({ role: 'tool', tool_call_id: call.id, content: clipToolOutput(JSON.stringify(output)) });
          }
        }
        if (result?.toolCalls?.length && !text) throw new Error('工具调用次数超过上限，暂时无法完成这次请求。');
        if (signal.aborted) throw Object.assign(new Error('请求已取消。'), { name: 'AbortError' });
        this.storage.finishTurn(turn, result.text, result.finishReason === 'length' ? 'truncated' : 'complete');
        let memoryError = '';
        if (settings.autoMemory && result.finishReason !== 'length') {
          try { this.storage.enqueueMemory(turn.userId); this.memory.kick(); }
          catch (error) { memoryError = error.message; }
        }
        send({ type: 'done', text: result.text, usage: result.usage, truncated: result.finishReason === 'length', memoryError });
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
