import { writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { appendCRC, createPacket, importIdentity, ReplayCache, STATUS, verifyPacket } from '../src/protocol.mjs';
import { decodeAudio, frameBits, metrics, modulate, modulateBits, OVERHEAD_BITS } from '../src/modem.mjs';
import { softwareLoopback, TEST_IDENTITY, TEST_MESSAGE } from '../src/selftest.mjs';
const keys = await importIdentity(TEST_IDENTITY);
const packet = await createPacket(TEST_MESSAGE, keys, Uint8Array.from({ length: 16 }, (_, i) => i));
const results = { generatedAt: new Date().toISOString(), environment: { node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model }, physicalAudio: { attempted: false, successfulTrials: null, failedTrials: null, reason: 'No two user-controlled physical devices or speaker-to-microphone path available in this execution environment.' }, baseline: [], adversarial: [], channelExperiments: [] };
for (const rate of [44100, 48000]) for (let trial = 1; trial <= 5; trial++) results.baseline.push({ trial, ...await softwareLoopback(rate) });
for (const attack of ['message-byte', 'signature', 'public-key', 'truncated-frame', 'duplicate-nonce', 'audio-bit-corruption']) {
  let p = packet.slice(), cache = new ReplayCache();
  if (attack === 'duplicate-nonce') await verifyPacket(p, cache);
  if (['message-byte', 'signature', 'public-key'].includes(attack)) {
    p[attack === 'message-byte' ? 55 : attack === 'signature' ? p.length - 5 : 5] ^= 1;
    p = appendCRC(p.slice(0, -4));
  }
  let bits = frameBits(p);
  if (attack === 'audio-bit-corruption') bits[OVERHEAD_BITS + 55 * 8 + 7] ^= 1;
  if (attack === 'truncated-frame') bits = bits.slice(0, -80);
  const start = performance.now(), pcm = modulateBits(bits), decoded = decodeAudio(pcm, 48000);
  const result = decoded.kind === 'packet' ? await verifyPacket(decoded.packet, cache) : { status: STATUS.corrupted, reason: decoded.reason };
  results.adversarial.push({ attack, status: result.status, demodulator: decoded.kind, successfulDecode: decoded.kind === 'packet' && result.status !== STATUS.corrupted, processingMs: performance.now() - start });
}
function seededNoise(length, amplitude) {
  let state = 42;
  return Float32Array.from({ length }, () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state / 2 ** 32 * 2 - 1) * amplitude; });
}
for (const amplitude of [0.03, 0.35, 1.0, 2.0]) {
  const pcm = modulate(packet, 48000, { leadSeconds: 0.17371 });
  const noise = seededNoise(pcm.length, amplitude);
  for (let i = 0; i < pcm.length; i++) pcm[i] += noise[i];
  const start = performance.now(), decoded = decodeAudio(pcm, 48000);
  const result = decoded.kind === 'packet' ? await verifyPacket(decoded.packet) : { status: 'NO VALID PACKET' };
  results.channelExperiments.push({ experiment: 'uniform additive seeded noise; no clipping', signalAmplitude: 0.35, noisePeakAmplitude: amplitude, seed: 42, demodulator: decoded.kind, status: result.status, successfulDecode: result.status === STATUS.verified, decodeAndVerifyMs: performance.now() - start });
}
for (const ppm of [250, 1000, 3000]) {
  const input = modulate(packet), scale = 1 + ppm / 1e6;
  const pcm = new Float32Array(Math.floor(input.length * scale));
  for (let i = 0; i < pcm.length; i++) { const at = i / scale, lo = Math.floor(at), f = at - lo; pcm[i] = (input[lo] || 0) * (1 - f) + (input[lo + 1] || 0) * f; }
  const start = performance.now(), decoded = decodeAudio(pcm, 48000);
  const result = decoded.kind === 'packet' ? await verifyPacket(decoded.packet) : { status: 'NO VALID PACKET' };
  results.channelExperiments.push({ experiment: 'synthetic sample-clock stretch; linear interpolation', ppm, demodulator: decoded.kind, status: result.status, successfulDecode: result.status === STATUS.verified, decodeAndVerifyMs: performance.now() - start });
}
await mkdir('results', { recursive: true });
await writeFile('results/measured-results.json', JSON.stringify(results, null, 2) + '\n');
// Deterministic public fixture WAV solely for synthetic browser microphone tests.
const pcm = modulate(packet, 48000, { leadSeconds: 1, tailSeconds: 1 });
const wav = Buffer.alloc(44 + pcm.length * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.length * 2, 40);
for (let i = 0; i < pcm.length; i++) wav.writeInt16LE(Math.round(pcm[i] * 32767), 44 + i * 2);
await writeFile('results/synthetic-input.wav', wav);
console.log(JSON.stringify({ baselineTrials: results.baseline.length, successfulBaselineTrials: results.baseline.filter(x => x.successfulDecode).length, metrics: metrics(packet), adversarial: results.adversarial, channelExperiments: results.channelExperiments, physicalAudio: results.physicalAudio }, null, 2));
