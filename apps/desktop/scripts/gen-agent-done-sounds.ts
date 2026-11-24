/**
 * Renders the Agent-Done Alert sounds offline into WAV files (Lotus #184 follow-up), so every
 * platform gets the same set. Synthesised here, once, because runtime Web Audio is silent in the
 * macOS WKWebView (CLAUDE.md); the app only plays the files through `HTMLAudioElement`.
 *
 * Original sounds, tuned to the *character* of the macOS alert set (measured from
 * /System/Library/Sounds, not copied): low-mid fundamentals (190–800 Hz), one dominant partial with
 * at most a faint overtone, a rounded or swelling attack, and a short tail. Peak-matched to Classic.
 *
 *   bun scripts/gen-agent-done-sounds.ts public/sounds chime,rise,hollow,droplet,pickup   # what ships
 *   bun scripts/gen-agent-done-sounds.ts ../../mockups/assets/agent-done-sounds --manifest # audition page
 *
 * An id list renders only those sounds. `--manifest` also writes `sounds.js` (names + waveform peaks)
 * for mockups/agent-done-sounds.html. Output is deterministic, so a re-run reproduces the same bytes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWavPcm16 } from "../src/modules/codecanvas/services/voice/pcm16-wav";

const SR = 44_100;
const TAU = Math.PI * 2;

type Buf = Float32Array;

interface Tone {
  at?: number; // start, seconds
  f: number; // fundamental, Hz
  glideFrom?: number; // Hz; slides to `f` over `glide` seconds
  glide?: number;
  attack?: number; // seconds, raised-cosine rise
  decay: number; // seconds to 1/e after the attack
  amp?: number;
  partials?: [ratio: number, gain: number, decayScale: number][]; // overtones beyond the fundamental
  gate?: number; // seconds; the note is cut (12ms release) after this — chiptune-style held notes
  stepped?: boolean; // envelope updates at 60 Hz, like an 8-bit console's frame-rate volume register
}

function tone(out: Buf, t0: Tone) {
  const { at = 0, f, glideFrom, glide = 0.03, attack = 0.004, decay, amp = 1, partials = [], gate, stepped } = t0;
  const start = Math.round(at * SR);
  const voices: [number, number, number][] = [[1, 1, 1], ...partials];
  const phases = voices.map(() => 0);
  for (let i = start; i < out.length; i++) {
    const t = (i - start) / SR;
    const te = stepped ? Math.floor(t * 60) / 60 : t;
    const rise = te < attack ? 0.5 - 0.5 * Math.cos((Math.PI * te) / attack) : 1;
    const tail = Math.max(0, te - attack);
    if (t > attack && Math.exp(-tail / decay) < 1e-4) break;
    if (gate !== undefined && t > gate + 0.08) break;
    const release = gate !== undefined && t > gate ? Math.exp(-(t - gate) / 0.012) : 1;
    const freq = glideFrom && t < glide ? glideFrom * (f / glideFrom) ** (t / glide) : f;
    let s = 0;
    voices.forEach(([r, g, k], v) => {
      phases[v] += (TAU * freq * r) / SR;
      s += g * Math.exp(-tail / (decay * k)) * Math.sin(phases[v]);
    });
    out[i] += amp * rise * release * s;
  }
}

/** Band-limited pulse wave overtones (duty 0.5 = square), kept under 7 kHz so it never fizzes. */
function pulse(f: number, duty = 0.5): [number, number, number][] {
  const out: [number, number, number][] = [];
  const base = Math.sin(Math.PI * duty);
  for (let n = 2; n * f < 7000; n++) {
    const g = Math.sin(Math.PI * n * duty) / (n * base);
    if (Math.abs(g) > 1e-3) out.push([n, g, 1]);
  }
  return out;
}

/** Band-limited triangle overtones — the soft "bass channel" voice of old consoles. */
function triangle(f: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let n = 3; n * f < 7000; n += 2) out.push([n, (n % 4 === 1 ? 1 : -1) / (n * n), 1]);
  return out;
}

