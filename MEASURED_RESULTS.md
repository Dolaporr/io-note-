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
| Raw capture export → offline replay | **Verified round-trip.** The browser's exported 32-bit float WAV replays through the same decoder via `scripts/replay-capture.mjs` and recovers the packet with SIGNATURE VERIFIED |
| Real microphone hardware in the *automated* checks | **Not exercised there.** The headless environment has no audio hardware; the physical result below came from two handsets, by hand |
| Physical speaker → air → microphone, two devices | **SUCCEEDED THREE TIMES, 19 September 2026, in both directions between an iPhone and an Android handset**, across two message lengths. All three: CRC-32 PASS, SIGNATURE VERIFIED, 0 preamble errors. **3 of 4 transmit/listen pairings in that session**, plus four failures in earlier sessions. One raw acoustic recording is committed and **replays offline through the same decoder** |

## Physical framing change, 20 September 2026

Every physical result in this file was measured on the **64-symbol preamble**. The preamble has
since been lengthened to **256 symbols** to fix late joining, which changes the baseline
numbers below but nothing about the packet, the tones, the bitrate, or the CRC.

| | Before | After |
| --- | ---: | ---: |
| Preamble | 64 symbols (0.32 s) | 256 symbols (1.28 s) |
| Framing bits | 112 | 304 |
| **Join grace** | **0.16 s** | **1.12 s** |
| Baseline tone duration | 6.04 s | 7.00 s |
| Baseline audio buffer | 6.34 s | 7.30 s |

The decoder validates only the 32 symbols immediately before the sync word, so the grace is
`(preamble − 32) / 200` seconds and **lengthening the preamble is a transmitter-side change
alone**. The detector is untouched; a longer preamble is still readable by any earlier receiver,
and a frame built with the old 64-symbol preamble still decodes here — proven both by a test and
by re-replaying the committed physical recording, which still recovers 157 bytes and verifies.

This is why the three deliveries above remain valid evidence: they were carried on framing the
current code can still read. Their measured durations belong to the older framing, and are
labelled as such rather than restated.

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

## Successful physical delivery — bidirectional, cross-platform, 19 September 2026

**Signed messages crossed a physical air gap in both directions between an iPhone and an
Android handset, and verified on each.** Both phones' exports are in `results/physical/`.

### Both devices on one timeline

| Time (UTC) | Device | Event |
| --- | --- | --- |
| 22:28:16.748 | A · iPhone | transmit, playback ended |
| 22:28:19.263 | B · Android | receive → **NO PACKET DECODED** (14.2 s capture) |
| 22:29:14.159 | A · iPhone | receive → NO PACKET DECODED (3.5 s capture; nothing was transmitting) |
| 22:29:34.190 | B · Android | transmit, playback ended |
| 22:29:34.763 | A · iPhone | receive → **SIGNATURE VERIFIED**, nonce `03e3a8a7…` |
| 22:34:05.362 | B · Android | receive → **SIGNATURE VERIFIED**, nonce `1f1b66a0…` |
| 22:34:05.492 | A · iPhone | transmit, playback ended |
| 22:49:50.871 | B · Android | receive → **SIGNATURE VERIFIED**, nonce `89e698e6…`, **157 bytes** |
| 22:49:51.236 | A · iPhone | transmit, playback ended |

Four genuine transmit↔listen pairings, **three verified, one failed.** The 22:29:14 listen had
nothing to hear and is not counted as a delivery attempt.

### The three deliveries, side by side

| | Android → iPhone | iPhone → Android | iPhone → Android |
| --- | --- | --- | --- |
| Time | 22:29:34 | 22:34:05 | 22:49:50 |
| Message | `we control the io pins` | `we control the io pins` | **`Hello world we control the io pins`** |
| Packet | 145 B / 1,272 bits | 145 B / 1,272 bits | **157 B / 1,368 bits** |
| Nonce | `03e3a8a7…90dbe` | `1f1b66a0…ad555` | `89e698e6…f86cd` |
| Sender key | `8b3d0efd…33563605` | `5803354736…0de1c2d6a6` | `c9838f90…fc1dbdf7e` |
| Level | −51.0 dBFS rms, crest 10.5 dB | −28.0 dBFS rms, crest 10.8 dB | −24.9 dBFS rms, crest 10.6 dB |
| Tone share | **73.0 % at 1,200 Hz** | 73.3 % at 2,200 Hz | 67.4 % at 2,200 Hz |
| Sync candidates | 1 accepted | 2 accepted | 3 accepted |
| Checksum | CRC-32 PASS | CRC-32 PASS | CRC-32 PASS |
| Decode | 35 ms | 109 ms | 94 ms |
| Signal onset → verdict | 6.498 s | 6.613 s | 6.958 s |

