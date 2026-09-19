# io-note

An isolated research PoC for an Ed25519-signed short message carried by audible 2-FSK. This project is independent of Breadlines. No Breadlines files were accessed or modified. No deployment was performed.

**Implemented and verified in software, in a browser, and — on 19 September 2026 — over a physical air gap in both directions between an iPhone and an Android handset.** Three verified deliveries across two message lengths, one with the raw acoustic recording committed and replayable offline: delivery is demonstrated and bidirectional, reliability is not. See [MEASURED_RESULTS.md](MEASURED_RESULTS.md) for actual successes, failures, and validation limits, and [PHYSICAL_TEST.md](PHYSICAL_TEST.md) for the two-device procedure that would change that.

## HTTPS preview

**https://dolaporr.github.io/io-note-/** — live.

It serves `docs/index.html`, the committed build, byte-for-byte identical to
`dist/io-note.html`. `.github/workflows/preview.yml` rebuilds from `src/`, refuses to publish
if the rebuild differs from the committed build, runs the tests, and deploys `docs/`.

The preview is a single static file. **The host has no part in message transport**: the
page's CSP sets `connect-src 'none'`, the app contains no fetch, WebSocket, WebRTC or
telemetry code, and the only path between two devices is sound. HTTPS exists here for one
reason — browsers only grant microphone access in a secure context. The page and
`docs/robots.txt` both ask crawlers to stay away; the repository itself is public.

Open the same URL on both devices, pick **Sender** on one and **Receiver** on the other,
and follow [PHYSICAL_TEST.md](PHYSICAL_TEST.md).

## Run it

1. Open the preview URL above on both devices, or open `dist/io-note.html` directly from disk. All code, CSS, worker code, and worklet code are embedded; there are no external resources, package downloads, or network services at runtime. **A local `file://` page cannot get microphone access in every browser — use the HTTPS preview for the receiver.**
2. Click **Run loopback** on both devices. Live controls stay disabled unless PCM modulation → decoding → Ed25519 verification succeeds.
3. Choose a role: **Sender**, **Receiver**, or **Both · one device** for a single-machine acoustic self-test. The choice is remembered per device and only affects which panels are shown.
4. On the sending device, click **Generate key**, or import an `io-note-key-v1` JSON keypair. No wallet is involved. Generated keys exist only in page memory unless explicitly exported. Two test messages are one click away, including `we control the io pins`.
5. On the receiving device, click **Listen on microphone** and grant access. It does not need the sender's private key or an imported identity. The receiver stays armed for 90 seconds and decodes a rolling 14-second window, so there is no rush to get to the other device.
6. On the sender, click **Transmit audio**. Start at low speaker volume and place the devices close together. Read the receiver's actual outcome; playback completion is not delivery confirmation.
7. Watch **Live receiver diagnostics** while the tones play: framing state, input level, detected tone shares, symbol count and confidence, sync candidates, bits received, checksum, and signature, plus a symbol trace and a timestamped receiver log. Every failure mode in [PHYSICAL_TEST.md](PHYSICAL_TEST.md) is read from that panel.
8. Use **Export measurements** on each device to preserve actual results; the receiver's export includes the diagnostics and the log. For replay testing, re-arm the receiver, then use **Resend same packet**. Normal **Transmit audio** creates a fresh random nonce even for identical text.

Browser prerequisite: Ed25519 Web Crypto, AudioContext, AudioWorklet, Worker, and `getUserMedia` in a secure context. A compatible desktop Chrome/Chromium is the intended initial trial target. The built file has been loaded and driven once over `file://` in headless Chromium 141 (loopback, adversarial lab, key generation; see [MEASURED_RESULTS.md](MEASURED_RESULTS.md)), which is **not a general compatibility claim and did not exercise the microphone**. Mobile file previews and embedded in-app viewers may not execute this app or allow microphone access. If the local file context is unsupported, the app shows an error; no server, hosting, or permission-bypass fallback is included. Browser/OS audio effects can also prevent decoding even when API setup succeeds.

