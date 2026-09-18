import { STATUS, MAX_MESSAGE, utf8, hex, fingerprint, generateIdentity, exportIdentity, importIdentity, createPacket, verifyPacket, ReplayCache, appendCRC, parsePacket } from './protocol.mjs';
import { modulate, modulateBits, frameBits, decodeAudio, metrics, OVERHEAD_BITS, FRAMING } from './modem.mjs';
import { softwareLoopback, TEST_IDENTITY, TEST_MESSAGE } from './selftest.mjs';

const $ = id => document.getElementById(id);
const DASH = '—';
const LISTEN_SECONDS = 90;
const MODES = ['sender', 'receiver', 'both'];
let keys = null, gatePassed = false, busy = false, tx = null, rx = null, lastPacket = null, mode = 'both';
const liveCache = new ReplayCache();
const records = [];
let successes = 0, failures = 0, logLines = [], lastDiagnostics = null, lastCapture = null;
// Ranked so the panel can keep the most informative attempt of a capture rather than the
// last one, which after a rolling window has usually aged the signal out entirely.
const FRAMING_RANK = [FRAMING.none, FRAMING.carrier, FRAMING.sync, FRAMING.length, FRAMING.incomplete, FRAMING.complete];
const rank = d => (d ? FRAMING_RANK.indexOf(d.framing) * 1000 + (d.sync?.accepted ?? 0) * 10 + (d.sync?.bestQuality ?? 0) : -1);

