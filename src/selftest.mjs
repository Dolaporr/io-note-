import { importIdentity, createPacket, verifyPacket, ReplayCache, STATUS, hex } from './protocol.mjs';
import { modulate, decodeAudio, metrics } from './modem.mjs';

// Public RFC 8032 test key. NEVER used for UI-generated live identities.
export const TEST_IDENTITY = Object.freeze({ format: 'io-note-key-v1', publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', privateKeyPkcs8: '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60' });
export const TEST_MESSAGE = 'hello, io-note';
export async function softwareLoopback(sampleRate = 48000) {
  const start = performance.now();
  const keys = await importIdentity(TEST_IDENTITY);
  const packet = await createPacket(TEST_MESSAGE, keys, Uint8Array.from({ length: 16 }, (_, i) => i));
  const pcm = modulate(packet, sampleRate);
  const decoded = decodeAudio(pcm, sampleRate);
  if (decoded.kind !== 'packet' || hex(decoded.packet) !== hex(packet)) throw new Error('Software audio decode failed');
  const result = await verifyPacket(decoded.packet, new ReplayCache());
  if (result.status !== STATUS.verified || result.message !== TEST_MESSAGE) throw new Error('Loopback signature check failed');
  return { ...metrics(packet, sampleRate), ...result, successfulDecode: true, processingMs: performance.now() - start, packetHex: hex(packet), mode: 'deterministic software PCM loopback' };
}