The runtime CSP sets `connect-src 'none'`; the application contains no fetch, WebSocket, WebRTC, telemetry, backend, wallet, or blockchain code. Speaker and microphone are the only intended inter-device message path.

## Development and reproducibility

Node.js 22+ with Ed25519 Web Crypto is required for the development commands. Tested here with Node.js 24.19.0. There are no npm dependencies and `npm install` is unnecessary.

```sh
cd io-note
npm run build
npm test
npm run measure
```

`npm run browser-check` is optional and deliberately excluded from `npm test`: it is the only command that needs software outside this project (`npx playwright install chromium`, or point `IO_NOTE_PLAYWRIGHT` at an existing Playwright install). It runs two stages — the UI, loopback gate, adversarial lab and role switching over `file://`, then the real `getUserMedia` → AudioWorklet → worker → verifier path over `http://127.0.0.1` with Chromium's fake capture device fed from `results/synthetic-input.wav`. **That capture device is software, not a microphone**, so the check proves nothing about physical audio and prints as much.

- `src/protocol.mjs`: canonical packet, keys, checksum, verification, replay cache.
- `src/modem.mjs`: binary framing, PCM synthesis, noncoherent tone detector.
- `src/capture-worklet.js`: microphone chunk capture; silent output.
- `src/decoder-worker.mjs`: bounded capture and periodic decode attempts off the UI thread.
- `src/selftest.mjs`: deterministic known public fixture; never the live sender identity.
- `src/app.mjs`, `src/index.html`, `src/style.css`: local UI.
- `scripts/build.mjs`: embeds everything into one HTML file.
- `scripts/browser-check.mjs`: optional headless-browser run of the built file, including the microphone path against a synthetic capture device and a raw-capture export round-trip; writes `results/browser-verification.json`.
- `scripts/channel-experiments.mjs`, `scripts/channel-lab.mjs`: offline reproductions of a physical failure — sample rates, resampling, tone imbalance, in-band noise, interruption; writes `results/channel-experiments.json`.
- `scripts/replay-capture.mjs`: replays an exported physical capture WAV through the same decoder, attempt by attempt.
- `tests/`: protocol, adversarial, waveform, and simulated capture/worker integration tests.
- `results/`: raw JSON measurements, TAP test output, public fixture WAV, browser-run output, validation status.
- `PHYSICAL_TEST.md`: the two-device speaker-to-microphone procedure, what to record, and failure triage from the diagnostics.
- `.github/workflows/preview.yml`: rebuild, verify, test and publish the static HTTPS preview.

The fixture uses a **public RFC 8032 test private key** and fixed nonce solely for reproducible software checks. Anyone can sign with it. Live identities are generated using Web Crypto randomness or explicitly imported by the user.

## Packet protocol v1

All integer fields use network byte order (big endian). `L` is the UTF-8 message byte count, 0–96 inclusive. No whitespace trimming, Unicode normalization, JSON canonicalization, or timestamp rewriting occurs. Unpaired UTF-16 surrogates are rejected before encoding; decoding rejects malformed UTF-8.

| Offset | Bytes | Field |
| --- | ---: | --- |
| 0 | 4 | Magic/domain: ASCII `ION1` (`49 4f 4e 31`) |
| 4 | 1 | Protocol version: `01` |
| 5 | 32 | Raw Ed25519 public key |
| 37 | 16 | Nonce; generated with `crypto.getRandomValues` for each normal send |
| 53 | 2 | Message length `L` |
| 55 | L | Exact UTF-8 message bytes |
| 55 + L | 64 | Ed25519 signature |
| 119 + L | 4 | CRC-32/ISO-HDLC |

Total packet size: **123 + L bytes**; 123–219 bytes.

