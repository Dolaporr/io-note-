import { decodeAudio } from './modem.mjs';

// Bounded sliding capture window. decodeAudio refuses buffers over 16 s, so older
// audio is evicted instead of ending the session: the receiver can stay armed while
// the operator walks to the second device. Nothing here changes modulation or framing.
const WINDOW_SECONDS = 14;
let chunks = [], length = 0, dropped = 0, captured = 0, rate = 48000, lastAttempt = 0, lastDecodeMs = 0;
function reset(sampleRate) { rate = sampleRate; chunks = []; length = 0; dropped = 0; captured = 0; lastAttempt = 0; lastDecodeMs = 0; }
function trim() {
  const max = Math.round(rate * WINDOW_SECONDS);
  while (length > max && chunks.length > 1) { const old = chunks.shift(); length -= old.length; dropped += old.length; }
}
function attempt(final) {
  const pcm = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) { pcm.set(chunk, at); at += chunk.length; }
  const start = performance.now();
  const result = decodeAudio(pcm, rate);
  lastDecodeMs = performance.now() - start;
  // Sample indices are reported against the start of capture, not the start of the window.
  const message = { ...result, final, capturedSeconds: captured / rate, windowSeconds: length / rate, droppedSamples: dropped, decodeMs: lastDecodeMs };
  if (result.startSample != null) message.startSample = result.startSample + dropped;
  if (result.endSample != null) message.endSample = result.endSample + dropped;
  postMessage(message);
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') reset(data.sampleRate);
    if (data.type === 'chunk') {
      chunks.push(data.pcm); length += data.pcm.length; captured += data.pcm.length;
      trim();
      // Never spend more than about half the wall clock decoding; keeps the window fresh.
      const interval = rate * Math.max(0.25, lastDecodeMs / 1000);
      if (captured - lastAttempt >= interval) { lastAttempt = captured; attempt(false); }
    }
    if (data.type === 'finish') attempt(true);
  } catch (e) { postMessage({ kind: 'error', reason: e.message }); }
};
