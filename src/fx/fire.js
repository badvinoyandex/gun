import * as THREE from 'three';
import { scene, camera, FRAME, Q } from '../core/env.js';
import { clamp, lerp, sr, srnd, TAU } from '../core/math.js';
import { lakeRho, pathInfluence, trenchDist, edgeDist, MAP, PADS, padRectDist, inBog, streamAt, STREAM_BW } from '../world/layout.js';
import { hFast, grassDensity } from '../world/heightcache.js';
import { forestDensity } from '../world/forest.js';
import { BURN, burnData, markBurnDirty } from '../core/fxu.js';
import { WIND } from '../world/wind.js';
import { FX } from './particles.js';
import { WEATHER } from '../world/weather.js';

/* ============================================================================
   ОГОНЬ
   Клеточный пожар на сетке 1 м поверх всей игровой зоны. Горючее — трава и
   хвойная подстилка (по плотности травы и полога), троп, воды и дна окопов нет.
   Клетка разгорается, выжигает горючее и гаснет, оставляя гарь; огонь ползёт
   к соседям — по ветру быстрее, против ветра почти не идёт. Дождь гасит,
   мокрая трава не занимается. Отдельно горят кроны у взрыва и отлетевшие ветки:
   упав в сухую траву, ветка поджигает её.
   Карта жара и гари уходит в текстуру — рельеф темнеет, трава чернеет и
   оседает, по ночам тлеющие угли подсвечивают землю.
============================================================================ */
const N = BURN.N;
const fuel = new Float32Array(N * N), fuel0 = new Float32Array(N * N), heat = new Float32Array(N * N);
const state = new Uint8Array(N * N);          // 0 — цело, 1 — горит, 2 — выгорело
let active = [];
export const FIRE = { cells: 0, trees: [], brands: [], lights: [], near: 0, structs: [] };
const MAXC = () => Math.round(500 + 900 * Q.tex);

export function buildFire() {
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = BURN.X0 + i + 0.5, z = BURN.X0 + j + 0.5, k = j * N + i;
    let f = 0;
    if (lakeRho(x, z) > 1.04 && pathInfluence(x, z, 0.3) < 0.4 && trenchDist(x, z) > 1.1 && inBog(x, z) < 0.4 && streamAt(x, z).d > STREAM_BW + 0.6 && !PADS.some(p => padRectDist(p, x, z) < 0.5)) {
      f = clamp(grassDensity(x, z) * 0.85 + forestDensity(x, z) * 0.35, 0, 1.2);
      const e = edgeDist(x, z);
      if (e > MAP.PLAY - 2 && e < MAP.FENCE) f *= 1.25;                  // сухостой минной полосы
    }
    fuel[k] = fuel0[k] = f;
  }
  const n = Q.fireLights;
  for (let i = 0; i < n; i++) {
    const L = new THREE.PointLight(0xff7a2a, 0, 16, 1.7);
    L.position.set(0, -500, 0);
    scene.add(L); FIRE.lights.push(L);
  }
}
const idx = (x, z) => { const i = Math.floor(x - BURN.X0), j = Math.floor(z - BURN.X0); return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i; };
function lightCell(k, h) {
  if (state[k] !== 0 || fuel[k] < 0.12 || active.length >= MAXC()) return false;
  state[k] = 1; heat[k] = h; active.push(k);
  return true;
}
/** Поджечь траву в радиусе r. strength 0..1 — доля клеток, которые займутся. */
export function ignite(x, z, r, strength = 1) {
  const wet = WEATHER.wet;
  let n = 0;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dz * dz > r * r) continue;
    const k = idx(x + dx, z + dz);
    if (k < 0) continue;
    if (Math.random() < strength * (1 - wet * 0.85) && lightCell(k, 0.3 + Math.random() * 0.5)) n++;
  }
  return n;
}
/** Гарь от взрыва: копоть и выбитая трава, без горения. */
export function scorch(x, z, r, amt = 1) {
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const d = Math.hypot(dx, dz) / r;
    if (d > 1) continue;
    const k = idx(x + dx, z + dz);
    if (k < 0) continue;
    const a = (1 - d * d) * amt;
    burnData[k * 4] = Math.max(burnData[k * 4], Math.min(255, a * 230));
    burnData[k * 4 + 3] = Math.max(burnData[k * 4 + 3], Math.min(255, a * 1.4 * 255));
    fuel[k] *= 1 - clamp(a, 0, 1) * 0.7;
  }
  markBurnDirty();
}
/** Лужа в воронке: при дожде вода собирается в канале B. */
export function markPuddle(x, z, r) {
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const d = Math.hypot(dx, dz) / r;
    if (d > 1) continue;
    const k = idx(x + dx, z + dz);
    if (k >= 0) burnData[k * 4 + 2] = Math.max(burnData[k * 4 + 2], (1 - d) * 255);
  }
  markBurnDirty();
}
export const heatAt = (x, z) => { const k = idx(x, z); return k < 0 ? 0 : heat[k]; };
/** Крона занялась: языки пламени по объёму кроны, потом дерево чернеет. */
export function igniteTree(t, life = 14) {
  if (WEATHER.rain > 0.6) life *= 0.35;
  FIRE.trees.push({ t, x: t.x, z: t.z, y0: t.y + t.h * 0.35, y1: t.y + t.h * 0.85, r: t.h * 0.14, age: 0, life });
}
/** Горящая головня (ветка в полёте): пламя на теле и поджог травы, куда упала. */
export function attachFire(b, life = 7) { FIRE.brands.push({ b, age: 0, life }); }

