// Converts Float32 audio to PCM16 and delivers chunks of 2048 samples
// (= 128 ms at 16 kHz) to the main thread. The AudioContext runs at
// 16 kHz mono — the common input format for speech-to-text models.
class Pcm16Writer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const samples = input[0]; // mono / first channel

    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset >= this.buffer.length) {
        // transfer a copy, keep reusing the buffer
        const out = this.buffer.slice(0);
        this.port.postMessage(out.buffer, [out.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-writer", Pcm16Writer);
