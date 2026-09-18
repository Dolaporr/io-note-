// Offline channel experiments for the first failed physical attempt.
// These only OBSERVE the production decoder; nothing here tunes it, and no parameter is
// fitted to the failed recording. Writes results/channel-experiments.json.
import { writeFile, mkdir } from 'node:fs/promises';
import { createPacket, importIdentity, verifyPacket, STATUS, hex } from '../src/protocol.mjs';
import { decodeAudio, modulate, modulateBits, frameBits, FRAMING, BITRATE, TONES, OVERHEAD_BITS } from '../src/modem.mjs';
import { TEST_IDENTITY } from '../src/selftest.mjs';
import { resampleLinear, resampleSinc, modulateImbalanced, whiteNoise, toneNoise, lfNoise, tilted, mix, pad } from './channel-lab.mjs';

const MESSAGE = 'we control the io pins';
const keys = await importIdentity(TEST_IDENTITY);
const packet = await createPacket(MESSAGE, keys, new Uint8Array(16));
const expected = hex(packet);
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;
const db = v => round(20 * Math.log10(Math.max(v, 1e-6)), 1);

// What the receiver reported on the failed attempt, for comparison only.
const OBSERVED = { sampleRate: 44100, rmsDbfs: -51.2, peakDbfs: -24.3, clippedSamples: 0, lowShare: 0.85, symbols: 1689, strongSymbols: 1198, meanConfidence: 0.66, syncAccepted: 0, trace: 'effectively all 0', framing: [FRAMING.none, FRAMING.carrier, FRAMING.length] };

async function run(pcm, rate) {
  const decoded = decodeAudio(pcm, rate);
  const d = decoded.diagnostics;
  const verified = decoded.kind === 'packet' ? (await verifyPacket(decoded.packet)).status : null;
  return {
    kind: decoded.kind, framing: d.framing, checksum: d.checksum,
    byteExact: decoded.kind === 'packet' && hex(decoded.packet) === expected,
    signature: verified,
    rmsDbfs: d.level.rmsDbfs, peakDbfs: d.level.peakDbfs, crestDb: round(d.level.peakDbfs - d.level.rmsDbfs, 1),
    clippedSamples: d.level.clippedSamples,
    lowShare: d.symbols.toneShare[1200], symbols: d.symbols.symbols, strongSymbols: d.symbols.strongSymbols,
    meanConfidence: d.symbols.meanConfidence,
    syncCandidates: d.sync.candidates, syncAccepted: d.sync.accepted, preambleRejected: d.sync.preambleRejected, qualityRejected: d.sync.qualityRejected,
    bestQuality: d.sync.bestQuality, bestPreambleErrors: d.sync.bestPreambleErrors,
    traceSource: d.traceSource, trace: d.symbolTrace.bits,
    traceAlternates: /^(01){8,}/.test(d.symbolTrace.bits) || /^(10){8,}/.test(d.symbolTrace.bits),
    traceAllZero: /^0+$/.test(d.symbolTrace.bits),
  };
}

const results = { generatedAt: new Date().toISOString(), message: MESSAGE, packetBytes: packet.length, packetHex: expected, observed: OBSERVED, experiments: {} };

// 1. Does 44,100 Hz on its own break it?
results.experiments.sampleRates = [];
for (const rate of [44100, 48000, 96000]) results.experiments.sampleRates.push({ rate, ...await run(modulate(packet, rate), rate) });

// 2. Browser-style 48k -> 44.1k resampling, on its own.
results.experiments.resampling = [];
for (const [name, fn] of [['linear', resampleLinear], ['windowed-sinc', resampleSinc]])
  for (const [from, to] of [[48000, 44100], [44100, 48000], [48000, 16000]])
    results.experiments.resampling.push({ method: name, from, to, ...await run(fn(modulate(packet, from), from, to), to) });

// 3. Tone gain imbalance, at the observed 44,100 Hz capture rate.
results.experiments.imbalance = [];
const bits = frameBits(packet);
for (const highGain of [1, 0.8, 0.6, 0.5, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05])
  results.experiments.imbalance.push({ attenuated: '2200 Hz', gain: highGain, gainDb: db(highGain), ...await run(modulateImbalanced(bits, 44100, 1, highGain), 44100) });
for (const lowGain of [0.5, 0.3, 0.2, 0.1, 0.05])
  results.experiments.imbalance.push({ attenuated: '1200 Hz', gain: lowGain, gainDb: db(lowGain), ...await run(modulateImbalanced(bits, 44100, lowGain, 1), 44100) });

