export type MusicMode = 'menu' | 'rest' | 'fight' | 'boss';

/** How far ahead notes are queued, so a dropped frame doesn't drop a beat. */
const SCHEDULE_AHEAD = 0.4;
const STEPS_PER_BAR = 16;
const TEMPO: Record<MusicMode, number> = { menu: 70, rest: 84, fight: 110, boss: 126 };
/** D2, the root of everything. */
const ROOT = 73.42;
/** Dorian: minor with a bright sixth, which suits a brave little hamlet. */
const SCALE = [0, 2, 3, 5, 7, 9, 10];
/** Chord roots, in semitones above D, two bars each. */
const PROGRESSION = [0, 5, 3, 7];
const ARP_DENSITY: Record<MusicMode, number> = { menu: 0.35, rest: 0.5, fight: 0.7, boss: 0.85 };

type LayerName = 'drone' | 'bass' | 'arp' | 'drums' | 'tension';
const LEVELS: Record<LayerName, Record<MusicMode, number>> = {
  drone: { menu: 0.9, rest: 0.7, fight: 0.6, boss: 0.7 },
  bass: { menu: 0.25, rest: 0.45, fight: 1, boss: 1 },
  arp: { menu: 0.5, rest: 0.7, fight: 0.9, boss: 1 },
  drums: { menu: 0, rest: 0.15, fight: 1, boss: 1 },
  tension: { menu: 0, rest: 0, fight: 0.25, boss: 1 },
};
const semitone = (n: number): number => 2 ** (n / 12);

/**
 * A generative score: a filtered drone that follows a slow chord progression, a pulse on the beat,
 * plucked arpeggios and drums that come in as the fight does. Everything is synthesized, so no audio ships.
 */
export class Music {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private layers = {} as Record<LayerName, GainNode>;
  private noise: AudioBuffer | null = null;
  private droneOscs: OscillatorNode[] = [];
  private droneFilter: BiquadFilterNode | null = null;
  private tensionOscs: OscillatorNode[] = [];
  private mode: MusicMode = 'menu';
  private volume = 0.7;
  private muted = false;
  private nextTime = 0;
  private step = 0;
  private bar = 0;
  private pattern: number[] = [];
  private patternMode: MusicMode | null = null;

  constructor(private getContext: () => AudioContext | null) {}

  setVolume(volume: number): void { this.volume = volume; this.applyVolume(); }
  setMuted(muted: boolean): void { this.muted = muted; this.applyVolume(); }
  setMode(mode: MusicMode): void { this.mode = mode; }

  private applyVolume(): void {
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(this.muted ? 0 : this.volume * 0.5, this.ctx.currentTime, 0.1);
  }

  /** Call every frame; it queues the next few beats and eases the layers toward the current mode. */
  update(): void {
    const ctx = this.getContext();
    if (!ctx || ctx.state !== 'running') return;
    if (!this.out) this.build(ctx);
    const now = ctx.currentTime;
    for (const name of Object.keys(this.layers) as LayerName[]) {
      this.layers[name].gain.setTargetAtTime(LEVELS[name][this.mode], now, 1.2);
    }
    if (this.nextTime < now - 1) { this.nextTime = now + 0.05; this.step = 0; }
    while (this.nextTime < now + SCHEDULE_AHEAD) {
      this.playStep(this.nextTime);
      this.nextTime += 60 / TEMPO[this.mode] / 4;
      this.step = (this.step + 1) % STEPS_PER_BAR;
      if (this.step === 0) this.bar++;
    }
  }

  private build(ctx: AudioContext): void {
    this.ctx = ctx;
    const out = ctx.createGain();
    out.gain.value = this.muted ? 0 : this.volume * 0.5;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -18;
    limiter.ratio.value = 6;
    out.connect(limiter).connect(ctx.destination);
    this.out = out;
    for (const name of Object.keys(LEVELS) as LayerName[]) {
      const g = ctx.createGain();
      g.gain.value = LEVELS[name][this.mode];
      g.connect(out);
      this.layers[name] = g;
    }
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;

    // The drone: two detuned saws and a sub sine, through a slowly breathing low-pass.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 320;
    filter.Q.value = 2.5;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.07;
    filter.connect(droneGain).connect(this.layers.drone);
    for (const [type, mul, detune] of [['sawtooth', 1, -7], ['sawtooth', 1, 7], ['sine', 0.5, 0]] as Array<[OscillatorType, number, number]>) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = ROOT * mul;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start();
      this.droneOscs.push(osc);
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 140;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    this.droneFilter = filter;

    // Tension: a high, slightly sour pair that only the boss layer lets through.
    const tensionGain = ctx.createGain();
    tensionGain.gain.value = 0.035;
    tensionGain.connect(this.layers.tension);
    for (const mul of [8, 8 * semitone(1)]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = ROOT * mul;
      osc.connect(tensionGain);
      osc.start();
      this.tensionOscs.push(osc);
    }
    const tremolo = ctx.createOscillator();
    tremolo.frequency.value = 5.5;
    const tremoloGain = ctx.createGain();
    tremoloGain.gain.value = 0.02;
    tremolo.connect(tremoloGain).connect(tensionGain.gain);
    tremolo.start();
    this.nextTime = ctx.currentTime + 0.05;
  }

