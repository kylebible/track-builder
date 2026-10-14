// The app's sounds, made on the fly with Web Audio rather than played from
// recordings: wheels clacking over joints, an engine's whistle and the bells
// of a level crossing. Browsers only start audio after the person has pressed
// something, so the audio context is made on the first press and every sound
// asked for before then is skipped.

const MUTE_KEY = 'track-builder:muted';

/** Where a sound comes from: left to right across the view, and how loud from there. */
export interface Place {
  /** -1 at the left edge of the view, 1 at the right. */
  pan: number;
  /** 0 to 1, from how far away the camera is. */
  near: number;
}

const CENTRE: Place = { pan: 0, near: 1 };

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private _muted: boolean;

  constructor() {
    this._muted = readMuted();
    const unlock = () => {
      this.start();
      if (this.ctx?.state === 'running') {
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
      }
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  get muted(): boolean {
    return this._muted;
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      // Storage blocked: the choice lasts until the page closes.
    }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  /** Ready to make a sound now. */
  get ready(): boolean {
    return !this._muted && this.ctx?.state === 'running';
  }

  private start(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      try {
        this.ctx = new Ctx();
      } catch {
        return;
      }
      // A gentle limiter so a long train over many joints never clips.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 8;
      this.master = this.ctx.createGain();
      this.master.gain.value = this._muted ? 0 : 1;
      this.master.connect(limiter).connect(this.ctx.destination);
      this.noise = whiteNoise(this.ctx, 1);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** A gain node for one sound, panned and scaled to where it is. */
  private voice(gain: number, place: Place): GainNode {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = gain * place.near;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, place.pan)) * 0.8;
      out.connect(pan).connect(this.master!);
    } else {
      out.connect(this.master!);
    }
    return out;
  }

  /** A wheel dropping over a joint: a hollow wooden tock with a click on top. `strength` 0..1. */
  clack(strength: number, place: Place = CENTRE): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const out = this.voice(0.15 + 0.5 * strength, place);
    // Pitch wanders a little so a run of clacks doesn't sound like a machine gun.
    const wobble = 1 + (Math.random() - 0.5) * 0.12;

    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(420 * wobble, t);
    body.frequency.exponentialRampToValueAtTime(190 * wobble, t + 0.05);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.9, t + 0.003);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    body.connect(bodyGain).connect(out);
    body.start(t);
    body.stop(t + 0.08);

    const click = ctx.createBufferSource();
    click.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2400 * wobble;
    band.Q.value = 1.4;
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.7, t);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    click.connect(band).connect(clickGain).connect(out);
    click.start(t, Math.random() * 0.5, 0.03);
  }

  /** Two toots on a toy steam whistle: a breathy chord, short then long. */
  whistle(place: Place = CENTRE): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.01;
    const out = this.voice(0.22, place);
    const toots: [number, number][] = [
      [0, 0.2],
      [0.3, 0.7],
    ];
    for (const [at, length] of toots) {
      const start = t + at;
      const end = start + length;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(1, start + 0.05);
      env.gain.setValueAtTime(1, end - 0.08);
      env.gain.exponentialRampToValueAtTime(0.0001, end);
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 2600;
      tone.connect(env).connect(out);
      // A three-chime whistle: a minor chord, each pipe slightly breathy.
      for (const f of [587, 698, 880]) {
        const pipe = ctx.createOscillator();
        pipe.type = 'triangle';
        pipe.frequency.setValueAtTime(f * 0.97, start);
        pipe.frequency.linearRampToValueAtTime(f, start + 0.06);
        const level = ctx.createGain();
        level.gain.value = 0.28;
        pipe.connect(level).connect(tone);
        pipe.start(start);
        pipe.stop(end + 0.02);
      }
      const steam = ctx.createBufferSource();
      steam.buffer = this.noise;
      steam.loop = true;
      const hiss = ctx.createBiquadFilter();
      hiss.type = 'bandpass';
      hiss.frequency.value = 1800;
      hiss.Q.value = 0.8;
      const hissLevel = ctx.createGain();
      hissLevel.gain.value = 0.18;
      steam.connect(hiss).connect(hissLevel).connect(env);
      steam.start(start);
      steam.stop(end + 0.02);
    }
  }

  /** One strike of a level-crossing bell: a bright metallic ding. */
  ding(place: Place = CENTRE): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.005;
    const out = this.voice(0.16, place);
    // Inharmonic partials are what make it sound like metal rather than a tone.
    const partials: [number, number, number][] = [
      [1, 1, 0.9],
      [2.76, 0.5, 0.45],
      [5.4, 0.25, 0.25],
      [8.93, 0.12, 0.15],
    ];
    for (const [ratio, level, decay] of partials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1050 * ratio;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(level, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      osc.connect(env).connect(out);
      osc.start(t);
      osc.stop(t + decay + 0.02);
    }
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function whiteNoise(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
