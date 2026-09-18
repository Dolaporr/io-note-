import test from 'node:test';
import assert from 'node:assert/strict';
import { appendCRC, crc32, createPacket, exportIdentity, generateIdentity, hex, importIdentity, parsePacket, ReplayCache, STATUS, unhex, utf8, verifyPacket } from '../src/protocol.mjs';
import { TEST_IDENTITY, TEST_MESSAGE } from '../src/selftest.mjs';

const keys = await importIdentity(TEST_IDENTITY);
const nonce = Uint8Array.from({ length: 16 }, (_, i) => i);
const original = await createPacket(TEST_MESSAGE, keys, nonce);
function tamper(index) { const p = original.slice(); p[index] ^= 1; return appendCRC(p.slice(0, -4)); }

test('RFC 8032 empty-message signature known-answer vector', async () => {
  const signature = await crypto.subtle.sign('Ed25519', keys.privateKey, new Uint8Array());
  assert.equal(hex(new Uint8Array(signature)), 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
});
test('CRC-32/ISO-HDLC known-answer vector', () => assert.equal(crc32(utf8.encode('123456789')), 0xcbf43926));
test('deterministic exact frame golden vector', async () => {
  assert.equal(hex(original), '494f4e3101d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a000102030405060708090a0b0c0d0e0f000e68656c6c6f2c20696f2d6e6f7465b590d5977bb8b1e8a4a987a7c324ed2a47583afac514549df24c0702b4de16df28d2813adc7c41057b1167cfe625cd7a9a53328cecf4adae02861145cc29f7069515f110');
  assert.deepEqual(await createPacket(TEST_MESSAGE, keys, nonce), original);
  const result = await verifyPacket(original);
  assert.equal(result.status, STATUS.verified); assert.equal(result.message, TEST_MESSAGE);
});
for (const [name, index] of [['message', 55], ['signature', original.length - 5], ['public key', 5], ['nonce', 37]]) {
  test(`modified ${name}, CRC recomputed → SIGNATURE INVALID`, async () => assert.equal((await verifyPacket(tamper(index))).status, STATUS.invalid));
}
test('single transport bit corruption → TRANSPORT CORRUPTED', async () => {
  const p = original.slice(); p[60] ^= 0x08;
  assert.equal((await verifyPacket(p)).status, STATUS.corrupted);
});
test('every truncation and trailing bytes rejected', async () => {
  for (let n = 0; n < original.length; n++) assert.equal((await verifyPacket(original.slice(0, n))).status, STATUS.corrupted);
  assert.equal((await verifyPacket(new Uint8Array([...original, 0]))).status, STATUS.corrupted);
});
test('unsupported version, magic, and forged length fail structurally', async () => {
  for (const i of [0, 4, 53, 54]) assert.equal((await verifyPacket(tamper(i))).status, STATUS.corrupted);
});
test('same sender + nonce replay rejected even with newly signed message', async () => {
  const cache = new ReplayCache();
  assert.equal((await verifyPacket(original, cache)).status, STATUS.verified);
  assert.equal((await verifyPacket(original, cache)).status, STATUS.replay);
  const changed = await createPacket('a different message', keys, nonce);
  assert.equal((await verifyPacket(changed, cache)).status, STATUS.replay);
});
test('invalid signature cannot poison replay memory', async () => {
  const cache = new ReplayCache();
  assert.equal((await verifyPacket(tamper(55), cache)).status, STATUS.invalid);
  assert.equal((await verifyPacket(original, cache)).status, STATUS.verified);
});
test('concurrent duplicate verification admits exactly one packet', async () => {
  const cache = new ReplayCache();
  const results = await Promise.all(Array.from({ length: 8 }, () => verifyPacket(original, cache)));
  assert.equal(results.filter(r => r.status === STATUS.verified).length, 1);
  assert.equal(results.filter(r => r.status === STATUS.replay).length, 7);
});
test('replay scope is per public key; full cache refuses new entries without eviction', async () => {
  const cache = new ReplayCache(2);
  await verifyPacket(original, cache);
  const other = await createPacket(TEST_MESSAGE, await generateIdentity(), nonce);
  assert.equal((await verifyPacket(other, cache)).status, STATUS.verified);
  assert.equal((await verifyPacket(original, cache)).status, STATUS.replay);
});
// Dedicated test avoids silently evicting a nonce when the bounded cache fills.
test('cache saturation is explicit', async () => {
  const cache = new ReplayCache(1); await verifyPacket(original, cache);
  const next = await createPacket(TEST_MESSAGE, keys, new Uint8Array(16));
  await assert.rejects(() => verifyPacket(next, cache), /Replay cache full/);
  assert.equal((await verifyPacket(original, cache)).status, STATUS.replay);
});
test('generate/export/import roundtrip and mismatched keypair rejection', async () => {
  const data = await exportIdentity(await generateIdentity());
  const imported = await importIdentity(data);
  assert.equal((await verifyPacket(await createPacket('roundtrip', imported))).status, STATUS.verified);
  await assert.rejects(() => importIdentity({ ...data, publicKey: TEST_IDENTITY.publicKey }), /do not match/);
  await assert.rejects(() => importIdentity({ ...data, privateKeyPkcs8: 'zz' }), /Invalid hex/);
});
test('exact Unicode, whitespace and embedded NUL bytes are preserved', async () => {
  const message = ' e\u0301 ≠ é\n\u0000🎵 ';
  const p = await createPacket(message, keys, nonce);
  assert.equal((await verifyPacket(p)).message, message);
  assert.deepEqual(parsePacket(p).payload, utf8.encode(message));
});
test('byte limit, empty message, malformed Unicode and nonce length', async () => {
  assert.equal((await createPacket('a'.repeat(96), keys)).length, 219);
  assert.equal((await verifyPacket(await createPacket('', keys))).status, STATUS.verified);
  await assert.rejects(() => createPacket('🎵'.repeat(25), keys), /exceeds/);
  await assert.rejects(() => createPacket('\ud800', keys), /well-formed/);
  await assert.rejects(() => createPacket('x', keys, unhex('00')), /16 bytes/);
});
