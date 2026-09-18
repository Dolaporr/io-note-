# io-note — actual measured results

Run date: 18 September 2026. Runtime: Node.js 24.19.0, Linux x64. Exact environment, raw timing, fixtures, and outcomes are in `results/measured-results.json`; test output is in `results/test-results.tap`. The browser run described below was added on the same date from a different machine; its raw output is in `results/browser-verification.json`.

## Verification status

| Layer | Actual result |
| --- | --- |
| Protocol + modem + integration tests | **32 passed, 0 failed, 0 skipped** |
| Deterministic software PCM baseline | **10/10 recovered byte-for-byte and signature verified** |
| AudioWorklet chunking → Worker decoding → verifier | Passed in a **Node VM simulation**, using the actual source code |
| Built HTML | Embedded script syntax and static no-network/CSP checks passed |
| Browser execution of `dist/io-note.html` over `file://` | **Verified once** in headless Chromium 141.0.7390.37 (Linux x64): loopback gate, all six adversarial cases, key generation and role switching produced the documented outcomes with no console or page errors |
| Browser microphone path (`getUserMedia` → AudioWorklet → worker → verifier) | **Exercised once end to end** in the same Chromium over a secure origin, fed by a **synthetic capture device**, not a microphone: SIGNATURE VERIFIED, CRC-32 PASS, 112 + 1,096 bits |
| Real microphone hardware, speakers, or a room | **Not exercised.** No audio hardware exists in that environment |
| Physical speaker → air → microphone, two devices | **Not attempted; no success/failure rate or physical end-to-end latency measured** |

## Baseline signal

Message: `hello, io-note` (14 UTF-8 bytes). Fixed public test identity and nonce.

| Quantity | Result |
| --- | ---: |
| Encoded packet | 137 bytes |
| Packet-only bits | 1,096 |
| On-air framing overhead | 112 bits |
| Total transmitted bits | 1,208 |
| Nominal raw bitrate | 200 bits/s |
| Tones | 1,200 / 2,200 Hz |
| Tone duration | 6.04 s |
| PCM buffer duration including silence | 6.34 s |
| 44,100 Hz baseline decode | 5/5 successful |
| 48,000 Hz baseline decode | 5/5 successful |

The signal durations come from actual generated sample counts / configured encoding. They are **not measured physical transmission times**. Software pipeline wall times include key import, signing, waveform generation, demodulation, and verification:

| Sample rate | Minimum | Median | Maximum | Trials |
| --- | ---: | ---: | ---: | ---: |
| 44,100 Hz | 65.20 ms | 88.04 ms | 128.14 ms | 5 |
| 48,000 Hz | 34.85 ms | 43.21 ms | 72.03 ms | 5 |

These small samples include warm-up effects and host scheduling; they are not a performance guarantee. A separate test also decoded at 96,000 Hz. The maximum 96-byte message passed a software decode test and produces 219 packet bytes, 1,864 transmitted bits, and 9.62 s of audio including silence.

## Requested adversarial cases

Every row below was exercised through generated PCM and the audio decoder. Message/signature/public-key mutations have recomputed CRCs to test cryptographic rejection independently of transport checks.

| Case | Actual verdict | Transport decode |
| --- | --- | --- |
| Modify one message byte | SIGNATURE INVALID | Successful |
| Modify signature | SIGNATURE INVALID | Successful |
| Modify public key | SIGNATURE INVALID | Successful |
| Truncate frame by 80 bits | TRANSPORT CORRUPTED | Failed; partial frame |
| Duplicate nonce for the same sender | REPLAYED PACKET | Successful |
| Invert one transmitted data bit | TRANSPORT CORRUPTED | Failed CRC |

Additional tests cover an RFC 8032 signature vector, a known CRC vector, a fixed complete packet vector, every byte truncation of the baseline packet, appended bytes, nonce mutation, malformed header/length/version, same nonce with a newly signed different message, replay cache saturation, concurrent duplicates, invalid-signature cache poisoning, exact UTF-8 preservation, key import consistency, silence, random noise, and damaged sync.