Signature input is exactly bytes `[0, 55 + L)`: magic, version, public key, nonce, message length, and message. This binds the exact payload together with its interpretation and replay nonce. The algorithm is pure Ed25519 via Web Crypto; no application prehash is used. CRC covers bytes `[0, 119 + L)`, including the signature. CRC parameters: reflected polynomial `0xedb88320`, initial value `0xffffffff`, final XOR `0xffffffff`; check value for ASCII `123456789` is `cbf43926`.

The import format is `{ "format": "io-note-key-v1", "publicKey": "<32 raw bytes as hex>", "privateKeyPkcs8": "<PKCS#8 DER as hex>" }`. Import signs and verifies a fixed consistency challenge before accepting the pair. Exported private-key JSON is **unencrypted**. Do not share it.

## Physical frame and modem

| Sequence | Size | Encoding |
| --- | ---: | --- |
| Lead silence | 150 ms | Not counted as transmitted bits |
| Preamble | 64 bits | Alternating `01`, beginning with 0 |
| Sync | 32 bits | `d391c5a7`, MSB first |
| Packet length | 16 bits | Unsigned packet byte count, MSB first |
| Packet | 8 × (123 + L) bits | Every byte MSB first |
| Tail silence | 150 ms | Not counted as transmitted bits |

- Binary frequency-shift keying: **0 = 1,200 Hz; 1 = 2,200 Hz**.
- **200 symbols/second = 200 bits/second**; one bit per 5 ms symbol.
- Continuous carrier phase, float PCM amplitude 0.35. Both tones are audible.
- No encryption, error correction, retransmission protocol, ACK, carrier sensing, equalizer, or in-packet clock tracking.
- Transmitted bits = `112 + 8 × packetBytes`.
- Tone duration = `transmittedBits / 200`; audio-buffer duration adds 0.30 s of silence.
- Maximum message produces 1,864 bits, 9.32 s of tones, and a 9.62 s audio buffer.

The receiver runs two quadrature correlations over each symbol's central 80%, comparing tone energies. Prefix sums allow constant-time window evaluation. It searches eight initial timing phases, requires an exact 32-bit sync and at most one error in the preceding 32 alternating preamble bits, and uses the checksum to choose a complete candidate. It does not receive the sender's packet, key, nonce, or sample offset out of band. Acquisition may tolerate loss in the first half of the preamble.

The microphone AudioWorklet sends 4,096-sample mono blocks to a Worker. The worker tries decoding every ~250 ms and bounds capture to 15 seconds. The app stops after one complete candidate or timeout. To receive another packet, explicitly re-arm it. Requested echo cancellation, noise suppression, and automatic gain control are disabled; the actual reported track settings are included in exported live results because the browser may ignore constraints. The worklet sends silence to the audio destination, not microphone feedback.

## Receiver decisions

1. Bounds, magic/version, lengths, strict UTF-8, and CRC are checked.
2. Ed25519 is verified independently with the **received** public key.
3. Only verified packets are checked/inserted in the replay cache, keyed by full public key + nonce.

| Display | Meaning |
| --- | --- |
| **SIGNATURE VERIFIED** | Structurally intact packet, valid Ed25519 signature, unseen nonce for this key in this receiver session. |
| **SIGNATURE INVALID** | Intact transport framing/checksum but failed cryptographic verification. |
| **TRANSPORT CORRUPTED** | CRC/structure failure, invalid physical length, or detected but truncated frame at end of capture. |
| **REPLAYED PACKET** | Valid signature but this public-key/nonce pair has already been accepted. |
| **NO PACKET DECODED** | No recognizable synchronized frame; not evidence of a signature failure. |
| **ACTION FAILED / RECEIVER ERROR** | API/setup/processing problem; not a cryptographic verdict. |

Transport corruption takes precedence over signature failure. Adversarial message/key/signature tests deliberately recompute CRC so they reach the signature check. A normal bit flip without CRC repair reports transport corruption.

