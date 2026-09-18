// Replay a raw physical capture offline through the same decoder the receiver ran.
//   node scripts/replay-capture.mjs io-note-capture-....wav [io-note-capture-....json]
// It slides the same bounded window the worker uses, reports every decode attempt's
// framing state, and verifies any recovered packet. It changes no decoder behaviour.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyPacket, hex } from '../src/protocol.mjs';
import { decodeAudio, FRAMING } from '../src/modem.mjs';

const WINDOW_SECONDS = 14, STEP_SECONDS = 0.25;
const FRAMING_RANK = [FRAMING.none, FRAMING.carrier, FRAMING.sync, FRAMING.length, FRAMING.incomplete, FRAMING.complete];
const rank = d => FRAMING_RANK.indexOf(d.framing) * 1000 + (d.sync.accepted ?? 0) * 10 + (d.sync.bestQuality ?? 0);

export function readWav(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const tag = at => String.fromCharCode(buffer[at], buffer[at + 1], buffer[at + 2], buffer[at + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file');
  let at = 12, fmt = null, data = null;
  while (at + 8 <= buffer.length) {
    const id = tag(at), size = view.getUint32(at + 4, true), body = at + 8;
    if (id === 'fmt ') fmt = { format: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    if (id === 'data') data = { at: body, size: Math.min(size, buffer.length - body) };
    at = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('Missing fmt or data chunk');
  const bytes = fmt.bits / 8, frames = Math.floor(data.size / bytes / fmt.channels);
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const off = data.at + i * bytes * fmt.channels; // first channel only
    pcm[i] = fmt.format === 3 ? view.getFloat32(off, true)
      : fmt.bits === 16 ? view.getInt16(off, true) / 32768
      : fmt.bits === 32 ? view.getInt32(off, true) / 2147483648 : 0;
  }
  if (fmt.format !== 3 && fmt.format !== 1) throw new Error(`Unsupported WAV format code ${fmt.format}`);
  return { pcm, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, float: fmt.format === 3 };
}

// Imported for readWav by the tests; only replays a file when run directly.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const [wavPath, jsonPath] = process.argv.slice(2);
  if (!wavPath) { console.error('usage: node scripts/replay-capture.mjs <capture.wav> [capture.json]'); process.exit(2); }
  const audio = readWav(await readFile(wavPath));
  const meta = jsonPath ? JSON.parse(await readFile(jsonPath, 'utf8')) : null;
  const { pcm, sampleRate } = audio;
  console.log(`${path.basename(wavPath)} · ${audio.float ? '32-bit float' : `${audio.bits}-bit int`} · ${audio.channels} ch · ${sampleRate.toLocaleString()} Hz · ${(pcm.length / sampleRate).toFixed(2)} s`);
  if (meta) console.log(`capture ${meta.capture?.startedAt} → ${meta.capture?.endedAt} · context ${meta.capture?.audioContextSampleRate} Hz · ${meta.userAgent ?? ''}`);

  const windowSamples = Math.min(pcm.length, Math.round(WINDOW_SECONDS * sampleRate));
  const step = Math.round(STEP_SECONDS * sampleRate);
  const attempts = [];
  let best = null, bestAt = 0, recovered = null;
  for (let end = Math.min(pcm.length, windowSamples); ; end = Math.min(pcm.length, end + step)) {
    const start = Math.max(0, end - windowSamples);
    const decoded = decodeAudio(pcm.subarray(start, end).slice(), sampleRate);
    const d = decoded.diagnostics;
    attempts.push({ windowStartSeconds: +(start / sampleRate).toFixed(2), windowEndSeconds: +(end / sampleRate).toFixed(2), kind: decoded.kind, framing: d.framing, checksum: d.checksum, rmsDbfs: d.level.rmsDbfs, crestDb: d.level.crestDb, lowShare: d.symbols.toneShare[1200], meanConfidence: d.symbols.meanConfidence, syncCandidates: d.sync.candidates, syncAccepted: d.sync.accepted });
    if (!best || rank(d) > rank(best)) { best = d; bestAt = start; }
    if (decoded.kind === 'packet' && !recovered) recovered = decoded;
    if (end >= pcm.length) break;
  }

  console.log(`\n${attempts.length} decode attempts over a ${WINDOW_SECONDS} s sliding window`);
  const seen = new Map();
  for (const a of attempts) seen.set(a.framing, (seen.get(a.framing) ?? 0) + 1);
  for (const [state, n] of seen) console.log(`  ${String(n).padStart(4)} attempts · ${state}`);

  console.log(`\nbest attempt · window from ${(bestAt / sampleRate).toFixed(2)} s`);
  console.log(`  framing        ${best.framing}`);
  console.log(`  level          ${best.level.rmsDbfs} dBFS rms · ${best.level.peakDbfs} peak · crest ${best.level.crestDb} dB · ${best.level.clippedSamples} clipped`);
  console.log(`  tone share     ${(best.symbols.toneShare[1200] * 100).toFixed(1)}% @1200 / ${(best.symbols.toneShare[2200] * 100).toFixed(1)}% @2200`);
  console.log(`  symbols        ${best.symbols.symbols} analysed · ${best.symbols.strongSymbols} strong · mean confidence ${best.symbols.meanConfidence} · phase ${best.reportedPhase}`);
  console.log(`  sync           ${best.sync.candidates} candidates · ${best.sync.accepted} accepted · ${best.sync.preambleRejected} preamble / ${best.sync.qualityRejected} quality rejected`);
  console.log(`  bits           ${best.bits.framing} framing + ${best.bits.receivedData ?? 0} / ${best.bits.expectedData ?? '?'} data`);
  console.log(`  checksum       ${best.checksum}`);
  console.log(`  trace (${best.traceSource})\n                 ${best.symbolTrace.bits}`);
  for (const c of best.candidates) console.log(`  candidate      phase ${c.phase} @ ${c.atSeconds}s · quality ${c.quality} · ${c.preambleErrors} preamble errors · ${c.outcome}: ${c.reason}`);

  let signature = null;
  if (recovered) {
    const result = await verifyPacket(recovered.packet);
    signature = result.status;
    console.log(`\nrecovered ${recovered.packet.length} bytes · ${result.status}${result.message !== undefined ? ` · ${JSON.stringify(result.message)}` : ''}`);
    console.log(`  packet ${hex(recovered.packet).slice(0, 64)}…`);
  } else {
    console.log('\nno packet recovered from this capture');
  }

  await mkdir('results', { recursive: true });
  const out = path.join('results', `replay-${path.basename(wavPath).replace(/\.wav$/i, '')}.json`);
  await writeFile(out, JSON.stringify({ source: path.basename(wavPath), audio: { sampleRate, channels: audio.channels, bits: audio.bits, float: audio.float, seconds: pcm.length / sampleRate }, attempts, bestWindowStartSeconds: +(bestAt / sampleRate).toFixed(2), bestDiagnostics: best, recovered: recovered ? { bytes: recovered.packet.length, hex: hex(recovered.packet), signature } : null, physicalAudioVerified: false }, null, 2) + '\n');
  console.log(`\nwrote ${out}`);
}
