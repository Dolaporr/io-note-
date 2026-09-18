import { decodeAudio } from './modem.mjs';

// Bounded sliding capture window. decodeAudio refuses buffers over 16 s, so older
// audio is evicted instead of ending the session: the receiver can stay armed while
// the operator walks to the second device. Nothing here changes modulation or framing.
const WINDOW_SECONDS = 14;
// Separately, every captured sample is retained for export, so a failed physical attempt
// can be replayed offline through this same decoder. Bounded so a long session cannot
// exhaust memory; once full, the oldest audio is dropped from the recording too.
const RECORD_SECONDS = 150;
let chunks = [], length = 0, dropped = 0, captured = 0, rate = 48000, lastAttempt = 0, lastDecodeMs = 0;
let recording = [], recorded = 0, recordDropped = 0;
function reset(sampleRate) {
  rate = sampleRate; chunks = []; length = 0; dropped = 0; captured = 0; lastAttempt = 0; lastDecodeMs = 0;
  recording = []; recorded = 0; recordDropped = 0;
}
function trim() {
  const max = Math.round(rate * WINDOW_SECONDS);
  while (length > max && chunks.length > 1) { const old = chunks.shift(); length -= old.length; dropped += old.length; }
  const recordMax = Math.round(rate * RECORD_SECONDS);
  while (recorded > recordMax && recording.length > 1) { const old = recording.shift(); recorded -= old.length; recordDropped += old.length; }
}
function window() {
  const pcm = new Float32Array(length);
  let at = 0;
  for (const chunk of chunks) { pcm.set(chunk, at); at += chunk.length; }
  return pcm;
}
function attempt(final) {
  const pcm = window();
  const start = performance.now();
  const result = decodeAudio(pcm, rate);
  lastDecodeMs = performance.now() - start;
  // Sample indices are reported against the start of capture, not the start of the window.
  const message = { ...result, final, capturedSeconds: captured / rate, windowSeconds: length / rate, droppedSamples: dropped, decodeMs: lastDecodeMs };
  if (result.startSample != null) message.startSample = result.startSample + dropped;
  if (result.endSample != null) message.endSample = result.endSample + dropped;
  postMessage(message);
}
// The exact samples the decoder saw, plus a full-detail decode of the current window.
function exportCapture() {
  const pcm = new Float32Array(recorded);
  let at = 0;
  for (const chunk of recording) { pcm.set(chunk, at); at += chunk.length; }
  const decoded = decodeAudio(window(), rate, { detail: true });
  postMessage({
    kind: 'export', sampleRate: rate, recording: pcm,
    recordedSamples: recorded, recordingDroppedSamples: recordDropped, recordingSeconds: recorded / rate,
    capturedSeconds: captured / rate, windowSeconds: length / rate, windowDroppedSamples: dropped,
    windowStartSample: dropped, windowEndSample: dropped + length,
    result: { kind: decoded.kind, reason: decoded.reason ?? null, startSample: decoded.startSample == null ? null : decoded.startSample + dropped, endSample: decoded.endSample == null ? null : decoded.endSample + dropped },
    diagnostics: decoded.diagnostics,
  }, [pcm.buffer]);
}
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') reset(data.sampleRate);
    if (data.type === 'chunk') {
      chunks.push(data.pcm); length += data.pcm.length; captured += data.pcm.length;
      recording.push(data.pcm); recorded += data.pcm.length;
      trim();
      // Never spend more than about half the wall clock decoding; keeps the window fresh.
      const interval = rate * Math.max(0.25, lastDecodeMs / 1000);
      if (captured - lastAttempt >= interval) { lastAttempt = captured; attempt(false); }
    }
    if (data.type === 'finish') attempt(true);
    if (data.type === 'export') exportCapture();
  } catch (e) { postMessage({ kind: 'error', reason: e.message }); }
};