**Three distinct sender keys, three distinct nonces, two message lengths.** The third delivery
carries a payload the protocol had never moved over air before — 34 UTF-8 bytes instead of 22,
a 157-byte packet, 1,368 bits — so the framing's length field was exercised with a real value.

### The third delivery is independently re-checkable

`results/physical/capture-2026-09-19T22-49-50-980Z-android.wav` is the **raw 32-bit float
acoustic recording** the Android's decoder consumed — the actual sound that crossed the room.
Replayed offline on an unrelated Linux machine through the same decoder:

```
$ node scripts/replay-capture.mjs capture-…-android.wav capture-…-android.json
  framing        FRAME COMPLETE
  sync           1 candidates · 1 accepted · 0 preamble errors
  checksum       CRC-32 PASS
  recovered 157 bytes · SIGNATURE VERIFIED · "Hello world we control the io pins"
```

SHA-256 of the public key recovered from that audio is
`c9838f90b5d7f5baa10a37ac06f20330205c0ee3da4bd6fd770f8d0fc1dbdf7e`, which is exactly the
fingerprint the receiving phone displayed, and the nonce in the packet matches its log. **The
claim no longer rests on either phone's self-report** — anyone can re-derive it from the audio.

Three things in these results are worth more than the successes themselves:

**The tone shares are inverted.** The iPhone heard 73 % of the energy in the 1,200 Hz bin; the
Android heard 73 % in the 2,200 Hz bin. Two completely opposite hardware responses, both
decoding byte-exact — the physical confirmation of the offline finding that **tone share is
not a verdict**.

**The eight-phase timing search earned its keep, twice.** On the 22:34 reception two phases
found the sync word at the same instant: phase 1 read a complete frame that **failed** CRC-32,
phase 2 read one that **passed**. On the 22:49 reception, at the moment the verdict fired,
phases 0 and 1 held **1,255 of 1,256 data bits** — one bit short — while phase 5 had the
complete frame and passed CRC. A single-phase detector loses both of those deliveries.

**The sender keys differ per direction**, and each nonce was generated on the transmitting
handset, so neither reception can be a local artefact. The nonce and key fingerprint visible
on the sender's screen (`1f1b66a0…`, key ending `0de1c2d6a6`) are exactly what the Android
verified. The Android also reported `echoCancellation`, `noiseSuppression`, `autoGainControl`
and `voiceIsolation` all honoured as `false`.

| Quantity | Value |
| --- | --- |
| Devices | iPhone → iPhone, iOS 26.6.2, Chrome (CriOS 150), receiver capturing at 48,000 Hz |
| Message | `we control the io pins` — 22 UTF-8 bytes, 145-byte packet, 1,272 bits on air |
| Verdict | **SIGNATURE VERIFIED** · CRC-32 PASS · framing `FRAME COMPLETE` |
| Sync | 1 candidate, 1 accepted, **0 preamble errors**, quality 0.886, timing phase 3 of 8 |
| Signal interval in the capture | 5.317 s → 11.677 s = **6.360 s**, exactly 1,272 bits ÷ 200 bit/s |
| Tone onset | 38 dB energy step at 5.30 s, against a silent floor |
| Symbol trace | `0101010101…` — a clean alternating preamble, recovered from air |
| Level | −51.0 dBFS RMS, −40.5 dBFS peak, crest 10.5 dB, **0 clipped samples** |
| Signal onset → verdict | **6.498 s** (6.360 s of it is the transmission itself); decode 35 ms, verify 1 ms |

**This is not a software loopback relabelled.** The two deterministic loopback records in the
same session used the public RFC 8032 fixture — key fingerprint `21fe31df…`, fixed nonce
`000102…0f`. The microphone record carries key fingerprint **`8b3d0efd…`** and a random nonce
**`03e3a8a7c53bd5e487d286bf92790dbe`**, generated on the *sending* phone. The receiver had no
way to produce either except by demodulating them out of the air.

### What fixed it

The procedure, not the protocol. Arming the receiver and leaving **5 seconds of recorded
silence before transmitting** put the whole frame — preamble first — inside the rolling
window. Modulation, framing, bitrate, tones, preamble and CRC are byte-for-byte what they
were when every attempt was failing.

### What this does not establish

