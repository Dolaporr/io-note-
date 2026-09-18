// All multibyte integers are big endian. No JSON on the wire.
export const VERSION = 1;
export const MAX_MESSAGE = 96;
export const MIN_PACKET = 123;
export const MAX_PACKET = MIN_PACKET + MAX_MESSAGE;
export const MAGIC = new Uint8Array([0x49, 0x4f, 0x4e, 0x31]); // ION1 / domain separation
export const STATUS = Object.freeze({ verified: 'SIGNATURE VERIFIED', invalid: 'SIGNATURE INVALID', corrupted: 'TRANSPORT CORRUPTED', replay: 'REPLAYED PACKET' });
export const utf8 = new TextEncoder();
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export function unhex(s) {
  if (typeof s !== 'string' || !/^(?:[a-fA-F0-9]{2})+$/.test(s)) throw new Error('Invalid hex');
  return Uint8Array.from(s.match(/../g), b => parseInt(b, 16));
}
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
export function appendCRC(bytes) {
  const out = concat(bytes, new Uint8Array(4));
  new DataView(out.buffer).setUint32(bytes.length, crc32(bytes));
  return out;
}
export async function generateIdentity() {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
}
export async function exportIdentity(keys) {
  return { format: 'io-note-key-v1', publicKey: hex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))), privateKeyPkcs8: hex(new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey))) };
}
export async function importIdentity(data) {
  if (data?.format !== 'io-note-key-v1') throw new Error('Expected io-note-key-v1 JSON');
  const raw = unhex(data.publicKey), pkcs8 = unhex(data.privateKeyPkcs8);
  if (raw.length !== 32 || pkcs8.length > 256) throw new Error('Invalid key size');
  const publicKey = await crypto.subtle.importKey('raw', raw, 'Ed25519', true, ['verify']);
  const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
  const challenge = utf8.encode('io-note keypair consistency check v1');
  const sig = await crypto.subtle.sign('Ed25519', privateKey, challenge);
  if (!await crypto.subtle.verify('Ed25519', publicKey, sig, challenge)) throw new Error('Private and public keys do not match');
  return { publicKey, privateKey };
}
export async function fingerprint(publicKeyBytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', publicKeyBytes)));
}
export async function createPacket(message, keys, nonce = crypto.getRandomValues(new Uint8Array(16))) {
  const bytes = utf8.encode(message);
  if (new TextDecoder().decode(bytes) !== message) throw new Error('Message must be well-formed Unicode');
  if (bytes.length > MAX_MESSAGE) throw new Error(`Message exceeds ${MAX_MESSAGE} UTF-8 bytes`);
  if (!(nonce instanceof Uint8Array) || nonce.length !== 16) throw new Error('Nonce must be 16 bytes');
  const pk = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const header = concat(MAGIC, new Uint8Array([VERSION]), pk, nonce, new Uint8Array(2), bytes);
  new DataView(header.buffer).setUint16(53, bytes.length);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, header));
  return appendCRC(concat(header, sig));
}
export function parsePacket(packet) {
  if (!(packet instanceof Uint8Array) || packet.length < MIN_PACKET || packet.length > MAX_PACKET) throw new Error('Packet size out of bounds / truncated');
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (view.getUint32(packet.length - 4) !== crc32(packet.subarray(0, -4))) throw new Error('CRC-32 mismatch');
  if (!MAGIC.every((v, i) => packet[i] === v) || packet[4] !== VERSION) throw new Error('Unsupported magic or version');
  const length = view.getUint16(53);
  if (length > MAX_MESSAGE || packet.length !== MIN_PACKET + length) throw new Error('Message length mismatch');
  const payload = packet.slice(55, 55 + length);
  // Fatal decoding prevents replacement characters hiding malformed bytes.
  const message = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  return { message, payload, publicKey: packet.slice(5, 37), nonce: packet.slice(37, 53), signature: packet.slice(55 + length, -4), signed: packet.slice(0, 55 + length) };
}
export class ReplayCache {
  constructor(limit = 1024) { this.limit = limit; this.seen = new Set(); }
  checkAndAdd(key) {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.limit) throw new Error('Replay cache full; reload starts a new receiver session');
    this.seen.add(key);
    return true;
  }
}
export async function verifyPacket(packet, cache = new ReplayCache()) {
  let p;
  try { p = parsePacket(packet); }
  catch (e) { return { status: STATUS.corrupted, reason: e.message }; }
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('raw', p.publicKey, 'Ed25519', false, ['verify']);
    valid = await crypto.subtle.verify('Ed25519', key, p.signature, p.signed);
  } catch { /* A malformed key/signature is not a verified packet. */ }
  if (!valid) return { status: STATUS.invalid, reason: 'Ed25519 verification failed' };
  // Atomic synchronous check-and-add AFTER verification; failed forgeries cannot poison it.
  const fresh = cache.checkAndAdd(`${hex(p.publicKey)}:${hex(p.nonce)}`);
  return { status: fresh ? STATUS.verified : STATUS.replay, message: p.message, nonce: hex(p.nonce), publicKey: hex(p.publicKey), fingerprint: await fingerprint(p.publicKey) };
}
