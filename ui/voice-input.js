/**
 * Responsibility: Capture a microphone turn and submit it through the fixed preload bridge.
 * Implementation: 1. Request microphone permission only on explicit start. 2. Record one short
 * utterance. 3. Convert the blob to base64 for main-process transcription, without persistence.
 */
class VoiceInput {
  constructor({ onState = () => {}, onText = () => {}, onError = () => {}, autoSend = false } = {}) {
    this.onState = onState;
    this.onText = onText;
    this.onError = onError;
    this.recorder = null;
    this.stream = null;
    this.chunks = [];
    this.mimeType = 'audio/webm';
    this.maxRecordingSeconds = 60;
    this.timer = null;
    this.autoSend = autoSend;
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new Error('当前环境不支持麦克风输入。');
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported?.(type)) || '';
    this.mimeType = (mimeType || 'audio/webm').split(';')[0];
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.addEventListener('dataavailable', event => { if (event.data.size) this.chunks.push(event.data); });
    this.recorder.addEventListener('stop', () => this.finish(this.mimeType));
    this.recorder.start();
    this.timer = setTimeout(() => this.stop(), this.maxRecordingSeconds * 1000);
    this.onState('recording');
  }

  stop() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.recorder = null;
    this.stream?.getTracks?.().forEach(track => track.stop());
    this.stream = null;
    if (this.onState) this.onState('idle');
  }

  async finish(mimeType) {
    this.stream?.getTracks?.().forEach(track => track.stop());
    this.stream = null;
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    try {
      const buffer = await blob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      const result = await window.desktopPet.transcribeVoice(btoa(binary), mimeType);
      this.onText(result.text);
      if (this.autoSend) window.desktopPet?.submitVoiceText?.(result.text);
      this.onState('idle');
    } catch (error) {
      this.onError(error);
      this.onState('error');
    }
  }
}

if (typeof module !== 'undefined') module.exports = { VoiceInput };
