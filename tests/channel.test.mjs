// Offline reproductions of the first failed physical attempt. These assert what the
// channel experiments found; they exercise the production decoder and change nothing in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPacket, importIdentity, hex } from '../src/protocol.mjs';
import { decodeAudio, modulate, frameBits, FRAMING, BITRATE } from '../src/modem.mjs';
import { TEST_IDENTITY } from '../src/selftest.mjs';
import { resampleLinear, resampleSinc, modulateImbalanced, toneNoise, mix, pad } from '../scripts/channel-lab.mjs';
import { readWav } from '../scripts/replay-capture.mjs';

const keys = await importIdentity(TEST_IDENTITY);
const packet = await createPacket('we control the io pins', keys, new Uint8Array(16));
const bits = frameBits(packet);
const expected = hex(packet);
const decode = (pcm, rate = 44100) => decodeAudio(pcm, rate);
const exact = decoded => decoded.kind === 'packet' && hex(decoded.packet) === expected;

test('44,100 Hz on its own recovers the io-pins packet byte for byte', () => {
  const decoded = decode(modulate(packet, 44100));
  assert.ok(exact(decoded), `44.1 kHz must not be the failure: got ${decoded.kind}`);
  assert.equal(decoded.diagnostics.checksum, 'CRC-32 PASS');
});

test('browser-style 48k -> 44.1k resampling recovers the packet byte for byte', () => {
  for (const resample of [resampleLinear, resampleSinc]) {
    const decoded = decode(resample(modulate(packet, 48000), 48000, 44100));
    assert.ok(exact(decoded), `${resample.name} 48k->44.1k must still decode: got ${decoded.kind}`);
  }
});

test('tone gain imbalance alone does not break synchronisation, so tone share is not a verdict', () => {
  // -12 dB on the 2,200 Hz tone pushes the 1,200 Hz share past 95% and still decodes.
  const decoded = decode(modulateImbalanced(bits, 44100, 1, 0.25));
  assert.ok(exact(decoded), 'a 12 dB tone imbalance must still decode');
  assert.ok(decoded.diagnostics.symbols.toneShare[1200] > 0.9, 'this case must look lopsided in the diagnostics');
  assert.equal(decoded.diagnostics.sync.accepted, 1);
});

test('narrowband 1,200 Hz interference at 0 dB reproduces the reported failure signature', () => {
  const signal = pad(modulateImbalanced(bits, 44100, 1, 1, 0.06), 44100, 0.5, 1.2);
  const decoded = decode(mix(signal, toneNoise(signal.length, 0.06, 1200, 44100)));
  const d = decoded.diagnostics;
  assert.equal(decoded.kind, 'none');
  assert.equal(d.framing, FRAMING.carrier);
  assert.equal(d.sync.accepted, 0);
  assert.ok(d.symbols.toneShare[1200] > 0.75, `observed capture read 0.85; got ${d.symbols.toneShare[1200]}`);
  assert.match(d.symbolTrace.bits, /^0+$/, 'the reported trace was all zero');
});

test('a clean preamble reads as alternating 0101 in the trace; all-zero means no alternation', () => {
  const clean = decode(modulate(packet, 44100)).diagnostics;
  assert.match(clean.symbolTrace.bits, /^(01){32}$/, 'the 64-symbol trace over a clean preamble must alternate');
  assert.equal(clean.traceSource, 'accepted sync candidate');
  // With no sync anywhere the trace follows in-band energy, not confidence: in near-silence
  // confidence is a ratio of noise and would point the trace at the wrong place entirely.
  const quiet = decode(new Float32Array(44100 * 3)).diagnostics;
  assert.equal(quiet.traceSource, 'peak in-band energy');
  assert.match(quiet.symbolTrace.bits, /^0+$/);
});

test('a transmission cut within 16 symbols of the sync word reproduces LENGTH INVALID', () => {
  const pcm = modulateImbalanced(bits, 44100, 1, 1);
  const from = Math.round(0.15 * 44100 + 96 * 44100 / BITRATE); // preamble 64 + sync 32
  for (let i = from; i < pcm.length; i++) pcm[i] = 0;
  const decoded = decode(pcm);
  assert.equal(decoded.diagnostics.framing, FRAMING.length);
  assert.ok(decoded.diagnostics.candidates.some(c => /declared length/.test(c.reason)), 'the candidate must carry its rejection reason');
});

test('crest factor separates a real tone from a window that is silence plus a transient', () => {
  const continuous = decode(modulate(packet, 44100)).diagnostics.level;
  assert.ok(continuous.crestDb < 7, `continuous FSK should sit near 3 dB, got ${continuous.crestDb}`);
  const mostlyEmpty = new Float32Array(Math.round(8.4 * 44100));
  mostlyEmpty.set(modulateImbalanced(bits, 44100, 1, 1, 0.06).subarray(0, Math.round(0.05 * 44100)));
  mostlyEmpty[mostlyEmpty.length - 1000] = 0.06;
  assert.ok(decode(mostlyEmpty).diagnostics.level.crestDb > 15, 'a near-empty window must read a high crest factor');
});

test('the replay reader accepts the WAV shapes a capture export can produce', async () => {
  const fixture = readWav(await readFile(new URL('../results/synthetic-input.wav', import.meta.url)));
  assert.equal(fixture.sampleRate, 48000);
  assert.equal(fixture.channels, 1);
  // The fixture carries the hello packet, not the io-pins one; what matters is that a WAV
  // read back off disk decodes and checksums through the same decoder the receiver ran.
  const decoded = decodeAudio(fixture.pcm, fixture.sampleRate);
  assert.equal(decoded.kind, 'packet');
  assert.equal(decoded.diagnostics.checksum, 'CRC-32 PASS');
  assert.equal(decoded.diagnostics.framing, FRAMING.complete);
});