/* ---------- Шаг клеточного автомата ---------- */
let acc = 0;
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 0.7], [-1, 1, 0.7], [1, -1, 0.7], [-1, -1, 0.7]];
function tick(st) {
  if (!active.length) { FIRE.cells = 0; return; }
  const wet = WEATHER.wet, rain = WEATHER.rain, wx = WIND.dir.x, wz = WIND.dir.y, ws = WIND.strength;
  const next = [];
  for (const k of active) {
    if (state[k] !== 1) continue;
    const f = fuel[k];
    heat[k] = Math.min(Math.min(1, 0.35 + f), heat[k] + st * 0.9);
    fuel[k] = f - st * (0.045 + heat[k] * 0.1);
    heat[k] -= st * (rain * 0.9 + wet * 0.12);
    const d = k * 4;
    burnData[d + 1] = Math.max(0, heat[k]) * 255;
    burnData[d] = Math.max(burnData[d], Math.min(255, (1 - fuel[k] / (fuel0[k] + 1e-3)) * 240));
    burnData[d + 3] = Math.max(burnData[d + 3], Math.min(255, (1 - fuel[k] / (fuel0[k] + 1e-3)) * 300));
    if (fuel[k] <= 0.03 || heat[k] <= 0.02) {
      state[k] = 2; heat[k] = 0; burnData[d + 1] = 0;
      // тлеющие угли остаются в копоти, но трава больше не займётся
      continue;
    }
    next.push(k);
    const i = k % N, j = (k / N) | 0;
    for (const [dx, dz, w0] of NB) {
      const ii = i + dx, jj = j + dz;
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
      const n = jj * N + ii;
      if (state[n] !== 0 || fuel[n] < 0.12) continue;
      const dot = (dx * wx + dz * wz) / (w0 === 1 ? 1 : 1.414);
      const w = Math.max(0.08, 1 + dot * (0.8 + ws * 2.2));
      // вероятность за время горения клетки: сухой луг (горючее ≈ 1) — огонь идёт, особенно по ветру;
      // лесная подстилка (≈ 0.5) — пожар сам затухает (ниже порога перколяции)
      const p = 0.13 * heat[k] * fuel[n] * fuel[n] * w * w0 * (1 - wet * 0.95) * st;
      if (Math.random() < p && lightCell(n, 0.2)) next.push(n);
    }
  }
  active = next;
  FIRE.cells = active.length;
  markBurnDirty();
}

