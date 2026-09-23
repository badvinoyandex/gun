import * as THREE from 'three';
import { scene, camera, FRAME } from '../core/env.js';
import { sr, srnd, TAU, clamp } from '../core/math.js';
import { MAP, terrainH, lakeRho, terrainNormal } from '../world/layout.js';
import { hFast } from '../world/heightcache.js';
import { TEX, M } from '../gen/materials.js';
import { windUniforms } from '../world/wind.js';
import { FX } from './particles.js';
import { boom, tinnitus } from './audio.js';
import { blastBarrels } from '../world/props.js';
import { nudgeCloth } from '../world/cloth.js';
import { addRipple } from '../world/lake.js';
import { onBlast } from './destruction.js';
import { blastKnock } from '../game/player.js';

/* ============================================================================
   ВЗРЫВЫ: мины, сброс с дрона
   Вспышка (свет из отдельного источника), огненный шар, столб земли,
   осколки грунта с отскоком, дым, воронка-декаль, ударная волна по траве,
   деревьям, флагам и бочкам, встряска камеры, звук с задержкой.
============================================================================ */
export const BLAST = { shake: 0, flash: null, craters: [], debris: null, chunks: [], last: null };

export function buildExplosions() {
  BLAST.flash = new THREE.PointLight(0xffb070, 0, 60, 1.6);
  BLAST.flash.position.set(0, -500, 0);
  scene.add(BLAST.flash);
  // осколки грунта: один инстанс-меш
  const g = new THREE.DodecahedronGeometry(0.09, 0);
  BLAST.debris = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0x3a2e22, roughness: 1 }), 220);
  BLAST.debris.count = 0; BLAST.debris.castShadow = true; BLAST.debris.frustumCulled = false;
  scene.add(BLAST.debris);
  // пул воронок
  const cm = new THREE.MeshStandardMaterial({ map: TEX.crater, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  for (let i = 0; i < 40; i++) {
    const pg = new THREE.PlaneGeometry(1, 1, 8, 8); pg.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(pg, cm); m.visible = false; m.receiveShadow = true; m.renderOrder = 1;
    scene.add(m); BLAST.craters.push(m);
  }
}
let craterI = 0;
function crater(x, z, r) {
  const m = BLAST.craters[craterI++ % BLAST.craters.length];
  const p = m.geometry.attributes.position;
  if (!m.userData.base) m.userData.base = p.array.slice();
  const b = m.userData.base;
  for (let i = 0; i < p.count; i++) {
    const lx = b[i * 3] * r * 2, lz = b[i * 3 + 2] * r * 2;
    p.setXYZ(i, lx, hFast(x + lx, z + lz) + 0.05, lz);
  }
  p.needsUpdate = true; m.geometry.computeVertexNormals(); m.geometry.computeBoundingSphere();
  m.position.set(x, 0, z); m.rotation.y = srnd() * TAU; m.visible = true;
}

/** kind: 'pmn' (противопехотная), 'tm' (противотанковая), 'ozm', 'vog' (сброс с дрона). */
export function explode(x, y, z, kind = 'pmn') {
  const size = kind === 'tm' ? 2.2 : kind === 'shell' ? 1.8 : kind === 'ozm' ? 1.3 : kind === 'vog' ? 0.8 : 1;
  const water = lakeRho(x, z) < 0.98 && y < MAP.WATER_Y + 0.6;
  const gy = water ? MAP.WATER_Y : terrainH(x, z);
  BLAST.last = { x, y: gy, z, t: FRAME.t, size };
  // вспышка
  BLAST.flash.position.set(x, gy + 1.5, z);
  BLAST.flash.intensity = 520 * size;
  BLAST.flash.userData.t = 0;
  // огненный шар
  for (let i = 0; i < 12 * size; i++) {
    const a = srnd() * TAU, u = srnd();
    FX.add.spawn({ x: x + Math.cos(a) * 0.3, y: gy + 0.4 + u, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * sr(1, 5) * size, vy: sr(2, 8) * size, vz: Math.sin(a) * sr(1, 5) * size,
      size: sr(0.8, 1.8) * size, grow: 3 * size, life: sr(0.18, 0.4), col: [3.2, 1.9, 0.8], a: 1, cool: 0.35, drag: 3 });
  }
  // искры
  for (let i = 0; i < 18 * size; i++) {
    const a = srnd() * TAU, e = sr(0.3, 1.3);
    FX.add.spawn({ x, y: gy + 0.3, z, vx: Math.cos(a) * Math.cos(e) * sr(8, 22), vy: Math.sin(e) * sr(8, 20), vz: Math.sin(a) * Math.cos(e) * sr(8, 22),
      size: 0.07, life: sr(0.3, 0.9), col: [3, 1.8, 0.7], a: 1, grav: 9, drag: 0.6 });
  }
  if (water) {
    // водяной столб и брызги
    for (let i = 0; i < 40 * size; i++) {
      const a = srnd() * TAU, r = sr(0, 0.8);
      FX.alpha.spawn({ x: x + Math.cos(a) * r, y: gy, z: z + Math.sin(a) * r, vx: Math.cos(a) * sr(0.5, 3), vy: sr(5, 14) * size, vz: Math.sin(a) * sr(0.5, 3),
        size: sr(0.5, 1.2), grow: 1.5, life: sr(1.2, 2.2), col: [0.72, 0.76, 0.78], a: 0.6, grav: 9.8, drag: 0.4, floor: gy });
    }
    addRipple(x, z, 1.2 * size);
    onBlast(x, gy, z, size, true);
  } else {
    // столб земли: тёмные клочья, падающие обратно
    for (let i = 0; i < 46 * size; i++) {
      const a = srnd() * TAU, e = sr(0.9, 1.5);
      const sp = sr(4, 13) * size;
      FX.dirt.spawn({ x: x + sr(-0.3, 0.3), y: gy + 0.2, z: z + sr(-0.3, 0.3), vx: Math.cos(a) * Math.cos(e) * sp, vy: Math.sin(e) * sp, vz: Math.sin(a) * Math.cos(e) * sp,
        size: sr(0.25, 0.8) * size, grow: 0.6, life: sr(1.2, 2.4), col: [0.16, 0.12, 0.09], a: 0.95, grav: 9.8, drag: 0.35, floor: gy - 0.2, fade: 2 });
    }
    // осколки грунта с отскоком
    for (let i = 0; i < 26 * size; i++) {
      const a = srnd() * TAU, e = sr(0.5, 1.4), sp = sr(4, 12) * size;
      BLAST.chunks.push({ p: new THREE.Vector3(x, gy + 0.2, z), v: new THREE.Vector3(Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp, Math.sin(a) * Math.cos(e) * sp), life: sr(2.5, 4.5), s: sr(0.6, 1.6), r: new THREE.Euler(srnd() * 6, srnd() * 6, 0) });
    }
    if (BLAST.chunks.length > 220) BLAST.chunks.splice(0, BLAST.chunks.length - 220);
    onBlast(x, gy, z, size, false);
    crater(x, z, 1.4 * size);
  }
  blastKnock(x, gy, z, size);
  // дым: медленно поднимается и сносится ветром
  for (let i = 0; i < 14 * size; i++) {
    FX.alpha.spawn({ x: x + sr(-1, 1), y: gy + sr(0.3, 2.5), z: z + sr(-1, 1), vx: sr(-0.8, 0.8), vy: sr(0.6, 2.2), vz: sr(-0.8, 0.8),
      size: sr(1.4, 2.6) * size, grow: 1.1, life: sr(5, 9), col: water ? [0.7, 0.72, 0.74] : [0.3, 0.28, 0.26], a: 0.5, fadeIn: 0.25, windK: 1.5, drag: 0.5 });
  }
  // ударная волна
  windUniforms.uBlast.value.set(x, gy, z, 0);
  windUniforms.uBlastStr.value = 1.6 * size;
  blastBarrels(x, gy, z, size);
  nudgeCloth(x, gy, z, 16, 30 * size);
  // камера и звук
  const d = camera.position.distanceTo(new THREE.Vector3(x, gy, z));
  BLAST.shake = Math.max(BLAST.shake, clamp(2.4 * size / (1 + d / 6), 0, 1.6));
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const panX = right.dot(new THREE.Vector3(x - camera.position.x, 0, z - camera.position.z).normalize());
  boom(d, size, panX);
  if (d < 9) tinnitus(clamp(1 - d / 9, 0, 1));
  return d;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _n = new THREE.Vector3();
export function updateExplosions(dt) {
  const f = BLAST.flash;
  if (f.intensity > 0) {
    f.userData.t += dt;
    f.intensity = Math.max(0, f.intensity * Math.exp(-dt * 16));
    if (f.intensity < 1) { f.intensity = 0; f.position.y = -500; }
  }
  const bu = windUniforms.uBlast.value;
  bu.w += dt;
  if (bu.w > 3) windUniforms.uBlastStr.value = 0;
  let n = 0;
  for (const c of BLAST.chunks) {
    c.life -= dt;
    if (c.life <= 0) continue;
    c.v.y -= 9.8 * dt;
    c.p.addScaledVector(c.v, dt);
    const g = hFast(c.p.x, c.p.z);
    if (c.p.y < g + 0.05) {
      c.p.y = g + 0.05;
      terrainNormal(c.p.x, c.p.z, _n);
      const vn = c.v.dot(_n);
      if (vn < 0) c.v.addScaledVector(_n, -vn * 1.4);
      c.v.multiplyScalar(0.55);
    } else { c.r.x += dt * 8; c.r.y += dt * 5; }
    _q.setFromEuler(c.r); _s.setScalar(c.s * Math.min(1, c.life));
    BLAST.debris.setMatrixAt(n++, _m.compose(c.p, _q, _s));
    if (n >= 220) break;
  }
  BLAST.chunks = BLAST.chunks.filter(c => c.life > 0);
  BLAST.debris.count = n;
  BLAST.debris.instanceMatrix.needsUpdate = true;
  BLAST.shake = Math.max(0, BLAST.shake - dt * 1.6);
}