function setMode(next) {
  mode = MODES.includes(next) ? next : 'both';
  document.body.className = `mode-${mode}`;
  for (const m of MODES) $(`mode-${m}`).classList.toggle('on', m === mode);
  try { localStorage.setItem('io-note-mode', mode); } catch { /* private mode is fine */ }
  controls();
}
function controls() {
  const sending = !!tx, receiving = !!rx;
  // Sender and receiver may run together only in single-device mode, for an acoustic self-test.
  const crossBlocked = mode === 'both' ? false : true;
  $('transmit').disabled = !gatePassed || !keys || busy || sending || (receiving && crossBlocked) || utf8.encode($('message').value).length > MAX_MESSAGE;
  $('resend').disabled = !gatePassed || !lastPacket || busy || sending || (receiving && crossBlocked);
  $('listen').disabled = !gatePassed || busy || receiving || (sending && crossBlocked);
  $('stop-rx').disabled = !receiving;
  $('stop-tx').disabled = !sending;
  $('selftest').disabled = busy || sending || receiving;
  $('generate').disabled = busy || sending || receiving;
  $('import-key').disabled = busy || sending || receiving;
  $('export-key').disabled = !keys || busy;
  $('run-attack').disabled = !gatePassed || busy || sending || receiving;
  $('export-capture').disabled = !lastCapture;
}
function display(result, label) {
  $('mode').textContent = label;
  $('status').textContent = result.status;
  $('received').textContent = result.message !== undefined ? result.message : result.reason || '';
  $('received-key').textContent = result.fingerprint || DASH;
  const kind = Object.keys(STATUS).find(k => STATUS[k] === result.status) || '';
  $('verdict').className = `verdict ${kind}`;
}
function showMetrics(m) {
  $('m-bytes').textContent = m.packetBytes;
  $('m-bits').textContent = m.transmittedBits;
  $('m-time').textContent = m.audioSeconds.toFixed(2);
}
function record(row) {
  records.push({ at: new Date().toISOString(), deviceRole: mode, ...row });
  if (row.successfulDecode === true) successes++;
  if (row.successfulDecode === false) failures++;
  $('m-decodes').textContent = `${successes} / ${failures}`;
}
function log(line) {
  logLines.push(`${new Date().toTimeString().slice(0, 8)}  ${line}`);
  if (logLines.length > 300) logLines.shift();
  const el = $('d-log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}
function cell(id, value, state = '') { const el = $(id); el.textContent = value; el.className = state; }
function resetDiagnostics(reason) {
  lastDiagnostics = null;
  for (const id of ['d-framing', 'd-level', 'd-tone', 'd-symbols', 'd-sync', 'd-bits', 'd-crc', 'd-sig']) cell(id, DASH);
  $('d-trace').textContent = DASH; $('d-trace-at').textContent = DASH; $('d-updated').textContent = reason;
}
// Everything below is observation of the decoder's own state; none of it feeds a decode decision.
function showDiagnostics(d, when) {
  if (!d) return;
  lastDiagnostics = d;
  $('d-updated').textContent = when;
  cell('d-framing', d.framing, d.framing === FRAMING.complete ? 'pass' : d.framing === FRAMING.none ? '' : 'hold');
  const quiet = d.level.rmsDbfs < -55;
  cell('d-level', `${d.level.rmsDbfs} / ${d.level.peakDbfs} dBFS`, d.level.clippedSamples > 0 ? 'fail' : quiet ? 'hold' : 'pass');
  $('d-level-note').textContent = `RMS / peak · crest ${d.level.crestDb} dB · ${d.level.clippedSamples} clipped · ${d.capturedSeconds} s window${d.level.crestDb > 12 ? ' · high crest: mostly not a tone' : ''}`;
  const s = d.symbols || {};
  const low = Math.round((s.toneShare?.[1200] ?? 0) * 100), high = Math.round((s.toneShare?.[2200] ?? 0) * 100);
  cell('d-tone', `${low}% / ${high}%`);
  $('d-tone-note').textContent = `1,200 Hz vs 2,200 Hz energy · ${s.lowToneSymbols ?? 0} low / ${s.highToneSymbols ?? 0} high symbols`;
  const confidence = s.meanConfidence ?? 0;
  cell('d-symbols', `${s.symbols ?? 0} · ${s.strongSymbols ?? 0} · ${confidence.toFixed(2)}`, confidence >= 0.6 ? 'pass' : confidence >= 0.4 ? 'hold' : 'fail');
  $('d-symbols-note').textContent = `analysed · strong (≥0.50) · mean confidence · timing phase ${d.reportedPhase ?? DASH} of 8`;
  cell('d-sync', `${d.sync.candidates} · ${d.sync.accepted}`, d.sync.accepted ? 'pass' : d.sync.candidates ? 'hold' : '');
  $('d-sync-note').textContent = `candidates · accepted · rejected ${d.sync.preambleRejected} preamble / ${d.sync.qualityRejected} quality${d.sync.bestQuality == null ? '' : ` · best quality ${d.sync.bestQuality}, ${d.sync.bestPreambleErrors} preamble errors`}`;
  cell('d-bits', d.bits.expectedData == null ? (d.sync.accepted ? `${d.bits.framing} + 0` : DASH) : `${d.bits.framing} + ${d.bits.receivedData} / ${d.bits.expectedData}`,
    d.bits.total ? 'pass' : d.bits.expectedData ? 'hold' : '');
  $('d-bits-note').textContent = d.declaredPacketBytes == null ? 'framing bits + data bits received / expected' : `framing + data bits · declared ${d.declaredPacketBytes}-byte packet${d.bits.total ? ` · ${d.bits.total} on air` : ''}`;
  cell('d-crc', d.checksum, d.checksum.endsWith('PASS') ? 'pass' : d.checksum.endsWith('FAIL') ? 'fail' : '');
  if (d.symbolTrace) {
    $('d-trace').textContent = d.symbolTrace.bits || DASH;
    const mean = d.symbolTrace.confidence.reduce((a, b) => a + b, 0) / Math.max(1, d.symbolTrace.confidence.length);
    $('d-trace-at').textContent = `from symbol ${d.symbolTrace.fromSymbol} · mean confidence ${mean.toFixed(2)} · a clean preamble reads 0101…`;
  }
}
// 32-bit float WAV: the exact samples the decoder consumed, with no quantisation step
// between the microphone and an offline replay.
function wav(pcm, sampleRate) {
  const buffer = new ArrayBuffer(58 + pcm.length * 4), view = new DataView(buffer);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 50 + pcm.length * 4, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 18, true);
  view.setUint16(20, 3, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 32, true); view.setUint16(36, 0, true);
  ascii(38, 'fact'); view.setUint32(42, 4, true); view.setUint32(46, pcm.length, true);
  ascii(50, 'data'); view.setUint32(54, pcm.length * 4, true);
  for (let i = 0; i < pcm.length; i++) view.setFloat32(58 + i * 4, pcm[i], true);
  return buffer;
}
function save(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function guarded(action) {
  busy = true; controls();
  try { await action(); }
  catch (e) { display({ status: 'ACTION FAILED', reason: e.message }, 'LOCAL ERROR'); log(`action failed: ${e.message}`); record({ mode: 'operation', error: e.message }); }
  finally { busy = false; controls(); }
}
async function updateKey() {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  $('sender-key').textContent = await fingerprint(raw);
  lastPacket = null; $('tx-packet').textContent = 'No packet encoded yet';
}
for (const m of MODES) $(`mode-${m}`).onclick = () => setMode(m);
$('message').addEventListener('input', () => { $('byte-count').textContent = `${utf8.encode($('message').value).length} / 96 UTF-8 bytes`; controls(); });
const preset = text => () => { $('message').value = text; $('message').dispatchEvent(new Event('input')); };
$('preset-io').onclick = preset('we control the io pins');
$('preset-hello').onclick = preset(TEST_MESSAGE);
$('clear-log').onclick = () => { logLines = []; $('d-log').textContent = 'Log cleared.'; };
$('message').dispatchEvent(new Event('input'));
$('selftest').onclick = () => guarded(async () => {
  gatePassed = false;
  $('gate-text').textContent = 'Decoding deterministic PCM samples and verifying…';
  try {
    const result = await softwareLoopback();
    gatePassed = true; $('gate-dot').className = 'dot pass';
    $('gate-text').textContent = 'Software loopback passed. Live audio controls unlocked.';
    display(result, 'SOFTWARE LOOPBACK · NO MICROPHONE'); showMetrics(result); record(result);
    log(`software loopback verified · ${result.packetBytes} bytes · ${result.transmittedBits} bits · ${result.processingMs.toFixed(1)} ms`);
    $('timing').textContent = `Software pipeline: ${result.processingMs.toFixed(1)} ms compute · ${result.toneSeconds.toFixed(2)} s tones + 0.30 s silence. No physical audio measured.`;
  } catch (e) { $('gate-dot').className = 'dot'; $('gate-text').textContent = `Loopback failed: ${e.message}`; log(`software loopback FAILED: ${e.message}`); record({ mode: 'software loopback', successfulDecode: false, error: e.message }); throw e; }
});
$('generate').onclick = () => guarded(async () => { keys = await generateIdentity(); await updateKey(); log('generated a new local Ed25519 identity'); });
$('export-key').onclick = () => guarded(async () => { download('io-note-private-key.json', JSON.stringify(await exportIdentity(keys), null, 2)); $('tx-note').textContent = 'Export contains an unencrypted private key. Keep it local; do not share it.'; });
$('import-key').onchange = () => guarded(async () => {
  const file = $('import-key').files[0]; if (!file) return;
  if (file.size > 4096) throw new Error('Key file exceeds 4 KiB');
  const imported = await importIdentity(JSON.parse(await file.text()));
  keys = imported; await updateKey(); $('import-key').value = ''; log('imported an io-note-key-v1 identity');
});
async function transmit(reuse) {
  const actionStart = performance.now();
  const context = new AudioContext();
  await context.resume();
  try {
    const packet = reuse ? lastPacket.slice() : await createPacket($('message').value, keys);
    lastPacket = packet.slice();
    const pcm = modulate(packet, context.sampleRate), m = metrics(packet, context.sampleRate);
    const buffer = context.createBuffer(1, pcm.length, context.sampleRate); buffer.copyToChannel(pcm, 0);
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    tx = { source, context, stopped: false }; const session = tx;
    showMetrics(m); $('signal').classList.add('active');
    $('tx-packet').textContent = `nonce ${hex(packet.slice(37, 53))} · crc ${hex(packet.slice(-4))} · ${context.sampleRate.toLocaleString()} Hz`;
    $('tx-note').textContent = `Transmitting ${m.transmittedBits} bits · ${m.audioSeconds.toFixed(2)} seconds${reuse ? ' · same nonce (replay test)' : ''}`;
    log(`transmitting ${m.packetBytes} bytes / ${m.transmittedBits} bits · ${m.audioSeconds.toFixed(2)} s · crc ${hex(packet.slice(-4))}${reuse ? ' · replayed nonce' : ''}`);
    source.onended = () => {
      const elapsed = performance.now() - actionStart;
      record({ mode: 'speaker transmission', ...m, replayedNonce: !!reuse, senderButtonToEndedMs: elapsed, interrupted: session.stopped, receiverOutcome: 'unknown on sender' });
      $('tx-note').textContent = session.stopped ? 'Transmission interrupted.' : 'Audio playback completed. Check the receiving device for its verdict.';
      $('timing').textContent = `Sender button → playback ended: ${(elapsed / 1000).toFixed(2)} s. This does not establish receiver success.`;
      log(`playback ${session.stopped ? 'interrupted' : 'completed'} after ${(elapsed / 1000).toFixed(2)} s; sender cannot observe delivery`);
      $('signal').classList.remove('active'); context.close(); tx = null; controls();
    };
    source.start(context.currentTime + 0.05);
  } catch (e) { await context.close(); throw e; }
}
$('transmit').onclick = () => guarded(() => transmit(false));
$('resend').onclick = () => guarded(() => transmit(true));
$('stop-tx').onclick = () => { if (tx) { tx.stopped = true; tx.source.stop(); } };
// Ask the worker for the exact samples it decoded, then shut the session down.
function endCapture(session) {
  if (!session || session.closed) return;
  if (session.exporting || !session.worker) return closeReceiver(session);
  session.exporting = true;
  session.exportTimer = setTimeout(() => closeReceiver(session), 8000);
  session.worker.postMessage({ type: 'export' });
}
function closeReceiver(session) {
  if (!session || session.closed) return;
  session.closed = true; clearInterval(session.timer); clearTimeout(session.exportTimer);
  session.worker?.terminate(); session.stream?.getTracks().forEach(t => t.stop());
  session.node?.disconnect(); session.source?.disconnect(); session.context?.close();
  if (rx === session) rx = null;
  controls();
}
async function handleAudio(session, data) {
  if (session.closed) return;
  if (data.kind === 'export') {
    clearTimeout(session.exportTimer);
    lastCapture = { ...data, capturedAt: session.startedAt, endedAt: new Date().toISOString(), microphoneSettings: session.settings, contextSampleRate: session.rate, best: session.best ?? null, log: logLines.slice() };
    log(`raw capture retained · ${data.recordingSeconds.toFixed(1)} s · ${data.sampleRate.toLocaleString()} Hz · export enabled`);
    closeReceiver(session); return;
  }
  if (data.diagnostics) {
    if (rank(data.diagnostics) > rank(session.best)) session.best = data.diagnostics;
    showDiagnostics(data.diagnostics, `${data.final ? 'FINAL' : 'LIVE'} · ${data.capturedSeconds.toFixed(1)} s CAPTURED · DECODE ${data.decodeMs.toFixed(0)} ms`);
    if (data.diagnostics.framing !== session.framing) {
      session.framing = data.diagnostics.framing;
      log(`framing → ${session.framing} at ${data.capturedSeconds.toFixed(1)} s (rms ${data.diagnostics.level.rmsDbfs} dBFS, confidence ${(data.diagnostics.symbols?.meanConfidence ?? 0).toFixed(2)})`);
    }
    if (!session.verifying) $('rx-note').textContent = `Listening · ${data.capturedSeconds.toFixed(1)} s captured · ${Math.max(0, session.endsAt - Date.now()) / 1000 | 0} s left · ${data.diagnostics.framing}`;
  }
  if (session.verifying) return;
  if (data.kind === 'error') {
    closeReceiver(session); display({ status: 'RECEIVER ERROR', reason: data.reason }, 'MICROPHONE');
    log(`receiver error: ${data.reason}`);
    record({ mode: 'microphone', successfulDecode: false, error: data.reason }); return;
  }
  if (data.kind === 'packet') {
    let intact = false;
    try { parsePacket(data.packet); intact = true; } catch { /* wait a little for trailing samples before rejecting */ }
    if (!intact && !data.final && data.capturedSeconds < data.endSample / session.rate + 0.20) return;
    session.verifying = true;
    const verifiedStart = performance.now();
    try {
      const result = await verifyPacket(data.packet, liveCache);
      const now = performance.now();
      const m = metrics(data.packet, session.rate);
      const row = { mode: 'microphone', ...m, ...result, successfulDecode: intact, capturedSeconds: data.capturedSeconds, decodeMs: data.decodeMs, verifyMs: now - verifiedStart, listenToVerdictMs: now - session.started, estimatedSignalToVerdictMs: session.captureEpoch == null ? null : now - session.captureEpoch - data.startSample / session.rate * 1000, frameSampleDurationSeconds: (data.endSample - data.startSample) / session.rate, microphoneSettings: session.settings, diagnostics: data.diagnostics };
      const sig = result.status === STATUS.verified ? 'pass' : result.status === STATUS.replay ? 'hold' : 'fail';
      cell('d-sig', result.status, sig);
      display(result, 'MICROPHONE INPUT'); showMetrics(m); record(row);
      log(`verdict ${result.status} after ${(row.listenToVerdictMs / 1000).toFixed(2)} s · ${m.packetBytes} bytes · checksum ${data.diagnostics?.checksum ?? 'n/a'}`);
      $('timing').textContent = `Listen → verdict: ${(row.listenToVerdictMs / 1000).toFixed(2)} s · estimated signal → verdict: ${row.estimatedSignalToVerdictMs == null ? 'unavailable' : (row.estimatedSignalToVerdictMs / 1000).toFixed(2) + ' s'} · decode ${data.decodeMs.toFixed(1)} ms`;
      $('rx-note').textContent = 'Capture stopped. Click Listen again to receive another packet; replay memory is retained.';
    } catch (e) { display({ status: 'RECEIVER ERROR', reason: e.message }, 'MICROPHONE'); log(`verification error: ${e.message}`); record({ mode: 'microphone', successfulDecode: false, error: e.message }); }
    finally { endCapture(session); }
  } else if (data.final) {
    const status = data.kind === 'none' ? 'NO PACKET DECODED' : STATUS.corrupted;
    display({ status, reason: data.reason }, 'MICROPHONE · DECODE FAILED');
    cell('d-sig', 'not reached');
    record({ mode: 'microphone', successfulDecode: false, status, reason: data.reason, capturedSeconds: data.capturedSeconds, diagnostics: data.diagnostics });
    log(`capture finished without a valid frame: ${data.reason}`);
    // The final window is usually the least informative one, so show the best attempt.
    if (session.best && rank(session.best) > rank(data.diagnostics)) {
      showDiagnostics(session.best, `BEST ATTEMPT OF THIS CAPTURE · ${session.best.capturedSeconds} s WINDOW`);
      log(`final window held no frame; showing the best attempt instead (${session.best.framing})`);
    }
    $('rx-note').textContent = 'Capture stopped without a complete valid frame. Export the raw capture before re-arming; the panel shows the best attempt of the capture, not the last one.';
    endCapture(session);
  }
}
$('listen').onclick = () => guarded(async () => {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone unavailable here. Open this page over HTTPS (or localhost) in a browser that allows microphone access; a local file:// page cannot prompt for it in every browser.');
  const context = new AudioContext();
  await context.resume();
  const session = { context, started: performance.now(), startedAt: new Date().toISOString(), captureEpoch: null, closed: false, verifying: false, exporting: false, framing: null, best: null, endsAt: Date.now() + LISTEN_SECONDS * 1000 };
  rx = session;
  resetDiagnostics('ARMING MICROPHONE');
  try {
    session.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
    session.settings = session.stream.getAudioTracks()[0].getSettings(); session.rate = context.sampleRate;
    const workerUrl = URL.createObjectURL(new Blob([decoderWorkerSource], { type: 'text/javascript' }));
    session.worker = new Worker(workerUrl); URL.revokeObjectURL(workerUrl);
    session.worker.onerror = e => { e.preventDefault(); handleAudio(session, { kind: 'error', reason: e.message || 'Decoder worker failed' }); };
    session.worker.onmessage = ({ data }) => handleAudio(session, data);
    session.worker.postMessage({ type: 'init', sampleRate: context.sampleRate });
    const workletUrl = URL.createObjectURL(new Blob([audioWorkletSource], { type: 'text/javascript' }));
    try { await context.audioWorklet.addModule(workletUrl); } finally { URL.revokeObjectURL(workletUrl); }
    session.node = new AudioWorkletNode(context, 'io-note-capture');
    session.node.port.onmessage = ({ data }) => {
      if (session.closed) return;
      session.captureEpoch ??= performance.now() - data.length / session.rate * 1000;
      session.worker.postMessage({ type: 'chunk', pcm: data }, [data.buffer]);
    };
    session.source = context.createMediaStreamSource(session.stream);
    session.source.connect(session.node);
    // Worklet outputs silence; microphone input is never fed back to speakers.
    session.node.connect(context.destination);
    session.timer = setInterval(() => {
      if (session.closed) return clearInterval(session.timer);
      if (Date.now() >= session.endsAt) { clearInterval(session.timer); session.worker?.postMessage({ type: 'finish' }); }
    }, 1000);
    display({ status: 'LISTENING', reason: `Transmit from the other device now. Auto-stop after ${LISTEN_SECONDS} seconds; the decoder keeps a rolling 14-second window.` }, 'MICROPHONE · ARMED');
    cell('d-sig', 'awaiting frame');
    log(`microphone armed · ${context.sampleRate.toLocaleString()} Hz · ${session.settings.echoCancellation === false ? 'echo cancellation off' : 'echo cancellation not reported off'}`);
    $('rx-note').textContent = `Microphone active · ${context.sampleRate.toLocaleString()} Hz · waiting for a frame…`;
  } catch (e) { closeReceiver(session); resetDiagnostics('MICROPHONE UNAVAILABLE'); throw e; }
});
$('stop-rx').onclick = () => { if (rx) { $('stop-rx').disabled = true; rx.worker?.postMessage({ type: 'finish' }); } };
$('run-attack').onclick = () => guarded(async () => {
  const type = $('attack').value, keys = await importIdentity(TEST_IDENTITY);
  let packet = await createPacket(TEST_MESSAGE, keys, new Uint8Array(16));
  const cache = new ReplayCache();
  if (type === 'nonce') await verifyPacket(packet, cache);
  if (['message', 'signature', 'public-key'].includes(type)) {
    const offset = type === 'message' ? 55 : type === 'public-key' ? 5 : packet.length - 5;
    packet[offset] ^= 1; packet = appendCRC(packet.slice(0, -4));
  }
  let result, decoded;
  if (type === 'truncate') result = await verifyPacket(packet.slice(0, -8), cache);
  else {
    const bits = frameBits(packet);
    if (type === 'bit') bits[OVERHEAD_BITS + 55 * 8 + 7] ^= 1;
    decoded = decodeAudio(modulateBits(bits), 48000);
    result = decoded.kind === 'packet' ? await verifyPacket(decoded.packet, cache) : { status: STATUS.corrupted, reason: decoded.reason };
  }
  display(result, `ADVERSARIAL SOFTWARE TEST · ${type.toUpperCase()}`);
  if (decoded?.diagnostics) showDiagnostics(decoded.diagnostics, `ADVERSARIAL SOFTWARE PCM · ${type.toUpperCase()}`);
  cell('d-sig', result.status, result.status === STATUS.verified ? 'pass' : result.status === STATUS.replay ? 'hold' : 'fail');
  showMetrics(metrics(packet));
  log(`adversarial ${type} → ${result.status}`);
  record({ mode: 'adversarial software PCM', attack: type, ...result, successfulDecode: result.status !== STATUS.corrupted });
  $('timing').textContent = 'Adversarial software test only. No physical audio measurement.';
});
$('export-capture').onclick = () => guarded(async () => {
  const c = lastCapture;
  if (!c) throw new Error('No capture retained yet. Arm the microphone and let a capture finish.');
  const stamp = c.endedAt.replace(/[:.]/g, '-');
  const signal = c.result.startSample == null ? null : { startSeconds: +(c.result.startSample / c.sampleRate).toFixed(3), endSeconds: c.result.endSample == null ? null : +(c.result.endSample / c.sampleRate).toFixed(3) };
  save(`io-note-capture-${stamp}.wav`, new Blob([wav(c.recording, c.sampleRate)], { type: 'audio/wav' }));
  download(`io-note-capture-${stamp}.json`, JSON.stringify({
    app: 'io-note 0.1.0', kind: 'raw physical capture', userAgent: navigator.userAgent, deviceRole: mode,
    wav: { file: `io-note-capture-${stamp}.wav`, format: '32-bit IEEE float, mono', sampleRate: c.sampleRate, samples: c.recordedSamples, seconds: c.recordingSeconds, contains: 'the exact microphone samples the decoder consumed', droppedFromStartSamples: c.recordingDroppedSamples },
    capture: { startedAt: c.capturedAt, endedAt: c.endedAt, capturedSeconds: c.capturedSeconds, audioContextSampleRate: c.contextSampleRate, microphoneSettings: c.microphoneSettings },
    decoderWindow: { seconds: c.windowSeconds, startSample: c.windowStartSample, endSample: c.windowEndSample, note: 'The decoder only ever sees this rolling window; the WAV holds the whole capture.' },
    signalInterval: signal, finalResult: c.result,
    finalWindowDiagnostics: c.diagnostics, bestAttemptDiagnostics: c.best,
    log: c.log,
    replay: 'node scripts/replay-capture.mjs <wav> [json] — runs this audio back through the same decoder offline.',
    physicalAudioVerified: false,
  }, null, 2));
  $('rx-note').textContent = 'Raw capture exported: a 32-bit float WAV of the exact samples plus the diagnostics JSON.';
  log('exported raw capture WAV + metadata');
});
$('export-results').onclick = () => download('io-note-session-results.json', JSON.stringify({
  app: 'io-note 0.1.0', userAgent: navigator.userAgent, deviceRole: mode,
  securityBoundary: 'Authenticity/integrity only; no encryption; identity requires out-of-band fingerprint comparison',
  scopeNote: 'A microphone row records one attempt between these two devices in this room. It is not a general physical-transport verification claim.',
  counters: { successfulDecodes: successes, failedDecodes: failures },
  lastDiagnostics, log: logLines, records,
}, null, 2));
window.addEventListener('pagehide', () => { closeReceiver(rx); if (tx) tx.source.stop(); });
let stored = null;
try { stored = localStorage.getItem('io-note-mode'); } catch { /* private mode is fine */ }
setMode(stored || 'both');
resetDiagnostics('NO CAPTURE YET');
if (!globalThis.crypto?.subtle) { $('gate-text').textContent = 'Web Crypto unavailable in this context.'; $('selftest').disabled = true; $('generate').disabled = true; }
if (!globalThis.isSecureContext) $('rx-note').textContent = 'This page is not a secure context, so the microphone will not be available. Load it over HTTPS or from localhost.';
