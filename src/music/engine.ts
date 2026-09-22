/**
 * Generative Web Audio engine for the Padify music player.
 *
 * Tracks are recipes (see tracks.ts); this module renders them live. The
 * scheduler is beat-index based: every event is a pure function of its
 * absolute slot index (via `hashRand`), so `seek()` works naturally —
 * jumping to any position simply re-derives the pattern state from there.
 *
 * Graph (per AudioContext, reused across tracks):
 *   layer buses ──▶ per-layer filters ──▶ dry bus ─────────────▶ dry gain ┐
 *                        │                                                ├─▶ fade ─▶ lowpass(+LFO) ─▶ master ─▶ compressor ─▶ destination
 *                        └──▶ per-layer sends ──▶ convolver ──▶ wet gain ┘
 *
 * Pause = ctx.suspend() (currentTime freezes, so positions stay coherent);
 * resume = ctx.resume(). Track end = 1.5 s fade → stop → onEnd.
 */

import type { Track, LayerCfg } from './tracks';
import { hashRand } from './rng';

const LOOKAHEAD_SEC = 0.18;
const SCHED_INTERVAL_MS = 40;
const BEATS_PER_BAR = 4;
const CHORD_BARS = 4; // chords advance every 4 bars
const IR_SECONDS = 3.2;
const NOISE_BUFFER_SECONDS = 2;

/** Salt values so each layer gets an independent deterministic stream. */
const SALT = { pad: 0x1a, pluck: 0x2b, bells: 0x3c, bass: 0x4d } as const;

interface ActiveVoice {
  /** Context time after which the voice has fully ended. */
  endsAt: number;
  /** Hard-stop the voice at context time `when` with a fast fade. */
  kill: (when: number) => void;
}

