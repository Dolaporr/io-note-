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

// Framing states reported to the operator while a physical transmission is in flight.
export const FRAMING = Object.freeze({ none: 'NO SIGNAL', carrier: 'CARRIER; NO SYNC', sync: 'SYNC FOUND; HEADER INCOMPLETE', length: 'SYNC FOUND; LENGTH INVALID', incomplete: 'FRAME INCOMPLETE', complete: 'FRAME COMPLETE' });
const TRACE_SYMBOLS = 64;
const db = v => 20 * Math.log10(Math.max(v, 1e-6));
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
function levels(pcm) {
  let peak = 0, squares = 0, clipped = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
    if (v > peak) peak = v;
    if (v >= 0.999) clipped++;
    squares += pcm[i] * pcm[i];
  }
  const rms = Math.sqrt(squares / Math.max(1, pcm.length));
  return { rms: round(rms, 5), peak: round(peak, 5), rmsDbfs: round(db(rms), 1), peakDbfs: round(db(peak), 1), clippedSamples: clipped };
}
// Per-phase symbol telemetry. Observational only: it never feeds a decode decision.
function summarise(phase, bits, strength, energyLow, energyHigh) {
  let strong = 0, confidence = 0, low = 0, best = 0, window = 0, at = 0;
  for (let b = 0; b < bits.length; b++) {
    confidence += strength[b];
    if (strength[b] >= 0.5) strong++;
    if (bits[b] === 0) low++;
    window += strength[b];
    if (b >= TRACE_SYMBOLS) window -= strength[b - TRACE_SYMBOLS];
    if (b >= TRACE_SYMBOLS - 1 && window > best) { best = window; at = b - TRACE_SYMBOLS + 1; }
  }
  const energy = energyLow + energyHigh;
  return {
    phase, symbols: bits.length, strongSymbols: strong,
    meanConfidence: round(bits.length ? confidence / bits.length : 0),
    lowToneSymbols: low, highToneSymbols: bits.length - low,
    toneShare: { 1200: round(energy ? energyLow / energy : 0), 2200: round(energy ? energyHigh / energy : 0) },
    strongestWindowStart: at, strongestWindowConfidence: round(bits.length >= TRACE_SYMBOLS ? best / TRACE_SYMBOLS : 0),
  };
}
function trace(bits, strength, from) {
  const start = Math.max(0, Math.min(from, bits.length - TRACE_SYMBOLS));
  const end = Math.min(bits.length, start + TRACE_SYMBOLS);
  const out = { fromSymbol: start, bits: '', confidence: [] };
  for (let b = start; b < end; b++) { out.bits += bits[b]; out.confidence.push(round(strength[b], 2)); }
  return out;
}

