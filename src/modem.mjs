import { MIN_PACKET, MAX_PACKET, crc32 } from './protocol.mjs';

export const BITRATE = 200;
export const TONES = [1200, 2200];
// The preamble is an acquisition run, not a fixed header. Synchronisation only ever
// validates the PREAMBLE_CHECK symbols immediately before the sync word, so a receiver may
// join anywhere in the preamble and still lock: the join grace is
// (PREAMBLE_BITS - PREAMBLE_CHECK) symbols. Lengthening it is a transmitter-side change —
// the detector is untouched, and a longer preamble stays readable by any earlier receiver.
export const PREAMBLE_BITS = 256;
export const PREAMBLE_CHECK = 32;
export const JOIN_GRACE_SECONDS = (PREAMBLE_BITS - PREAMBLE_CHECK) / 200;
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
// `preambleSymbols` exists so a test can build a frame with an earlier preamble length and
// confirm this decoder still reads it. Senders should leave it at the default.
export function frameBits(packet, preambleSymbols = PREAMBLE_BITS) {
  if (packet.length < MIN_PACKET || packet.length > MAX_PACKET) throw new Error('Packet size out of bounds');
  if (!Number.isInteger(preambleSymbols) || preambleSymbols < PREAMBLE_CHECK) throw new Error(`Preamble must be at least ${PREAMBLE_CHECK} symbols`);
  const h = new Uint8Array(6), v = new DataView(h.buffer);
  v.setUint32(0, SYNC); v.setUint16(4, packet.length);
  const header = preambleSymbols + 48;
  const bits = new Uint8Array(header + packet.length * 8);
  for (let i = 0; i < preambleSymbols; i++) bits[i] = i % 2;
  bits.set(bytesToBits(h), preambleSymbols);
  bits.set(bytesToBits(packet), header);
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
const MAX_CANDIDATES = 64;
const TIMELINE_BINS = 240;
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
  // Crest factor separates "a tone is here" from "this window is silence plus a bang":
  // continuous FSK sits near 3 dB, an empty window with one transient runs far higher.
  return { rms: round(rms, 5), peak: round(peak, 5), rmsDbfs: round(db(rms), 1), peakDbfs: round(db(peak), 1), crestDb: round(db(peak) - db(rms), 1), clippedSamples: clipped };
}
// Per-phase symbol telemetry. Observational only: it never feeds a decode decision.
// Two candidate trace windows are tracked. The confidence window is where the detector is
// most certain; in near-silence that is noise, because confidence is a ratio and ignores
// level. The energy window is where the loudest in-band audio actually is, which is what a
// faint physical capture needs.
function summarise(phase, bits, strength, energyLow, energyHigh) {
  let strong = 0, confidence = 0, low = 0, totalLow = 0, totalHigh = 0;
  let bestConf = 0, confWindow = 0, confAt = 0, bestEnergy = 0, energyWindow = 0, energyAt = 0;
  for (let b = 0; b < bits.length; b++) {
    confidence += strength[b];
    if (strength[b] >= 0.5) strong++;
    if (bits[b] === 0) low++;
    totalLow += energyLow[b]; totalHigh += energyHigh[b];
    confWindow += strength[b];
    energyWindow += energyLow[b] + energyHigh[b];
    if (b >= TRACE_SYMBOLS) { confWindow -= strength[b - TRACE_SYMBOLS]; energyWindow -= energyLow[b - TRACE_SYMBOLS] + energyHigh[b - TRACE_SYMBOLS]; }
    if (b >= TRACE_SYMBOLS - 1) {
      if (confWindow > bestConf) { bestConf = confWindow; confAt = b - TRACE_SYMBOLS + 1; }
      if (energyWindow > bestEnergy) { bestEnergy = energyWindow; energyAt = b - TRACE_SYMBOLS + 1; }
    }
  }
  const energy = totalLow + totalHigh;
  return {
    phase, symbols: bits.length, strongSymbols: strong,
    meanConfidence: round(bits.length ? confidence / bits.length : 0),
    lowToneSymbols: low, highToneSymbols: bits.length - low,
    toneShare: { 1200: round(energy ? totalLow / energy : 0), 2200: round(energy ? totalHigh / energy : 0) },
    strongestWindowStart: confAt, strongestWindowConfidence: round(bits.length >= TRACE_SYMBOLS ? bestConf / TRACE_SYMBOLS : 0),
    peakEnergyWindowStart: energyAt,
  };
}
function trace(bits, strength, from) {
  const start = Math.max(0, Math.min(from, bits.length - TRACE_SYMBOLS));
  const end = Math.min(bits.length, start + TRACE_SYMBOLS);
  const out = { fromSymbol: start, bits: '', confidence: [] };
  for (let b = start; b < end; b++) { out.bits += bits[b]; out.confidence.push(round(strength[b], 2)); }
  return out;
}
// Per-tone energy against time, so a capture can be read for level collapse or tone loss.
function timeline(energyLow, energyHigh, strength, symbolSamples, sampleRate) {
  const count = energyLow.length;
  if (!count) return { binSeconds: 0, bins: [] };
  const per = Math.max(1, Math.ceil(count / TIMELINE_BINS)), bins = [];
  for (let at = 0; at < count; at += per) {
    const end = Math.min(count, at + per);
    let low = 0, high = 0, confidence = 0;
    for (let b = at; b < end; b++) { low += energyLow[b]; high += energyHigh[b]; confidence += strength[b]; }
    const total = low + high, n = end - at;
    bins.push({ atSeconds: round(at * symbolSamples / sampleRate, 3), symbols: n, energyLow: round(low / n, 6), energyHigh: round(high / n, 6), lowShare: round(total ? low / total : 0), meanConfidence: round(confidence / n) });
  }
  return { binSeconds: round(per * symbolSamples / sampleRate, 3), bins };
}