const midi = (m: number) => 440 * 2 ** ((m - 69) / 12);

interface Mix {
  wet?: number;
  room?: number; // reverb feedback: 0.7 small room, ~0.84 open water
  cutoff?: number;
  peak?: number; // output peak; chiptune voices are denser, so they sit lower to feel as loud
}

function render(sec: number, tones: Tone[], wet = 0.08, mix: Mix = {}): Buf {
  const o = new Float32Array(Math.round(sec * SR));
  for (const t of tones) tone(o, t);
  const y = reverb(lowpass(o, mix.cutoff ?? 6000), mix.wet ?? wet, mix.room);
  if (mix.peak) (y as Buf & { peak?: number }).peak = mix.peak;
  return y;
}

/** One-pole low-pass: shaves the top so nothing sounds sharp. */
function lowpass(x: Buf, cutoff: number): Buf {
  const a = 1 - Math.exp((-TAU * cutoff) / SR);
  let y = 0;
  return x.map((v) => (y += a * (v - y)));
}

/** Small Schroeder reverb: 4 combs + 2 allpasses, mixed `wet`. Just enough room to feel smooth. */
function reverb(x: Buf, wet: number, room = 0.7): Buf {
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ d, b: new Float32Array(d), i: 0 }));
  const aps = [225, 556].map((d) => ({ d, b: new Float32Array(d), i: 0 }));
  const y = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    for (const c of combs) {
      const o = c.b[c.i];
      c.b[c.i] = x[n] + o * room;
      c.i = (c.i + 1) % c.d;
      s += o;
    }
    s /= combs.length;
    for (const a of aps) {
      const o = a.b[a.i];
      const v = s + o * 0.5;
      a.b[a.i] = v;
      a.i = (a.i + 1) % a.d;
      s = o - v * 0.5;
    }
    y[n] = x[n] * (1 - wet) + s * wet;
  }
  return y;
}

/** Peak-match Classic (0.47 ≈ -6.5 dBFS) and fade the tail so nothing clicks. */
function finish(x: Buf & { peak?: number }): Int16Array {
  const peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const target = x.peak ?? 0.47;
  const fade = Math.round(0.05 * SR);
  return Int16Array.from(x, (v, i) => Math.round((v / peak) * target * Math.min(1, (x.length - i) / fade) * 32767));
}

/** A drop or bubble: a pure tone whose pitch rises fast as it rings out (Minnaert resonance). */
const drop = (at: number, from: number, to: number, glide: number, decay: number, amp = 1): Tone => ({
  at, f: to, glideFrom: from, glide, decay, attack: 0.003, amp,
});

type Sound = { id: string; name: string; group: "Clean" | "Water" | "Retro"; ref?: string; desc: string; render: () => Buf };

/** Water: dry and short. One pure sine per drop, a small upward glide, no reverb, no body. */
const DRY: Mix = { wet: 0, peak: 0.6 }; // short transients: higher peak to sit as loud as the rest

const WATER: Sound[] = [
  {
    id: "droplet",
    name: "Droplet",
    group: "Water",
    desc: "Satu tetes air yang bersih dan singkat.",
    render: () => render(0.18, [drop(0, 900, 1400, 0.025, 0.03)], 0, DRY),
  },
  {
    id: "ripple",
    name: "Ripple",
    group: "Water",
    desc: "Satu tetes, disusul tetes kecil yang lebih pelan.",
    render: () => render(0.26, [drop(0, 860, 1340, 0.025, 0.03), drop(0.075, 1150, 1750, 0.02, 0.022, 0.3)], 0, DRY),
  },
  {
    id: "blup",
    name: "Blup",
    group: "Water",
    desc: "Satu gelembung bulat yang lebih rendah.",
    render: () => render(0.2, [drop(0, 380, 620, 0.045, 0.04)], 0, DRY),
  },
  {
    id: "plop",
    name: "Plop",
    group: "Water",
    desc: "Tetes yang sedikit lebih penuh, dengan pantulan tipis.",
    render: () => render(0.3, [drop(0, 600, 950, 0.035, 0.045), drop(0.06, 600, 950, 0.035, 0.04, 0.14)], 0, DRY),
  },
];

