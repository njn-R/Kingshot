const STORAGE_KEY = 'palisade.muted';
const MASTER_VOLUME = 0.55;

/** Shortest gap between repeats of a sound, in seconds, so a big fight doesn't turn to noise. */
const MIN_GAP: Record<string, number> = { boulder: 0.1, beacon: 0.5, cast: 0.2, shoot: 0.07, tower: 0.12, hit: 0.05, kill: 0.06, coin: 0.045, chop: 0.08, pay: 0.05, hurt: 0.2, gateHit: 0.25 };

function readMuted(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

/** Every sound is synthesized here, so the game ships no audio files. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private last = new Map<string, number>();
  muted = readMuted();

  /** Browsers only allow audio after a user gesture, so call this from one. */
  unlock(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER_VOLUME;
    const limiter = ctx.createDynamicsCompressor();
    master.connect(limiter).connect(ctx.destination);
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.ctx = ctx;
    this.master = master;
    this.noiseBuffer = noise;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : MASTER_VOLUME;
    try { localStorage.setItem(STORAGE_KEY, this.muted ? '1' : '0'); } catch { /* the setting just won't persist */ }
    return this.muted;
  }

  /** Returns the start time, or null if the sound should be skipped. */
  private ready(name: string): number | null {
    if (!this.ctx || this.muted || this.ctx.state !== 'running') return null;
    const now = this.ctx.currentTime;
    if (now - (this.last.get(name) ?? -1) < (MIN_GAP[name] ?? 0)) return null;
    this.last.set(name, now);
    return now;
  }

  private tone(at: number, type: OscillatorType, from: number, to: number, dur: number, volume: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(to, at + dur);
    gain.gain.setValueAtTime(volume, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  private noise(at: number, filter: BiquadFilterType, from: number, to: number, dur: number, volume: number): void {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const biquad = ctx.createBiquadFilter();
    biquad.type = filter;
    biquad.frequency.setValueAtTime(from, at);
    biquad.frequency.exponentialRampToValueAtTime(to, at + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    source.connect(biquad).connect(gain).connect(this.master!);
    source.start(at, Math.random() * 0.8, dur + 0.02);
  }

  /** Plays one held chord or note through a dark filter, like a brass horn. */
  private brass(at: number, freq: number, dur: number, volume: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq * 2, at);
    filter.frequency.linearRampToValueAtTime(freq * 5, at + dur * 0.4);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.06);
    gain.gain.setValueAtTime(volume, at + dur * 0.7);
    gain.gain.linearRampToValueAtTime(0.0001, at + dur);
    osc.connect(filter).connect(gain).connect(this.master!);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  private melody(at: number, notes: number[], step: number, volume: number): void {
    notes.forEach((f, i) => this.tone(at + i * step, 'triangle', f, f, step * 2.2, volume));
  }

  shoot(tower = false): void {
    const t = this.ready(tower ? 'tower' : 'shoot');
    if (t === null) return;
    const v = tower ? 0.1 : 0.2;
    this.noise(t, 'bandpass', 3200, 900, 0.07, v);
    this.tone(t, 'triangle', tower ? 170 : 260, 90, 0.08, v);
  }

  hit(): void {
    const t = this.ready('hit');
    if (t === null) return;
    this.tone(t, 'square', 700 + Math.random() * 500, 240, 0.035, 0.07);
    this.noise(t, 'highpass', 1800, 1200, 0.03, 0.12);
  }

  kill(): void {
    const t = this.ready('kill');
    if (t === null) return;
    for (let i = 0; i < 3; i++) {
      this.tone(t + i * 0.035, 'square', 1100 - i * 220 + Math.random() * 200, 300, 0.03, 0.07);
    }
    this.noise(t, 'lowpass', 900, 300, 0.1, 0.12);
  }

  coin(): void {
    const t = this.ready('coin');
    if (t === null) return;
    this.tone(t, 'triangle', 1320, 1320, 0.05, 0.08);
    this.tone(t + 0.045, 'triangle', 1760, 1760, 0.09, 0.08);
  }

  chop(): void {
    const t = this.ready('chop');
    if (t === null) return;
    this.noise(t, 'bandpass', 1400, 500, 0.06, 0.3);
    this.tone(t, 'triangle', 190, 90, 0.07, 0.25);
  }

  boulder(): void {
    const t = this.ready('boulder');
    if (t === null) return;
    this.tone(t, 'sine', 95, 42, 0.2, 0.42);
    this.noise(t, 'lowpass', 1100, 220, 0.16, 0.26);
  }

  beacon(): void {
    const t = this.ready('beacon');
    if (t === null) return;
    this.tone(t, 'sine', 1040, 720, 0.16, 0.05);
  }

  cast(): void {
    const t = this.ready('cast');
    if (t === null) return;
    this.tone(t, 'sawtooth', 300, 760, 0.16, 0.06);
    this.tone(t, 'sine', 520, 1120, 0.2, 0.07);
  }

  fell(): void {
    const t = this.ready('fell');
    if (t === null) return;
    this.noise(t, 'lowpass', 1600, 200, 0.3, 0.3);
    this.tone(t, 'sine', 110, 50, 0.25, 0.35);
  }

  /** `progress` runs from 0 to 1, so filling a pad climbs in pitch. */
  pay(progress: number): void {
    const t = this.ready('pay');
    if (t === null) return;
    this.tone(t, 'triangle', 340 + progress * 620, 340 + progress * 620, 0.06, 0.12);
  }

  build(): void {
    const t = this.ready('build');
    if (t === null) return;
    this.tone(t, 'sine', 130, 55, 0.25, 0.5);
    this.noise(t, 'lowpass', 900, 200, 0.2, 0.3);
    this.melody(t + 0.06, [392, 523, 659], 0.07, 0.14);
  }

  hurt(): void {
    const t = this.ready('hurt');
    if (t === null) return;
    this.tone(t, 'sawtooth', 200, 70, 0.14, 0.16);
    this.noise(t, 'lowpass', 800, 250, 0.1, 0.18);
  }

  gateHit(): void {
    const t = this.ready('gateHit');
    if (t === null) return;
    this.tone(t, 'sine', 120, 60, 0.12, 0.22);
    this.noise(t, 'bandpass', 700, 300, 0.08, 0.14);
  }

  gateBreak(): void {
    const t = this.ready('gateBreak');
    if (t === null) return;
    this.tone(t, 'sine', 100, 38, 0.4, 0.5);
    this.noise(t, 'lowpass', 2400, 180, 0.45, 0.45);
  }

  levelUp(): void {
    const t = this.ready('levelUp');
    if (t !== null) this.melody(t, [523, 659, 784, 1047], 0.075, 0.16);
  }

  pick(): void {
    const t = this.ready('pick');
    if (t !== null) this.melody(t, [784, 1175], 0.06, 0.14);
  }

  horn(boss: boolean): void {
    const t = this.ready('horn');
    if (t === null) return;
    if (boss) {
      this.brass(t, 73.4, 1.1, 0.26);
      this.brass(t, 110, 1.1, 0.14);
      this.tone(t, 'sine', 70, 34, 0.7, 0.5);
    } else {
      this.brass(t, 146.8, 0.28, 0.16);
      this.brass(t + 0.26, 220, 0.5, 0.16);
    }
  }

  cleared(): void {
    const t = this.ready('cleared');
    if (t !== null) this.melody(t, [587, 784], 0.1, 0.13);
  }

  bossDown(): void {
    const t = this.ready('bossDown');
    if (t === null) return;
    this.tone(t, 'sine', 90, 30, 0.8, 0.6);
    this.noise(t, 'lowpass', 2600, 120, 0.8, 0.5);
  }

  win(): void {
    const t = this.ready('end');
    if (t === null) return;
    [[293.7, 0], [392, 0.22], [587.3, 0.44]].forEach(([f, at]) => this.brass(t + at, f, at === 0.44 ? 1.1 : 0.3, 0.14));
  }

  lose(): void {
    const t = this.ready('end');
    if (t === null) return;
    [[220, 0], [174.6, 0.34], [146.8, 0.68]].forEach(([f, at]) => this.brass(t + at, f, at === 0.68 ? 1.2 : 0.42, 0.15));
  }
}
