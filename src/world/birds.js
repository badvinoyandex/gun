import * as THREE from 'three';
import { scene, camera, Q, FRAME, NO_REFLECT } from '../core/env.js';
import { rng, TAU, clamp, lerp, sr } from '../core/math.js';
import { MAP, lakeRho, edgeDist } from './layout.js';
import { hFast } from './heightcache.js';
import { TREES } from './forest.js';
import { bushNear } from './groundcover.js';
import { flockSound } from '../fx/audio.js';
import { WIND } from './wind.js';

/* ============================================================================
   ВОРОНЫ
   Стаи сидят на верхушках высоких сосен. Выстрел, разрыв, дрон вплотную или
   боец, ломящийся через кусты, поднимают стаю: хлопанье крыльев, карканье,
   птицы кружат над местом и улетают садиться на другое дерево. Это выдаёт
   позицию — и тому, кто стрелял, и тому, кто крадётся.
============================================================================ */
export const BIRDS = { flocks: [], im: null, count: 0 };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();

function birdGeo() {
  // тело — вытянутый ромб, крылья — два треугольника с изломом; aWing — доля размаха
  const P = [], W = [], I = [];
  const v = (x, y, z, w) => { P.push(x, y, z); W.push(w); return P.length / 3 - 1; };
  const nose = v(0, 0, 0.22, 0), tail = v(0, 0.01, -0.24, 0), top = v(0, 0.05, 0, 0), bot = v(0, -0.04, 0.02, 0), l = v(-0.05, 0, 0, 0), r = v(0.05, 0, 0, 0);
  I.push(nose, l, top, nose, top, r, nose, bot, l, nose, r, bot, tail, top, l, tail, r, top, tail, l, bot, tail, bot, r);
  const tl = v(-0.03, 0.01, -0.2, 0), tr = v(0.03, 0.01, -0.2, 0), tt = v(0, 0.01, -0.32, 0);
  I.push(tl, tt, tr, tl, tr, tt);
  for (const sx of [-1, 1]) {
    const a = v(sx * 0.04, 0.02, 0.06, 0), b = v(sx * 0.04, 0.02, -0.08, 0), c = v(sx * 0.2, 0.03, 0.02, 0.5), d = v(sx * 0.2, 0.03, -0.1, 0.5), e = v(sx * 0.38, 0.02, -0.08, 1);
    I.push(a, c, b, b, c, d, c, e, d, a, b, c, b, d, c, c, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(W, 1));
  g.setIndex(I); g.computeVertexNormals();
  return g;
}
export function buildBirds() {
  const R = rng(3131);
  const nF = Math.round(2 + 6 * Q.tex);
  // насесты: высокие живые деревья внутри карты, не над водой
  const perches = TREES.filter(t => !t.dead && t.h > 15 && edgeDist(t.x, t.z) < MAP.PLAY - 6 && lakeRho(t.x, t.z) > 1.3);
  const pick = () => perches[Math.floor(R() * perches.length)];
  const N = nF * 11, geo = birdGeo();
  const flap = new THREE.InstancedBufferAttribute(new Float32Array(N), 1); flap.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aFlap', flap);
  const mat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.75, metalness: 0.1, side: THREE.DoubleSide });
  mat.onBeforeCompile = sh => {
    sh.vertexShader = 'attribute float aWing;\nattribute float aFlap;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      // взмах: крыло поворачивается вокруг плеча, кончик отстаёт
      float fl = sin(aFlap), fl2 = sin(aFlap - 0.6);
      transformed.y += aWing * 0.34 * mix(fl, fl2, aWing) * step(0.001, aWing + 0.0) ;
      transformed.x *= 1.0 - 0.18 * abs(fl) * aWing;`);
  };
  const im = new THREE.InstancedMesh(geo, mat, N);
  im.frustumCulled = false; im.castShadow = false; im.name = 'birds';
  scene.add(im); NO_REFLECT.push(im);
  BIRDS.im = im; BIRDS.flap = flap; BIRDS.count = N;
  let k = 0;
  for (let f = 0; f < nF && perches.length; f++) {
    const home = pick(), n = 7 + Math.floor(R() * 5);
    const F = { perch: home, state: 'sit', t: 0, birds: [], c: new THREE.Vector3(), v: new THREE.Vector3(), target: null, calm: R() * 30, caw: 10 + R() * 30 };
    for (let i = 0; i < n && k < N; i++, k++) {
      const b = { i: k, off: new THREE.Vector3(sr(-1.4, 1.4), sr(-0.6, 0.3), sr(-1.4, 1.4)), p: new THREE.Vector3(), v: new THREE.Vector3(), ph: R() * TAU, yaw: R() * TAU, fr: sr(9, 12), hop: 0 };
      F.birds.push(b);
    }
    seat(F, home);
    BIRDS.flocks.push(F);
  }
  for (let i = k; i < N; i++) im.setMatrixAt(i, _m.makeScale(0, 0, 0));
  BIRDS.pick = pick;
}
function seat(F, t) {
  F.perch = t; F.state = 'sit'; F.t = 0;
  const top = t.y + t.h * 0.97;
  F.c.set(t.x, top, t.z);
  for (const b of F.birds) { b.p.set(t.x + b.off.x * 0.8, top + b.off.y - 0.3, t.z + b.off.z * 0.8); b.v.set(0, 0, 0); }
}
/** Спугнуть стаи в радиусе: k — вероятность для каждой стаи. */
export function scareBirds(x, y, z, radius, k = 1) {
  for (const F of BIRDS.flocks) {
    if (F.state !== 'sit') continue;
    const d = Math.hypot(F.c.x - x, F.c.z - z);
    if (d > radius || Math.random() > k * (1 - d / radius * 0.5)) continue;
    takeOff(F, x, z);
  }
}
function takeOff(F, fx, fz) {
  F.state = 'fly'; F.t = 0; F.circle = sr(4, 8);
  // новое дерево — подальше от угрозы
  let best = null, bs = -1e9;
  for (let i = 0; i < 12; i++) {
    const t = BIRDS.pick(), d = Math.hypot(t.x - F.c.x, t.z - F.c.z), away = Math.hypot(t.x - fx, t.z - fz);
    const sc = away - Math.abs(d - 90) * 0.6;
    if (d > 35 && sc > bs) { bs = sc; best = t; }
  }
  F.target = best || BIRDS.pick();
  F.v.set(F.c.x - fx, 0, F.c.z - fz).normalize().multiplyScalar(6).setY(4);
  for (const b of F.birds) b.v.set(sr(-2, 2) + F.v.x * 0.5, sr(3, 6), sr(-2, 2) + F.v.z * 0.5);
  flockSound(camera.position.distanceTo(F.c), clamp((F.c.x - camera.position.x) / 60, -1, 1), F.birds.length);
}
let bushT = 0;
export function updateBirds(dt, pl, sky) {
  if (!BIRDS.im) return;
  const t = FRAME.t, cp = camera.position;
  // боец ломится через кусты (не пригнувшись), дрон пролетает над насестом
  bushT -= dt;
  if (bushT <= 0) {
    bushT = 0.4;
    const sp = Math.hypot(pl.vel.x, pl.vel.z);
    if (pl.mode === 'walk' && pl.crouch < 0.5 && sp > 1.6 && bushNear(pl.pos.x, pl.pos.z)) scareBirds(pl.pos.x, pl.pos.y, pl.pos.z, 32, 0.35 * Math.min(1, sp / 3));
    if (pl.mode === 'drone') for (const F of BIRDS.flocks) if (F.state === 'sit' && cp.distanceTo(F.c) < 11) takeOff(F, cp.x, cp.z);
  }
  for (const F of BIRDS.flocks) {
    F.t += dt;
    if (F.state === 'sit') {
      // сами по себе иногда перелетают; днём покаркивают
      F.calm -= dt; F.caw -= dt;
      if (F.calm < -120 - Math.random() * 200) { F.calm = 0; takeOff(F, F.c.x + sr(-5, 5), F.c.z + sr(-5, 5)); }
      if (F.caw <= 0) { F.caw = sr(15, 45); if (sky.night < 0.5 && cp.distanceTo(F.c) < 70) flockSound(cp.distanceTo(F.c) + 20, 0, 0); }
      for (const b of F.birds) {
        b.hop -= dt;
        if (b.hop < 0 && Math.random() < dt * 0.3) b.hop = 0.35;
        b.ph = b.hop > 0 ? b.ph + dt * 25 : 1.2;
        b.yaw += Math.sin(t * 0.3 + b.i) * dt * 0.3;
      }
    } else {
      // кружат над местом, потом летят к новому дереву и садятся
      const T = F.target, top = T.y + T.h * 0.97;
      const cruise = F.t < F.circle;
      const goal = cruise ? new THREE.Vector3(F.c.x + Math.cos(F.t * 0.9) * 10, F.perch.y + F.perch.h + 12, F.c.z + Math.sin(F.t * 0.9) * 10)
        : new THREE.Vector3(T.x, top + Math.min(12, Math.hypot(T.x - F.c.x, T.z - F.c.z) * 0.2), T.z);
      const to = goal.sub(F.c), dist = to.length();
      F.v.lerp(to.normalize().multiplyScalar(cruise ? 7 : 9), Math.min(1, dt * 1.2));
      F.c.addScaledVector(F.v, dt);
      F.c.x += WIND.dir.x * WIND.strength * dt * 0.5; F.c.z += WIND.dir.y * WIND.strength * dt * 0.5;
      if (!cruise && Math.hypot(T.x - F.c.x, T.z - F.c.z) < 3) { seat(F, T); continue; }
      for (const b of F.birds) {
        const want = _p.set(F.c.x + b.off.x * 3 + Math.sin(t * 1.3 + b.i) * 1.5, F.c.y + b.off.y * 3 + Math.sin(t * 2.1 + b.i * 3) * 0.8, F.c.z + b.off.z * 3 + Math.cos(t * 1.1 + b.i) * 1.5);
        b.v.lerp(want.sub(b.p).multiplyScalar(1.6), Math.min(1, dt * 2.5));
        b.p.addScaledVector(b.v, dt);
        const g = hFast(b.p.x, b.p.z) + 1.5; if (b.p.y < g) b.p.y = g;
        // машут чаще при наборе высоты, парят на снижении
        b.ph += dt * (b.v.y > -0.5 ? b.fr : 3);
        const yawT = Math.atan2(b.v.x, b.v.z);
        let dy = yawT - b.yaw; while (dy > Math.PI) dy -= TAU; while (dy < -Math.PI) dy += TAU;
        b.yaw += dy * Math.min(1, dt * 4);
      }
    }
    for (const b of F.birds) {
      const fly = F.state !== 'sit';
      _e.set(fly ? clamp(-b.v.y * 0.05, -0.4, 0.4) : 0, b.yaw, fly ? Math.sin(t + b.i) * 0.15 : 0, 'YXZ');
      _q.setFromEuler(_e);
      _s.setScalar(fly ? 1.15 : 0.9);
      BIRDS.im.setMatrixAt(b.i, _m.compose(b.p, _q, _s));
      BIRDS.flap.array[b.i] = fly ? b.ph : (b.hop > 0 ? b.ph : -1.2);
    }
  }
  BIRDS.im.instanceMatrix.needsUpdate = true; BIRDS.flap.needsUpdate = true;
}
export const birdStats = () => ({ flocks: BIRDS.flocks.length, flying: BIRDS.flocks.filter(f => f.state !== 'sit').length });
