/**
 * Responsibility: Track response-owned bubbles independently of stream chunks.
 * Implementation: 1. Update entries by message ID. 2. Keep transient status outside history.
 * 3. Bound the stack and retain only the latest message in replacement mode.
 */
(function exposeSpeechMessages(root) {
  class SpeechMessages {
    constructor(limit = 12) { this.limit = limit; this.entries = []; this.transient = null; this.mode = 'stack'; }

    // A setting change affects the visible stack immediately without reviving cleared messages.
    setMode(mode) {
      this.mode = mode === 'replace' ? 'replace' : 'stack';
      if (this.mode === 'replace') this.entries = this.entries.slice(0, 1);
    }

    // Streaming deltas update one bubble; only a new response ID creates a new entry.
    update(payload) {
      const item = { ...payload, messageId: String(payload.messageId || 'legacy'), text: String(payload.text || '') };
      if (item.transient) { this.transient = item; return; }
      this.transient = null;
      const index = this.entries.findIndex(entry => entry.messageId === item.messageId);
      if (index >= 0) this.entries[index] = item;
      else {
        this.entries.forEach(entry => { entry.closable = true; });
        this.entries.unshift(item);
      }
      this.entries = this.entries.slice(0, this.mode === 'replace' ? 1 : this.limit);
    }

    // Expose only the top body; lower entries are represented by fixed-size blank surfaces.
    current() { return this.transient || this.entries[0]; }
    depth() { return this.mode === 'stack' ? Math.min(2, Math.max(0, this.entries.length - (this.transient ? 0 : 1))) : 0; }

    // Dismissing the top reveals the previous message when stacking is enabled.
    dismiss() { if (this.transient) this.transient = null; else this.entries.shift(); }
    clear() { this.entries = []; this.transient = null; }
  }
  if (typeof module === 'object' && module.exports) module.exports = { SpeechMessages };
  else root.SpeechMessages = SpeechMessages;
}(typeof window === 'undefined' ? globalThis : window));
