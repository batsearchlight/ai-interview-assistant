// Wandelt Float32-Audio in PCM16 um und liefert Bloecke von 2048 Samples
// (= 128 ms bei 16 kHz) an den Haupt-Thread. Der AudioContext laeuft mit
// 16 kHz mono — das uebliche Eingabeformat fuer Speech-to-Text-Modelle.
class Pcm16Writer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(2048);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const samples = input[0]; // mono / erster Kanal

    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.offset >= this.buffer.length) {
        // Kopie uebertragen, Puffer weiterverwenden
        const out = this.buffer.slice(0);
        this.port.postMessage(out.buffer, [out.buffer]);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-writer", Pcm16Writer);