// Noncoherent quadrature detector. Prefix sums make each candidate symbol O(1).
// Eight timing phases tolerate an unknown sample offset; no shared TX clock or packet.
// Diagnostics are accumulated alongside, and never alter a decode decision. `detail` adds
// the full per-symbol dump for offline replay; it changes nothing the decoder decides.
export function decodeAudio(pcm, sampleRate, { detail = false } = {}) {
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
    checksum: 'not reached', phases: [], symbolTrace: null, traceSource: null, candidates: [], candidatesTruncated: false, timeline: null,
  };
  const phaseBits = [], phaseStrength = [], phaseLow = [], phaseHigh = [];
  let best = null, pending = null, bestPhase = null, pendingPhase = null, traceFrom = null, traceSource = null;
  const note = row => { if (diagnostics.candidates.length < MAX_CANDIDATES) diagnostics.candidates.push(row); else diagnostics.candidatesTruncated = true; };
  const report = (result, phase) => {
    const p = phase == null ? diagnostics.phases.reduce((a, b) => (b.meanConfidence > a.meanConfidence ? b : a), diagnostics.phases[0]) : diagnostics.phases[phase];
    diagnostics.reportedPhase = p?.phase ?? null;
    diagnostics.symbols = p ?? null;
    if (p) {
      const from = traceFrom ?? p.peakEnergyWindowStart;
      diagnostics.traceSource = traceSource ?? 'peak in-band energy';
      diagnostics.symbolTrace = trace(phaseBits[p.phase], phaseStrength[p.phase], from);
      diagnostics.timeline = timeline(phaseLow[p.phase], phaseHigh[p.phase], phaseStrength[p.phase], symbol, sampleRate);
      if (detail) diagnostics.detail = {
        phase: p.phase, symbolSamples: symbol,
        bits: Array.from(phaseBits[p.phase]).join(''),
        confidence: Array.from(phaseStrength[p.phase], v => round(v, 3)),
        energyLow: Array.from(phaseLow[p.phase], v => round(v, 6)),
        energyHigh: Array.from(phaseHigh[p.phase], v => round(v, 6)),
      };
    }
    if (diagnostics.framing === FRAMING.none && p && p.meanConfidence >= 0.4 && diagnostics.level.rmsDbfs > -60) diagnostics.framing = FRAMING.carrier;
    return { ...result, diagnostics };
  };
  for (let phase = 0; phase < 8; phase++) {
    const offset = phase * symbol / 8;
    const count = Math.max(0, Math.floor((pcm.length - offset) / symbol));
    const bits = new Uint8Array(count), strength = new Float32Array(count);
    const low = new Float64Array(count), high = new Float64Array(count);
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
      low[b] = energy[0]; high[b] = energy[1];
    }
    phaseBits[phase] = bits; phaseStrength[phase] = strength; phaseLow[phase] = low; phaseHigh[phase] = high;
    diagnostics.phases.push(summarise(phase, bits, strength, low, high));
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
      const candidate = { phase, symbol: syncStart, atSeconds: round((offset + syncStart * symbol) / sampleRate, 3), preambleErrors, quality: round(quality / 32) };
      if (diagnostics.sync.bestQuality == null || quality / 32 > diagnostics.sync.bestQuality) {
        diagnostics.sync.bestQuality = round(quality / 32); diagnostics.sync.bestPreambleErrors = preambleErrors; diagnostics.sync.phase = phase;
      }
      if (preambleErrors > 1) { diagnostics.sync.preambleRejected++; note({ ...candidate, outcome: 'rejected', reason: `preamble errors ${preambleErrors} > 1` }); continue; }
      if (quality / 32 < 0.4) { diagnostics.sync.qualityRejected++; note({ ...candidate, outcome: 'rejected', reason: `symbol quality ${round(quality / 32)} < 0.4` }); continue; }
      diagnostics.sync.accepted++;
      // Measure the acquisition run actually received rather than assuming this build's
      // length: a sender with a different preamble, or a receiver that joined partway
      // through one, both report honestly here. Observation only.
      let observed = 1;
      while (syncStart - observed - 1 >= 0 && observed < 4096 && bits[syncStart - observed - 1] !== bits[syncStart - observed]) observed++;
      // Reported next to what this build transmits, so the reader compares rather than
      // trusting a verdict. On real audio the run can overshoot by a few symbols when the
      // preceding noise happens to alternate.
      diagnostics.observedPreambleSymbols = observed;
      diagnostics.preambleSymbolsSent = PREAMBLE_BITS;
      diagnostics.bits.framing = observed + 48;
      traceFrom = Math.max(0, syncStart - observed); traceSource = 'accepted sync candidate';
      const startSample = Math.max(0, offset + (syncStart - observed) * symbol);
      if (b + 17 >= count) {
        diagnostics.framing = FRAMING.sync; diagnostics.bits.receivedData = 0;
        note({ ...candidate, outcome: 'accepted', reason: 'capture ends inside the physical header' });
        pending = { kind: 'partial', reason: 'Incomplete physical header', startSample }; pendingPhase = phase; continue;
      }
      let length = 0;
      for (let j = 1; j <= 16; j++) length = (length << 1) | bits[b + j];
      if (length < MIN_PACKET || length > MAX_PACKET) {
        diagnostics.framing = FRAMING.length; diagnostics.declaredPacketBytes = length;
        note({ ...candidate, outcome: 'accepted', length, reason: `declared length ${length} outside ${MIN_PACKET}..${MAX_PACKET}` });
        best ??= { kind: 'corrupted', reason: 'Physical length out of bounds', startSample }; bestPhase ??= phase; continue;
      }
      const dataStart = b + 17, end = dataStart + length * 8;
      if (end > count) {
        diagnostics.framing = FRAMING.incomplete; diagnostics.declaredPacketBytes = length;
        diagnostics.bits.expectedData = length * 8; diagnostics.bits.receivedData = Math.max(0, count - dataStart);
        note({ ...candidate, outcome: 'accepted', length, reason: `capture holds ${Math.max(0, count - dataStart)} of ${length * 8} data bits` });
        pending = { kind: 'partial', reason: 'Frame detected but incomplete', expectedBytes: length, startSample }; pendingPhase = phase; continue;
      }
      const packet = bitsToBytes(bits.slice(dataStart, end));
      const endSample = offset + end * symbol;
      const frame = { kind: 'packet', packet, startSample, endSample, quality: quality / 32 };
      const view = new DataView(packet.buffer);
      const crcOk = view.getUint32(packet.length - 4) === crc32(packet.subarray(0, -4));
      diagnostics.framing = FRAMING.complete; diagnostics.declaredPacketBytes = length;
      diagnostics.bits.expectedData = length * 8; diagnostics.bits.receivedData = length * 8; diagnostics.bits.total = diagnostics.bits.framing + length * 8;
      diagnostics.checksum = crcOk ? 'CRC-32 PASS' : 'CRC-32 FAIL';
      note({ ...candidate, outcome: 'accepted', length, reason: crcOk ? 'complete frame, CRC-32 PASS' : 'complete frame, CRC-32 FAIL' });
      // CRC selects a timing phase, not authenticity. Signature checked independently.
      if (crcOk) return report(frame, phase);
      if (!best || quality / 32 > (best.quality ?? 0)) { best = frame; bestPhase = phase; }
    }
  }
  if (best) return report(best, bestPhase);
  if (pending) return report(pending, pendingPhase);
  return report({ kind: 'none', reason: 'No synchronized frame found' }, null);
}
