import { clamp, lerp } from '../core/math.js';

/* ============================================================================
   ЗВУК — полностью синтезированный (WebAudio), без файлов.
   Ветер в кронах, птицы днём, сверчки и сова ночью, далёкая канонада,
   гул дрона. Взрыв приходит с задержкой по скорости звука: вспышку видно
   раньше, чем слышно, — на дистанции это сразу читается.
============================================================================ */
export const AUDIO = { ctx: null, master: null, on: true, t: 0, nextBird: 3, nextCricket: 0, nextShell: 20, nextOwl: 30 };
let noiseBuf, windGain, windFilter, droneOsc, droneGain, droneFilter, cricketGain;

export function initAudio() {
  if (AUDIO.ctx) { AUDIO.ctx.resume(); return; }
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return;
  const ctx = new C();
  AUDIO.ctx = ctx;
  AUDIO.master = ctx.createGain(); AUDIO.master.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 6;
  AUDIO.master.connect(comp); comp.connect(ctx.destination);
  // розовый шум для ветра и взрывов
  const len = ctx.sampleRate * 4;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048;
    d[i] = (b0 + b1 + b2 + w * 0.02) * 1.8;
  }
  const wind = ctx.createBufferSource(); wind.buffer = noiseBuf; wind.loop = true;
  windFilter = ctx.createBiquadFilter(); windFilter.type = 'bandpass'; windFilter.frequency.value = 500; windFilter.Q.value = 0.5;
  windGain = ctx.createGain(); windGain.gain.value = 0;
  wind.connect(windFilter); windFilter.connect(windGain); windGain.connect(AUDIO.master); wind.start();
  // гул винтов: две детюненные пилы через ФНЧ
  droneGain = ctx.createGain(); droneGain.gain.value = 0;
  droneFilter = ctx.createBiquadFilter(); droneFilter.type = 'lowpass'; droneFilter.frequency.value = 900;
  droneOsc = [ctx.createOscillator(), ctx.createOscillator()];
  droneOsc.forEach((o, i) => { o.type = 'sawtooth'; o.frequency.value = 180 + i * 3.7; o.connect(droneFilter); o.start(); });
  droneFilter.connect(droneGain); droneGain.connect(AUDIO.master);
  cricketGain = ctx.createGain(); cricketGain.gain.value = 0; cricketGain.connect(AUDIO.master);
}
function env(g, t0, a, peak, dec) {
  g.gain.cancelScheduledValues(t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
}
function pan(ctx, x) { const p = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(); if (p.pan) p.pan.value = clamp(x, -1, 1); return p; }

function bird(ctx, t, x) {
  // короткая трель: пара свистов с глиссандо
  const n = 2 + Math.floor(Math.random() * 4), base = 2600 + Math.random() * 1800;
  const p = pan(ctx, x); p.connect(AUDIO.master);
  for (let i = 0; i < n; i++) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    const t0 = t + i * (0.09 + Math.random() * 0.06);
    o.frequency.setValueAtTime(base * (1 + Math.random() * 0.2), t0);
    o.frequency.exponentialRampToValueAtTime(base * (0.7 + Math.random() * 0.6), t0 + 0.07);
    env(g, t0, 0.01, 0.025 + Math.random() * 0.02, 0.08);
    o.connect(g); g.connect(p); o.start(t0); o.stop(t0 + 0.2);
  }
}
function owl(ctx, t) {
  const p = pan(ctx, Math.random() * 2 - 1); p.connect(AUDIO.master);
  for (const [dt, f, dur] of [[0, 420, 0.35], [0.55, 400, 0.18], [0.8, 410, 0.6]]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f, t + dt); o.frequency.linearRampToValueAtTime(f * 0.92, t + dt + dur);
    env(g, t + dt, 0.06, 0.035, dur);
    o.connect(g); g.connect(p); o.start(t + dt); o.stop(t + dt + dur + 0.2);
  }
}
function crickets(ctx, t, amt) {
  // хор: пульсирующие высокие тона
  for (let k = 0; k < 3; k++) {
    const o = ctx.createOscillator(), g = ctx.createGain(), p = pan(ctx, Math.random() * 2 - 1);
    o.type = 'sine'; o.frequency.value = 4200 + Math.random() * 900;
    const t0 = t + Math.random() * 0.5;
    for (let i = 0; i < 6; i++) { g.gain.setValueAtTime(0.0001, t0 + i * 0.07); g.gain.linearRampToValueAtTime(0.008 * amt, t0 + i * 0.07 + 0.01); g.gain.linearRampToValueAtTime(0.0001, t0 + i * 0.07 + 0.04); }
    o.connect(g); g.connect(p); p.connect(AUDIO.master); o.start(t0); o.stop(t0 + 0.6);
  }
}
/** Взрыв: треск + низкий удар, дальний — глухой и с задержкой. */
export function boom(dist, size = 1, x = 0) {
  const ctx = AUDIO.ctx;
  if (!ctx || !AUDIO.on) return;
  const t = ctx.currentTime + dist / 343;
  const vol = clamp(size * 1.6 / (1 + dist / 25), 0.02, 1.4);
  const src = ctx.createBufferSource(); src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = 'lowpass';
  f.frequency.setValueAtTime(lerp(5000, 700, clamp(dist / 250, 0, 1)), t);
  f.frequency.exponentialRampToValueAtTime(120, t + 1.8);
  const g = ctx.createGain(); env(g, t, 0.005, vol, 1.6 + size * 0.6);
  const p = pan(ctx, x);
  src.connect(f); f.connect(g); g.connect(p); p.connect(AUDIO.master);
  src.start(t, Math.random() * 2); src.stop(t + 3);
  const o = ctx.createOscillator(), og = ctx.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.6);
  env(og, t, 0.004, vol * 0.9, 0.7);
  o.connect(og); og.connect(AUDIO.master); o.start(t); o.stop(t + 1);
}
/** Щелчок взрывателя под ногой. */
export function click() {
  const ctx = AUDIO.ctx;
  if (!ctx) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square'; o.frequency.setValueAtTime(1800, t); o.frequency.exponentialRampToValueAtTime(400, t + 0.03);
  env(g, t, 0.001, 0.2, 0.05); o.connect(g); g.connect(AUDIO.master); o.start(t); o.stop(t + 0.1);
}
/** Звон в ушах после близкого разрыва. */
export function tinnitus(k) {
  const ctx = AUDIO.ctx;
  if (!ctx || k < 0.1) return;
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine'; o.frequency.value = 3900;
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.05 * k, t + 0.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 4 * k);
  o.connect(g); g.connect(AUDIO.master); o.start(t); o.stop(t + 4.5);
  AUDIO.master.gain.setValueAtTime(0.25, t); AUDIO.master.gain.linearRampToValueAtTime(0.8, t + 3 * k);
}
/** Раз в кадр: амбиент по времени суток, ветру и высоте. */
export function updateAudio(dt, s) {
  const ctx = AUDIO.ctx;
  if (!ctx) return;
  const t = ctx.currentTime;
  AUDIO.master.gain.value = AUDIO.on ? AUDIO.master.gain.value : 0;
  windGain.gain.setTargetAtTime(AUDIO.on ? (0.05 + s.wind * 0.12) * (1 + clamp(s.agl / 60, 0, 1.5)) : 0, t, 0.3);
  windFilter.frequency.setTargetAtTime(350 + s.wind * 500 + s.agl * 4, t, 0.3);
  const drone = AUDIO.on && s.drone ? 0.018 + s.speed * 0.0016 : 0;
  droneGain.gain.setTargetAtTime(drone, t, 0.2);
  droneOsc[0].frequency.setTargetAtTime(170 + s.speed * 6, t, 0.2);
  droneOsc[1].frequency.setTargetAtTime(174 + s.speed * 6.3, t, 0.2);
  if (!AUDIO.on) return;
  AUDIO.t += dt;
  const day = 1 - s.night;
  if (AUDIO.t > AUDIO.nextBird && day > 0.3 && s.agl < 40) { bird(ctx, t, Math.random() * 2 - 1); AUDIO.nextBird = AUDIO.t + 1.5 + Math.random() * 6 / day; }
  if (AUDIO.t > AUDIO.nextCricket && s.night > 0.4) { crickets(ctx, t, s.night); AUDIO.nextCricket = AUDIO.t + 0.6 + Math.random() * 1.2; }
  if (AUDIO.t > AUDIO.nextOwl && s.night > 0.7) { owl(ctx, t); AUDIO.nextOwl = AUDIO.t + 25 + Math.random() * 50; }
  if (AUDIO.t > AUDIO.nextShell) {
    // далёкая канонада за горизонтом: фронт рядом, но не здесь
    boom(1500 + Math.random() * 2500, 2.2, Math.random() * 2 - 1);
    if (Math.random() < 0.5) setTimeout(() => boom(1800 + Math.random() * 2000, 2.0, Math.random() * 2 - 1), 900 + Math.random() * 1500);
    AUDIO.nextShell = AUDIO.t + 25 + Math.random() * 60;
  }
}