## Browser execution

One headless Chromium run (141.0.7390.37, Linux x64) loaded the built `dist/io-note.html` from a local `file://` URL and drove the real UI. `scripts/browser-check.mjs` reproduces it; it is optional, is not part of `npm test`, and needs Playwright installed outside this project.

| Checked in the browser | Actual result |
| --- | --- |
| Page load under the embedded CSP | No console output, no page errors |
| Transmit / Listen / adversarial controls before the loopback | Disabled |
| **Run loopback** | SIGNATURE VERIFIED · `hello, io-note` · 137 bytes · 1,208 bits · 6.34 s buffer |
| Live controls after the loopback | Unlocked |
| Six adversarial lab cases | Same verdicts as the software table above |
| **Generate key** via Web Crypto Ed25519 | Key generated and its 64-hex-character SHA-256 fingerprint rendered; transmit enabled |

A second stage served the same file from `http://127.0.0.1` — a secure context, like the HTTPS preview — and ran the receiver against Chromium's fake capture device fed from `results/synthetic-input.wav`:

| Checked in the microphone path | Actual result |
| --- | --- |
| `getUserMedia` → AudioWorklet capture → worker decode → verifier | Ran end to end; capture negotiated at 44,100 Hz against a 48,000 Hz fixture |
| Verdict | SIGNATURE VERIFIED · `hello, io-note` |
| Diagnostics at the verdict | `FRAME COMPLETE` · CRC-32 PASS · 1,448 symbols, 1,208 strong, mean confidence 0.83 · 1 sync candidate accepted · 112 + 1,096 / 1,096 bits |
| Framing progression logged | `NO SIGNAL` → `FRAME INCOMPLETE` → `FRAME COMPLETE` |
| Listen → verdict | 7.29 s (6.27 s estimated from signal start), decode 31.1 ms |

**That capture device is software.** No speaker, no air, no room, no second device, and no
real microphone were involved, so it is not a physical-transport result and is not counted as
one. What it does establish is that the browser capture path itself works and that the
diagnostics report real state, which is what the physical attempt in `PHYSICAL_TEST.md` needs
in order to be debuggable.

The UI was not rendered for visual inspection and no speaker output was produced.

## Controlled synthetic channel experiments

These are single deterministic experiments per setting, not statistical live-audio trials. Seed = 42. Sender amplitude = 0.35. Noise is uniformly distributed additive float noise **without clipping**, so the larger settings are not realistic bounded microphone samples.

| Experiment | Actual outcome |
| --- | --- |
| Noise peak ±0.03, unknown start offset | SIGNATURE VERIFIED |
| Noise peak ±0.35, unknown start offset | SIGNATURE VERIFIED |
| Noise peak ±1.00, unknown start offset | SIGNATURE VERIFIED |
| Noise peak ±2.00, unknown start offset | **No synchronized packet** |
| Synthetic sample-clock stretch +250 ppm | SIGNATURE VERIFIED |
| Synthetic sample-clock stretch +1,000 ppm | **TRANSPORT CORRUPTED** |
| Synthetic sample-clock stretch +3,000 ppm | **TRANSPORT CORRUPTED** |

The clock-stretch experiment linearly resamples the complete waveform. It exposes the absence of continuous timing recovery. The PoC was not expanded to fix that research limitation.

## What is not established

No general browser/device compatibility, physical range, room-noise tolerance, successful two-device live transmission, or live end-to-end latency has been established; the headless Chromium runs above cover one browser build on one machine, and the only capture device involved was synthetic. The microphone path is implemented and has now run end to end in a browser against a synthetic capture device; real hardware, real speakers and a real room still need a trial on user-controlled devices. `PHYSICAL_TEST.md` is the procedure for that trial, and this file will not record a physical result until such a run produces one. No production deployment, backend, wallet, blockchain integration, or Breadlines modification was performed.
