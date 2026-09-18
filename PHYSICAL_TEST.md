# Two-device physical audio test — procedure

Physical speaker → air → microphone transport is **not verified**. This document is the
procedure for attempting it. Nothing in this repository claims a physical result until a
run recorded with these steps says so.

## What a successful run would establish, and what it would not

A run establishes that **these two devices, in this room, at this volume and distance,
carried one signed packet over audible sound and the receiver verified it independently.**
It does not establish range, room-noise tolerance, device compatibility, a success rate, or
anything about other hardware. One success is one data point. Record the failures too.

The security boundary is unchanged: **authenticity and integrity only.** The audio is
unencrypted and anyone within earshot can record and decode it. A verified signature says
the holder of that key signed those exact bytes with that nonce — nothing about who they are.

## Before you start

- **Two devices.** Desktop Chrome/Chromium is the intended target. A phone may work as
  either end; it is untested.
- **The preview URL over HTTPS** (see README). A microphone prompt needs a secure context.
  The page will say so if it is not one.
- **A quiet room.** No music, no fans directly on a microphone, no active call.
- **Wired or built-in audio.** Bluetooth speakers and headsets add latency, resampling and
  aggressive processing; use them only once the wired case works.
- **Volume around 50 %** on the sender, and both devices **30 cm apart**, speaker pointing
  at the microphone. The tones are audible and will be heard by anyone in the room.

Both devices load the same URL. Nothing is exchanged through the server: the page is
static, its CSP sets `connect-src 'none'`, and the only path between the devices is sound.

## Procedure

1. **Both devices:** open the preview URL. Click **Run loopback**. The dot turns green and
   the text reads *Software loopback passed*. Live audio controls stay disabled until it does.
   If the loopback fails, stop — the problem is that browser, not the channel.
2. **Receiving device:** click **Receiver**. The sender panel disappears; the live
   diagnostics panel stays.
3. **Sending device:** click **Sender**, then **Generate key**. A 64-character SHA-256
   fingerprint appears. Leave it on screen; you will compare it in step 8.
4. **Sending device:** click the **we control the io pins** test message button. The counter
   reads *22 / 96 UTF-8 bytes*.
5. **Receiving device:** click **Listen on microphone** and grant microphone access.
   The verdict reads `LISTENING` and the receiver log records the capture sample rate.
   The receiver stays armed for 90 seconds and decodes a rolling 14-second window, so there
   is no rush between this step and the next.
6. **Sending device:** click **Transmit audio**. Roughly 6.7 seconds of two-tone audio plays.
   Do not talk over it. The sender cannot observe delivery — it only reports that playback
   finished.
7. **Receiving device:** watch the diagnostics panel while the tones play. Expect, in order:
   `NO SIGNAL` → `CARRIER; NO SYNC` → `FRAME INCOMPLETE` → `FRAME COMPLETE`, then a verdict
   of **SIGNATURE VERIFIED** with the message text `we control the io pins`.
8. **Compare fingerprints out of band.** The receiver's *Received key fingerprint* must match
   the sender's fingerprint from step 3, character for character. Read it aloud or compare on
   screen. The app cannot do this for you; an unverified fingerprint is an unknown sender.
9. **Replay check.** Re-arm the receiver (**Listen on microphone**), then on the sender click
   **Resend same packet**. The expected verdict is **REPLAYED PACKET**, not a second
   acceptance: same key, same nonce.
10. **Export both sides.** Click **Export measurements** on each device. The receiver's file
    carries the diagnostics and the full receiver log. Keep the failures.

## What to record for every attempt

Distance, volume, room, both device models and browsers, the capture sample rate from the
receiver log, and the exact verdict. Then: **attempts, successes, failures.** A success rate
of 3/10 is a result; "it worked" is not.

## If it fails — read the diagnostics before changing anything

| Diagnostics show | Most likely cause | Try |
| --- | --- | --- |
| Input level near `-120 dBFS`, framing `NO SIGNAL` | Wrong microphone selected, or muted | Check OS input device and permission |
| Level fine, framing stays `CARRIER; NO SYNC`, mean confidence below ~0.4 | Too much room noise, too far, or too quiet | Move closer, raise volume, quieten the room |
| `clipped samples` above 0, level near `0 dBFS` | Too loud or too close; the microphone is saturating | Lower the volume or move apart |
| Tone share heavily one-sided (e.g. 90 % / 10 %) with low confidence | Something else in the room is at one tone frequency, or heavy filtering | Change rooms; check no audio processing is on |
| Sync candidates > 0 but `accepted` 0, preamble errors high | Timing recovered briefly then slipped | Shorten the distance; avoid Bluetooth |
| Framing reaches `FRAME INCOMPLETE` and stops | Transmission was cut off, or the receiver stopped early | Re-arm, transmit the whole 6.7 s |
| `FRAME COMPLETE` but **CRC-32 FAIL** | Bits arrived with errors — real channel damage | This is the interesting failure. Record it |
| `CRC-32 PASS` but **SIGNATURE INVALID** | The packet is intact but not validly signed | Record it; this should not happen on an honest channel |
| Verdict `REPLAYED PACKET` on a first send | The same packet was already accepted in this page session | Reload the receiver page, or use **Transmit audio** for a fresh nonce |

A known limitation, already measured in software: the decoder has **no continuous timing
recovery**. A sample-clock mismatch of about +250 ppm between the two devices still decodes;
+1,000 ppm does not. If two particular devices never sync while everything else looks clean,
that is the suspect, and fixing it means adding timing recovery — not retuning the test.

## Do not

- Do not change the modulation, framing, bitrate, tones or CRC to make a run succeed. A
  result produced by moving the goalposts is not a result.
- Do not report physical transport as verified from a software or synthetic-capture run.
  `MEASURED_RESULTS.md` keeps those separate on purpose.
