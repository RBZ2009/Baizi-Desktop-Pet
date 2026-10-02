/**
 * Responsibility: Coordinate durable turns and automatic memory work.
 * Implementation: 1. Serialize foreground generations. 2. Build budgeted context. 3. Persist completion or interruption before emitting terminal events.
 */
const { ContextManager } = require('./context-manager');
const { chatCompletion } = require('./provider');

class ChatService {
  constructor(storage, persona, memoryService) { this.storage = storage; this.context = new ContextManager(storage, persona); this.memory = memoryService; this.tail = null; }

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
        const result = await chatCompletion(settings, context.messages, {
          signal, onDelta: delta => { text += delta; send({ type: 'chunk', text: delta }); }
        });
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
