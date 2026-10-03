/**
 * Responsibility: Own one provider-independent voice session and its text-to-speech fallback.
 * Implementation:
 * 1. Normalize provider lifecycle events into a small state machine.
 * 2. Reject late events from an interrupted session by generation.
 * 3. Keep fallback playback independent from realtime provider failures.
 * Collaborators: a future realtime provider implements `connect({ signal, emit })`; the
 * existing macOS speech service implements the fallback methods used by text replies.
 */

const STATES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  LISTENING: 'listening',
  RESPONDING: 'responding',
  FALLBACK: 'fallback',
  FAILED: 'failed'
});

// Keep lifecycle notifications stable so a renderer can render any provider consistently.
function makeEvent(type, sessionId, payload = {}) {
  return { type, sessionId, ...payload };
}

class VoiceSession {
  constructor({ fallback = null, onEvent = () => {} } = {}) {
    this.fallback = fallback;
    this.onEvent = onEvent;
    this.state = STATES.IDLE;
    this.sessionId = null;
    this.generation = 0;
    this.providerClose = null;
    this.providerAbort = null;
  }

  // Stop the previous owner before allocating a new session identity.
  stop(reason = 'stopped') {
    this.generation += 1;
    const previous = this.sessionId;
    this.providerAbort?.();
    try { this.providerClose?.(); } catch (_) { /* provider cleanup must not break cancellation */ }
    this.providerClose = null;
    this.providerAbort = null;
    this.fallback?.stop?.();
    this.sessionId = null;
    this.state = STATES.IDLE;
    if (previous) this.emit('session.stopped', { reason }, previous);
  }

  // Start a provider session while preserving cancellation ownership in this object.
  async connect(provider, options = {}) {
    if (!provider || typeof provider.connect !== 'function') {
      throw new TypeError('语音供应商必须提供 connect 方法。');
    }
    this.stop('replaced');
    const generation = ++this.generation;
    const sessionId = `${Date.now().toString(36)}-${generation.toString(36)}`;
    this.sessionId = sessionId;
    this.state = STATES.CONNECTING;
    this.emit('session.connecting', {}, sessionId);
    const controller = new AbortController();
    const signal = options.signal;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.providerAbort = () => controller.abort();
    try {
      const close = await provider.connect({
        ...options,
        signal: controller.signal,
        emit: event => this.handle(event, generation, sessionId)
      });
      if (!this.isCurrent(generation, sessionId)) {
        try { close?.(); } catch (_) { /* stale provider */ }
        return sessionId;
      }
      this.providerClose = typeof close === 'function' ? close : close?.close;
      return sessionId;
    } catch (error) {
      if (this.isCurrent(generation, sessionId)) this.fail(error, generation, sessionId);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  // Begin the existing local speech path as a deliberate fallback session.
  beginFallback(settings, onStatus) {
    this.stop('replaced');
    const generation = ++this.generation;
    const sessionId = `${Date.now().toString(36)}-${generation.toString(36)}`;
    this.sessionId = sessionId;
    this.state = STATES.FALLBACK;
    this.fallback?.begin?.(settings, status => {
      if (this.isCurrent(generation, sessionId)) onStatus?.(status);
    });
    this.emit('session.fallback', { provider: 'system' }, sessionId);
    return sessionId;
  }

  // Start a configured realtime provider without coupling the session to its protocol.
  connectConfigured(provider, settings = {}, options = {}) {
    const providerName = String(settings.provider || 'custom').trim() || 'custom';
    return this.connect(provider, { ...options, settings: { ...settings, provider: providerName } });
  }

  // Forward generated text to whichever response owner is active.
  appendText(text) {
    if (!this.sessionId || this.state !== STATES.FALLBACK) return false;
    this.fallback?.append?.(String(text || ''));
    return true;
  }

  // Flush fallback text after the gateway has completed the response.
  finishText() {
    if (!this.sessionId || this.state !== STATES.FALLBACK) return false;
    this.fallback?.finish?.();
    return true;
  }

  // Handle the normalized provider event vocabulary used by future realtime adapters.
  handle(event, generation = this.generation, sessionId = this.sessionId) {
    if (!this.isCurrent(generation, sessionId) || !event?.type) return false;
    switch (event.type) {
      case 'session.ready': this.state = STATES.LISTENING; break;
      case 'input.started': this.state = STATES.LISTENING; break;
      case 'response.started': this.state = STATES.RESPONDING; break;
      case 'response.done': this.state = STATES.LISTENING; break;
      case 'error': this.fail(new Error(event.error || '语音服务失败。'), generation, sessionId); return true;
      case 'session.closed': this.stop(event.reason || 'provider-closed'); return true;
      default: break;
    }
    this.emit(event.type, { ...event }, sessionId);
    return true;
  }

  // Route provider failure to fallback without allowing it to revive an obsolete session.
  fail(error, generation = this.generation, sessionId = this.sessionId) {
    if (!this.isCurrent(generation, sessionId)) return false;
    this.state = STATES.FAILED;
    this.emit('session.error', { error: error?.message || String(error) }, sessionId);
    return true;
  }

  // Invalidate all callbacks before stopping child processes or provider sockets.
  cancel(reason = 'cancelled') { this.stop(reason); }

  isCurrent(generation, sessionId) { return generation === this.generation && sessionId === this.sessionId; }

  emit(type, payload, sessionId = this.sessionId) {
    this.onEvent(makeEvent(type, sessionId, payload));
  }
}

module.exports = { STATES, VoiceSession };
