import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createPacket, importIdentity, verifyPacket, STATUS } from '../src/protocol.mjs';
import { modulate } from '../src/modem.mjs';
import { TEST_IDENTITY, TEST_MESSAGE } from '../src/selftest.mjs';
const read = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const plain = s => s.replace(/^import .*?;\s*$/gm, '').replace(/^export /gm, '');

test('built standalone script parses; CSP rejects network; no external resources', async () => {
  const html = await read('dist/io-note.html');
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<(?:script|link|img|iframe)[^>]+(?:src|href)=["']https?:/i);
  assert.doesNotMatch(script, /\b(?:fetch|XMLHttpRequest|WebSocket|RTCPeerConnection|sendBeacon)\b/);
});

test('actual AudioWorklet chunker → actual worker decoder → independent verifier (Node VM simulation)', async () => {
  const captures = []; let Capture;
  class AudioWorkletProcessor { constructor() { this.port = { postMessage: pcm => captures.push(pcm.slice()) }; } }
  const captureContext = vm.createContext({ AudioWorkletProcessor, Float32Array, registerProcessor: (name, cls) => { assert.equal(name, 'io-note-capture'); Capture = cls; } });
  vm.runInContext(await read('src/capture-worklet.js'), captureContext);
  const processor = new Capture();
  const keys = await importIdentity(TEST_IDENTITY);
  const packet = await createPacket(TEST_MESSAGE, keys, new Uint8Array(16));
  const pcm = modulate(packet);
  for (let at = 0; at < pcm.length; at += 128) assert.equal(processor.process([[pcm.slice(at, at + 128)]]), true);
  assert.ok(captures.length > 0); assert.ok(captures.every(x => x.length === 4096));
  const messages = [], self = {};
  const workerContext = vm.createContext({ self, postMessage: msg => messages.push(msg), performance, crypto, TextEncoder, TextDecoder, Uint8Array, Float32Array, Float64Array, DataView });
  const workerScript = [await read('src/protocol.mjs'), await read('src/modem.mjs'), await read('src/decoder-worker.mjs')].map(plain).join('\n');
  vm.runInContext(workerScript, workerContext);
  self.onmessage({ data: { type: 'init', sampleRate: 48000 } });
  for (const pcm of captures) self.onmessage({ data: { type: 'chunk', pcm } });
  self.onmessage({ data: { type: 'finish' } });
  const decoded = messages.find(r => r.kind === 'packet' && Buffer.from(r.packet).equals(Buffer.from(packet)));
  assert.ok(decoded, 'Streaming pipeline must recover the exact original packet');
  assert.equal((await verifyPacket(decoded.packet)).status, STATUS.verified);
  assert.ok(messages.some(r => r.kind === 'partial'));
  self.onmessage({ data: { type: 'init', sampleRate: 48000 } });
  self.onmessage({ data: { type: 'chunk', pcm: new Float32Array(48000) } });
  self.onmessage({ data: { type: 'finish' } });
  assert.equal(messages.at(-1).kind, 'none'); assert.equal(messages.at(-1).final, true);
});

test('worker keeps a bounded sliding window and still recovers a late frame (Node VM simulation)', async () => {
  const keys = await importIdentity(TEST_IDENTITY);
  const packet = await createPacket('we control the io pins', keys, new Uint8Array(16));
  const rate = 16000, lead = rate * 10;
  const signal = modulate(packet, rate);
  const total = new Float32Array(lead + signal.length + rate * 4);
  total.set(signal, lead);
  const messages = [], self = {};
  const workerContext = vm.createContext({ self, postMessage: msg => messages.push(msg), performance, crypto, TextEncoder, TextDecoder, Uint8Array, Float32Array, Float64Array, DataView });
  vm.runInContext([await read('src/protocol.mjs'), await read('src/modem.mjs'), await read('src/decoder-worker.mjs')].map(plain).join('\n'), workerContext);
  self.onmessage({ data: { type: 'init', sampleRate: rate } });
  for (let at = 0; at < total.length; at += 4096) self.onmessage({ data: { type: 'chunk', pcm: total.slice(at, at + 4096) } });
  self.onmessage({ data: { type: 'finish' } });

  // The capture ran well past the 14 s window and past decodeAudio's 16 s hard limit.
  const last = messages.at(-1);
  assert.ok(last.capturedSeconds > 16, `captured ${last.capturedSeconds} s`);
  assert.ok(last.windowSeconds <= 14.1, `window ${last.windowSeconds} s`);
  assert.ok(last.droppedSamples > 0, 'older audio must be evicted, not kept');
  assert.ok(!messages.some(m => m.kind === 'error'), 'no message may exceed the decoder buffer bound');
  // No message before the explicit finish may claim to be final; the session is the app's to end.
  assert.equal(messages.filter(m => m.final).length, 1);

  const decoded = messages.find(m => m.kind === 'packet' && Buffer.from(m.packet).equals(Buffer.from(packet)));
  assert.ok(decoded, 'a frame arriving after older audio was evicted must still decode');
  assert.equal((await verifyPacket(decoded.packet)).status, STATUS.verified);
  assert.equal(decoded.diagnostics.checksum, 'CRC-32 PASS');
  // Sample indices stay in capture coordinates, so signal-to-verdict timing survives eviction.
  assert.ok(Math.abs(decoded.startSample - lead) < rate * 0.5, `startSample ${decoded.startSample} vs ${lead}`);
});