  private get chordRoot(): number {
    return ROOT * semitone(PROGRESSION[Math.floor(this.bar / 2) % PROGRESSION.length]);
  }

  /** A fresh 16-step arpeggio every four bars, as a random walk over the scale. */
  private refreshPattern(): void {
    const density = ARP_DENSITY[this.mode];
    let degree = 2 + Math.floor(Math.random() * 3);
    this.pattern = [];
    for (let i = 0; i < STEPS_PER_BAR; i++) {
      if (Math.random() > density) { this.pattern.push(-1); continue; }
      degree += Math.random() < 0.5 ? -1 : 1;
      degree = Math.max(0, Math.min(SCALE.length * 2 - 1, degree));
      this.pattern.push(degree);
    }
    this.patternMode = this.mode;
  }

  private playStep(at: number): void {
    const ctx = this.ctx!;
    const mode = this.mode;
    if (this.step === 0 && (this.bar % 4 === 0 || this.patternMode !== mode || this.pattern.length === 0)) this.refreshPattern();
    if (this.step === 0 && this.bar % 2 === 0) {
      const root = this.chordRoot;
      this.droneOscs.forEach((osc, i) => osc.frequency.setTargetAtTime(root * (i === 2 ? 0.5 : 1), at, 0.4));
      this.tensionOscs.forEach((osc, i) => osc.frequency.setTargetAtTime(root * 8 * (i === 1 ? semitone(1) : 1), at, 0.4));
      if (this.droneFilter) this.droneFilter.frequency.setTargetAtTime({ menu: 320, rest: 420, fight: 900, boss: 1400 }[mode], at, 0.8);
    }
    const beat = this.step % 4 === 0;
    const busy = mode === 'fight' || mode === 'boss';
    if (beat && (busy || this.step % 8 === 0)) {
      this.kick(at, busy ? 0.9 : 0.5);
      this.pluck(this.layers.bass, 'triangle', this.chordRoot, at, 0.32, 0.3);
    }
    if (mode === 'boss' && (this.step === 6 || this.step === 14)) this.kick(at, 0.6);

    const degree = this.pattern[this.step] ?? -1;
    if (degree >= 0) {
      const octave = Math.floor(degree / SCALE.length);
      const freq = this.chordRoot * 4 * semitone(SCALE[degree % SCALE.length] + octave * 12);
      this.pluck(this.layers.arp, 'triangle', freq, at, 0.28, 0.22);
      this.pluck(this.layers.arp, 'sine', freq / 2, at, 0.35, 0.08);
    }

    if (this.step % 4 === 2) this.hit(at, 'highpass', 6000, 0.04, 0.1);
    if (this.step === 4 || this.step === 12) {
      this.hit(at, 'bandpass', 1800, 0.14, 0.32);
      this.sweep(this.layers.drums, at, 190, 120, 0.1, 0.25);
    }
  }

  private pluck(layer: GainNode, type: OscillatorType, freq: number, at: number, dur: number, volume: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(layer);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  private sweep(layer: GainNode, at: number, from: number, to: number, dur: number, volume: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + dur);
    gain.gain.setValueAtTime(volume, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(layer);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  private kick(at: number, volume: number): void {
    this.sweep(this.layers.bass, at, 130, 42, 0.16, volume);
  }

  private hit(at: number, filter: BiquadFilterType, freq: number, dur: number, volume: number): void {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const biquad = ctx.createBiquadFilter();
    biquad.type = filter;
    biquad.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    source.connect(biquad).connect(gain).connect(this.layers.drums);
    source.start(at, Math.random() * 0.5, dur + 0.02);
  }
}