// 4. Level and room noise: does a faint signal under low-frequency noise look like the capture?
results.experiments.levelAndNoise = [];
for (const amplitude of [0.35, 0.1, 0.03, 0.01, 0.004, 0.002])
  for (const noise of [0, 0.002, 0.01])
    results.experiments.levelAndNoise.push({
      signalAmplitude: amplitude, signalPeakDbfs: db(amplitude), noiseAmplitude: noise,
      ...await run(mix(pad(modulateImbalanced(bits, 44100, 1, 1, amplitude), 44100, 0.5, 1.2), lfNoise(Math.round(44100 * 8.4), noise)), 44100),
    });

// 4b. In-band noise: broadband, and narrowband parked on the 1,200 Hz tone.
results.experiments.inBandNoise = [];
const SIGNAL = 0.06; // the observed capture peaked at -24.3 dBFS
for (const [kind, make] of [['white', (n, a) => whiteNoise(n, a)], ['1200 Hz interferer', (n, a) => toneNoise(n, a, 1200, 44100)], ['2200 Hz interferer', (n, a) => toneNoise(n, a, 2200, 44100)]])
  for (const noise of [0.006, 0.02, 0.06, 0.12, 0.25, 0.5]) {
    const signal = pad(modulateImbalanced(bits, 44100, 1, 1, SIGNAL), 44100, 0.5, 1.2);
    results.experiments.inBandNoise.push({ noiseKind: kind, snrDb: db(SIGNAL / noise), noiseAmplitude: noise, ...await run(mix(signal, make(signal.length, noise)), 44100) });
  }

// 7. A transmission that stops, or collapses in level, after the preamble and sync word.
// This is the shape of the receiver's reported SYNC FOUND; LENGTH INVALID.
results.experiments.interrupted = [];
for (const afterSymbols of [96, 100, 112, 150, 300, 800])
  for (const tailGain of [0, 0.02]) {
    const pcm = modulateImbalanced(bits, 44100, 1, 1, 0.35);
    const from = Math.round(0.15 * 44100 + afterSymbols * 44100 / BITRATE);
    for (let i = from; i < pcm.length; i++) pcm[i] *= tailGain;
    results.experiments.interrupted.push({ goodSymbols: afterSymbols, tailGain, ...await run(pcm, 44100) });
  }

// 8. Interference that is absent while the preamble and sync arrive, then returns.
// If this reproduces both reported states, one mechanism explains the whole attempt.
results.experiments.intermittent = [];
for (const startSymbol of [0, 64, 96, 112, 200, 600])
  for (const noise of [0.06, 0.12]) {
    const signal = pad(modulateImbalanced(bits, 44100, 1, 1, SIGNAL), 44100, 0.5, 1.2);
    const interferer = toneNoise(signal.length, noise, 1200, 44100);
    const from = Math.round(0.5 * 44100 + 0.15 * 44100 + startSymbol * 44100 / BITRATE);
    for (let i = 0; i < from && i < interferer.length; i++) interferer[i] = 0;
    results.experiments.intermittent.push({ interferenceFromSymbol: startSymbol, noiseAmplitude: noise, snrDb: db(SIGNAL / noise), ...await run(mix(signal, interferer), 44100) });
  }

// 9. Reconstruct the reported final window from its four numbers and see which mixture
// lands on all of them at once: RMS -51.2, peak -24.3 (crest 26.9 dB), lowShare 0.85,
// mean confidence 0.66, 1198 of 1689 symbols strong.
results.experiments.reconstruction = [];
for (const tilt of [0.3, 0.12, 0.06, 0.03]) {
  for (const signalSeconds of [0, 0.5]) {
    const length = Math.round(8.4 * 44100);
    const noise = tilted(length, 0.00275, 44100, tilt);      // -51.2 dBFS RMS
    for (let k = 0; k < 6; k++) {                            // transients -> peak -24.3 dBFS
      const at = Math.round((0.7 + k * 1.2) * 44100);
      for (let i = 0; i < 400 && at + i < length; i++) noise[at + i] += 0.06 * Math.sin(2 * Math.PI * 180 * i / 44100) * Math.exp(-i / 120);
    }
    if (signalSeconds) {
      const full = modulateImbalanced(bits, 44100, 1, 1, 0.004);
      const held = full.subarray(0, Math.round(signalSeconds * 44100));
      for (let i = 0; i < held.length; i++) noise[i + 44100] += held[i];
    }
    results.experiments.reconstruction.push({ noiseTilt: tilt, signalSecondsInWindow: signalSeconds, ...await run(noise, 44100) });
  }
}

