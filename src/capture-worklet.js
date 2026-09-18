class IoNoteCapture extends AudioWorkletProcessor {
  constructor() { super(); this.chunk = new Float32Array(4096); this.at = 0; }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) for (let i = 0; i < input.length; i++) {
      this.chunk[this.at++] = input[i];
      if (this.at === this.chunk.length) {
        this.port.postMessage(this.chunk, [this.chunk.buffer]);
        this.chunk = new Float32Array(4096); this.at = 0;
      }
    }
    return true;
  }
}
registerProcessor('io-note-capture', IoNoteCapture);
