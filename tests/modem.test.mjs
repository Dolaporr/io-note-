import test from 'node:test';
import assert from 'node:assert/strict';
import { createPacket, importIdentity, verifyPacket, STATUS } from '../src/protocol.mjs';
import { bitsToBytes, bytesToBits, decodeAudio, frameBits, metrics, modulate, modulateBits, OVERHEAD_BITS } from '../src/modem.mjs';
import { softwareLoopback, TEST_IDENTITY, TEST_MESSAGE } from '../src/selftest.mjs';

const keys = await importIdentity(TEST_IDENTITY);
const packet = await createPacket(TEST_MESSAGE, keys, new Uint8Array(16));
function noise(length, amplitude, seed = 42) {
  const out = new Float32Array(length); let s = seed;
  for (let i = 0; i < length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = (s / 0x100000000 * 2 - 1) * amplitude; }
  return out;
}
test('MSB-first bits roundtrip all 256 byte values', () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(bitsToBytes(bytesToBits(bytes)), bytes);
  assert.throws(() => bitsToBytes(new Uint8Array(7)));
});
for (const sampleRate of [44100, 48000, 96000]) {
  test(`deterministic PCM loopback at ${sampleRate} Hz`, async () => {
    const result = await softwareLoopback(sampleRate);
    assert.equal(result.status, STATUS.verified); assert.equal(result.packetBytes, 137);
    assert.equal(result.transmittedBits, 1208); assert.equal(result.toneSeconds, 6.04);
  });
}
test('unknown start phase + seeded noise + attenuation', async () => {
  const sampleRate = 48000, pcm = modulate(packet, sampleRate, { amplitude: 0.08, leadSeconds: 0.17371 });
  const n = noise(pcm.length, 0.03); for (let i = 0; i < pcm.length; i++) pcm[i] += n[i];
  const decoded = decodeAudio(pcm, sampleRate);
  assert.equal(decoded.kind, 'packet'); assert.deepEqual(decoded.packet, packet);
  assert.equal((await verifyPacket(decoded.packet)).status, STATUS.verified);
});
test('inverted waveform and arbitrary carrier phase preserve payload', () => {
  const pcm = modulate(packet, 44100, { leadSeconds: 0.1913 });
  for (let i = 0; i < pcm.length; i++) pcm[i] *= -0.5;
  assert.deepEqual(decodeAudio(pcm, 44100).packet, packet);
});
test('96-byte message decodes at maximum bounded packet size', async () => {
  const p = await createPacket('z'.repeat(96), keys, new Uint8Array(16));
  assert.deepEqual(decodeAudio(modulate(p), 48000).packet, p);
  assert.equal(metrics(p).audioSeconds, 9.62);
});
test('audio data-bit inversion recovers altered packet and fails CRC', async () => {
  const bits = frameBits(packet); bits[OVERHEAD_BITS + 55 * 8 + 7] ^= 1;
  const decoded = decodeAudio(modulateBits(bits), 48000);
  assert.equal(decoded.kind, 'packet'); assert.notDeepEqual(decoded.packet, packet);
  assert.equal((await verifyPacket(decoded.packet)).status, STATUS.corrupted);
});
test('truncated audio after sync is explicitly partial', () => {
  const pcm = modulate(packet);
  assert.equal(decodeAudio(pcm.slice(0, -48000), 48000).kind, 'partial');
});
test('silence and seeded noise produce no synchronized packet', () => {
  assert.equal(decodeAudio(new Float32Array(48000), 48000).kind, 'none');
  assert.equal(decodeAudio(noise(48000 * 2, 0.5), 48000).kind, 'none');
});
test('destroyed sync produces no packet rather than a signature verdict', () => {
  const bits = frameBits(packet); bits[70] ^= 1;
  assert.equal(decodeAudio(modulateBits(bits), 48000).kind, 'none');
});
test('corrupt physical length is bounded without allocation from untrusted length', () => {
  const bits = frameBits(packet); bits[96] = 1;
  assert.equal(decodeAudio(modulateBits(bits), 48000).kind, 'corrupted');
});