// Noncoherent quadrature detector. Prefix sums make each candidate symbol O(1).
// Eight timing phases tolerate an unknown sample offset; no shared TX clock or packet.
// Diagnostics are accumulated alongside, and never alter a decode decision.
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
  const diagnostics = {
    sampleRate, capturedSeconds: round(pcm.length / sampleRate, 2), symbolSamples: round(symbol, 2), tones: TONES,
    level: levels(pcm), sync: { candidates: 0, preambleRejected: 0, qualityRejected: 0, accepted: 0, bestPreambleErrors: null, bestQuality: null, phase: null },
    framing: FRAMING.none, declaredPacketBytes: null, bits: { framing: OVERHEAD_BITS, expectedData: null, receivedData: null, total: null },
    checksum: 'not reached', phases: [], symbolTrace: null,
  };
  const phaseBits = [], phaseStrength = [];
  let best = null, pending = null, bestPhase = null, pendingPhase = null, traceFrom = null;
  const report = (result, phase) => {
    const p = phase == null ? diagnostics.phases.reduce((a, b) => (b.meanConfidence > a.meanConfidence ? b : a), diagnostics.phases[0]) : diagnostics.phases[phase];
    diagnostics.reportedPhase = p?.phase ?? null;
    diagnostics.symbols = p ?? null;
    if (p) diagnostics.symbolTrace = trace(phaseBits[p.phase], phaseStrength[p.phase], traceFrom ?? p.strongestWindowStart);
    if (diagnostics.framing === FRAMING.none && p && p.meanConfidence >= 0.4 && diagnostics.level.rmsDbfs > -60) diagnostics.framing = FRAMING.carrier;
    return { ...result, diagnostics };
  };
  for (let phase = 0; phase < 8; phase++) {
    const offset = phase * symbol / 8;
    const count = Math.max(0, Math.floor((pcm.length - offset) / symbol));
    const bits = new Uint8Array(count), strength = new Float32Array(count);
    let energyLow = 0, energyHigh = 0;
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
      energyLow += energy[0]; energyHigh += energy[1];
    }
    phaseBits[phase] = bits; phaseStrength[phase] = strength;
    diagnostics.phases.push(summarise(phase, bits, strength, energyLow, energyHigh));
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
      diagnostics.sync.candidates++;
      if (diagnostics.sync.bestQuality == null || quality / 32 > diagnostics.sync.bestQuality) {
        diagnostics.sync.bestQuality = round(quality / 32); diagnostics.sync.bestPreambleErrors = preambleErrors; diagnostics.sync.phase = phase;
      }
      if (preambleErrors > 1) { diagnostics.sync.preambleRejected++; continue; }
      if (quality / 32 < 0.4) { diagnostics.sync.qualityRejected++; continue; }
      diagnostics.sync.accepted++;
      traceFrom = Math.max(0, syncStart - PREAMBLE_BITS);
      const startSample = Math.max(0, offset + (syncStart - PREAMBLE_BITS) * symbol);
      if (b + 17 >= count) {
        diagnostics.framing = FRAMING.sync; diagnostics.bits.receivedData = 0;
        pending = { kind: 'partial', reason: 'Incomplete physical header', startSample }; pendingPhase = phase; continue;
      }
      let length = 0;
      for (let j = 1; j <= 16; j++) length = (length << 1) | bits[b + j];
      if (length < MIN_PACKET || length > MAX_PACKET) {
        diagnostics.framing = FRAMING.length; diagnostics.declaredPacketBytes = length;
        best ??= { kind: 'corrupted', reason: 'Physical length out of bounds', startSample }; bestPhase ??= phase; continue;
      }
      const dataStart = b + 17, end = dataStart + length * 8;
      if (end > count) {
        diagnostics.framing = FRAMING.incomplete; diagnostics.declaredPacketBytes = length;
        diagnostics.bits.expectedData = length * 8; diagnostics.bits.receivedData = Math.max(0, count - dataStart);
        pending = { kind: 'partial', reason: 'Frame detected but incomplete', expectedBytes: length, startSample }; pendingPhase = phase; continue;
      }
      const packet = bitsToBytes(bits.slice(dataStart, end));
      const endSample = offset + end * symbol;
      const frame = { kind: 'packet', packet, startSample, endSample, quality: quality / 32 };
      const view = new DataView(packet.buffer);
      const crcOk = view.getUint32(packet.length - 4) === crc32(packet.subarray(0, -4));
      diagnostics.framing = FRAMING.complete; diagnostics.declaredPacketBytes = length;
      diagnostics.bits.expectedData = length * 8; diagnostics.bits.receivedData = length * 8; diagnostics.bits.total = OVERHEAD_BITS + length * 8;
      diagnostics.checksum = crcOk ? 'CRC-32 PASS' : 'CRC-32 FAIL';
      // CRC selects a timing phase, not authenticity. Signature checked independently.
      if (crcOk) return report(frame, phase);
      if (!best || quality / 32 > (best.quality ?? 0)) { best = frame; bestPhase = phase; }
    }
  }
  if (best) return report(best, bestPhase);
  if (pending) return report(pending, pendingPhase);
  return report({ kind: 'none', reason: 'No synchronized frame found' }, null);
}
