// Signal synthesis for the offline channel lab: resamplers, controlled tone imbalance,
// and noise sources. Nothing here is part of the app; it only builds inputs for the
// production decoder so a physical failure can be reproduced without touching it.
import { BITRATE, TONES } from '../src/modem.mjs';

// Linear interpolation: the naive resample, and the one the clock-stretch test already used.
export function resampleLinear(pcm, from, to) {
  const out = new Float32Array(Math.floor(pcm.length * to / from));
  for (let i = 0; i < out.length; i++) {
    const at = i * from / to, lo = Math.floor(at), f = at - lo;
    out[i] = (pcm[lo] ?? 0) * (1 - f) + (pcm[lo + 1] ?? 0) * f;
  }
  return out;
}

// Windowed-sinc: closer to what a browser/OS audio stack actually does.
export function resampleSinc(pcm, from, to, taps = 32) {
  const out = new Float32Array(Math.floor(pcm.length * to / from));
  const ratio = Math.min(1, to / from);
  for (let i = 0; i < out.length; i++) {
    const at = i * from / to, centre = Math.floor(at);
    let sum = 0, weight = 0;
    for (let k = -taps; k <= taps; k++) {
      const n = centre + k, x = (at - n) * ratio;
      if (n < 0 || n >= pcm.length) continue;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.54 + 0.46 * Math.cos(Math.PI * (at - n) / (taps + 1));
      const w = sinc * window * ratio;
      sum += pcm[n] * w; weight += w;
    }
    out[i] = weight ? sum / weight * (weight > 0 ? 1 : 1) : 0;
  }
  return out;
}

// Per-symbol amplitude by tone: a controlled stand-in for a speaker/microphone that does
// not reproduce 1,200 Hz and 2,200 Hz equally. Framing and timing are untouched.
export function modulateImbalanced(bits, sampleRate, lowGain, highGain, amplitude = 0.35, leadSeconds = 0.15, tailSeconds = 0.15) {
  const lead = Math.round(leadSeconds * sampleRate), body = Math.round(bits.length * sampleRate / BITRATE);
  const pcm = new Float32Array(lead + body + Math.round(tailSeconds * sampleRate));
  let phase = 0;
  for (let i = 0; i < body; i++) {
    const bit = bits[Math.min(bits.length - 1, Math.floor(i * BITRATE / sampleRate))];
    pcm[lead + i] = amplitude * (bit ? highGain : lowGain) * Math.sin(phase);
    phase = (phase + 2 * Math.PI * TONES[bit] / sampleRate) % (2 * Math.PI);
  }
  return pcm;
}

export function whiteNoise(length, amplitude, seed = 7) {
  const out = new Float32Array(length); let s = seed;
  for (let i = 0; i < length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = ((s / 2 ** 32) * 2 - 1) * amplitude; }
  return out;
}

// Narrowband interference sitting on the 1,200 Hz tone: the worst case for a two-bin detector.
export function toneNoise(length, amplitude, hz, sampleRate, seed = 11) {
  const out = new Float32Array(length); let s = seed, phase = 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    phase += 2 * Math.PI * hz / sampleRate + ((s / 2 ** 32) - 0.5) * 0.05;
    out[i] = amplitude * Math.sin(phase);
  }
  return out;
}

export function lfNoise(length, amplitude, seed = 42) {
  // Room-like noise: white noise through a one-pole low-pass, so it sits under 1,200 Hz.
  const out = new Float32Array(length);
  let s = seed, y = 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    y += 0.02 * ((s / 2 ** 32) * 2 - 1 - y);
    out[i] = y * amplitude;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak) for (let i = 0; i < length; i++) out[i] *= amplitude / peak;
  return out;
}

export function tilted(length, rms, sampleRate, tilt, seed = 5) {
  // Low-passed noise: `tilt` sets how much more of it lands in the 1,200 Hz bin.
  const out = new Float32Array(length); let s = seed, y = 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const white = (s / 2 ** 32) * 2 - 1;
    y += tilt * (white - y);
    out[i] = y;
  }
  let squares = 0;
  for (const v of out) squares += v * v;
  const scale = rms / Math.sqrt(squares / length);
  for (let i = 0; i < length; i++) out[i] *= scale;
  return out;
}

export const mix = (...parts) => { const n = Math.max(...parts.map(p => p.length)), out = new Float32Array(n); for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i]; return out; };
export const pad = (pcm, rate, before, after) => { const out = new Float32Array(pcm.length + Math.round((before + after) * rate)); out.set(pcm, Math.round(before * rate)); return out; };
