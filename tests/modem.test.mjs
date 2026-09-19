import test from 'node:test';
import assert from 'node:assert/strict';
import { createPacket, importIdentity, verifyPacket, STATUS } from '../src/protocol.mjs';
import { bitsToBytes, bytesToBits, decodeAudio, FRAMING, frameBits, JOIN_GRACE_SECONDS, metrics, modulate, modulateBits, OVERHEAD_BITS, PREAMBLE_BITS, PREAMBLE_CHECK } from '../src/modem.mjs';
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
    assert.equal(result.transmittedBits, 1400); assert.equal(result.toneSeconds, 7);
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
  assert.equal(metrics(p).audioSeconds, 10.58);
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
  const bits = frameBits(packet); bits[PREAMBLE_BITS + 6] ^= 1;
  assert.equal(decodeAudio(modulateBits(bits), 48000).kind, 'none');
});
test('corrupt physical length is bounded without allocation from untrusted length', () => {
  const bits = frameBits(packet); bits[PREAMBLE_BITS + 32] = 1;
  assert.equal(decodeAudio(modulateBits(bits), 48000).kind, 'corrupted');
});
test('diagnostics are additive: decode results carry no extra decision fields', () => {
  const decoded = decodeAudio(modulate(packet), 48000);
  assert.deepEqual(Object.keys(decoded).filter(k => k !== 'diagnostics').sort(), ['endSample', 'kind', 'packet', 'quality', 'startSample']);
  assert.deepEqual(decoded.packet, packet);
});
test('diagnostics report a complete frame, checksum and bit counts for a clean signal', () => {
  const d = decodeAudio(modulate(packet), 48000).diagnostics;
  assert.equal(d.framing, FRAMING.complete);
  assert.equal(d.checksum, 'CRC-32 PASS');
  assert.equal(d.declaredPacketBytes, packet.length);
  assert.equal(d.bits.framing, OVERHEAD_BITS);
  assert.equal(d.bits.expectedData, packet.length * 8);
  assert.equal(d.bits.receivedData, packet.length * 8);
  assert.equal(d.bits.total, metrics(packet).transmittedBits);
  assert.equal(d.sync.candidates, 1); assert.equal(d.sync.accepted, 1);
  assert.equal(d.tones.join(), '1200,2200');
  assert.ok(d.symbols.meanConfidence > 0.9, `confidence ${d.symbols.meanConfidence}`);
  assert.ok(d.level.rmsDbfs > -20 && d.level.clippedSamples === 0);
  // The preamble is alternating by construction, so a correctly timed trace must read 0101…
  assert.match(d.symbolTrace.bits, /^(01){20,}/);
});
test('diagnostics separate a failed checksum from a failed sync and from silence', async () => {
  const bits = frameBits(packet); bits[OVERHEAD_BITS + 55 * 8 + 7] ^= 1;
  const corrupted = decodeAudio(modulateBits(bits), 48000).diagnostics;
  assert.equal(corrupted.framing, FRAMING.complete);
  assert.equal(corrupted.checksum, 'CRC-32 FAIL');
  assert.equal(corrupted.bits.receivedData, corrupted.bits.expectedData);

  const broken = frameBits(packet); broken[PREAMBLE_BITS + 6] ^= 1;
  const nosync = decodeAudio(modulateBits(broken), 48000).diagnostics;
  assert.equal(nosync.framing, FRAMING.carrier);
  assert.equal(nosync.sync.candidates, 0);
  assert.equal(nosync.checksum, 'not reached');

  const silent = decodeAudio(new Float32Array(48000 * 2), 48000).diagnostics;
  assert.equal(silent.framing, FRAMING.none);
  assert.equal(silent.level.rmsDbfs, -120);
  assert.equal(silent.symbols.meanConfidence, 0);

  const short = decodeAudio(modulate(packet).slice(0, -48000), 48000).diagnostics;
  assert.equal(short.framing, FRAMING.incomplete);
  assert.ok(short.bits.receivedData < short.bits.expectedData);
  assert.equal(short.bits.total, null);
});
test('a corrupt physical length is reported as an invalid length, not a short frame', () => {
  const bits = frameBits(packet); bits[PREAMBLE_BITS + 32] = 1;
  const d = decodeAudio(modulateBits(bits), 48000).diagnostics;
  assert.equal(d.framing, FRAMING.length);
  assert.ok(d.declaredPacketBytes > 219 || d.declaredPacketBytes < 123);
});

test('a receiver joining late still locks, for the whole acquisition preamble', async () => {
  // Synchronisation validates the 32 symbols before the sync word, so the grace is
  // (PREAMBLE_BITS - PREAMBLE_CHECK) symbols. Cut that much off the front and it must lock;
  // one symbol more and there is no longer a preamble to validate.
  const rate = 48000, symbol = rate / 200, lead = Math.round(0.15 * rate);
  const cut = lost => modulate(packet, rate).slice(lead + Math.round(lost * symbol));
  const grace = PREAMBLE_BITS - PREAMBLE_CHECK;
  assert.equal(JOIN_GRACE_SECONDS, grace / 200);
  assert.ok(JOIN_GRACE_SECONDS >= 1, `join grace should be at least a second, got ${JOIN_GRACE_SECONDS}`);

  for (const lost of [0, 32, 100, grace - 1, grace]) {
    const decoded = decodeAudio(cut(lost), rate);
    assert.equal(decoded.kind, 'packet', `losing ${lost} symbols must still decode`);
    assert.deepEqual(decoded.packet, packet);
    assert.equal(decoded.diagnostics.checksum, 'CRC-32 PASS');
  }
  assert.equal(decodeAudio(cut(grace + 1), rate).diagnostics.sync.accepted, 0, 'past the preamble there is nothing left to validate');
});

test('a frame built with the earlier 64-symbol preamble still decodes unchanged', async () => {
  // The detector never depended on preamble length, so old senders and old recordings
  // stay readable. This is what keeps the committed physical captures valid.
  const legacy = decodeAudio(modulateBits(frameBits(packet, 64), 48000), 48000);
  assert.equal(legacy.kind, 'packet');
  assert.deepEqual(legacy.packet, packet);
  assert.equal(legacy.diagnostics.checksum, 'CRC-32 PASS');
  assert.equal((await verifyPacket(legacy.packet)).status, STATUS.verified);
});