const RETRO_MIX: Mix = { wet: 0.04, cutoff: 8000, peak: 0.34 };

const RETRO: Sound[] = [
  {
    id: "blip",
    name: "Blip",
    group: "Retro",
    desc: "Satu bunyi pilih menu 8-bit, pendek dan bersih.",
    render: () => render(0.25, [{ f: midi(81), partials: pulse(midi(81), 0.25), decay: 0.08, gate: 0.06, stepped: true }], 0, RETRO_MIX),
  },
  {
    id: "pickup",
    name: "Pickup",
    group: "Retro",
    desc: "Dua nada naik cepat, rasa “dapat item”.",
    render: () =>
      render(0.5, [
        { f: midi(81), partials: pulse(midi(81)), decay: 1, gate: 0.07, stepped: true },
        { at: 0.07, f: midi(88), partials: pulse(midi(88)), decay: 0.12, gate: 0.3, stepped: true },
      ], 0, RETRO_MIX),
  },
  {
    id: "powerup",
    name: "Power Up",
    group: "Retro",
    desc: "Arpeggio naik beruntun, rasa “naik level”.",
    render: () =>
      render(0.7, [60, 64, 67, 72, 76, 79, 84].map((m, k, all) => ({
        at: k * 0.045, f: midi(m), partials: pulse(midi(m), 0.25),
        decay: k === all.length - 1 ? 0.12 : 1, gate: k === all.length - 1 ? 0.3 : 0.045, stepped: true,
      })), 0, RETRO_MIX),
  },
  {
    id: "clear",
    name: "Clear",
    group: "Retro",
    desc: "Fanfare kecil empat nada, rasa “stage selesai”.",
    render: () =>
      render(0.95, [
        ...[[72, 0], [76, 0.09], [79, 0.18]].map(([m, at]) => ({ at, f: midi(m), partials: pulse(midi(m)), decay: 1, gate: 0.08, stepped: true })),
        { at: 0.27, f: midi(84), partials: pulse(midi(84)), decay: 0.18, gate: 0.55, stepped: true },
        { at: 0.27, f: midi(60), partials: triangle(midi(60)), decay: 0.2, gate: 0.55, amp: 0.8 },
      ], 0, RETRO_MIX),
  },
  {
    id: "echo",
    name: "Echo",
    group: "Retro",
    desc: "Nada triangle lembut dengan gema chiptune.",
    render: () =>
      render(0.8, [0, 0.12, 0.24].flatMap((at, k) => [
        { at, f: midi(79), partials: triangle(midi(79)), decay: 0.08, amp: 0.5 ** k, stepped: true },
        { at: at + 0.06, f: midi(86), partials: triangle(midi(86)), decay: 0.1, amp: 0.8 * 0.5 ** k, stepped: true },
      ]), 0, { ...RETRO_MIX, peak: 0.42 }),
  },
];