Three deliveries out of four pairings in one session, plus four failures in earlier sessions.
No success rate worth quoting, no range, no room-noise tolerance, and no device compatibility
beyond these two handsets in this room at this distance. **Delivery is demonstrated and works
in both directions across two operating systems; reliability is not established.** Ten
consecutive attempts at a fixed distance and volume would be the first number worth citing.

## Earlier physical attempts — failed at synchronisation

One real two-device attempt was made over air. **It failed, and nothing about physical
transport is claimed from it.** What the receiver reported:

| Reading | Value |
| --- | --- |
| Capture sample rate | 44,100 Hz |
| Framing states seen | `NO SIGNAL` → `CARRIER; NO SYNC`, and in an earlier capture repeated `SYNC FOUND; LENGTH INVALID` before falling back to `CARRIER; NO SYNC` |
| Level, final window | −51.2 dBFS RMS / −24.3 dBFS peak — a **crest factor of 26.9 dB** |
| Clipped samples | 0 |
| Tone share | 85 % at 1,200 Hz / 15 % at 2,200 Hz |
| Symbols | 1,689 analysed, 1,198 strong, mean confidence 0.66 |
| Sync candidates accepted | 0 in the final state |
| Symbol trace | effectively all `0` |
| Checksum / signature | never reached |

Two facts are worth stating precisely. The earlier `SYNC FOUND; LENGTH INVALID` state means
**the 64-bit preamble and the 32-bit sync word were recovered from real air** — 96 consecutive
correct symbols, which a false positive cannot plausibly produce (the joint probability of an
exact 32-bit sync word with at most one preamble error, over eight phases and this many
positions, is about 3 × 10⁻⁶). The modem did lock, briefly. And 1,689 symbols at 44,100 Hz is
**8.44 s of audio**, so the final decode window was 8.44 s, not the full 14 s — the capture was
short relative to a 6.7 s transmission.

## Offline reproductions of that failure

`scripts/channel-experiments.mjs` drives the production decoder with synthesised inputs;
`results/channel-experiments.json` holds every row. No parameter was fitted to the recording.

| Hypothesis | Verdict |
| --- | --- |
| 44,100 Hz capture rate alone | **Not the cause.** Byte-exact recovery at 44,100 / 48,000 / 96,000 Hz |
| 48k → 44.1k browser-style resampling | **Not the cause.** Byte-exact with linear *and* windowed-sinc resampling, both directions |
| Tone gain imbalance | **Not the cause.** The 2,200 Hz tone attenuated by 26 dB — a 99.8 % low-tone share — still decodes byte-exact. A lopsided tone share is therefore **not evidence of failure** |
| Broadband white noise | Tolerated to about −12 dB SNR; fails near −18 dB, and does not skew the tone share |
| **Narrowband 1,200 Hz interference** | **Reproduces the reported final state.** At 0 dB signal-to-interferer: `CARRIER; NO SYNC`, 0 sync accepted, 82 % low-tone share, mean confidence 0.68, all-zero trace — against the reported 85 %, 0.66, all-zero |
| **Transmission cut within 16 symbols of the sync word** | **Reproduces `SYNC FOUND; LENGTH INVALID` exactly.** The 16 length bits read as zero, which is outside 123–219 |
| Interference that starts *after* the sync word | Produces `SYNC FOUND; LENGTH INVALID` too, so **one mechanism can explain both reported states** |
| A window holding almost no signal | Crest factor climbs from ~4 dB (continuous tone, even at −54 dBFS) to 16.8 dB at 0.5 s of signal in 8.4 s, and 55.7 dB at 0.05 s |

The single unexplained reading is the combination: 26.9 dB crest **and** an 85 % low-tone share
**and** 0.66 mean confidence at once. Interference alone gives a ~6 dB crest; an empty window
alone gives a ~0.5 tone share and ~0.04 confidence. A reconstruction of quiet
low-frequency-tilted noise plus transients, with little or no signal in the window, moves every
number in the right direction (−50.4 dBFS, 22.6–23.3 dB crest, up to 0.76 low share, 0.60
confidence) without landing on all of them. **That mixture cannot be pinned down from summary
statistics; it needs the raw audio**, which is why the receiver now exports it.

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

No general browser/device compatibility, physical range, room-noise tolerance, or repeatable
delivery rate has been established. Three deliveries and three end-to-end latency figures exist,
from a single pair of handsets in one room; the headless Chromium runs cover one browser build
on one machine, and the capture device there is synthetic. Ten consecutive attempts at a fixed
distance and volume would be the first reliability number worth citing, and no range has been
measured at all. No production deployment, backend, wallet, or blockchain integration was
performed.