interface EngineDebugSnapshot {
  contextState: string;
  playing: boolean;
  trackId: string | null;
  position: number;
  activeVoices: number;
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export class MusicEngine {
  private ctx: AudioContext | null = null;

  // Graph nodes (created once per AudioContext).
  private masterGain: GainNode | null = null; // user volume
  private fadeGain: GainNode | null = null; // play fade-in / end fade-out
  private compressor: DynamicsCompressorNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private filterLfo: OscillatorNode | null = null;
  private filterLfoDepth: GainNode | null = null;
  private dryBus: GainNode | null = null;
  private dryGain: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private wetGain: GainNode | null = null;
  private padBus: GainNode | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private pluckBus: GainNode | null = null;
  private pluckFilter: BiquadFilterNode | null = null;
  private bellBus: GainNode | null = null;
  private bassBus: GainNode | null = null;
  private noiseBus: GainNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;
  private noiseLfo: OscillatorNode | null = null;
  private noiseLfoDepth: GainNode | null = null;
  private noiseSrc: AudioBufferSourceNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  // Playback state.
  private track: Track | null = null;
  private playing = false;
  private everStarted = false;
  private pausedPosition = 0;
  private startCtxTime = 0;
  private startPosition = 0;
  private volume = 0.7;
  private schedulerId: ReturnType<typeof setInterval> | null = null;
  private endTimerId: ReturnType<typeof setTimeout> | null = null;
  private fadingOut = false;
  private endHandled = false;
  /** True while pause()'s async suspend() has not settled yet. */
  private suspendPending = false;
  private voices: ActiveVoice[] = [];
  private layerSched = { pad: 0, pluck: 0, bells: 0, bass: 0 };

  onStateChange: (() => void) | null = null;
  onEnd: (() => void) | null = null;

  // ---- Public API ---------------------------------------------------------

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentTrack(): Track | null {
    return this.track;
  }

  /** Loads a track without starting audio (restored "paused" state). */
  load(track: Track): void {
    this.stopInternal(false);
    this.track = track;
    this.pausedPosition = 0;
    this.everStarted = false;
  }

  /** Starts (or restarts) a track at `positionSec`. Safe from user gestures. */
  play(track: Track, positionSec = 0): void {
    const ctx = this.ensureContext();
    // Always attempt to resume: the context may be suspended (autoplay
    // policy) or a previous pause()'s suspend() may still be in flight.
    this.suspendPending = false;
    void ctx.resume().catch(() => undefined);

    this.stopInternal(false);

    this.track = track;
    this.playing = true;
    this.everStarted = true;
    this.fadingOut = false;
    this.endHandled = false;

    this.applyTrackParams(track);

    const now = ctx.currentTime;
    const pos = Math.max(0, Math.min(positionSec, track.durationSec));
    this.startPosition = pos;
    this.startCtxTime = now + 0.08;
    this.pausedPosition = pos;
    this.resetLayerSchedule(pos);

    this.startNoiseSource(track);

    // Gentle fade-in so restarts never click.
    const fade = this.fadeGain;
    if (fade) {
      const g = fade.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(0.0001, now);
      g.linearRampToValueAtTime(1, now + 0.5);
    }

    this.startScheduler();
    this.fireStateChange();
  }

  pause(): void {
    if (!this.playing) return;
    this.pausedPosition = this.getPosition();
    this.playing = false;
    this.stopScheduler();
    if (this.ctx && this.ctx.state === 'running') {
      const ctx = this.ctx;
      this.suspendPending = true;
      void ctx
        .suspend()
        .then(() => {
          // resume()/play() may have been issued while this suspend
          // was still in flight — re-issue resume so the later
          // intent wins (state transitions queue in call order, but
          // re-resuming is idempotent and covers ordering quirks).
          if (!this.suspendPending) {
            void ctx.resume().catch(() => undefined);
          }
          this.suspendPending = false;
        })
        .catch(() => {
          this.suspendPending = false;
        });
    }
    this.fireStateChange();
  }

  resume(): void {
    if (this.playing || !this.track) return;
    if (!this.everStarted) {
      // Track was only `load()`ed (restored paused state): full start.
      this.play(this.track, this.pausedPosition);
      return;
    }
    const ctx = this.ensureContext();
    // Always issue resume(): pause()'s suspend() may still be in flight
    // (ctx.state reads "running"), and a resume() that lands after it
    // wins. Resuming an already-running context is a harmless no-op.
    this.suspendPending = false;
    void ctx.resume().catch(() => undefined);
    // currentTime was frozen while suspended, so startCtxTime still maps
    // correctly to the paused position — no rebase needed.
    this.playing = true;
    this.startScheduler();
    this.fireStateChange();
  }

  stop(): void {
    this.stopInternal(true);
    this.fireStateChange();
  }

  /** Jump to an absolute position (works while playing or paused). */
  seek(sec: number): void {
    const track = this.track;
    if (!track) return;
    const target = Math.max(0, Math.min(sec, Math.max(0, track.durationSec - 0.05)));
    this.clearEndTimer();
    this.endHandled = false;

    if (this.playing && this.ctx) {
      this.killVoices();
      this.startPosition = target;
      this.startCtxTime = this.ctx.currentTime + 0.06;
      this.resetLayerSchedule(target);
      this.pausedPosition = target;
      this.restoreFade();
      // Restart the "air" source so it keeps breathing through the seek.
      this.stopNoiseSource();
      this.startNoiseSource(track);
    } else {
      this.pausedPosition = target;
      this.startPosition = target;
      if (this.ctx) {
        // currentTime is frozen while suspended: anchoring here means
        // position resumes from exactly `target` after ctx.resume().
        this.startCtxTime = this.ctx.currentTime;
      }
      this.killVoices();
      this.resetLayerSchedule(target);
    }
    this.fireStateChange();
  }

  /** Sets output volume (0..1). Never disturbs playing state. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  getVolume(): number {
    return this.volume;
  }

  /** Current absolute position in seconds. */
  getPosition(): number {
    const track = this.track;
    if (!track) return 0;
    if (!this.playing || !this.ctx) return this.pausedPosition;
    const pos = this.startPosition + (this.ctx.currentTime - this.startCtxTime);
    return Math.max(0, Math.min(track.durationSec, pos));
  }

  /** Small introspection hook for debugging / E2E probes. */
  debugSnapshot(): EngineDebugSnapshot {
    return {
      contextState: this.ctx ? this.ctx.state : 'uncreated',
      playing: this.playing,
      trackId: this.track ? this.track.id : null,
      position: this.getPosition(),
      activeVoices: this.voices.length,
    };
  }

  // ---- Context & graph ------------------------------------------------------

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!ctor) {
        // Practically unreachable in browsers that run this module.
        throw new Error('Web Audio API is not available');
      }
      this.ctx = new ctor();
      this.buildGraph();
    }
    return this.ctx;
  }

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -20;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.01;
    this.compressor.release.value = 0.28;
    this.compressor.connect(ctx.destination);

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.volume;
    this.masterGain.connect(this.compressor);

    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.lowpass.frequency.value = 2400;
    this.lowpass.Q.value = 0.4;
    this.lowpass.connect(this.masterGain);

    // Slow master-filter drift.
    this.filterLfo = ctx.createOscillator();
    this.filterLfo.type = 'sine';
    this.filterLfo.frequency.value = 0.06;
    this.filterLfoDepth = ctx.createGain();
    this.filterLfoDepth.gain.value = 150;
    this.filterLfo.connect(this.filterLfoDepth);
    this.filterLfoDepth.connect(this.lowpass.frequency);
    this.filterLfo.start();

    this.fadeGain = ctx.createGain();
    this.fadeGain.gain.value = 1;
    this.fadeGain.connect(this.lowpass);

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeImpulseResponse(ctx);
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0.45;
    this.convolver.connect(this.wetGain);
    this.wetGain.connect(this.fadeGain);

    this.dryBus = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 0.85;
    this.dryBus.connect(this.dryGain);
    this.dryGain.connect(this.fadeGain);

    // Pad: two detuned oscillators per note → layer lowpass.
    this.padBus = ctx.createGain();
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 1100;
    this.padFilter.Q.value = 0.6;
    this.padBus.connect(this.padFilter);
    this.padFilter.connect(this.dryBus);
    this.connectSend(this.padFilter, 0.5);

    // Pluck.
    this.pluckBus = ctx.createGain();
    this.pluckFilter = ctx.createBiquadFilter();
    this.pluckFilter.type = 'lowpass';
    this.pluckFilter.frequency.value = 5200;
    this.pluckBus.connect(this.pluckFilter);
    this.pluckFilter.connect(this.dryBus);
    this.connectSend(this.pluckFilter, 0.3);

    // Bells: mostly reverb.
    this.bellBus = ctx.createGain();
    this.bellBus.connect(this.dryBus);
    this.connectSend(this.bellBus, 0.95);

    // Bass: mostly dry.
    this.bassBus = ctx.createGain();
    this.bassBus.connect(this.dryBus);
    this.connectSend(this.bassBus, 0.12);

    // Noise "air": looping pink noise → bandpass → LFO-ed gain.
    this.noiseBus = ctx.createGain();
    this.noiseBus.gain.value = 0;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 650;
    this.noiseFilter.Q.value = 0.8;
    this.noiseBus.connect(this.noiseFilter);
    this.noiseFilter.connect(this.dryBus);
    this.connectSend(this.noiseFilter, 0.35);
    this.noiseLfo = ctx.createOscillator();
    this.noiseLfo.type = 'sine';
    this.noiseLfo.frequency.value = 0.05;
    this.noiseLfoDepth = ctx.createGain();
    this.noiseLfoDepth.gain.value = 0;
    this.noiseLfo.connect(this.noiseLfoDepth);
    this.noiseLfoDepth.connect(this.noiseBus.gain);
    this.noiseLfo.start();
  }

  /** Connects `from` to the reverb input via a gain node of `level`. */
  private connectSend(from: AudioNode, level: number): void {
    if (!this.ctx || !this.convolver) return;
    const send = this.ctx.createGain();
    send.gain.value = level;
    from.connect(send);
    send.connect(this.convolver);
  }

  private applyTrackParams(track: Track): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const set = (param: AudioParam, value: number): void => {
      param.setTargetAtTime(value, now, 0.08);
    };

    set(this.padBus!.gain, track.layers.pad.gain);
    set(this.pluckBus!.gain, track.layers.pluck.gain);
    set(this.bellBus!.gain, track.layers.bells.gain);
    set(this.bassBus!.gain, track.layers.bass.gain);

    set(this.wetGain!.gain, track.reverbWet);
    set(this.dryGain!.gain, 1 - track.reverbWet * 0.4);
    set(this.lowpass!.frequency, track.filterHz);
    set(this.filterLfoDepth!.gain, track.filterHz * 0.08);

    const noise = track.layers.noise;
    const noiseBase = noise.gain > 0.001 ? noise.gain * 0.6 : 0;
    set(this.noiseBus!.gain, noiseBase);
    set(this.noiseFilter!.frequency, 400 + noise.density * 500);
    set(this.noiseLfoDepth!.gain, noise.gain * 0.4 * (0.35 + 0.65 * noise.density));
  }

  // ---- Buffers ------------------------------------------------------------

  /** Stereo exponential-decay noise IR for the convolution reverb. */
  private makeImpulseResponse(ctx: AudioContext): AudioBuffer {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * IR_SECONDS);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const decay = Math.pow(1 - i / length, 2.4);
        data[i] = (Math.random() * 2 - 1) * decay;
      }
    }
    return buffer;
  }

  /** 2 s looping pink-ish noise buffer (Paul Kellet's filter). */
  private makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * NOISE_BUFFER_SECONDS);
    const buffer = ctx.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + white * 0.029;
      b1 = 0.985 * b1 + white * 0.032;
      b2 = 0.95 * b2 + white * 0.048;
      data[i] = (b0 + b1 + b2 + white * 0.05) * 0.25;
    }
    return buffer;
  }

  // ---- Scheduler ------------------------------------------------------------

  private startScheduler(): void {
    this.stopScheduler();
    this.schedulerId = setInterval(() => this.tick(), SCHED_INTERVAL_MS);
    this.tick();
  }

  private stopScheduler(): void {
    if (this.schedulerId !== null) {
      clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
  }

  private resetLayerSchedule(positionSec: number): void {
    this.layerSched = {
      pad: positionSec,
      pluck: positionSec,
      bells: positionSec,
      bass: positionSec,
    };
  }

  private tick(): void {
    const ctx = this.ctx;
    const track = this.track;
    if (!ctx || !track || !this.playing || this.fadingOut) return;
    if (ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const pos = this.startPosition + (now - this.startCtxTime);

    if (pos >= track.durationSec - 0.001) {
      this.beginEndFade();
      return;
    }

    const horizon = Math.min(pos + LOOKAHEAD_SEC, track.durationSec - 0.001);
    this.schedulePadLayer(track, horizon);
    this.schedulePluckLayer(track, horizon);
    this.scheduleBellLayer(track, horizon);
    this.scheduleBassLayer(track, horizon);
    this.pruneVoices(now);
  }

  /** Context time that corresponds to an absolute track position. */
  private ctxTimeForPos(posSec: number): number {
    return this.startCtxTime + (posSec - this.startPosition);
  }

  /** Slots in [fromSec, toSec] at `slotDur` granularity. */
  private slotRange(fromSec: number, toSec: number, slotDur: number): number[] {
    const first = Math.ceil(fromSec / slotDur - 1e-9);
    const last = Math.floor(toSec / slotDur + 1e-9);
    const slots: number[] = [];
    for (let i = first; i <= last; i++) {
      const t = i * slotDur;
      if (t >= fromSec - 1e-9 && t <= toSec + 1e-9) slots.push(i);
    }
    return slots;
  }

  // ---- Layers ----------------------------------------------------------------

  /** Scale-degree → MIDI note (wraps octaves as needed). */
  private degreeToMidi(track: Track, degree: number): number {
    const scale = track.scale;
    const len = scale.length;
    const octave = Math.floor(degree / len);
    const idx = ((degree % len) + len) % len;
    return track.rootMidi + scale[idx] + 12 * octave;
  }

  /** Chord (scale-degree stack) active at a given beat index. */
  private chordAtBeat(track: Track, beat: number): number[] {
    const bar = Math.floor(beat / BEATS_PER_BAR);
    const chordIdx =
      ((Math.floor(bar / CHORD_BARS) % track.chords.length) + track.chords.length) %
      track.chords.length;
    return track.chords[chordIdx];
  }

  private registerVoice(
    gainNodes: GainNode[],
    oscillators: OscillatorNode[],
    endsAt: number,
  ): void {
    const voice: ActiveVoice = {
      endsAt,
      kill: (when: number) => {
        for (const node of gainNodes) {
          try {
            node.gain.cancelScheduledValues(when);
          } catch {
            /* param already detached */
          }
          node.gain.setTargetAtTime(0.0001, when, 0.02);
        }
        for (const osc of oscillators) {
          try {
            osc.stop(when + 0.12);
          } catch {
            /* already stopped — double-stop guard */
          }
        }
      },
    };
    this.voices.push(voice);
  }

  /**
   * Pad layer: 3-4 note chord voicing, 2 detuned oscillators per note
   * (saw + triangle), slow attack, long release, subtle detune drift.
   */
  private schedulePadLayer(track: Track, horizon: number): void {
    const cfg = track.layers.pad;
    if (cfg.gain <= 0.001) {
      this.layerSched.pad = horizon;
      return;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const beatDur = 60 / track.bpm;
    const barDur = beatDur * BEATS_PER_BAR;
    const slotDur = barDur * 2; // pad swell every 2 bars
    const from = this.layerSched.pad;
    const slots = this.slotRange(from, horizon, slotDur);

    for (const slot of slots) {
      this.layerSched.pad = Math.max(this.layerSched.pad, slot * slotDur);
      const r = hashRand(track.seed, SALT.pad, slot);
      const prob = Math.min(1, 0.45 + cfg.density);
      if (r > prob) continue;

      const beat = slot * BEATS_PER_BAR * 2;
      const chord = this.chordAtBeat(track, beat);
      const t0 = Math.max(this.ctxTimeForPos(slot * slotDur), ctx.currentTime);
      this.spawnPadChord(track, chord, slot, t0, cfg);
    }
    this.layerSched.pad = Math.max(this.layerSched.pad, horizon);
  }

  private spawnPadChord(
    track: Track,
    chord: number[],
    slot: number,
    t0: number,
    _cfg: LayerCfg,
  ): void {
    const ctx = this.ctx;
    const bus = this.padBus;
    if (!ctx || !bus) return;

    const beatDur = 60 / track.bpm;
    const barDur = beatDur * BEATS_PER_BAR;
    const noteDur = barDur * 2.2;
    const rA = hashRand(track.seed, SALT.pad + 1, slot);
    const rR = hashRand(track.seed, SALT.pad + 2, slot);
    const attack = 2 + rA * 2; // 2-4 s
    const release = 4 + rR * 4; // 4-8 s
    const total = noteDur + release;

    // Voicing: chord degrees, with an octave doubling on top for 3-note
    // chords and a soft sub-octave on the root.
    const degrees = chord.slice();
    if (degrees.length < 4) degrees.push(chord[0] + track.scale.length);
    degrees.push(chord[0] - track.scale.length);

    const oscillators: OscillatorNode[] = [];
    const noteGains: GainNode[] = [];
    const notes = degrees.length;
    const perNotePeak = 0.16 / notes; // two oscillators per note

    for (const degree of degrees) {
      const midi = this.degreeToMidi(track, degree);
      const freq = midiToFreq(midi);
      const isSub = degree < chord[0];
      const peak = isSub ? perNotePeak * 1.4 : perNotePeak;

      for (const [type, detune] of [
        ['sawtooth', 6],
        ['triangle', -6],
      ] as const) {
        if (isSub && type === 'sawtooth') continue; // sub stays clean

        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;

        // Subtle slow detune drift across the note.
        const drift = (hashRand(track.seed, SALT.pad + 3, slot * 31 + midi) - 0.5) * 10;
        osc.detune.setValueAtTime(detune + drift * 0.3, t0);
        osc.detune.linearRampToValueAtTime(-detune + drift, t0 + total);

        const noteGain = ctx.createGain();
        const g = noteGain.gain;
        g.setValueAtTime(0.0001, t0);
        g.linearRampToValueAtTime(peak, t0 + attack);
        g.setValueAtTime(peak, t0 + noteDur);
        g.linearRampToValueAtTime(0.0001, t0 + total);

        osc.connect(noteGain);
        noteGain.connect(bus);
        osc.start(t0);
        osc.stop(t0 + total + 0.05);
        oscillators.push(osc);
        noteGains.push(noteGain);
      }
    }

    this.registerVoice(noteGains, oscillators, t0 + total + 0.05);
  }

  /**
   * Pluck layer: 8th/16th grid, triangle osc, exponential decay,
   * velocity varies, probability by density, octave-up accents.
   */
  private schedulePluckLayer(track: Track, horizon: number): void {
    const cfg = track.layers.pluck;
    if (cfg.gain <= 0.001) {
      this.layerSched.pluck = horizon;
      return;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const beatDur = 60 / track.bpm;
    const subdivisions = cfg.density > 0.72 ? 4 : 2; // 16ths vs 8ths
    const slotDur = beatDur / subdivisions;
    const probBase = cfg.density * (subdivisions === 4 ? 0.45 : 0.6);
    const from = this.layerSched.pluck;
    const slots = this.slotRange(from, horizon, slotDur);

    for (const slot of slots) {
      this.layerSched.pluck = Math.max(this.layerSched.pluck, slot * slotDur);
      const r = hashRand(track.seed, SALT.pluck, slot);
      if (r > probBase) continue;

      const rOct = hashRand(track.seed, SALT.pluck + 1, slot);
      const rVel = hashRand(track.seed, SALT.pluck + 2, slot);
      const rDeg = hashRand(track.seed, SALT.pluck + 3, slot);
      const rDec = hashRand(track.seed, SALT.pluck + 4, slot);

      const beat = slot / subdivisions;
      const chord = this.chordAtBeat(track, beat);
      let degree = chord[Math.floor(rDeg * chord.length) % chord.length];
      if (rOct < 0.22)
        degree += track.scale.length; // octave-up accent
      else if (rOct < 0.3) degree += track.scale.length * 2;

      const velocity = 0.4 + rVel * 0.6;
      const decay = 0.25 + rDec * 0.35;

      const t0 = Math.max(this.ctxTimeForPos(slot * slotDur), ctx.currentTime);
      this.spawnPluck(track, degree, velocity, decay, t0);
    }
    this.layerSched.pluck = Math.max(this.layerSched.pluck, horizon);
  }

  private spawnPluck(
    track: Track,
    degree: number,
    velocity: number,
    decay: number,
    t0: number,
  ): void {
    const ctx = this.ctx;
    const bus = this.pluckBus;
    if (!ctx || !bus) return;
    const freq = midiToFreq(this.degreeToMidi(track, degree));

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const noteGain = ctx.createGain();
    const g = noteGain.gain;
    const peak = velocity * 0.32;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + 0.006);
    g.exponentialRampToValueAtTime(0.0001, t0 + decay);

    osc.connect(noteGain);
    noteGain.connect(bus);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
    this.registerVoice([noteGain], [osc], t0 + decay + 0.05);
  }

  /**
   * Bell layer: sparse (avg every 3-7 s), sine + partial at ~2.76x freq,
   * 3-6 s decay, low gain, high reverb send (bell bus send is ~0.95).
   */
  private scheduleBellLayer(track: Track, horizon: number): void {
    const cfg = track.layers.bells;
    if (cfg.gain <= 0.001) {
      this.layerSched.bells = horizon;
      return;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const slotDur = 1; // decision slots of 1 s
    const avgInterval = 7 - cfg.density * 4; // 3-7 s
    const probPerSlot = 1 / avgInterval;
    const from = this.layerSched.bells;
    const slots = this.slotRange(from, horizon, slotDur);

    for (const slot of slots) {
      this.layerSched.bells = Math.max(this.layerSched.bells, slot);
      const r = hashRand(track.seed, SALT.bells, slot);
      if (r > probPerSlot) continue;

      const rJit = hashRand(track.seed, SALT.bells + 1, slot);
      const rDeg = hashRand(track.seed, SALT.bells + 2, slot);
      const rDec = hashRand(track.seed, SALT.bells + 3, slot);

      const beat = slot / (60 / track.bpm);
      const chord = this.chordAtBeat(track, beat);
      const degree = chord[Math.floor(rDeg * chord.length) % chord.length] + track.scale.length * 2; // high register
      const decay = 3 + rDec * 3;

      const slotTime = slot + rJit * 0.9;
      const t0 = Math.max(this.ctxTimeForPos(slotTime), ctx.currentTime);
      this.spawnBell(track, degree, decay, t0);
    }
    this.layerSched.bells = Math.max(this.layerSched.bells, horizon);
  }

  private spawnBell(track: Track, degree: number, decay: number, t0: number): void {
    const ctx = this.ctx;
    const bus = this.bellBus;
    if (!ctx || !bus) return;
    const freq = midiToFreq(this.degreeToMidi(track, degree));

    const oscillators: OscillatorNode[] = [];
    const noteGain = ctx.createGain();
    const g = noteGain.gain;
    const peak = 0.14;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + 0.012);
    g.exponentialRampToValueAtTime(0.0001, t0 + decay);

    for (const [mult, level] of [
      [1, 1],
      [2.76, 0.32],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const partial = ctx.createGain();
      partial.gain.value = level;
      osc.connect(partial);
      partial.connect(noteGain);
      osc.start(t0);
      osc.stop(t0 + decay + 0.05);
      oscillators.push(osc);
    }

    noteGain.connect(bus);
    this.registerVoice([noteGain], oscillators, t0 + decay + 0.05);
  }

  /** Bass layer: chord root, one note per 2 bars, gentle. */
  private scheduleBassLayer(track: Track, horizon: number): void {
    const cfg = track.layers.bass;
    if (cfg.gain <= 0.001) {
      this.layerSched.bass = horizon;
      return;
    }
    const ctx = this.ctx;
    if (!ctx) return;
    const beatDur = 60 / track.bpm;
    const barDur = beatDur * BEATS_PER_BAR;
    const slotDur = barDur * 2; // one note per 2 bars
    const from = this.layerSched.bass;
    const slots = this.slotRange(from, horizon, slotDur);

    for (const slot of slots) {
      this.layerSched.bass = Math.max(this.layerSched.bass, slot * slotDur);
      const r = hashRand(track.seed, SALT.bass, slot);
      if (r > 0.92) continue; // rare rest

      const beat = slot * BEATS_PER_BAR * 2;
      const chord = this.chordAtBeat(track, beat);
      const degree = chord[0] - track.scale.length; // one octave below root
      const t0 = Math.max(this.ctxTimeForPos(slot * slotDur), ctx.currentTime);
      this.spawnBassNote(track, degree, slotDur * 1.9, t0);
    }
    this.layerSched.bass = Math.max(this.layerSched.bass, horizon);
  }

  private spawnBassNote(track: Track, degree: number, duration: number, t0: number): void {
    const ctx = this.ctx;
    const bus = this.bassBus;
    if (!ctx || !bus) return;
    const freq = midiToFreq(this.degreeToMidi(track, degree));

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;

    const noteGain = ctx.createGain();
    const g = noteGain.gain;
    const peak = 0.24;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + 0.4);
    g.setValueAtTime(peak, t0 + duration * 0.7);
    g.linearRampToValueAtTime(0.0001, t0 + duration);

    osc.connect(noteGain);
    sub.connect(noteGain);
    noteGain.connect(bus);
    osc.start(t0);
    sub.start(t0);
    osc.stop(t0 + duration + 0.05);
    sub.stop(t0 + duration + 0.05);
    this.registerVoice([noteGain], [osc, sub], t0 + duration + 0.05);
  }

  // ---- Noise "air" -------------------------------------------------------------

  private startNoiseSource(track: Track): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseFilter) return;
    if (track.layers.noise.gain <= 0.001) return;
    if (!this.noiseBuffer) {
      this.noiseBuffer = this.makeNoiseBuffer(ctx);
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.connect(this.noiseFilter);
    const t0 = Math.max(this.ctxTimeForPos(this.startPosition), ctx.currentTime);
    try {
      src.start(t0);
    } catch {
      /* buffer unavailable — skip the air layer */
      return;
    }
    this.noiseSrc = src;
  }

  private stopNoiseSource(): void {
    if (this.noiseSrc) {
      try {
        this.noiseSrc.stop();
      } catch {
        /* already stopped */
      }
      this.noiseSrc.disconnect();
      this.noiseSrc = null;
    }
  }

  // ---- Voice lifecycle / stop ---------------------------------------------------

  private killVoices(): void {
    const ctx = this.ctx;
    if (!ctx) {
      this.voices = [];
      return;
    }
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      voice.kill(now);
    }
    this.voices = [];
  }

  private pruneVoices(now: number): void {
    if (this.voices.length === 0) return;
    this.voices = this.voices.filter((v) => v.endsAt > now);
  }

  private restoreFade(): void {
    const ctx = this.ctx;
    if (!ctx || !this.fadeGain) return;
    const g = this.fadeGain.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(Math.max(g.value, 0.0001), ctx.currentTime);
    g.linearRampToValueAtTime(1, ctx.currentTime + 0.15);
  }

  private clearEndTimer(): void {
    if (this.endTimerId !== null) {
      clearTimeout(this.endTimerId);
      this.endTimerId = null;
    }
  }

  /** 1.5 s fade-out → stop → onEnd (fires once per track end). */
  private beginEndFade(): void {
    if (this.fadingOut || this.endHandled) return;
    this.fadingOut = true;
    this.endHandled = true;
    const ctx = this.ctx;
    if (!ctx || !this.fadeGain) {
      this.finish();
      return;
    }
    const now = ctx.currentTime;
    const g = this.fadeGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(g.value, 0.0001), now);
    g.linearRampToValueAtTime(0.0001, now + 1.5);
    this.endTimerId = setTimeout(() => {
      this.endTimerId = null;
      this.finish();
    }, 1600);
  }

  private finish(): void {
    this.stopScheduler();
    this.clearEndTimer();
    this.killVoices();
    this.stopNoiseSource();
    this.playing = false;
    this.fadingOut = false;
    this.pausedPosition = 0;
    this.startPosition = 0;
    this.everStarted = false;
    if (this.ctx) {
      this.startCtxTime = this.ctx.currentTime;
      if (this.fadeGain) {
        const g = this.fadeGain.gain;
        g.cancelScheduledValues(this.ctx.currentTime);
        g.setValueAtTime(1, this.ctx.currentTime);
      }
    }
    this.fireStateChange();
    if (this.onEnd) this.onEnd();
  }

  /**
   * Shared teardown. `notify` distinguishes user-facing stop() from the
   * internal reset that happens inside play() (which fires its own event).
   */
  private stopInternal(notify: boolean): void {
    this.stopScheduler();
    this.clearEndTimer();
    this.killVoices();
    this.stopNoiseSource();
    this.playing = false;
    this.fadingOut = false;
    this.endHandled = false;
    this.pausedPosition = 0;
    this.startPosition = 0;
    this.everStarted = false;
    if (this.ctx) {
      this.startCtxTime = this.ctx.currentTime;
    }
    if (this.fadeGain && this.ctx) {
      const g = this.fadeGain.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setValueAtTime(1, this.ctx.currentTime);
    }
    if (notify) {
      this.fireStateChange();
    }
  }

  private fireStateChange(): void {
    if (this.onStateChange) this.onStateChange();
  }
}
