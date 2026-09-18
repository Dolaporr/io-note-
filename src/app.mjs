import { STATUS, MAX_MESSAGE, utf8, hex, unhex, fingerprint, generateIdentity, exportIdentity, importIdentity, createPacket, verifyPacket, ReplayCache, appendCRC, parsePacket } from './protocol.mjs';
import { modulate, modulateBits, frameBits, decodeAudio, metrics, OVERHEAD_BITS } from './modem.mjs';
import { softwareLoopback, TEST_IDENTITY, TEST_MESSAGE } from './selftest.mjs';

const $ = id => document.getElementById(id);
let keys = null, gatePassed = false, busy = false, tx = null, rx = null, lastPacket = null;
const liveCache = new ReplayCache();
const records = [];
let successes = 0, failures = 0;
function controls() {
  $('transmit').disabled = !gatePassed || !keys || busy || !!tx || !!rx || utf8.encode($('message').value).length > MAX_MESSAGE;
  $('resend').disabled = !gatePassed || !lastPacket || busy || !!tx || !!rx;
  $('listen').disabled = !gatePassed || busy || !!tx || !!rx;
  $('stop-rx').disabled = !rx;
  $('stop-tx').disabled = !tx;
  $('selftest').disabled = busy || !!tx || !!rx;
  $('generate').disabled = busy || !!tx || !!rx;
  $('import-key').disabled = busy || !!tx || !!rx;
  $('export-key').disabled = !keys || busy;
  $('run-attack').disabled = !gatePassed || busy || !!tx || !!rx;
}
function display(result, mode) {
  $('mode').textContent = mode;
  $('status').textContent = result.status;
  $('received').textContent = result.message !== undefined ? result.message : result.reason || '';
  $('received-key').textContent = result.fingerprint || '—';
  const kind = Object.keys(STATUS).find(k => STATUS[k] === result.status) || '';
  $('verdict').className = `verdict ${kind}`;
}
function showMetrics(m) {
  $('m-bytes').textContent = m.packetBytes;
  $('m-bits').textContent = m.transmittedBits;
  $('m-time').textContent = m.audioSeconds.toFixed(2);
}
function record(row) {
  records.push({ at: new Date().toISOString(), ...row });
  if (row.successfulDecode === true) successes++;
  if (row.successfulDecode === false) failures++;
  $('m-decodes').textContent = `${successes} / ${failures}`;
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function guarded(action) {
  busy = true; controls();
  try { await action(); }
  catch (e) { display({ status: 'ACTION FAILED', reason: e.message }, 'LOCAL ERROR'); record({ mode: 'operation', error: e.message }); }
  finally { busy = false; controls(); }
}
async function updateKey() {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  $('sender-key').textContent = await fingerprint(raw);
  lastPacket = null;
}
$('message').addEventListener('input', () => { $('byte-count').textContent = `${utf8.encode($('message').value).length} / 96 UTF-8 bytes`; controls(); });
$('message').dispatchEvent(new Event('input'));
$('selftest').onclick = () => guarded(async () => {
  gatePassed = false;
  $('gate-text').textContent = 'Decoding deterministic PCM samples and verifying…';
  try {
    const result = await softwareLoopback();
    gatePassed = true; $('gate-dot').className = 'dot pass';
    $('gate-text').textContent = 'Software loopback passed. Live audio controls unlocked.';
    display(result, 'SOFTWARE LOOPBACK · NO MICROPHONE'); showMetrics(result); record(result);
    $('timing').textContent = `Software pipeline: ${result.processingMs.toFixed(1)} ms compute · ${result.toneSeconds.toFixed(2)} s tones + 0.30 s silence. No physical audio measured.`;
  } catch (e) { $('gate-dot').className = 'dot'; $('gate-text').textContent = `Loopback failed: ${e.message}`; record({ mode: 'software loopback', successfulDecode: false, error: e.message }); throw e; }
});
$('generate').onclick = () => guarded(async () => { keys = await generateIdentity(); await updateKey(); });
$('export-key').onclick = () => guarded(async () => { download('io-note-private-key.json', JSON.stringify(await exportIdentity(keys), null, 2)); $('tx-note').textContent = 'Export contains an unencrypted private key. Keep it local; do not share it.'; });
$('import-key').onchange = () => guarded(async () => {
  const file = $('import-key').files[0]; if (!file) return;
  if (file.size > 4096) throw new Error('Key file exceeds 4 KiB');
  const imported = await importIdentity(JSON.parse(await file.text()));
  keys = imported; await updateKey(); $('import-key').value = '';
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
    $('tx-note').textContent = `Transmitting ${m.transmittedBits} bits · ${m.audioSeconds.toFixed(2)} seconds${reuse ? ' · same nonce' : ''}`;
    source.onended = () => {
      const elapsed = performance.now() - actionStart;
      record({ mode: 'speaker transmission', ...m, senderButtonToEndedMs: elapsed, interrupted: session.stopped, receiverOutcome: 'unknown on sender' });
      $('tx-note').textContent = session.stopped ? 'Transmission interrupted.' : 'Audio playback completed. Check the receiving device for its verdict.';
      $('timing').textContent = `Sender button → playback ended: ${(elapsed / 1000).toFixed(2)} s. This does not establish receiver success.`;
      $('signal').classList.remove('active'); context.close(); tx = null; controls();
    };
    source.start(context.currentTime + 0.05);
  } catch (e) { await context.close(); throw e; }
}
$('transmit').onclick = () => guarded(() => transmit(false));
$('resend').onclick = () => guarded(() => transmit(true));
$('stop-tx').onclick = () => { if (tx) { tx.stopped = true; tx.source.stop(); } };
function closeReceiver(session) {
  if (!session || session.closed) return;
  session.closed = true; clearTimeout(session.timer);
  session.worker?.terminate(); session.stream?.getTracks().forEach(t => t.stop());
  session.node?.disconnect(); session.source?.disconnect(); session.context?.close();
  if (rx === session) rx = null;
  controls();
}
async function handleAudio(session, data) {
  if (session.closed || session.verifying) return;
  if (data.kind === 'error') {
    closeReceiver(session); display({ status: 'RECEIVER ERROR', reason: data.reason }, 'MICROPHONE');
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
      const row = { mode: 'microphone', ...m, ...result, successfulDecode: intact, capturedSeconds: data.capturedSeconds, decodeMs: data.decodeMs, verifyMs: now - verifiedStart, listenToVerdictMs: now - session.started, estimatedSignalToVerdictMs: session.captureEpoch == null ? null : now - session.captureEpoch - data.startSample / session.rate * 1000, frameSampleDurationSeconds: (data.endSample - data.startSample) / session.rate, microphoneSettings: session.settings };
      display(result, 'MICROPHONE INPUT'); showMetrics(m); record(row);
      $('timing').textContent = `Listen → verdict: ${(row.listenToVerdictMs / 1000).toFixed(2)} s · estimated signal → verdict: ${row.estimatedSignalToVerdictMs == null ? 'unavailable' : (row.estimatedSignalToVerdictMs / 1000).toFixed(2) + ' s'} · decode ${data.decodeMs.toFixed(1)} ms`;
      $('rx-note').textContent = 'Capture stopped. Click Listen again to receive another packet; replay memory is retained.';
    } catch (e) { display({ status: 'RECEIVER ERROR', reason: e.message }, 'MICROPHONE'); record({ mode: 'microphone', successfulDecode: false, error: e.message }); }
    finally { closeReceiver(session); }
  } else if (data.final) {
    const status = data.kind === 'none' ? 'NO PACKET DECODED' : STATUS.corrupted;
    display({ status, reason: data.reason }, 'MICROPHONE · DECODE FAILED');
    record({ mode: 'microphone', successfulDecode: false, status, reason: data.reason, capturedSeconds: data.capturedSeconds });
    $('rx-note').textContent = 'Capture stopped without a complete valid frame. Re-arm to try again.';
    closeReceiver(session);
  } else if (data.kind === 'partial') {
    $('rx-note').textContent = `Frame detected · receiving${data.expectedBytes ? ' ' + data.expectedBytes + ' bytes' : ''}…`;
  }
}
$('listen').onclick = () => guarded(async () => {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone unavailable in this browser/file context. Open the downloaded HTML in a compatible desktop browser; no server fallback is provided.');
  const context = new AudioContext();
  await context.resume();
  const session = { context, started: performance.now(), captureEpoch: null, closed: false, verifying: false };
  rx = session;
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
    session.timer = setTimeout(() => session.worker?.postMessage({ type: 'finish' }), 15000);
    display({ status: 'LISTENING', reason: 'Transmit from the other device now. Auto-stop after 15 seconds.' }, 'MICROPHONE · ARMED');
    $('rx-note').textContent = `Microphone active · ${context.sampleRate.toLocaleString()} Hz · waiting for frame…`;
  } catch (e) { closeReceiver(session); throw e; }
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
  showMetrics(metrics(packet));
  record({ mode: 'adversarial software PCM', attack: type, ...result, successfulDecode: result.status !== STATUS.corrupted });
  $('timing').textContent = 'Adversarial software test only. No physical audio measurement.';
});
$('export-results').onclick = () => download('io-note-session-results.json', JSON.stringify({ app: 'io-note 0.1.0', userAgent: navigator.userAgent, securityBoundary: 'Authenticity/integrity only; no encryption; identity requires out-of-band fingerprint comparison', counters: { successfulDecodes: successes, failedDecodes: failures }, records }, null, 2));
window.addEventListener('pagehide', () => { closeReceiver(rx); if (tx) tx.source.stop(); });
controls();
if (!globalThis.crypto?.subtle) { $('gate-text').textContent = 'Web Crypto unavailable in this context.'; $('selftest').disabled = true; $('generate').disabled = true; }
