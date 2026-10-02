/**
 * Responsibility: Play cancellable reply sentences with macOS system speech.
 * Implementation: 1. Queue complete sentences. 2. Send text on stdin without shell interpolation. 3. Keep speech errors separate from chat completion.
 */
const { spawn } = require('node:child_process');

class SpeechService {
  constructor() { this.child = null; this.queue = []; this.buffer = ''; this.generation = 0; this.enabled = false; }

  // Begin a new reply and stop all audio belonging to its predecessor.
  begin(settings, onStatus) {
    this.stop();
    this.settings = settings;
    this.onStatus = onStatus;
    this.enabled = settings.ttsEnabled;
    if (this.enabled && process.platform !== 'darwin') {
      this.enabled = false;
      onStatus({ type: 'error', error: '系统语音目前支持 macOS，文字回复不受影响。' });
    }
  }

  // Buffer deltas until sentence boundaries, including length bounds for punctuation-free responses.
  append(text) {
    if (!this.enabled) return;
    this.buffer += text;
    let match;
    while ((match = this.buffer.match(/^([\s\S]*?[。！？!?\n])/)) || this.buffer.length > 240) {
      const sentence = match ? match[1] : this.buffer.slice(0, 200);
      this.buffer = this.buffer.slice(sentence.length);
      if (sentence.trim()) this.queue.push(sentence.trim());
    }
    this.playNext();
  }

  // Flush the final fragment after text generation has committed successfully.
  finish() {
    if (!this.enabled) return;
    if (this.buffer.trim()) this.queue.push(this.buffer.trim());
    this.buffer = '';
    this.playNext();
  }

  // Run one owned speech process at a time and never turn speech failure into chat failure.
  playNext() {
    if (!this.enabled || this.child || !this.queue.length) return;
    const text = this.queue.shift();
    const generation = this.generation;
    const args = ['-r', String(this.settings.ttsRate)];
    if (this.settings.ttsVoice) args.push('-v', this.settings.ttsVoice);
    const child = spawn('/usr/bin/say', args, { stdio: ['pipe', 'ignore', 'ignore'] });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stdin.end(text);
    child.once('spawn', () => { if (generation === this.generation) this.onStatus?.({ type: 'playing' }); });
    const fail = () => {
      if (generation !== this.generation) return;
      this.enabled = false; this.queue = []; this.buffer = '';
      this.onStatus?.({ type: 'error', error: '系统语音播放失败，请检查声音名称和音频设备。' });
    };
    child.once('error', fail);
    child.once('close', code => {
      if (generation !== this.generation) return;
      this.child = null;
      if (code !== 0) fail();
      else { this.playNext(); if (!this.child && !this.queue.length) this.onStatus?.({ type: 'idle' }); }
    });
  }

  // Invalidate callbacks before killing the old process, preventing stale status events.
  stop() {
    this.generation += 1;
    this.child?.kill(); this.child = null;
    this.queue = []; this.buffer = ''; this.enabled = false;
  }
}
module.exports = { SpeechService };