// 5. A window that holds almost no signal: the crest factor the observed capture reported.
results.experiments.windowComposition = [];
for (const seconds of [8.4, 6.9, 4, 2, 0.5, 0.05]) {
  const full = modulateImbalanced(bits, 44100, 1, 1, 0.06);
  const held = full.subarray(0, Math.min(full.length, Math.round(seconds * 44100)));
  const window = new Float32Array(Math.round(8.4 * 44100));
  window.set(held.subarray(0, Math.min(held.length, window.length)));
  window[window.length - 1000] = 0.06; // one transient, so peak is defined even when quiet
  results.experiments.windowComposition.push({ signalSecondsInWindow: seconds, windowSeconds: 8.4, ...await run(window, 44100) });
}

// 6. The other observed state: sync recovered, then the capture stops inside the header.
results.experiments.truncation = [];
for (const dropBits of [0, 16, 17, 40, 200, 1000]) {
  const kept = bits.slice(0, bits.length - dropBits);
  results.experiments.truncation.push({ droppedTrailingBits: dropBits, ...await run(modulateImbalanced(kept, 44100, 1, 1), 44100) });
}
// Sync present, then silence: the LENGTH INVALID path the receiver reported.
{
  const head = frameBits(packet).slice(0, OVERHEAD_BITS - 16 + 4);
  const pcm = pad(modulateImbalanced(head, 44100, 1, 1), 44100, 0, 3);
  results.experiments.truncation.push({ droppedTrailingBits: 'everything after sync', ...await run(pcm, 44100) });
}

await mkdir('results', { recursive: true });
await writeFile('results/channel-experiments.json', JSON.stringify(results, null, 2) + '\n');

const line = r => `${String(r.kind).padEnd(9)} ${String(r.framing).padEnd(30)} lowShare=${String(r.lowShare).padEnd(6)} conf=${String(r.meanConfidence).padEnd(6)} sync=${r.syncCandidates}/${r.syncAccepted} crest=${String(r.crestDb).padStart(5)}dB rms=${String(r.rmsDbfs).padStart(6)} trace=${r.traceAlternates ? 'alternating' : r.traceAllZero ? 'ALL ZERO' : 'other'} ${r.byteExact ? 'BYTE-EXACT' : ''}`;
console.log('\n1. sample rates');
for (const r of results.experiments.sampleRates) console.log(`  ${String(r.rate).padEnd(8)} ${line(r)}`);
console.log('\n2. resampling');
for (const r of results.experiments.resampling) console.log(`  ${r.method.padEnd(13)} ${r.from}->${String(r.to).padEnd(6)} ${line(r)}`);
console.log('\n3. tone gain imbalance');
for (const r of results.experiments.imbalance) console.log(`  ${r.attenuated} ${String(r.gainDb).padStart(6)}dB ${line(r)}`);
console.log('\n4. level and low-frequency noise');
for (const r of results.experiments.levelAndNoise) console.log(`  sig=${String(r.signalPeakDbfs).padStart(6)}dB noise=${String(r.noiseAmplitude).padEnd(6)} ${line(r)}`);
console.log('\n4b. in-band noise');
for (const r of results.experiments.inBandNoise) console.log(`  ${r.noiseKind.padEnd(19)} snr=${String(r.snrDb).padStart(6)}dB ${line(r)}`);
console.log('\n7. transmission interrupted after N good symbols (sync needs 96)');
for (const r of results.experiments.interrupted) console.log(`  ${String(r.goodSymbols).padStart(4)} symbols tail=${String(r.tailGain).padEnd(5)} ${line(r)}`);
console.log('\n8. 1,200 Hz interference starting partway through the frame (sync completes at symbol 96)');
for (const r of results.experiments.intermittent) console.log(`  from symbol ${String(r.interferenceFromSymbol).padStart(4)} snr=${String(r.snrDb).padStart(6)}dB ${line(r)}`);
console.log('\n9. reconstruction of the reported window (target: rms -51.2, crest 26.9, lowShare 0.85, conf 0.66, strong 1198/1689)');
for (const r of results.experiments.reconstruction) console.log(`  tilt=${String(r.noiseTilt).padEnd(5)} sig=${String(r.signalSecondsInWindow).padEnd(4)}s ${line(r)} strong=${r.strongSymbols}/${r.symbols}`);
console.log('\n5. how much signal is actually inside the window');
for (const r of results.experiments.windowComposition) console.log(`  ${String(r.signalSecondsInWindow).padStart(5)}s of 8.4s ${line(r)}`);
console.log('\n6. truncation');
for (const r of results.experiments.truncation) console.log(`  drop ${String(r.droppedTrailingBits).padEnd(24)} ${line(r)}`);