/* ---------- Кадр: частицы, свет, головни, кроны ---------- */
const _v = new THREE.Vector3();
let lightT = 0;
export function updateFire(dt) {
  acc += dt;
  if (acc >= 0.125) { tick(acc); acc = 0; }
  const cp = camera.position, t = FRAME.t;
  // пламя: бюджет частиц на кадр делится между ближними горящими клетками
  let near = [];
  for (const k of active) {
    const x = BURN.X0 + (k % N) + 0.5, z = BURN.X0 + ((k / N) | 0) + 0.5;
    const d2 = (x - cp.x) ** 2 + (z - cp.z) ** 2;
    if (d2 < 85 * 85) near.push(k);
  }
  FIRE.near = near.length;
  const budget = Math.min(near.length, Math.round(18 + 30 * Q.tex));
  for (let n = 0; n < budget; n++) {
    const k = near[(Math.random() * near.length) | 0], h = heat[k];
    if (Math.random() > h * dt * 60 * 0.5) continue;
    const x = BURN.X0 + (k % N) + Math.random(), z = BURN.X0 + ((k / N) | 0) + Math.random(), y = hFast(x, z);
    FX.add.spawn({ flame: true, x, y: y + 0.1, z, vx: WIND.dir.x * 0.5 + sr(-0.2, 0.2), vy: sr(0.8, 2.0), vz: WIND.dir.y * 0.5 + sr(-0.2, 0.2), size: sr(0.35, 0.8) * (0.6 + h), grow: -0.3, life: sr(0.35, 0.8), col: [1.7, 0.85, 0.35], a: 0.9, cool: 0.45, windK: 0.6 });
    if (Math.random() < 0.18) FX.alpha.spawn({ x, y: y + 0.8, z, vx: 0, vy: sr(0.8, 1.6), vz: 0, size: sr(0.6, 1.2), grow: 0.9, life: sr(3, 6), col: [0.2, 0.19, 0.18], a: 0.3, fadeIn: 0.4, windK: 1.6, drag: 0.3 });
    if (Math.random() < 0.05) FX.add.spawn({ x, y: y + 0.4, z, vx: sr(-0.5, 0.5), vy: sr(1.5, 3.5), vz: sr(-0.5, 0.5), size: 0.05, life: sr(1, 2), col: [2.6, 1.2, 0.4], a: 1, grav: 1.2, windK: 0.8, drag: 0.4 });
  }
  // горящие кроны
  for (let i = FIRE.trees.length - 1; i >= 0; i--) {
    const f = FIRE.trees[i];
    f.age += dt;
    if (f.age > f.life) { FIRE.trees.splice(i, 1); continue; }
    const k = Math.sin(Math.min(1, f.age / 1.5) * Math.PI * 0.5) * (1 - Math.max(0, (f.age - f.life + 3) / 3));
    if ((f.x - cp.x) ** 2 + (f.z - cp.z) ** 2 > 150 * 150) continue;
    for (let n = 0; n < 3; n++) {
      if (Math.random() > k) continue;
      const a = srnd() * TAU, r = Math.sqrt(srnd()) * f.r, y = lerp(f.y0, f.y1, srnd());
      FX.add.spawn({ flame: true, x: f.x + Math.cos(a) * r, y, z: f.z + Math.sin(a) * r, vx: WIND.dir.x, vy: sr(1.5, 3), vz: WIND.dir.y, size: sr(0.6, 1.4), grow: -0.2, life: sr(0.4, 0.9), col: [1.8, 0.8, 0.3], a: 0.9, cool: 0.4, windK: 0.8 });
    }
    if (Math.random() < k * 0.35) FX.alpha.spawn({ x: f.x, y: f.y1, z: f.z, vx: 0, vy: sr(1, 2), vz: 0, size: sr(1.4, 2.4), grow: 1.4, life: sr(4, 8), col: [0.16, 0.15, 0.14], a: 0.4, fadeIn: 0.5, windK: 2, drag: 0.3 });
    // с горящей кроны падают угли
    if (Math.random() < k * dt * 0.8) ignite(f.x + sr(-f.r, f.r), f.z + sr(-f.r, f.r), 1, 0.7);
  }
  // головни
  for (let i = FIRE.brands.length - 1; i >= 0; i--) {
    const g = FIRE.brands[i];
    g.age += dt;
    const b = g.b;
    if (!b.body || g.age > g.life || WEATHER.rain > 0.7 && g.age > 2) { FIRE.brands.splice(i, 1); continue; }
    if (Math.random() < 0.7) FX.add.spawn({ flame: true, x: b.pos.x + sr(-0.2, 0.2), y: b.pos.y + 0.1, z: b.pos.z + sr(-0.2, 0.2), vx: 0, vy: sr(0.5, 1.2), vz: 0, size: sr(0.2, 0.45), grow: -0.3, life: sr(0.3, 0.6), col: [1.8, 0.9, 0.35], a: 0.9, cool: 0.4, windK: 0.4 });
    if (Math.random() < 0.12) FX.alpha.spawn({ x: b.pos.x, y: b.pos.y + 0.4, z: b.pos.z, vx: 0, vy: 0.8, vz: 0, size: 0.4, grow: 0.7, life: 3, col: [0.22, 0.21, 0.2], a: 0.25, windK: 1.2 });
    // лежит на земле — поджигает траву под собой
    if (g.age > 0.6 && b.pos.y - hFast(b.pos.x, b.pos.z) < 0.4 && Math.random() < dt * 2.5) ignite(b.pos.x, b.pos.z, 0, 1);
    if (g.age > 0.6 && Math.random() < dt * 0.4 && FIRE.onBrand) FIRE.onBrand(b.pos);
    if (b.wet) { FIRE.brands.splice(i, 1); continue; }
  }
  // свет: несколько точечных источников на самых близких очагах, с мерцанием
  lightT -= dt;
  if (lightT <= 0) {
    lightT = 0.2;
    const cand = [];
    for (const k of near) cand.push([BURN.X0 + (k % N) + 0.5, BURN.X0 + ((k / N) | 0) + 0.5, heat[k]]);
    for (const f of FIRE.trees) cand.push([f.x, f.z, 3, (f.y0 + f.y1) / 2]);
    for (const g of FIRE.brands) if (g.b.body) cand.push([g.b.pos.x, g.b.pos.z, 0.6, g.b.pos.y + 0.3]);
    for (const f of FIRE.structs) cand.push([f.x, f.z, f.p, f.y]);
    cand.sort((a, b) => ((a[0] - cp.x) ** 2 + (a[1] - cp.z) ** 2) - ((b[0] - cp.x) ** 2 + (b[1] - cp.z) ** 2));
    const picked = [];
    for (const c of cand) {
      if (picked.length >= FIRE.lights.length) break;
      const p = picked.find(p => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 < 49);
      if (p) { p[2] += c[2]; continue; }
      picked.push([c[0], c[1], c[2], c[3]]);
    }
    FIRE.lights.forEach((L, i) => {
      const p = picked[i];
      if (!p) { L.userData.I = 0; return; }
      L.position.set(p[0], p[3] ?? hFast(p[0], p[1]) + 0.9, p[1]);
      L.userData.I = Math.min(40, 6 + p[2] * 3);
    });
  }
  FIRE.lights.forEach((L, i) => {
    const I = L.userData.I || 0;
    L.intensity = I * (0.78 + 0.14 * Math.sin(t * 13 + i * 2) + 0.1 * Math.sin(t * 29 + i));
    if (!I) L.position.y = -500;
  });
}
export const fireStats = () => ({ fireCells: FIRE.cells, treeFires: FIRE.trees.length });
