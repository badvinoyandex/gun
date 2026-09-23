import * as THREE from 'three';
import { scene, camera, FRAME } from '../core/env.js';
import { sr, srnd, TAU, clamp } from '../core/math.js';
import { terrainH, lakeRho, MAP } from '../world/layout.js';
import { hFast } from '../world/heightcache.js';
import { COLLIDERS } from '../core/colliders.js';
import { PHYS, rayCast, impulse } from '../core/physics.js';
import { FX } from '../fx/particles.js';
import { breakPane, paneByIndex } from '../fx/glass.js';
import { splinters } from '../fx/destruction.js';
import { explode } from '../fx/explosions.js';
import { shotSound, whistleSound } from '../fx/audio.js';
import { M } from '../gen/materials.js';
import { PL } from './player.js';

/* ============================================================================
   ОРУЖИЕ ДЛЯ ПРОВЕРКИ ФИЗИКИ
   ПКМ — выстрел: луч ammo.js по всему миру. Стекло бьётся, от стволов летит
   щепа, земля пылит, обломки и бочки получают импульс в точке попадания.
   B — артналёт: пять снарядов со свистом ложатся вокруг точки прицела.
============================================================================ */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _dir = new THREE.Vector3();
let flash = null, tracer = null, tracerT = 0, lastShot = -1;

export function buildWeapons() {
  flash = new THREE.PointLight(0xffc27a, 0, 12, 2);
  camera.add(flash); flash.position.set(0.15, -0.1, -0.6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  tracer = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  tracer.frustumCulled = false; scene.add(tracer);
}
/** Точка прицела: луч по физике, без неё — шаг по рельефу. */
export function aimPoint(maxD = 600) {
  camera.getWorldDirection(_dir);
  _a.copy(camera.position); _b.copy(_a).addScaledVector(_dir, maxD);
  const h = rayCast(_a, _b);
  if (h) return h.point.clone();
  for (let d = 1; d < maxD; d += 1) {
    const p = _a.clone().addScaledVector(_dir, d);
    if (p.y < terrainH(p.x, p.z)) return p;
  }
  return null;
}
export function shoot() {
  if (PL.dead > 0 || FRAME.t - lastShot < 0.11) return;
  lastShot = FRAME.t;
  camera.getWorldDirection(_dir);
  _dir.x += sr(-0.004, 0.004); _dir.y += sr(-0.004, 0.004); _dir.normalize();
  _a.copy(camera.position).addScaledVector(_dir, 0.3);
  _b.copy(_a).addScaledVector(_dir, 500);
  shotSound();
  flash.intensity = 6; PL.pitch += 0.006; 
  let h = rayCast(_a, _b);
  let p = h ? h.point.clone() : null, n = h ? h.normal.clone() : new THREE.Vector3(0, 1, 0);
  if (!PHYS.ready) {
    for (let d = 1; d < 300; d += 0.5) { const q = _a.clone().addScaledVector(_dir, d); if (q.y < hFast(q.x, q.z)) { p = q; break; } }
  }
  const end = p || _b;
  const tp = tracer.geometry.attributes.position;
  tp.setXYZ(0, _a.x + _dir.x * 1.5, _a.y + _dir.y * 1.5 - 0.05, _a.z + _dir.z * 1.5); tp.setXYZ(1, end.x, end.y, end.z); tp.needsUpdate = true;
  tracer.material.opacity = 0.7; tracerT = 0.06;
  if (!p) return;
  if (h && h.idx <= -1000) { const pane = paneByIndex(h.idx); if (pane) breakPane(pane, _dir.clone(), 2.5, p); return; }
  if (h && h.body) { impulse(h.body, _dir.x * 6, _dir.y * 6, _dir.z * 6, p.x - h.body.pos.x, p.y - h.body.pos.y, p.z - h.body.pos.z); sparks(p, n, [2.2, 1.8, 1.2]); return; }
  const c = h && h.idx >= 0 ? COLLIDERS[h.idx] : null;
  if (c && c.tree) { splinters(p.x, p.y, p.z, n, 3, M.logEnd, 0.18); puff(p, n, [0.35, 0.26, 0.18], 4); return; }
  if (c) { puff(p, n, [0.4, 0.36, 0.3], 5); sparks(p, n, [2, 1.6, 1]); return; }
  // земля или вода
  if (lakeRho(p.x, p.z) < 0.98 && p.y < MAP.WATER_Y + 0.2) { for (let i = 0; i < 8; i++) FX.alpha.spawn({ x: p.x, y: MAP.WATER_Y, z: p.z, vx: sr(-0.4, 0.4), vy: sr(2, 4), vz: sr(-0.4, 0.4), size: 0.15, grow: 0.4, life: 0.8, col: [0.7, 0.75, 0.78], a: 0.5, grav: 9.8 }); return; }
  puff(p, n, [0.3, 0.24, 0.18], 7);
}
function puff(p, n, col, k) {
  for (let i = 0; i < k; i++) FX.alpha.spawn({ x: p.x, y: p.y, z: p.z, vx: n.x * sr(0.5, 2) + sr(-0.4, 0.4), vy: n.y * sr(0.5, 2) + sr(0, 0.6), vz: n.z * sr(0.5, 2) + sr(-0.4, 0.4), size: sr(0.1, 0.25), grow: 0.8, life: sr(0.6, 1.4), col, a: 0.6, drag: 2 });
  for (let i = 0; i < k; i++) FX.dirt.spawn({ x: p.x, y: p.y, z: p.z, vx: n.x * sr(1, 4) + sr(-1, 1), vy: sr(1, 4), vz: n.z * sr(1, 4) + sr(-1, 1), size: 0.05, life: 0.9, col: col.map(v => v * 0.6), a: 0.9, grav: 9.8, floor: p.y - 0.3 });
}
function sparks(p, n, col) {
  for (let i = 0; i < 6; i++) FX.add.spawn({ x: p.x, y: p.y, z: p.z, vx: n.x * sr(2, 6) + sr(-2, 2), vy: n.y * sr(2, 6) + sr(0, 2), vz: n.z * sr(2, 6) + sr(-2, 2), size: 0.03, life: sr(0.15, 0.4), col, a: 1, grav: 9.8 });
}
/** Артналёт: пять снарядов вокруг точки прицела, свист перед каждым разрывом. */
export function artillery(target) {
  if (!target) return false;
  for (let i = 0; i < 5; i++) {
    const a = srnd() * TAU, r = Math.sqrt(srnd()) * 9;
    const x = target.x + Math.cos(a) * r, z = target.z + Math.sin(a) * r;
    setTimeout(() => whistleThen(x, z), 500 + i * sr(500, 900));
  }
  return true;
}
function whistleThen(x, z) {
  whistleSound(0.9);
  setTimeout(() => explode(x, terrainH(x, z), z, 'shell'), 900);
}
export function updateWeapons(dt) {
  if (flash) flash.intensity = Math.max(0, flash.intensity - dt * 90);
  if (tracerT > 0) { tracerT -= dt; if (tracerT <= 0) tracer.material.opacity = 0; }
}
