import { MIN_PACKET, MAX_PACKET, crc32 } from './protocol.mjs';

export const BITRATE = 200;
export const TONES = [1200, 2200];
export const PREAMBLE_BITS = 64;
export const SYNC = 0xd391c5a7;
export const OVERHEAD_BITS = PREAMBLE_BITS + 32 + 16;
export function bytesToBits(bytes) {
  return Uint8Array.from(Array.from(bytes).flatMap(b => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1)));
}
export function bitsToBytes(bits) {
  if (bits.length % 8) throw new Error('Non-byte-aligned bit array');
  const bytes = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) bytes[i >> 3] |= bits[i] << (7 - (i & 7));
  return bytes;
}
export function frameBits(packet) {
  if (packet.length < MIN_PACKET || packet.length > MAX_PACKET) throw new Error('Packet size out of bounds');
  const h = new Uint8Array(6), v = new DataView(h.buffer);
  v.setUint32(0, SYNC); v.setUint16(4, packet.length);
  const bits = new Uint8Array(OVERHEAD_BITS + packet.length * 8);
  for (let i = 0; i < PREAMBLE_BITS; i++) bits[i] = i % 2;
  bits.set(bytesToBits(h), PREAMBLE_BITS);
  bits.set(bytesToBits(packet), OVERHEAD_BITS);
  return bits;
}
export function modulateBits(bits, sampleRate = 48000, { amplitude = 0.35, leadSeconds = 0.15, tailSeconds = 0.15 } = {}) {
  const lead = Math.round(leadSeconds * sampleRate), body = Math.round(bits.length * sampleRate / BITRATE);
  const pcm = new Float32Array(lead + body + Math.round(tailSeconds * sampleRate));
  let phase = 0;
  for (let i = 0; i < body; i++) {
    const bit = bits[Math.min(bits.length - 1, Math.floor(i * BITRATE / sampleRate))];
    pcm[lead + i] = amplitude * Math.sin(phase);
    phase = (phase + 2 * Math.PI * TONES[bit] / sampleRate) % (2 * Math.PI);
  }
  return pcm;
}
export function modulate(packet, sampleRate = 48000, options) { return modulateBits(frameBits(packet), sampleRate, options); }
export function metrics(packet, sampleRate = 48000) {
  const bits = OVERHEAD_BITS + packet.length * 8;
  return { packetBytes: packet.length, packetBits: packet.length * 8, transmittedBits: bits, bitrate: BITRATE, toneSeconds: bits / BITRATE, audioSeconds: modulate(packet, sampleRate).length / sampleRate, sampleRate };
}

// Noncoherent quadrature detector. Prefix sums make each candidate symbol O(1).
// Eight timing phases tolerate an unknown sample offset; no shared TX clock or packet.
export function decodeAudio(pcm, sampleRate) {
  if (!(pcm instanceof Float32Array) || sampleRate < 8000 || sampleRate > 192000 || pcm.length > sampleRate * 16) throw new Error('Unsupported audio buffer');
  const sums = Array.from({ length: 4 }, () => new Float64Array(pcm.length + 1));
  for (let f = 0; f < 2; f++) {
    const w = 2 * Math.PI * TONES[f] / sampleRate;
    for (let i = 0; i < pcm.length; i++) {
      sums[f * 2][i + 1] = sums[f * 2][i] + pcm[i] * Math.cos(i * w);
      sums[f * 2 + 1][i + 1] = sums[f * 2 + 1][i] + pcm[i] * Math.sin(i * w);
    }
  }
  const symbol = sampleRate / BITRATE;
  let best = null, pending = null;
  for (let phase = 0; phase < 8; phase++) {
    const offset = phase * symbol / 8;
    const count = Math.max(0, Math.floor((pcm.length - offset) / symbol));
    const bits = new Uint8Array(count), strength = new Float32Array(count);
    for (let b = 0; b < count; b++) {
      const start = Math.round(offset + (b + 0.1) * symbol), end = Math.round(offset + (b + 0.9) * symbol);
      const energy = [0, 0];
      for (let f = 0; f < 2; f++) {
        const re = sums[f * 2][end] - sums[f * 2][start], im = sums[f * 2 + 1][end] - sums[f * 2 + 1][start];
        energy[f] = re * re + im * im;
      }
      const total = energy[0] + energy[1];
      bits[b] = energy[1] > energy[0] ? 1 : 0;
      strength[b] = total > 1e-5 ? Math.abs(energy[1] - energy[0]) / total : 0;
    }
    let shift = 0;
    for (let b = 0; b < count; b++) {
      shift = ((shift << 1) | bits[b]) >>> 0;
      if (shift !== SYNC || b < 63) continue;
      const syncStart = b - 31;
      let preambleErrors = 0, quality = 0;
      for (let j = 0; j < 32; j++) {
        if (bits[syncStart - 32 + j] !== j % 2) preambleErrors++;
        quality += strength[syncStart + j];
      }
      if (preambleErrors > 1 || quality / 32 < 0.4) continue;
      const startSample = Math.max(0, offset + (syncStart - PREAMBLE_BITS) * symbol);
      if (b + 17 >= count) { pending = { kind: 'partial', reason: 'Incomplete physical header', startSample }; continue; }
      let length = 0;
      for (let j = 1; j <= 16; j++) length = (length << 1) | bits[b + j];
      if (length < MIN_PACKET || length > MAX_PACKET) {
        best ??= { kind: 'corrupted', reason: 'Physical length out of bounds', startSample };
        continue;
      }
      const dataStart = b + 17, end = dataStart + length * 8;
      if (end > count) { pending = { kind: 'partial', reason: 'Frame detected but incomplete', expectedBytes: length, startSample }; continue; }
      const packet = bitsToBytes(bits.slice(dataStart, end));
      const endSample = offset + end * symbol;
      const frame = { kind: 'packet', packet, startSample, endSample, quality: quality / 32 };
      const view = new DataView(packet.buffer);
      // CRC selects a timing phase, not authenticity. Signature checked independently.
      if (view.getUint32(packet.length - 4) === crc32(packet.subarray(0, -4))) return frame;
      if (!best || quality / 32 > (best.quality ?? 0)) best = frame;
    }
  }
  return best ?? pending ?? { kind: 'none', reason: 'No synchronized frame found' };
}
