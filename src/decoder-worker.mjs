import { decodeAudio } from './modem.mjs';

let chunks = [], length = 0, rate = 48000, lastAttempt = 0;
function attempt(final) {
  const pcm = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) { pcm.set(chunk, at); at += chunk.length; }
  const start = performance.now();
  const result = decodeAudio(pcm, rate);
  postMessage({ ...result, final, capturedSeconds: length / rate, decodeMs: performance.now() - start });
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') { rate = data.sampleRate; chunks = []; length = 0; lastAttempt = 0; }
    if (data.type === 'chunk') {
      if (length + data.pcm.length > rate * 15) { attempt(true); return; }
      chunks.push(data.pcm); length += data.pcm.length;
      if (length - lastAttempt >= rate * 0.25) { lastAttempt = length; attempt(false); }
    }
    if (data.type === 'finish') attempt(true);
  } catch (e) { postMessage({ kind: 'error', reason: e.message }); }
};