const CLEAN: Sound[] = ([] as Omit<Sound, "group">[]).concat([
  {
    id: "tap",
    name: "Tap",
    ref: "Boop",
    desc: "Ketukan kecil yang kering dan sangat pendek.",
    render: () => render(0.35, [{ f: 700, decay: 0.03, attack: 0.002, partials: [[2.76, 0.12, 0.5]] }], 0.06),
  },
  {
    id: "drop",
    name: "Drop",
    ref: "Bubble",
    desc: "Tetes air yang membulat, “plop”.",
    render: () => render(0.4, [{ f: 600, glideFrom: 980, glide: 0.035, decay: 0.06, attack: 0.003 }], 0.07),
  },
  {
    id: "hollow",
    name: "Hollow",
    ref: "Pebble",
    desc: "Nada rendah berongga, seperti meniup mulut botol.",
    render: () => render(0.5, [{ f: 196, decay: 0.11, attack: 0.04, partials: [[3, 0.25, 0.6], [5, 0.06, 0.4]] }], 0.1),
  },
  {
    id: "chime",
    name: "Chime",
    ref: "Crystal",
    desc: "Denting jernih dengan kilau tipis di atasnya.",
    render: () => render(1.0, [{ f: 392, decay: 0.24, attack: 0.004, partials: [[8.05, 0.1, 0.25], [2.0, 0.08, 0.6]] }], 0.12),
  },
  {
    id: "ping",
    name: "Ping",
    ref: "Sonar",
    desc: "Satu “ting” bulat yang bergema sebentar.",
    render: () => render(0.8, [{ f: 523, decay: 0.13, attack: 0.003, partials: [[3.06, 0.14, 0.4]] }], 0.14),
  },
  {
    id: "rise",
    name: "Rise",
    ref: "Heroine",
    desc: "Akor yang mengembang pelan, rasa “berhasil”.",
    render: () =>
      render(0.9, [
        { at: 0, f: 247, decay: 0.2, attack: 0.1, amp: 0.7 },
        { at: 0.03, f: 330, decay: 0.2, attack: 0.1, amp: 0.55 },
        { at: 0.06, f: 494, decay: 0.2, attack: 0.1, amp: 0.4 },
        { at: 0.09, f: 659, decay: 0.18, attack: 0.1, amp: 0.3 },
      ], 0.12),
  },
  {
    id: "deep",
    name: "Deep",
    ref: "Submerge",
    desc: "Dengung rendah yang lembut, seperti sonar dari jauh.",
    render: () => render(0.9, [{ f: 330, decay: 0.2, attack: 0.15, partials: [[2, 0.22, 0.7]] }], 0.12),
  },
  {
    id: "air",
    name: "Air",
    ref: "Breeze",
    desc: "Akor tiga nada yang muncul dan hilang halus.",
    render: () =>
      render(0.8, [
        { f: 392, decay: 0.16, attack: 0.11, amp: 0.6 },
        { f: 494, decay: 0.16, attack: 0.11, amp: 0.4 },
        { f: 587, decay: 0.16, attack: 0.11, amp: 0.35 },
      ], 0.1),
  },
]).map((s) => ({ ...s, group: "Clean" as const }));

const SOUNDS: Sound[] = [...CLEAN, ...WATER, ...RETRO];

function peaks(pcm: Int16Array, bins = 64): number[] {
  const step = Math.ceil(pcm.length / bins);
  let top = 1;
  for (const v of pcm) top = Math.max(top, Math.abs(v));
  return Array.from({ length: bins }, (_, b) => {
    let m = 0;
    for (let i = b * step; i < Math.min(pcm.length, (b + 1) * step); i++) m = Math.max(m, Math.abs(pcm[i]));
    return Math.round((m / top) * 100) / 100;
  });
}

{
  const [outDir, ...rest] = process.argv.slice(2);
  if (!outDir) throw new Error("usage: bun scripts/gen-agent-done-sounds.ts <out-dir> [id,id,...] [--manifest]");
  const only = rest.find((a) => !a.startsWith("--"))?.split(",");
  const unknown = only?.filter((id) => !SOUNDS.some((s) => s.id === id));
  if (unknown?.length) throw new Error(`unknown sound id(s): ${unknown.join(", ")}`);
  mkdirSync(outDir, { recursive: true });
  const manifest = SOUNDS.filter((s) => !only || only.includes(s.id)).map(({ id, name, group, ref, desc, render }) => {
    const pcm = finish(render());
    writeFileSync(join(outDir, `agent-done-${id}.wav`), Buffer.from(encodeWavPcm16(pcm, SR)));
    return { id, name, group, ref, desc, file: `agent-done-${id}.wav`, seconds: +(pcm.length / SR).toFixed(2), peaks: peaks(pcm) };
  });
  if (rest.includes("--manifest")) writeFileSync(join(outDir, "sounds.js"), `window.AGENT_DONE_SOUNDS = ${JSON.stringify(manifest)};\n`);
  console.log(manifest.map((m) => `${m.file}  ${m.seconds}s`).join("\n"));
}