Replay memory lasts only for the current page session, up to 1,024 accepted entries. It is not shared across devices/tabs, is not durable, and resets on reload. It does not prove freshness or reject a first-seen old recording. A different valid message signed by the same key with the same nonce is also a replay. Invalid signatures never consume a nonce. Check-and-add is synchronous after verification so concurrent verification cannot admit duplicates. At capacity, the cache refuses a new entry with an explicit error; it does not evict old nonces. Software tests use separate fresh caches so they cannot pollute live replay memory.

## Measurement definitions

- **Packet bytes** includes magic, version, key, nonce, lengths, message, signature, and CRC.
- **Transmitted bits** includes preamble, sync, physical length, and packet, but excludes silence.
- **Bitrate** is the configured nominal raw symbol bitrate, not measured hardware clock rate or application goodput.
- **Audio buffer seconds** is the generated sample count divided by sample rate. This is a signal-length calculation, not proof of physical delivery.
- **Software processing ms** is measured wall time for fixture import, signing, PCM generation, decode, and signature verification; it runs faster than real-time. It is not physical transmission latency.
- **Sender button → playback ended** includes signing, synthesis, scheduling, and local playback. It cannot establish receiving success.
- **Listen → verdict** is elapsed receiver wall time from arming (including permission/setup time).
- **Estimated signal → verdict** uses the detected first preamble sample and an estimated capture epoch from the first worklet chunk arrival. It includes decode/verification and batching delay but has uncalibrated capture/dispatch latency. This is **not a synchronized two-device end-to-end timing measurement**.
- **Successful decode** means recovered, structurally valid, checksum-valid packet; it can still be signature-invalid or replayed. Failed decode includes incomplete/CRC-bad/no-frame cases. UI counters combine labeled test modes; exported rows identify each mode.

No physical end-to-end result was obtained here. For a real trial, export both devices' session logs, record hardware/browser/distance/volume, and retain a video showing both devices if measuring observable send-to-verdict duration. Do not label calculated waveform duration as measured live latency.

## 10–15 second recording sequence

Preparation outside the recording: open the local file on two compatible devices, pass loopback on both, generate the sender key, enter `hello, io-note`, compare the sender's full SHA-256 key fingerprint if you need to identify it, and arrange both screens in the camera view.

1. 0–2 s: click **Listen on microphone** on the receiver, then **Transmit audio** on the sender.
2. ~2–9 s: show the waveform activity and the receiving UI while the 6.34 s audio buffer plays.
3. Remaining seconds: show the **actual** receiver verdict, recovered message, key fingerprint, and metrics.

If transport fails, keep and report the failed take. Do not substitute a software-loopback verdict into a video labeled as physical delivery. Replay rejection needs a separate take: re-arm the same receiver page and resend the exact packet. The adversarial lab can demonstrate the other labels independently and is visibly labeled software-only.

## Security boundary and limitations

This demonstrates **authenticity and integrity relative to a public key**. It does not authenticate a person unless the public-key fingerprint is independently trusted. An attacker can generate a different keypair and send a different correctly signed message; that should verify under that different key.

Audio and payload bytes are unencrypted. Anyone nearby may hear, record, decode, copy, jam, relay, or replay them. It provides no confidentiality, secrecy, distance proof, delivery guarantee, persistent freshness, or resistance to interception. CRC is not an authentication mechanism. This is not production-ready.

Speaker/microphone response, clipping, room reflections, audio processing, sample-clock mismatch, device load, and background noise can cause failure. The measured synthetic 1,000 and 3,000 ppm clock-stretch cases failed; 250 ppm passed for one fixture. This is not a general tolerance bound. Synthetic additive-noise tests do not model a real room. No claims about live range or reliability are made.

API references: [W3C Web Cryptography Level 2, Ed25519](https://www.w3.org/TR/webcrypto/#ed25519), [W3C Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/). The implementation uses these browser APIs; document availability does not establish this app's device compatibility.
